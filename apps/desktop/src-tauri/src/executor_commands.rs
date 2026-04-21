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
use twistedflow_engine::{ExecContext, FlowGraph, GraphIndex, LogEntry, RunFlowOpts, StatusEvent};

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
    project_path: String,
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
    let on_log: Arc<dyn Fn(LogEntry) + Send + Sync> = Arc::new(move |entry: LogEntry| {
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

    let project_dir = std::path::Path::new(&project_path);
    let (registry, _load) =
        twistedflow_project::build_runtime_registry(Some(project_dir), &[], |msg| {
            eprintln!("{}", msg)
        });

    let opts = Arc::new(RunFlowOpts {
        index,
        context: exec_ctx,
        run_key: format!("desktop:{}:{}", project_path, flow_id),
        on_status,
        on_log,
        cancel: cancel.clone(),
        http_client,
        registry: std::sync::Arc::new(registry),
        processes: std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new())),
        depth: 0,
    });

    // Run the engine in a spawned task so panics are caught by tokio
    let handle = tokio::spawn(async move { twistedflow_engine::run_flow(opts).await });
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

/// Return metadata for all available node types (built-in + project WASM nodes + subflows).
/// `project_path` is optional — when provided, subflows from that project's
/// `flows/` directory are included (as `fn:<name>` types).
#[tauri::command]
pub fn list_node_types(project_path: Option<String>) -> serde_json::Value {
    let mut all = Vec::new();

    // Built-in nodes
    for meta in twistedflow_engine::all_node_metadata() {
        all.push(serde_json::to_value(meta).unwrap_or_default());
    }

    if let Some(p) = project_path {
        let project_dir = std::path::Path::new(&p);
        for meta in twistedflow_project::runtime_node_metadata(Some(project_dir), &[], |msg| {
            eprintln!("{}", msg)
        }) {
            all.push(serde_json::to_value(&meta).unwrap_or_default());
        }
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

    let _ = app.emit(
        "build:progress",
        serde_json::json!({
            "stage": "preparing",
            "message": "Preparing build...",
        }),
    );

    let _ = app.emit(
        "build:progress",
        serde_json::json!({
            "stage": "compiling",
            "message": format!("Compiling flow '{}' (this may take a moment)...", flow_name),
        }),
    );

    let project_path_for_build = project_path.clone();
    let output_path_for_build = output_path.clone();
    let flow_name_for_build = flow_name.clone();
    let env_name_for_build = env_name.clone();
    let build_result = tokio::task::spawn_blocking(move || {
        twistedflow_builder::build(
            std::path::Path::new(&project_path_for_build),
            &output_path_for_build,
            Some(&flow_name_for_build),
            &env_name_for_build,
            true,
        )
    })
    .await
    .map_err(|e| format!("Build task failed: {}", e))?;

    match build_result {
        Ok(result) => {
            let size_str = result.formatted_size();
            let output_path_str = result.output_path.display().to_string();
            let _ = app.emit(
                "build:progress",
                serde_json::json!({
                    "stage": "done",
                    "message": format!("Built successfully: {} ({})", output_path_str, size_str),
                }),
            );

            Ok(format!("{} ({})", output_path_str, size_str))
        }
        Err(err) => {
            let _ = app.emit(
                "build:progress",
                serde_json::json!({
                    "stage": "error",
                    "message": format!("Build failed: {}", err.trim()),
                }),
            );

            Err(format!("Build failed:\n{}", err.trim()))
        }
    }
}
