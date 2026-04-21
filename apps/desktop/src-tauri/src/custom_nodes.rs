//! Tauri commands for project-local custom node sources and builds.
//!
//! The desktop app owns plugin authoring directly. The CLI remains useful for
//! CI/CD and headless workflows, but the in-app Custom Nodes panel should not
//! depend on CLI argument compatibility at runtime.

use std::path::{Path, PathBuf};

/// Scaffold a new source plugin under `{project}/nodes-src/<name>/`.
#[tauri::command]
pub async fn create_custom_node_source(
    project_path: String,
    name: String,
) -> Result<String, String> {
    let project_dir = twistedflow_project::validate_project_dir(Path::new(&project_path))?;
    let nodes_src_dir = project_dir.join("nodes-src");
    std::fs::create_dir_all(&nodes_src_dir)
        .map_err(|e| format!("Failed to create nodes-src dir: {}", e))?;

    let folder_name = twistedflow_plugin_dev::sanitize_name(&name);
    if folder_name.is_empty() {
        return Err("Custom node name must contain at least one letter or number.".into());
    }

    let result =
        twistedflow_plugin_dev::scaffold_plugin(twistedflow_plugin_dev::ScaffoldPluginOptions {
            target_dir: nodes_src_dir.join(&folder_name),
            plugin_name: name.clone(),
            category: "Custom".to_string(),
            description: format!("Project-local custom node '{}'.", name),
            requested_nodes: vec![name],
            force: false,
            readme_kind: twistedflow_plugin_dev::ReadmeKind::DesktopProjectLocal,
        })?;

    Ok(result.source_dir.to_string_lossy().to_string())
}

/// Open an existing custom node source folder in the user's editor/file
/// association.
#[tauri::command]
pub fn open_custom_node_source(source_path: String) -> Result<(), String> {
    let path = PathBuf::from(&source_path);
    if !path.exists() {
        return Err(format!("Source path does not exist: {}", path.display()));
    }
    open::that(&path).map_err(|e| format!("Failed to open {}: {}", path.display(), e))
}

/// Build a project-local custom node directly from source and install the
/// validated `.wasm` into `{project}/nodes/`.
#[tauri::command]
pub async fn build_custom_node(
    project_path: String,
    source_path: String,
) -> Result<String, String> {
    let project_dir = twistedflow_project::validate_project_dir(Path::new(&project_path))?;
    let source_dir = PathBuf::from(&source_path);
    let install_dir = project_dir.join("nodes");

    let result = tokio::task::spawn_blocking(move || {
        twistedflow_plugin_dev::build_plugin(twistedflow_plugin_dev::BuildPluginOptions {
            source_dir,
            install_dir: Some(install_dir.clone()),
            debug: false,
        })
    })
    .await
    .map_err(|e| format!("Plugin build task failed: {}", e))??;

    let install_dir = result
        .installed_path
        .as_ref()
        .and_then(|path| path.parent().map(|dir| dir.to_path_buf()))
        .unwrap_or_else(|| project_dir.join("nodes"));
    let node_summary = result
        .nodes
        .iter()
        .map(|node| format!("{} ({})", node.name, node.type_id))
        .collect::<Vec<_>>()
        .join(", ");

    Ok(format!(
        "Built {} and installed {} node(s) to {}{}",
        result
            .installed_path
            .as_ref()
            .unwrap_or(&result.wasm_path)
            .display(),
        result.nodes.len(),
        install_dir.display(),
        if node_summary.is_empty() {
            String::new()
        } else {
            format!(": {}", node_summary)
        }
    ))
}
