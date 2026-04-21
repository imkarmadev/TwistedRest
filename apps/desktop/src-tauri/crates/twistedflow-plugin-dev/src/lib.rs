use std::path::{Path, PathBuf};
use std::process::Command;
use twistedflow_project::parse_crate_name;

#[derive(Debug, Clone, Copy)]
pub enum ReadmeKind {
    DesktopProjectLocal,
    Cli,
}

#[derive(Debug, Clone)]
pub struct ScaffoldPluginOptions {
    pub target_dir: PathBuf,
    pub plugin_name: String,
    pub category: String,
    pub description: String,
    pub requested_nodes: Vec<String>,
    pub force: bool,
    pub readme_kind: ReadmeKind,
}

#[derive(Debug, Clone)]
pub struct ScaffoldPluginResult {
    pub source_dir: PathBuf,
    pub crate_name: String,
}

#[derive(Debug, Clone)]
pub struct BuildPluginOptions {
    pub source_dir: PathBuf,
    pub install_dir: Option<PathBuf>,
    pub debug: bool,
}

#[derive(Debug, Clone)]
pub struct BuiltNodeInfo {
    pub type_id: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct BuildPluginResult {
    pub crate_name: String,
    pub wasm_path: PathBuf,
    pub installed_path: Option<PathBuf>,
    pub nodes: Vec<BuiltNodeInfo>,
}

pub fn scaffold_plugin(opts: ScaffoldPluginOptions) -> Result<ScaffoldPluginResult, String> {
    let target_dir = opts.target_dir;
    let crate_suffix = target_dir
        .file_name()
        .and_then(|s| s.to_str())
        .map(sanitize_name)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "Plugin directory name must contain at least one letter or number.".to_string()
        })?;

    if target_dir.exists() && !opts.force {
        return Err(format!(
            "Directory '{}' already exists. Use --force to overwrite.",
            target_dir.display()
        ));
    }

    std::fs::create_dir_all(target_dir.join("src"))
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    let crate_name = format!("twistedflow-plugin-{}", crate_suffix);
    let cargo_toml = format!(
        r#"[package]
name = "{crate_name}"
version = "0.1.0"
edition = "2021"
description = "{description}"

[lib]
crate-type = ["cdylib"]

[dependencies]
{sdk_dep}

[profile.release]
strip = true
lto = true
opt-level = "z"
codegen-units = 1
"#,
        description = opts.description,
        sdk_dep = sdk_dep_string(),
    );
    std::fs::write(target_dir.join("Cargo.toml"), cargo_toml)
        .map_err(|e| format!("Failed to write Cargo.toml: {}", e))?;

    let lib_rs = generate_lib_rs(&opts.plugin_name, &opts.category, &opts.requested_nodes);
    std::fs::write(target_dir.join("src/lib.rs"), lib_rs)
        .map_err(|e| format!("Failed to write src/lib.rs: {}", e))?;

    std::fs::write(target_dir.join(".gitignore"), "/target\nCargo.lock\n")
        .map_err(|e| format!("Failed to write .gitignore: {}", e))?;

    let readme = generate_readme(
        opts.readme_kind,
        &opts.plugin_name,
        &opts.description,
        &crate_name,
    );
    std::fs::write(target_dir.join("README.md"), readme)
        .map_err(|e| format!("Failed to write README.md: {}", e))?;

    Ok(ScaffoldPluginResult {
        source_dir: target_dir,
        crate_name,
    })
}

pub fn build_plugin(opts: BuildPluginOptions) -> Result<BuildPluginResult, String> {
    validate_source_dir(&opts.source_dir)?;

    let cargo_toml = opts.source_dir.join("Cargo.toml");
    let toml_content = std::fs::read_to_string(&cargo_toml)
        .map_err(|e| format!("Failed to read {}: {}", cargo_toml.display(), e))?;

    if !toml_content.contains("twistedflow-plugin") {
        return Err(format!(
            "{} is not a TwistedFlow plugin crate (missing `twistedflow-plugin` dependency).",
            opts.source_dir.display()
        ));
    }

    let crate_name =
        parse_crate_name(&toml_content).ok_or("Could not parse crate name from Cargo.toml")?;

    let mut command = Command::new("cargo");
    command.arg("build").arg("--target").arg("wasm32-wasip1");
    if !opts.debug {
        command.arg("--release");
    }
    let output = command
        .current_dir(&opts.source_dir)
        .output()
        .map_err(|e| format!("Failed to start plugin build: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let details = format!("{}\n{}", stdout.trim(), stderr.trim())
        .trim()
        .to_string();

    if !output.status.success() {
        return Err(if details.is_empty() {
            format!("Build failed for {}", opts.source_dir.display())
        } else {
            details
        });
    }

    let profile = if opts.debug { "debug" } else { "release" };
    let wasm_name = format!("{}.wasm", crate_name.replace('-', "_"));
    let wasm_path = opts
        .source_dir
        .join("target/wasm32-wasip1")
        .join(profile)
        .join(&wasm_name);

    if !wasm_path.exists() {
        return Err(format!(
            "Expected build artifact not found at {}",
            wasm_path.display()
        ));
    }

    let nodes = twistedflow_engine::validate_wasm(&wasm_path)
        .map_err(|e| format!("Plugin validation failed: {}", e))?
        .into_iter()
        .map(|(type_id, name)| BuiltNodeInfo { type_id, name })
        .collect::<Vec<_>>();

    let installed_path = if let Some(install_dir) = opts.install_dir {
        std::fs::create_dir_all(&install_dir)
            .map_err(|e| format!("Failed to create {}: {}", install_dir.display(), e))?;
        let dest = install_dir.join(&wasm_name);
        std::fs::copy(&wasm_path, &dest)
            .map_err(|e| format!("Failed to copy to {}: {}", dest.display(), e))?;
        Some(dest)
    } else {
        None
    };

    Ok(BuildPluginResult {
        crate_name,
        wasm_path,
        installed_path,
        nodes,
    })
}

pub fn sanitize_name(name: &str) -> String {
    let out = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .to_lowercase();

    out.trim_matches('-').to_string()
}

fn validate_source_dir(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Source path does not exist: {}", path.display()));
    }
    if !path.join("Cargo.toml").exists() {
        return Err(format!(
            "Not a Rust plugin source dir (missing Cargo.toml in {})",
            path.display()
        ));
    }
    Ok(())
}

fn generate_readme(
    kind: ReadmeKind,
    plugin_name: &str,
    description: &str,
    crate_name: &str,
) -> String {
    match kind {
        ReadmeKind::DesktopProjectLocal => format!(
            r#"# {plugin_name}

{description}

## Build

Build this node from the TwistedFlow desktop app, or run:

```bash
cargo build --target wasm32-wasip1 --release
```

The app installs the validated `.wasm` artifact into the current project's
`nodes/` directory.
"#
        ),
        ReadmeKind::Cli => format!(
            r#"# {plugin_name}

{desc}

## Build

```bash
twistedflow plugin build
```

This compiles to `target/wasm32-wasip1/release/{underscored}.wasm` and installs
it to the nearest TwistedFlow project's `nodes/` directory.

## Manual build

```bash
cargo build --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/{underscored}.wasm /path/to/project/nodes/
```

## Docs

See the [TwistedFlow plugin guide](https://github.com/imkarmadev/TwistedFlow/blob/main/docs/plugins.md).
"#,
            desc = if description.is_empty() {
                "A TwistedFlow WASM plugin."
            } else {
                description
            },
            underscored = crate_name.replace('-', "_"),
        ),
    }
}

fn generate_lib_rs(plugin_name: &str, category: &str, requested_nodes: &[String]) -> String {
    let node_decls: Vec<String> = if requested_nodes.is_empty() {
        let type_id = format!("{}Hello", to_camel(plugin_name));
        vec![format!(
            r#"    node "Hello" (type_id = "{type_id}", category = "{category}") {{
        inputs: [{{ key: "name", data_type: "string" }}],
        outputs: [{{ key: "greeting", data_type: "string" }}],
        execute: |inputs| {{
            let name = inputs.get_string("name").unwrap_or_else(|| "world".to_string());
            host::log(&format!("Hello, {{}}!", name));
            PluginOutputs::new().set("greeting", format!("Hello, {{}}!", name))
        }}
    }}"#
        )]
    } else {
        requested_nodes
            .iter()
            .map(|name| {
                let type_id = to_camel(name);
                format!(
                    r#"    node "{name}" (type_id = "{type_id}", category = "{category}") {{
        inputs: [{{ key: "input", data_type: "string" }}],
        outputs: [{{ key: "output", data_type: "string" }}],
        execute: |inputs| {{
            let input = inputs.get_string("input").unwrap_or_default();
            PluginOutputs::new().set("output", input)
        }}
    }}"#
                )
            })
            .collect()
    };

    format!(
        r#"//! {plugin_name} — TwistedFlow WASM plugin

use twistedflow_plugin::*;

nodes! {{
{}
}}
"#,
        node_decls.join("\n\n"),
    )
}

fn to_camel(s: &str) -> String {
    let mut out = String::new();
    let mut upper = false;
    for (i, c) in s.chars().enumerate() {
        if c == '-' || c == '_' || c == ' ' {
            upper = true;
        } else if i == 0 {
            out.push(c.to_ascii_lowercase());
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

const EMBEDDED_SDK_CARGO_TOML: &str = include_str!("../../twistedflow-plugin/Cargo.toml");
const EMBEDDED_SDK_LIB_RS: &str = include_str!("../../twistedflow-plugin/src/lib.rs");

fn ensure_sdk_extracted() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "$HOME not set")?;
    let sdk_dir = PathBuf::from(home).join(".twistedflow/sdk/twistedflow-plugin");

    let needs_write = if sdk_dir.join("Cargo.toml").exists() {
        let existing = std::fs::read_to_string(sdk_dir.join("Cargo.toml")).unwrap_or_default();
        existing != EMBEDDED_SDK_CARGO_TOML
    } else {
        true
    };

    if needs_write {
        std::fs::create_dir_all(sdk_dir.join("src"))
            .map_err(|e| format!("Failed to create SDK dir: {}", e))?;
        std::fs::write(sdk_dir.join("Cargo.toml"), EMBEDDED_SDK_CARGO_TOML)
            .map_err(|e| format!("Failed to write SDK Cargo.toml: {}", e))?;
        std::fs::write(sdk_dir.join("src/lib.rs"), EMBEDDED_SDK_LIB_RS)
            .map_err(|e| format!("Failed to write SDK lib.rs: {}", e))?;
    }

    Ok(sdk_dir)
}

fn sdk_dep_string() -> String {
    if let Ok(path) = std::env::var("TWISTEDFLOW_PLUGIN_SDK_PATH") {
        return format!(r#"twistedflow-plugin = {{ path = "{}" }}"#, path);
    }

    match ensure_sdk_extracted() {
        Ok(sdk_dir) => format!(
            r#"twistedflow-plugin = {{ path = "{}" }}"#,
            sdk_dir.display()
        ),
        Err(e) => {
            eprintln!(
                "Warning: could not extract embedded plugin SDK: {}. Falling back to git dep.",
                e
            );
            r#"twistedflow-plugin = { git = "https://github.com/imkarmadev/TwistedFlow", package = "twistedflow-plugin" }"#.to_string()
        }
    }
}
