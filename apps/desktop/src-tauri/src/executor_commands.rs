//! Tauri commands for flow execution — bridges the Rust engine to the frontend.
//!
//! Supports running multiple flows in parallel. Each flow is identified by
//! `flow_id` (the flow filename). Starting the same flow again cancels the
//! previous run of that flow only.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;
use twistedflow_engine::{
    ExecContext, FlowGraph, GraphIndex, LogEntry, RunFlowOpts, StatusEvent,
};

/// Shared state for active runs. Supports multiple concurrent flows.
pub struct ExecutorState {
    pub tokens: std::sync::Mutex<HashMap<String, CancellationToken>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEventPayload {
    flow_id: String,
    node_id: String,
    #[serde(flatten)]
    event: StatusEvent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEntryPayload {
    flow_id: String,
    node_id: String,
    label: String,
    value: serde_json::Value,
}

#[tauri::command]
pub async fn run_flow(
    app: AppHandle,
    flow_id: String,
    nodes: serde_json::Value,
    edges: serde_json::Value,
    context: serde_json::Value,
    executor_state: State<'_, ExecutorState>,
) -> Result<(), String> {
    // Deserialize graph
    let graph_nodes = serde_json::from_value(nodes).map_err(|e| format!("Invalid nodes: {}", e))?;
    let graph_edges = serde_json::from_value(edges).map_err(|e| format!("Invalid edges: {}", e))?;
    let exec_ctx: ExecContext =
        serde_json::from_value(context).map_err(|e| format!("Invalid context: {}", e))?;

    let graph = FlowGraph {
        nodes: graph_nodes,
        edges: graph_edges,
    };
    let index = Arc::new(GraphIndex::build(&graph));

    // Set up cancellation — only cancel the same flow if already running
    let cancel = CancellationToken::new();
    {
        let mut guard = executor_state.tokens.lock().unwrap();
        if let Some(old) = guard.remove(&flow_id) {
            old.cancel();
        }
        guard.insert(flow_id.clone(), cancel.clone());
    }

    // Notify frontend that this flow started
    let _ = app.emit("flow:started", serde_json::json!({ "flowId": &flow_id }));

    // Status emitter → Tauri events (scoped by flow_id)
    let app_for_status = app.clone();
    let fid_status = flow_id.clone();
    let on_status: Box<dyn Fn(&str, StatusEvent) + Send + Sync> =
        Box::new(move |node_id: &str, event: StatusEvent| {
            let payload = StatusEventPayload {
                flow_id: fid_status.clone(),
                node_id: node_id.to_owned(),
                event,
            };
            let _ = app_for_status.emit("flow:status", &payload);
        });

    // Log emitter → Tauri events (scoped by flow_id)
    let app_for_log = app.clone();
    let fid_log = flow_id.clone();
    let on_log: Box<dyn Fn(LogEntry) + Send + Sync> = Box::new(move |entry: LogEntry| {
        let payload = LogEntryPayload {
            flow_id: fid_log.clone(),
            node_id: entry.node_id,
            label: entry.label,
            value: entry.value,
        };
        let _ = app_for_log.emit("flow:log", &payload);
    });

    // Build reqwest client
    let http_client = reqwest::Client::builder()
        .user_agent("TwistedFlow/0.3")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    // Build the node registry: built-in nodes (via inventory) + WASM plugins.
    let mut registry = twistedflow_engine::build_registry();

    // Load WASM plugins from default + project-specific directories
    let plugin_dirs = vec![twistedflow_engine::DEFAULT_PLUGINS_DIR];
    let wasm_nodes = twistedflow_engine::load_wasm_plugins(&plugin_dirs);
    for (type_id, node, _meta) in wasm_nodes {
        registry.insert(type_id, node);
    }

    let opts = Arc::new(RunFlowOpts {
        index,
        context: exec_ctx,
        on_status,
        on_log,
        cancel: cancel.clone(),
        http_client,
        registry,
        processes: std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new())),
    });

    // Run the engine in a spawned task so panics are caught by tokio
    let handle = tokio::spawn(async move {
        twistedflow_engine::run_flow(opts).await
    });
    let result = handle.await;

    // Always clean up: remove token and notify frontend (even on panic)
    {
        let mut guard = executor_state.tokens.lock().unwrap();
        guard.remove(&flow_id);
    }
    let _ = app.emit("flow:finished", serde_json::json!({ "flowId": &flow_id }));

    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(format!("Flow execution panicked: {}", e)),
    }
}

#[tauri::command]
pub fn stop_flow(flow_id: String, executor_state: State<'_, ExecutorState>) -> Result<(), String> {
    let mut guard = executor_state.tokens.lock().unwrap();
    if let Some(token) = guard.remove(&flow_id) {
        token.cancel();
    }
    Ok(())
}

/// Returns the list of currently running flow IDs.
#[tauri::command]
pub fn running_flows(executor_state: State<'_, ExecutorState>) -> Vec<String> {
    let guard = executor_state.tokens.lock().unwrap();
    guard.keys().cloned().collect()
}

/// Return metadata for all available node types (built-in + WASM plugins).
#[tauri::command]
pub fn list_node_types() -> serde_json::Value {
    let mut all = Vec::new();

    // Built-in nodes
    for meta in twistedflow_engine::all_node_metadata() {
        all.push(serde_json::to_value(meta).unwrap_or_default());
    }

    // WASM plugins
    let plugin_dirs = vec![twistedflow_engine::DEFAULT_PLUGINS_DIR];
    let wasm_nodes = twistedflow_engine::load_wasm_plugins(&plugin_dirs);
    for (_type_id, _node, meta) in wasm_nodes {
        all.push(serde_json::to_value(&meta).unwrap_or_default());
    }

    serde_json::Value::Array(all)
}

/// Build a flow into a standalone binary.
/// Streams progress via "build:progress" events.
#[tauri::command]
pub async fn build_flow(
    app: AppHandle,
    project_path: String,
    flow_filename: String,
    env_name: String,
    output_path: String,
) -> Result<String, String> {
    // Resolve the flow name from filename (strip .flow.json)
    let flow_name = flow_filename
        .strip_suffix(".flow.json")
        .or_else(|| flow_filename.strip_suffix(".json"))
        .unwrap_or(&flow_filename)
        .to_string();

    let _ = app.emit("build:progress", serde_json::json!({
        "stage": "preparing",
        "message": "Preparing build...",
    }));

    // Find the twistedflow-cli binary — it's in the same target dir as this binary
    let cli_path = find_cli_binary().ok_or("Cannot find twistedflow-cli binary. Build it with: cargo build -p twistedflow-cli")?;

    let _ = app.emit("build:progress", serde_json::json!({
        "stage": "compiling",
        "message": format!("Compiling flow '{}' (this may take a moment)...", flow_name),
    }));

    // Run the CLI build command as a subprocess
    let output = tokio::process::Command::new(&cli_path)
        .arg("build")
        .arg(&project_path)
        .arg("-o")
        .arg(&output_path)
        .arg("--flow")
        .arg(&flow_name)
        .arg("--env")
        .arg(&env_name)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("Failed to start build: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        // Get file size
        let size = std::fs::metadata(&output_path)
            .map(|m| m.len())
            .unwrap_or(0);
        let size_str = if size >= 1_048_576 {
            format!("{:.1}MB", size as f64 / 1_048_576.0)
        } else {
            format!("{:.0}KB", size as f64 / 1024.0)
        };

        let _ = app.emit("build:progress", serde_json::json!({
            "stage": "done",
            "message": format!("Built successfully: {} ({})", output_path, size_str),
        }));

        Ok(format!("{} ({})", output_path, size_str))
    } else {
        let _ = app.emit("build:progress", serde_json::json!({
            "stage": "error",
            "message": format!("Build failed: {}", stderr.trim()),
        }));

        Err(format!("Build failed:\n{}", stderr.trim()))
    }
}

/// Find the twistedflow-cli binary relative to the current executable.
fn find_cli_binary() -> Option<String> {
    let current_exe = std::env::current_exe().ok()?;
    let dir = current_exe.parent()?;

    // Check same directory (debug/release builds)
    let cli = dir.join("twistedflow-cli");
    if cli.exists() {
        return Some(cli.to_string_lossy().to_string());
    }

    // Check ../target/debug
    let debug = dir.join("../target/debug/twistedflow-cli");
    if debug.exists() {
        return Some(debug.to_string_lossy().to_string());
    }

    None
}
