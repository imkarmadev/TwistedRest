use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use twistedflow_engine::{build_registry, load_subflows, load_wasm_plugins, Node, NodeMetadata};

#[derive(Debug, Clone, Copy, Default)]
pub struct ProjectRuntimeLoad {
    pub wasm_count: usize,
    pub subflow_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomNodeSummary {
    pub type_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomNodeAsset {
    pub id: String,
    pub name: String,
    pub wasm_path: Option<String>,
    pub source_path: Option<String>,
    pub status: String,
    pub can_use: bool,
    pub can_build: bool,
    pub can_open_source: bool,
    pub nodes: Vec<CustomNodeSummary>,
    pub error: Option<String>,
}

pub fn build_runtime_registry<F>(
    project_dir: Option<&Path>,
    extra_plugin_dirs: &[String],
    on_log: F,
) -> (HashMap<String, Box<dyn Node>>, ProjectRuntimeLoad)
where
    F: Fn(&str),
{
    let mut registry = build_registry();
    let load =
        extend_registry_with_runtime_assets(&mut registry, project_dir, extra_plugin_dirs, on_log);
    (registry, load)
}

pub fn extend_registry_with_runtime_assets<F>(
    registry: &mut HashMap<String, Box<dyn Node>>,
    project_dir: Option<&Path>,
    extra_plugin_dirs: &[String],
    on_log: F,
) -> ProjectRuntimeLoad
where
    F: Fn(&str),
{
    let plugin_dir_strings = runtime_plugin_dirs(project_dir, extra_plugin_dirs);
    let plugin_dirs: Vec<&str> = plugin_dir_strings.iter().map(|s| s.as_str()).collect();
    let wasm_nodes = load_wasm_plugins(&plugin_dirs);
    let wasm_count = wasm_nodes.len();
    for (type_id, node, _meta) in wasm_nodes {
        registry.insert(type_id.to_string(), node);
    }

    let mut subflow_count = 0;
    if let Some(project_dir) = project_dir {
        let subflow_nodes = load_subflows(project_dir, |msg| on_log(msg));
        subflow_count = subflow_nodes.len();
        for (type_id, node, _meta) in subflow_nodes {
            registry.insert(type_id, node);
        }
    }

    ProjectRuntimeLoad {
        wasm_count,
        subflow_count,
    }
}

pub fn runtime_node_metadata<F>(
    project_dir: Option<&Path>,
    extra_plugin_dirs: &[String],
    on_log: F,
) -> Vec<NodeMetadata>
where
    F: Fn(&str),
{
    let mut all = Vec::new();

    let plugin_dir_strings = runtime_plugin_dirs(project_dir, extra_plugin_dirs);
    let plugin_dirs: Vec<&str> = plugin_dir_strings.iter().map(|s| s.as_str()).collect();
    for (_type_id, _node, meta) in load_wasm_plugins(&plugin_dirs) {
        all.push(meta);
    }

    if let Some(project_dir) = project_dir {
        for (_type_id, _node, meta) in load_subflows(project_dir, |msg| on_log(msg)) {
            all.push(meta);
        }
    }

    all
}

pub fn list_custom_node_assets(project_dir: &Path) -> Result<Vec<CustomNodeAsset>, String> {
    ensure_project_dirs(project_dir)?;

    let mut assets: BTreeMap<String, CustomNodeAsset> = BTreeMap::new();
    let nodes_dir = project_dir.join("nodes");
    let sources_dir = project_dir.join("nodes-src");

    if let Ok(entries) = std::fs::read_dir(&nodes_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("wasm") {
                continue;
            }

            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("custom-node")
                .to_string();
            let wasm_path = path.to_string_lossy().to_string();

            let (status, can_use, nodes, error) = match twistedflow_engine::validate_wasm(&path) {
                Ok(nodes) => {
                    let nodes = nodes
                        .into_iter()
                        .map(|(type_id, name)| CustomNodeSummary { type_id, name })
                        .collect::<Vec<_>>();
                    ("loaded".to_string(), true, nodes, None)
                }
                Err(e) => ("invalid".to_string(), false, Vec::new(), Some(e)),
            };

            let name = nodes
                .first()
                .map(|n| n.name.clone())
                .unwrap_or_else(|| id.clone());

            assets.insert(
                id.clone(),
                CustomNodeAsset {
                    id,
                    name,
                    wasm_path: Some(wasm_path),
                    source_path: None,
                    status,
                    can_use,
                    can_build: false,
                    can_open_source: false,
                    nodes,
                    error,
                },
            );
        }
    }

    if let Ok(entries) = std::fs::read_dir(&sources_dir) {
        for entry in entries.flatten() {
            let source_path = entry.path();
            let cargo_toml = source_path.join("Cargo.toml");
            if !cargo_toml.exists() {
                continue;
            }

            let toml = std::fs::read_to_string(&cargo_toml).unwrap_or_default();
            if !toml.contains("twistedflow-plugin") {
                continue;
            }

            let source_name = source_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("custom-node")
                .to_string();
            let crate_name = parse_crate_name(&toml).unwrap_or_else(|| source_name.clone());
            let artifact_id = crate_name.replace('-', "_");
            let source_path_str = source_path.to_string_lossy().to_string();

            match assets.get_mut(&artifact_id) {
                Some(asset) => {
                    asset.source_path = Some(source_path_str);
                    asset.can_build = true;
                    asset.can_open_source = true;
                }
                None => {
                    assets.insert(
                        artifact_id.clone(),
                        CustomNodeAsset {
                            id: artifact_id,
                            name: source_name,
                            wasm_path: None,
                            source_path: Some(source_path_str),
                            status: "draft".to_string(),
                            can_use: false,
                            can_build: true,
                            can_open_source: true,
                            nodes: Vec::new(),
                            error: None,
                        },
                    );
                }
            }
        }
    }

    Ok(assets.into_values().collect())
}

pub fn ensure_project_dirs(project_path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(project_path.join("flows"))
        .map_err(|e| format!("Failed to create flows dir: {}", e))?;
    std::fs::create_dir_all(project_path.join("nodes"))
        .map_err(|e| format!("Failed to create nodes dir: {}", e))?;
    std::fs::create_dir_all(project_path.join("nodes-src"))
        .map_err(|e| format!("Failed to create nodes-src dir: {}", e))?;
    Ok(())
}

pub fn parse_crate_name(toml: &str) -> Option<String> {
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

pub fn validate_project_dir(path: &Path) -> Result<PathBuf, String> {
    if path.join("twistedflow.toml").exists() {
        Ok(path.to_path_buf())
    } else {
        Err(format!(
            "Not a TwistedFlow project (missing twistedflow.toml in {})",
            path.display()
        ))
    }
}

pub fn find_project_root(start: &Path) -> Option<PathBuf> {
    for dir in start.ancestors() {
        if dir.join("twistedflow.toml").exists() {
            return Some(dir.to_path_buf());
        }
    }
    None
}

pub fn expand_tilde(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if raw.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(&raw[2..]);
        }
    }
    path.to_path_buf()
}

fn runtime_plugin_dirs(project_dir: Option<&Path>, extra_plugin_dirs: &[String]) -> Vec<String> {
    let mut dirs = Vec::new();
    if let Some(project_dir) = project_dir {
        dirs.push(project_dir.join("nodes").to_string_lossy().to_string());
    }
    for dir in extra_plugin_dirs {
        if !dir.is_empty() {
            dirs.push(dir.clone());
        }
    }
    dirs
}
