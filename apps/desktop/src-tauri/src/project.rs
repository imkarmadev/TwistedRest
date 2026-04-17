//! File-based project commands.
//!
//! A project is a folder on disk:
//!   my-project/
//!   ├── twistedflow.toml
//!   ├── .env
//!   ├── .env.dev
//!   ├── flows/
//!   │   └── main.flow.json
//!   └── nodes/
//!       └── custom.wasm

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

// ── Types ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSummary {
    pub name: String,
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowDetail {
    pub name: String,
    pub filename: String,
    pub nodes: Value,
    pub edges: Value,
    pub viewport: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variables: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvInfo {
    pub name: String,
    pub filename: String,
    pub vars: Vec<EnvVar>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

// ── Project TOML config ─────────────────────────────────────────────

#[derive(Debug, Deserialize, Serialize)]
struct ProjectConfig {
    name: String,
}

fn read_project_config(project_path: &Path) -> Result<ProjectConfig, String> {
    let toml_path = project_path.join("twistedflow.toml");
    let content = std::fs::read_to_string(&toml_path)
        .map_err(|e| format!("Cannot read twistedflow.toml: {}", e))?;
    // Simple TOML parsing — just extract name = "..."
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("name") {
            if let Some(val) = line.split('=').nth(1) {
                let name = val.trim().trim_matches('"').trim_matches('\'').to_string();
                return Ok(ProjectConfig { name });
            }
        }
    }
    // Fallback: use folder name
    let name = project_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled")
        .to_string();
    Ok(ProjectConfig { name })
}

// ── .env file parsing ───────────────────────────────────────────────

fn parse_dotenv(content: &str) -> Vec<EnvVar> {
    let mut vars = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim().to_string();
            let value = value.trim().trim_matches('"').trim_matches('\'').to_string();
            if !key.is_empty() {
                vars.push(EnvVar { key, value });
            }
        }
    }
    vars
}

fn serialize_dotenv(vars: &[EnvVar]) -> String {
    let mut out = String::new();
    for var in vars {
        out.push_str(&var.key);
        out.push('=');
        // Quote if contains spaces or special chars
        if var.value.contains(' ') || var.value.contains('#') || var.value.contains('=') {
            out.push('"');
            out.push_str(&var.value.replace('\\', "\\\\").replace('"', "\\\""));
            out.push('"');
        } else {
            out.push_str(&var.value);
        }
        out.push('\n');
    }
    out
}

fn env_name_from_filename(filename: &str) -> String {
    if filename == ".env" {
        "default".to_string()
    } else if let Some(suffix) = filename.strip_prefix(".env.") {
        suffix.to_string()
    } else {
        filename.to_string()
    }
}

fn env_filename_from_name(name: &str) -> String {
    if name == "default" {
        ".env".to_string()
    } else {
        format!(".env.{}", name)
    }
}

// ── Tauri Commands ──────────────────────────────────────────────────

/// Create a new project folder with scaffolding.
#[tauri::command]
pub fn create_project(parent_path: String, name: String) -> Result<ProjectInfo, String> {
    let project_dir = Path::new(&parent_path).join(&name);

    if project_dir.exists() {
        return Err(format!("Folder already exists: {}", project_dir.display()));
    }

    // Create structure
    std::fs::create_dir_all(project_dir.join("flows"))
        .map_err(|e| format!("Failed to create flows dir: {}", e))?;
    std::fs::create_dir_all(project_dir.join("nodes"))
        .map_err(|e| format!("Failed to create nodes dir: {}", e))?;

    // twistedflow.toml
    let toml = format!("name = \"{}\"\n", name);
    std::fs::write(project_dir.join("twistedflow.toml"), toml)
        .map_err(|e| format!("Failed to write twistedflow.toml: {}", e))?;

    // Default .env
    std::fs::write(project_dir.join(".env"), "# Default environment\n")
        .map_err(|e| format!("Failed to write .env: {}", e))?;

    // Seed main flow with Start node
    let main_flow = serde_json::json!({
        "twistedflow": 1,
        "name": "main",
        "nodes": [{
            "id": "start-1",
            "kind": "start",
            "position": { "x": 200, "y": 300 },
            "config": { "environmentId": null }
        }],
        "edges": [],
        "viewport": { "x": 0, "y": 0, "zoom": 1.0 }
    });
    let main_json = serde_json::to_string_pretty(&main_flow).unwrap();
    std::fs::write(project_dir.join("flows/main.flow.json"), main_json)
        .map_err(|e| format!("Failed to write main flow: {}", e))?;

    // .gitignore
    std::fs::write(
        project_dir.join(".gitignore"),
        "# Uncomment to exclude env secrets from git\n# .env*\n",
    )
    .map_err(|e| format!("Failed to write .gitignore: {}", e))?;

    Ok(ProjectInfo {
        path: project_dir.to_string_lossy().to_string(),
        name,
    })
}

/// Open an existing project folder.
#[tauri::command]
pub fn open_project(path: String) -> Result<ProjectInfo, String> {
    let expanded = expand_tilde(&path);
    let project_path = expanded.as_path();
    if !project_path.join("twistedflow.toml").exists() {
        return Err(format!(
            "Not a TwistedFlow project (missing twistedflow.toml in {})",
            project_path.display()
        ));
    }
    let config = read_project_config(project_path)?;
    let canonical = project_path.to_string_lossy().to_string();
    Ok(ProjectInfo {
        path: canonical,
        name: config.name,
    })
}

/// List all flows in a project.
#[tauri::command]
pub fn list_flows(project_path: String) -> Result<Vec<FlowSummary>, String> {
    let flows_dir = Path::new(&project_path).join("flows");
    if !flows_dir.exists() {
        return Ok(Vec::new());
    }

    let mut flows = Vec::new();
    let entries = std::fs::read_dir(&flows_dir)
        .map_err(|e| format!("Cannot read flows dir: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            let filename = path.file_name().unwrap().to_string_lossy().to_string();
            let name = filename
                .strip_suffix(".flow.json")
                .or_else(|| filename.strip_suffix(".json"))
                .unwrap_or(&filename)
                .to_string();
            flows.push(FlowSummary { name, filename });
        }
    }

    flows.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(flows)
}

/// Read a single flow file.
#[tauri::command]
pub fn get_flow(project_path: String, filename: String) -> Result<FlowDetail, String> {
    let flow_path = Path::new(&project_path).join("flows").join(&filename);
    let content = std::fs::read_to_string(&flow_path)
        .map_err(|e| format!("Cannot read flow {}: {}", filename, e))?;

    let parsed: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid flow JSON: {}", e))?;

    let name = parsed
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(FlowDetail {
        name,
        filename,
        nodes: parsed.get("nodes").cloned().unwrap_or(Value::Array(vec![])),
        edges: parsed.get("edges").cloned().unwrap_or(Value::Array(vec![])),
        viewport: parsed.get("viewport").cloned(),
        variables: parsed.get("variables").cloned(),
    })
}

/// Save a flow to disk.
#[tauri::command]
pub fn save_flow(
    project_path: String,
    filename: String,
    nodes: Value,
    edges: Value,
    viewport: Option<Value>,
    variables: Option<Value>,
) -> Result<(), String> {
    let flow_path = Path::new(&project_path).join("flows").join(&filename);

    // Read existing to preserve name and variables (if not explicitly passed)
    let existing = std::fs::read_to_string(&flow_path)
        .ok()
        .and_then(|c| serde_json::from_str::<Value>(&c).ok());

    let existing_name = existing
        .as_ref()
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| {
            filename
                .strip_suffix(".flow.json")
                .unwrap_or(&filename)
                .to_string()
        });

    // Use provided variables, or preserve existing from disk
    let vars = variables.or_else(|| {
        existing.as_ref().and_then(|v| v.get("variables").cloned())
    });

    let mut flow = serde_json::json!({
        "twistedflow": 1,
        "name": existing_name,
        "nodes": nodes,
        "edges": edges,
        "viewport": viewport.unwrap_or(serde_json::json!({ "x": 0, "y": 0, "zoom": 1.0 })),
    });

    if let Some(v) = vars {
        flow.as_object_mut().unwrap().insert("variables".into(), v);
    }

    let json = serde_json::to_string_pretty(&flow).unwrap();
    std::fs::write(&flow_path, json)
        .map_err(|e| format!("Failed to save flow: {}", e))?;

    Ok(())
}

/// Create a new flow file with a Start node.
#[tauri::command]
pub fn create_flow(project_path: String, name: String) -> Result<FlowSummary, String> {
    let filename = format!("{}.flow.json", sanitize_filename(&name));
    let flow_path = Path::new(&project_path).join("flows").join(&filename);

    if flow_path.exists() {
        return Err(format!("Flow already exists: {}", filename));
    }

    let flow = serde_json::json!({
        "twistedflow": 1,
        "name": name,
        "variables": [],
        "nodes": [{
            "id": "start-1",
            "kind": "start",
            "position": { "x": 200, "y": 300 },
            "config": { "environmentId": null }
        }],
        "edges": [],
        "viewport": { "x": 0, "y": 0, "zoom": 1.0 }
    });

    let json = serde_json::to_string_pretty(&flow).unwrap();
    std::fs::write(&flow_path, json)
        .map_err(|e| format!("Failed to create flow: {}", e))?;

    Ok(FlowSummary {
        name,
        filename,
    })
}

/// Delete a flow file.
#[tauri::command]
pub fn delete_flow(project_path: String, filename: String) -> Result<(), String> {
    let flow_path = Path::new(&project_path).join("flows").join(&filename);
    std::fs::remove_file(&flow_path)
        .map_err(|e| format!("Failed to delete flow: {}", e))?;
    Ok(())
}

/// Rename a flow file.
#[tauri::command]
pub fn rename_flow(
    project_path: String,
    old_filename: String,
    new_name: String,
) -> Result<FlowSummary, String> {
    let flows_dir = Path::new(&project_path).join("flows");
    let old_path = flows_dir.join(&old_filename);
    let new_filename = format!("{}.flow.json", sanitize_filename(&new_name));
    let new_path = flows_dir.join(&new_filename);

    if new_path.exists() && new_path != old_path {
        return Err(format!("Flow already exists: {}", new_filename));
    }

    // Update the name field inside the JSON
    let content = std::fs::read_to_string(&old_path)
        .map_err(|e| format!("Cannot read flow: {}", e))?;
    let mut parsed: Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON: {}", e))?;
    if let Value::Object(ref mut map) = parsed {
        map.insert("name".into(), Value::String(new_name.clone()));
    }
    let json = serde_json::to_string_pretty(&parsed).unwrap();
    std::fs::write(&new_path, json)
        .map_err(|e| format!("Failed to write: {}", e))?;

    // Remove old file if filename changed
    if old_path != new_path {
        std::fs::remove_file(&old_path).ok();
    }

    Ok(FlowSummary {
        name: new_name,
        filename: new_filename,
    })
}

/// List all environments (parsed from .env* files).
#[tauri::command]
pub fn list_environments(project_path: String) -> Result<Vec<EnvInfo>, String> {
    let project_dir = Path::new(&project_path);
    let mut envs = Vec::new();

    let entries = std::fs::read_dir(project_dir)
        .map_err(|e| format!("Cannot read project dir: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let filename = path.file_name().unwrap().to_string_lossy().to_string();

        // Match .env or .env.{name}
        if filename == ".env" || filename.starts_with(".env.") {
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            let vars = parse_dotenv(&content);
            let name = env_name_from_filename(&filename);
            envs.push(EnvInfo {
                name,
                filename,
                vars,
            });
        }
    }

    // Sort: "default" first, then alphabetical
    envs.sort_by(|a, b| {
        if a.name == "default" {
            std::cmp::Ordering::Less
        } else if b.name == "default" {
            std::cmp::Ordering::Greater
        } else {
            a.name.cmp(&b.name)
        }
    });

    Ok(envs)
}

/// Save environment variables back to the .env* file.
#[tauri::command]
pub fn save_environment(
    project_path: String,
    env_name: String,
    vars: Vec<EnvVar>,
) -> Result<(), String> {
    let filename = env_filename_from_name(&env_name);
    let env_path = Path::new(&project_path).join(&filename);
    let content = serialize_dotenv(&vars);
    std::fs::write(&env_path, content)
        .map_err(|e| format!("Failed to save environment: {}", e))?;
    Ok(())
}

/// Create a new environment file.
#[tauri::command]
pub fn create_environment(
    project_path: String,
    env_name: String,
) -> Result<EnvInfo, String> {
    let filename = env_filename_from_name(&env_name);
    let env_path = Path::new(&project_path).join(&filename);
    if env_path.exists() {
        return Err(format!("Environment already exists: {}", env_name));
    }
    std::fs::write(&env_path, format!("# {} environment\n", env_name))
        .map_err(|e| format!("Failed to create environment: {}", e))?;
    Ok(EnvInfo {
        name: env_name,
        filename,
        vars: Vec::new(),
    })
}

/// Delete an environment file.
#[tauri::command]
pub fn delete_environment(project_path: String, env_name: String) -> Result<(), String> {
    let filename = env_filename_from_name(&env_name);
    let env_path = Path::new(&project_path).join(&filename);
    std::fs::remove_file(&env_path)
        .map_err(|e| format!("Failed to delete environment: {}", e))?;
    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .to_lowercase()
}

fn expand_tilde(path: &str) -> std::path::PathBuf {
    if path.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return std::path::PathBuf::from(home).join(&path[2..]);
        }
    }
    std::path::PathBuf::from(path)
}
