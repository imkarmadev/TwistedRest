//! Tauri commands for flow execution — bridges the Rust engine to the frontend.

use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;
use twistedflow_engine::{
    ExecContext, FlowGraph, GraphIndex, LogEntry, RunFlowOpts, StatusEvent,
};

/// Shared state for the active run. One run at a time.
pub struct ExecutorState {
    pub cancel: std::sync::Mutex<Option<CancellationToken>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEventPayload {
    node_id: String,
    #[serde(flatten)]
    event: StatusEvent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEntryPayload {
    node_id: String,
    label: String,
    value: serde_json::Value,
}

#[tauri::command]
pub async fn run_flow(
    app: AppHandle,
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

    // Set up cancellation
    let cancel = CancellationToken::new();
    {
        let mut guard = executor_state.cancel.lock().unwrap();
        // Cancel any previously running flow
        if let Some(old) = guard.take() {
            old.cancel();
        }
        *guard = Some(cancel.clone());
    }

    // Status emitter → Tauri events
    let app_for_status = app.clone();
    let on_status: Box<dyn Fn(&str, StatusEvent) + Send + Sync> =
        Box::new(move |node_id: &str, event: StatusEvent| {
            let payload = StatusEventPayload {
                node_id: node_id.to_owned(),
                event,
            };
            let _ = app_for_status.emit("flow:status", &payload);
        });

    // Log emitter → Tauri events
    let app_for_log = app.clone();
    let on_log: Box<dyn Fn(LogEntry) + Send + Sync> = Box::new(move |entry: LogEntry| {
        let payload = LogEntryPayload {
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

    // Run the engine
    let result = twistedflow_engine::run_flow(opts).await;

    // Clear cancel token
    {
        let mut guard = executor_state.cancel.lock().unwrap();
        *guard = None;
    }

    result
}

#[tauri::command]
pub fn stop_flow(executor_state: State<'_, ExecutorState>) -> Result<(), String> {
    let guard = executor_state.cancel.lock().unwrap();
    if let Some(token) = guard.as_ref() {
        token.cancel();
    }
    Ok(())
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
