//! `twistedflow plugin` — scaffold and build WASM plugin crates.
//!
//! Commands:
//!   twistedflow plugin new <name> [--category C] [--description D] [--node N]... [--force]
//!   twistedflow plugin build [--install DIR] [--no-install] [--debug]

use std::path::{Path, PathBuf};
use std::process::Command;

// ── CLI args ────────────────────────────────────────────────────────

use clap::Subcommand;

#[derive(Subcommand)]
pub enum PluginCmd {
    /// Scaffold a new WASM plugin crate
    New {
        /// Plugin directory name (creates ./<name>/)
        name: String,
        /// Display category for the nodes (e.g. "Text", "Utility")
        #[arg(long, default_value = "Utility")]
        category: String,
        /// Short description
        #[arg(long, default_value = "")]
        description: String,
        /// Pre-declare a node. Repeatable: --node Foo --node Bar
        #[arg(long = "node")]
        nodes: Vec<String>,
        /// Overwrite if directory exists
        #[arg(long)]
        force: bool,
    },
    /// Compile the plugin in the current directory and install it
    Build {
        /// Install path (overrides auto-detection)
        #[arg(long)]
        install: Option<PathBuf>,
        /// Skip install, leave .wasm in target/
        #[arg(long)]
        no_install: bool,
        /// Debug build (skip --release)
        #[arg(long)]
        debug: bool,
    },
}

// ── `plugin new` ────────────────────────────────────────────────────

pub fn run_new(
    name: &str,
    category: &str,
    description: &str,
    nodes: &[String],
    force: bool,
) -> Result<(), String> {
    let dir = PathBuf::from(name);

    if dir.exists() {
        if !force {
            return Err(format!(
                "Directory '{}' already exists. Use --force to overwrite.",
                dir.display()
            ));
        }
    }

    std::fs::create_dir_all(dir.join("src"))
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    let crate_name = format!("twistedflow-plugin-{}", name);
    let sdk_dep = sdk_dep_string();

    // Cargo.toml
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
"#
    );
    std::fs::write(dir.join("Cargo.toml"), cargo_toml)
        .map_err(|e| format!("Failed to write Cargo.toml: {}", e))?;

    // src/lib.rs — generate stubs for each requested node
    let lib_rs = generate_lib_rs(name, category, description, nodes);
    std::fs::write(dir.join("src/lib.rs"), lib_rs)
        .map_err(|e| format!("Failed to write src/lib.rs: {}", e))?;

    // .gitignore
    std::fs::write(dir.join(".gitignore"), "/target\nCargo.lock\n")
        .map_err(|e| format!("Failed to write .gitignore: {}", e))?;

    // README.md
    let readme = format!(
        r#"# {name}

{desc}

## Build

```bash
twistedflow plugin build
```

This compiles to `target/wasm32-wasip1/release/{underscored}.wasm` and installs
it to `./nodes/` if present, else `~/.twistedflow/plugins/`.

## Manual build

```bash
cargo build --target wasm32-wasip1 --release
cp target/wasm32-wasip1/release/{underscored}.wasm ~/.twistedflow/plugins/
```

## Docs

See the [TwistedFlow plugin guide](https://github.com/imkarmadev/TwistedFlow/blob/main/docs/plugins.md).
"#,
        name = name,
        desc = if description.is_empty() { "A TwistedFlow WASM plugin." } else { description },
        underscored = crate_name.replace('-', "_"),
    );
    std::fs::write(dir.join("README.md"), readme)
        .map_err(|e| format!("Failed to write README.md: {}", e))?;

    println!("✓ Created {}/", name);
    println!("  Next: cd {} && twistedflow plugin build", name);
    Ok(())
}

fn generate_lib_rs(
    plugin_name: &str,
    category: &str,
    _description: &str,
    requested_nodes: &[String],
) -> String {
    let node_decls: Vec<String> = if requested_nodes.is_empty() {
        // Default: one "Hello" sample node
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
            // TODO: implement {name}
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
        plugin_name = plugin_name,
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

/// The absolute path to the twistedflow-plugin crate as known at compile time.
/// This is resolved from the CLI crate's CARGO_MANIFEST_DIR since the plugin
/// SDK lives in the same workspace.
const SDK_CRATE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../twistedflow-plugin");

/// Generate the `twistedflow-plugin` dependency line for Cargo.toml.
/// Priority: env override > compiled-in absolute path (if exists on disk) > git fallback.
fn sdk_dep_string() -> String {
    // 1. Explicit env override
    if let Ok(path) = std::env::var("TWISTEDFLOW_PLUGIN_SDK_PATH") {
        return format!(r#"twistedflow-plugin = {{ path = "{}" }}"#, path);
    }

    // 2. Use the compiled-in SDK path (works when running a dev build from the repo)
    let sdk_path = Path::new(SDK_CRATE_DIR);
    if sdk_path.exists() {
        // Canonicalize to get a clean absolute path
        if let Ok(abs) = sdk_path.canonicalize() {
            return format!(
                r#"twistedflow-plugin = {{ path = "{}" }}"#,
                abs.display()
            );
        }
    }

    // 3. Fallback: git dep (for release builds where the source tree isn't around)
    r#"twistedflow-plugin = { git = "https://github.com/imkarmadev/TwistedFlow", package = "twistedflow-plugin" }"#.to_string()
}

// ── `plugin build` ──────────────────────────────────────────────────

pub fn run_build(
    install: Option<PathBuf>,
    no_install: bool,
    debug: bool,
) -> Result<(), String> {
    let cwd = std::env::current_dir().map_err(|e| format!("Failed to get CWD: {}", e))?;
    let cargo_toml = cwd.join("Cargo.toml");

    if !cargo_toml.exists() {
        return Err(format!(
            "No Cargo.toml in {}. Run from inside a plugin crate.",
            cwd.display()
        ));
    }

    let toml_content = std::fs::read_to_string(&cargo_toml)
        .map_err(|e| format!("Failed to read Cargo.toml: {}", e))?;

    if !toml_content.contains("twistedflow-plugin") {
        return Err("This doesn't look like a TwistedFlow plugin crate (no `twistedflow-plugin` dependency found).".into());
    }

    let crate_name = parse_crate_name(&toml_content)
        .ok_or("Could not parse crate name from Cargo.toml")?;

    // Compile
    println!("→ Compiling {} to wasm32-wasip1...", crate_name);
    let mut cmd = Command::new("cargo");
    cmd.arg("build").arg("--target").arg("wasm32-wasip1");
    if !debug {
        cmd.arg("--release");
    }
    let status = cmd
        .status()
        .map_err(|e| format!("Failed to run cargo: {}", e))?;
    if !status.success() {
        return Err("Cargo build failed".into());
    }

    // Find the .wasm
    let profile = if debug { "debug" } else { "release" };
    let wasm_name = format!("{}.wasm", crate_name.replace('-', "_"));
    let wasm_path = cwd
        .join("target/wasm32-wasip1")
        .join(profile)
        .join(&wasm_name);

    if !wasm_path.exists() {
        return Err(format!(
            "Expected .wasm not found at {}",
            wasm_path.display()
        ));
    }

    // Validate
    println!("→ Validating {}...", wasm_path.display());
    match twistedflow_engine::validate_wasm(&wasm_path) {
        Ok(nodes) => {
            println!("✓ Valid plugin with {} node(s):", nodes.len());
            for (type_id, name) in &nodes {
                println!("    • {} ({})", name, type_id);
            }
        }
        Err(e) => return Err(format!("Plugin validation failed: {}", e)),
    }

    if no_install {
        println!("✓ Built: {}", wasm_path.display());
        return Ok(());
    }

    // Determine install dir
    let install_dir = if let Some(dir) = install {
        dir
    } else if cwd.join("nodes").is_dir() {
        cwd.join("nodes")
    } else {
        let home = std::env::var("HOME").map_err(|_| "$HOME not set")?;
        let dir = PathBuf::from(home).join(".twistedflow/plugins");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create {}: {}", dir.display(), e))?;
        dir
    };

    let dest = install_dir.join(&wasm_name);
    std::fs::copy(&wasm_path, &dest)
        .map_err(|e| format!("Failed to copy to {}: {}", dest.display(), e))?;

    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    println!(
        "✓ Installed: {} ({} KB)",
        dest.display(),
        size / 1024
    );

    Ok(())
}

fn parse_crate_name(toml: &str) -> Option<String> {
    // Very simple: look for `name = "..."` under `[package]`.
    // Matches the regex approach used in build.rs.
    let mut in_package = false;
    for line in toml.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]";
            continue;
        }
        if in_package && trimmed.starts_with("name") {
            if let Some(eq) = trimmed.find('=') {
                let rest = trimmed[eq + 1..].trim();
                return Some(rest.trim_matches('"').trim_matches('\'').to_string());
            }
        }
    }
    None
}
