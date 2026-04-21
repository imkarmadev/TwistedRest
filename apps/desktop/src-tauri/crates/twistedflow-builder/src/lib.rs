//! Shared flow build logic for TwistedFlow desktop and CLI.

use std::path::{Path, PathBuf};
use std::process::Command;

const CRATES_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

#[derive(Debug, Clone)]
pub struct BuildResult {
    pub output_path: PathBuf,
    pub size_bytes: u64,
}

impl BuildResult {
    pub fn formatted_size(&self) -> String {
        format_size(self.size_bytes)
    }
}

pub fn build(
    project: &Path,
    output: &str,
    flow_name: Option<&str>,
    env_name: &str,
    release: bool,
) -> Result<BuildResult, String> {
    let project =
        twistedflow_project::validate_project_dir(&twistedflow_project::expand_tilde(project))?;

    let project_name = std::fs::read_to_string(project.join("twistedflow.toml"))
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("name"))
                .and_then(|l| l.split('=').nth(1))
                .map(|v| v.trim().trim_matches('"').to_string())
        })
        .unwrap_or_else(|| "app".into());

    let flows_dir = project.join("flows");
    let mut available_flows: Vec<(String, String)> = Vec::new();
    if flows_dir.exists() {
        for entry in std::fs::read_dir(&flows_dir)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                let name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("flow")
                    .replace(".flow", "");
                let content = std::fs::read_to_string(&path)
                    .map_err(|e| format!("Cannot read {}: {}", path.display(), e))?;
                available_flows.push((name, content));
            }
        }
    }

    if available_flows.is_empty() {
        return Err("No flows found in project".into());
    }

    let (selected_name, flow_json) = if let Some(name) = flow_name {
        available_flows
            .iter()
            .find(|(n, _)| n == name)
            .ok_or_else(|| {
                let names: Vec<&str> = available_flows.iter().map(|(n, _)| n.as_str()).collect();
                format!("Flow '{}' not found. Available: {:?}", name, names)
            })?
            .clone()
    } else {
        available_flows.first().unwrap().clone()
    };

    let env_filename = if env_name == "default" {
        ".env".into()
    } else {
        format!(".env.{}", env_name)
    };
    let env_content = std::fs::read_to_string(project.join(&env_filename)).unwrap_or_default();

    eprintln!("Building: flow={}, env={}", selected_name, env_name);

    let tmp = tempfile::tempdir().map_err(|e| format!("Tempdir: {}", e))?;
    let build_dir = tmp.path();
    std::fs::create_dir_all(build_dir.join("src")).map_err(|e| e.to_string())?;

    let bin_name = sanitize(&project_name);
    let engine_path = format!("{}/twistedflow-engine", CRATES_DIR).replace('\\', "/");
    let nodes_path = format!("{}/twistedflow-nodes", CRATES_DIR).replace('\\', "/");

    let cargo_toml = format!(
        r#"[package]
name = "{bin_name}"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "{bin_name}"
path = "src/main.rs"

[dependencies]
twistedflow-engine = {{ path = "{engine_path}" }}
twistedflow-nodes = {{ path = "{nodes_path}" }}
serde_json = "1"
tokio = {{ version = "1", features = ["rt-multi-thread", "macros", "signal"] }}
tokio-util = "0.7"
reqwest = {{ version = "0.12", default-features = false, features = ["rustls-tls"] }}
"#
    );

    std::fs::write(build_dir.join("Cargo.toml"), cargo_toml).map_err(|e| e.to_string())?;

    let mut subflow_sources: Vec<String> = Vec::new();
    for (_, src) in &available_flows {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(src) {
            if parsed.get("kind").and_then(|v| v.as_str()) == Some("subflow") {
                subflow_sources.push(src.clone());
            }
        }
    }
    let subflows_json = serde_json::to_string(&subflow_sources).unwrap_or_else(|_| "[]".into());

    let escaped_flow = flow_json
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    let escaped_env = env_content
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    let escaped_subflows = subflows_json
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");

    let main_rs = format!(
        r##"//! Built by `twistedflow build`. Flow: {flow_name}, Env: {env_name}
extern crate twistedflow_nodes;

use std::collections::HashMap;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use twistedflow_engine::{{
    FlowFile, FlowKind, GraphIndex, LogEntry, RunFlowOpts, StatusEvent, SubflowNode,
    build_registry, load_wasm_plugins,
}};
use serde_json::Value;
use std::sync::Arc as StdArc;

const FLOW_JSON: &str = "{escaped_flow}";
const ENV_CONTENT: &str = "{escaped_env}";
const SUBFLOWS_JSON: &str = "{escaped_subflows}";

fn parse_dotenv(content: &str) -> HashMap<String, Value> {{
    let mut map = HashMap::new();
    for line in content.lines() {{
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {{ continue; }}
        if let Some((key, value)) = line.split_once('=') {{
            let key = key.trim().to_string();
            let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
            if !key.is_empty() {{ map.insert(key, Value::String(value)); }}
        }}
    }}
    map
}}

#[tokio::main]
async fn main() {{
    let quiet = std::env::args().any(|a| a == "-q" || a == "--quiet");

    let flow_file = FlowFile::parse(FLOW_JSON).expect("embedded flow is invalid");
    if !quiet {{ eprintln!("Running: {{}}", flow_file.name); }}

    let graph = flow_file.to_graph();
    let index = Arc::new(GraphIndex::build(&graph));

    let mut registry = build_registry();
    let runtime_nodes_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("nodes")))
        .filter(|p| p.is_dir())
        .or_else(|| std::env::current_dir().ok().map(|d| d.join("nodes")).filter(|p| p.is_dir()));
    if let Some(nodes_dir) = runtime_nodes_dir {{
        let nodes_dir = nodes_dir.to_string_lossy().to_string();
        for (id, node, _) in load_wasm_plugins(&[nodes_dir.as_str()]) {{ registry.insert(id.to_string(), node); }}
    }}

    if !SUBFLOWS_JSON.is_empty() {{
        if let Ok(subflows) = serde_json::from_str::<Vec<String>>(SUBFLOWS_JSON) {{
            for src in subflows {{
                if let Ok(flow) = FlowFile::parse(&src) {{
                    if flow.kind == FlowKind::Subflow && !flow.name.is_empty() {{
                        let iface = flow.interface.clone().unwrap_or_default();
                        let type_id = format!("fn:{{}}", flow.name);
                        let node: Box<dyn twistedflow_engine::Node> = Box::new(SubflowNode {{
                            flow: StdArc::new(flow),
                            interface: iface,
                        }});
                        registry.insert(type_id, node);
                    }}
                }}
            }}
        }}
    }}

    let env_vars = parse_dotenv(ENV_CONTENT);
    let context = twistedflow_engine::ExecContext {{
        env_vars: if env_vars.is_empty() {{ None }} else {{ Some(env_vars) }},
        ..Default::default()
    }};

    let q1 = quiet;
    let on_status: Box<dyn Fn(&str, StatusEvent) + Send + Sync> = Box::new(move |id, ev| {{
        if q1 && ev.status != "error" {{ return; }}
        match ev.status.as_str() {{
            "error" => eprintln!("  ✗ {{}} — {{}}", id, ev.error.as_deref().unwrap_or("error")),
            "ok" => eprintln!("  ✓ {{}}", id),
            _ => {{}}
        }}
    }});

    let q2 = quiet;
    let on_log: std::sync::Arc<dyn Fn(LogEntry) + Send + Sync> = std::sync::Arc::new(move |e| {{
        if q2 {{ return; }}
        let v = match &e.value {{ Value::String(s) => s.clone(), o => serde_json::to_string_pretty(o).unwrap_or_default() }};
        println!("[{{}}] {{}}", e.label, v);
    }});

    let cancel = CancellationToken::new();
    let cc = cancel.clone();
    tokio::spawn(async move {{ tokio::signal::ctrl_c().await.ok(); cc.cancel(); }});

    let opts = Arc::new(RunFlowOpts {{
        index, context, on_status, on_log, cancel,
        http_client: reqwest::Client::builder().user_agent("TwistedFlow-Built/1.0").build().unwrap(),
        registry: StdArc::new(registry),
        processes: std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new())),
        depth: 0,
    }});

    match twistedflow_engine::run_flow(opts).await {{
        Ok(()) => {{ if !quiet {{ eprintln!("Done"); }} }}
        Err(e) => {{ eprintln!("Error: {{}}", e); std::process::exit(1); }}
    }}
}}
"##,
        flow_name = selected_name,
        env_name = env_name,
        escaped_flow = escaped_flow,
        escaped_env = escaped_env,
        escaped_subflows = escaped_subflows,
    );

    std::fs::write(build_dir.join("src/main.rs"), main_rs).map_err(|e| e.to_string())?;

    eprintln!("Compiling (this may take a moment)...");
    let mut cmd = Command::new("cargo");
    cmd.arg("build").current_dir(build_dir);
    if release {
        cmd.arg("--release");
    }

    let status = cmd.status().map_err(|e| format!("cargo: {}", e))?;
    if !status.success() {
        return Err("Compilation failed".into());
    }

    let profile_dir = if release { "release" } else { "debug" };
    let built = build_dir.join("target").join(profile_dir).join(&bin_name);
    let out_path = if output.starts_with('/') || output.starts_with("./") {
        PathBuf::from(output)
    } else {
        std::env::current_dir().unwrap_or_default().join(output)
    };

    std::fs::copy(&built, &out_path).map_err(|e| format!("Copy: {}", e))?;

    let project_nodes = project.join("nodes");
    if project_nodes.is_dir() {
        let out_nodes = out_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("nodes");
        std::fs::create_dir_all(&out_nodes).map_err(|e| format!("Create nodes dir: {}", e))?;
        let mut copied_nodes = 0usize;
        for entry in std::fs::read_dir(&project_nodes)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("wasm") {
                continue;
            }
            let Some(file_name) = path.file_name() else {
                continue;
            };
            let dest = out_nodes.join(file_name);
            std::fs::copy(&path, &dest)
                .map_err(|e| format!("Copy node {}: {}", path.display(), e))?;
            copied_nodes += 1;
        }
        if copied_nodes > 0 {
            eprintln!(
                "Copied {} custom node artifact(s) to {}",
                copied_nodes,
                out_nodes.display()
            );
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(0o755)).ok();
    }

    let size_bytes = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    eprintln!(
        "Built: {} ({})",
        out_path.display(),
        format_size(size_bytes)
    );

    Ok(BuildResult {
        output_path: out_path,
        size_bytes,
    })
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect::<String>()
        .to_lowercase()
}

fn format_size(bytes: u64) -> String {
    if bytes >= 1_048_576 {
        format!("{:.1}MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.0}KB", bytes as f64 / 1024.0)
    } else {
        format!("{}B", bytes)
    }
}
