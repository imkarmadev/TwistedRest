//! Flow executor — walks the exec-edge DAG, resolves data pins lazily,
//! fires HTTP via an injected client, and streams status events.
//!
//! Direct port of the JS executor in packages/core/src/executor.ts.

use crate::graph::GraphIndex;
use crate::node::{
    ExecContext, LogEntry, Node, NodeCtx, NodeResult, Outputs, StatusEvent, TapLogs,
};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// Options for running a flow.
pub struct RunFlowOpts {
    pub index: Arc<GraphIndex>,
    pub context: ExecContext,
    pub on_status: Box<dyn Fn(&str, StatusEvent) + Send + Sync>,
    pub on_log: Arc<dyn Fn(LogEntry) + Send + Sync>,
    pub cancel: CancellationToken,
    pub http_client: reqwest::Client,
    /// Arc-wrapped so nested subflow runs can share it cheaply.
    pub registry: Arc<HashMap<String, Box<dyn Node>>>,
    /// Process tasks spawned by process nodes. Separate from bg_tasks —
    /// these run until cancelled, not until the chain completes.
    pub processes: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    /// Subflow recursion depth. Top-level flow = 0. Guard against runaway
    /// recursion via MAX_SUBFLOW_DEPTH in subflow.rs.
    pub depth: u32,
}

/// Run a flow end-to-end. Resolves when execution completes.
pub async fn run_flow(opts: Arc<RunFlowOpts>) -> Result<(), String> {
    let index = &opts.index;

    // Find Start node
    let start = index
        .nodes
        .values()
        .find(|n| n.node_type.as_deref() == Some("start"))
        .ok_or_else(|| "Flow has no Start node".to_string())?;

    let outputs: Arc<Mutex<Outputs>> = Arc::new(Mutex::new(HashMap::new()));
    let tap_logs: Arc<Mutex<TapLogs>> = Arc::new(Mutex::new(HashMap::new()));
    let bg_tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));

    // Pre-seed EnvVar nodes
    {
        let env_vars = opts.context.env_vars.clone().unwrap_or_default();
        let mut out = outputs.lock().await;
        for node in index.nodes.values() {
            if node.node_type.as_deref() != Some("envVar") {
                continue;
            }
            let var_key = node.data.get("varKey").and_then(|v| v.as_str());
            if let Some(key) = var_key {
                let val = env_vars.get(key).cloned().unwrap_or(Value::Null);
                out.entry(node.id.clone())
                    .or_default()
                    .insert("value".into(), val);
            }
        }
    }

    // Pre-seed flow variables with declared defaults
    {
        let var_decls = opts.context.variables.clone().unwrap_or_default();
        if !var_decls.is_empty() {
            let mut out = outputs.lock().await;
            let var_store = out.entry("__variables__".to_string()).or_default();
            for decl in &var_decls {
                if let Some(ref default_str) = decl.default {
                    if !default_str.is_empty() {
                        let val = match decl.var_type.as_str() {
                            "number" => default_str
                                .parse::<f64>()
                                .map(|n| serde_json::json!(n))
                                .unwrap_or(Value::String(default_str.clone())),
                            "boolean" => match default_str.as_str() {
                                "true" | "1" => Value::Bool(true),
                                _ => Value::Bool(false),
                            },
                            "object" | "array" => serde_json::from_str(default_str)
                                .unwrap_or(Value::String(default_str.clone())),
                            _ => Value::String(default_str.clone()),
                        };
                        var_store.entry(decl.name.clone()).or_insert(val);
                    }
                }
            }
        }
    }

    // Mark non-pure-data nodes as pending
    let start_id = start.id.clone();
    for node in index.nodes.values() {
        if node.id == start_id {
            continue;
        }
        match node.node_type.as_deref() {
            Some(
                "envVar" | "breakObject" | "convert" | "tap" | "parseArgs" | "regex" | "template"
                | "encodeDecode" | "hash" | "merge" | "getVariable",
            ) => continue,
            _ => {}
        }
        (opts.on_status)(&node.id, StatusEvent::pending());
    }
    (opts.on_status)(&start_id, StatusEvent::ok(None));

    // Walk from Start's exec-out
    if let Some(next) = index.next_exec(&start_id, "exec-out") {
        run_chain(
            next.to_owned(),
            opts.clone(),
            outputs.clone(),
            bg_tasks.clone(),
            tap_logs.clone(),
        )
        .await?;
    }

    // Await background tasks (event listeners, async custom nodes)
    let tasks = {
        let mut guard = bg_tasks.lock().await;
        std::mem::take(&mut *guard)
    };
    for task in tasks {
        let _ = task.await;
    }

    // Eager Tap resolution — force-resolve any Tap not yet captured
    for node in index.nodes.values() {
        if node.node_type.as_deref() != Some("tap") {
            continue;
        }
        let already = tap_logs.lock().await.contains_key(&node.id);
        if already {
            continue;
        }
        resolve_pin_value(&node.id, "out:value", &opts, &outputs, &tap_logs).await;
    }

    // If process nodes are running, wait for cancellation (Ctrl+C / Stop button).
    // The flow is "done" but processes keep serving until explicitly stopped.
    let has_processes = !opts.processes.lock().await.is_empty();
    if has_processes {
        opts.cancel.cancelled().await;
        // Give processes a moment to clean up
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        // Abort remaining process tasks
        let procs = std::mem::take(&mut *opts.processes.lock().await);
        for p in procs {
            p.abort();
        }
    }

    Ok(())
}

/// Walk a chain of exec-connected nodes.
pub fn run_chain(
    start_id: String,
    opts: Arc<RunFlowOpts>,
    outputs: Arc<Mutex<Outputs>>,
    bg_tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    tap_logs: Arc<Mutex<TapLogs>>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
    Box::pin(async move {
        let mut current_id: Option<String> = Some(start_id);

        while let Some(ref node_id) = current_id {
            // Check cancellation
            if opts.cancel.is_cancelled() {
                return Ok(());
            }

            let node = match opts.index.get_node(node_id) {
                Some(n) => n.clone(),
                None => return Ok(()),
            };

            let mut node_type = node.node_type.as_deref().unwrap_or("");

            // For plugin nodes, the React Flow type is "pluginNode" but the actual
            // plugin type_id is in data._pluginDef.typeId. Resolve it for registry dispatch.
            let plugin_type_id;
            if node_type == "pluginNode" {
                if let Some(type_id) = node
                    .data
                    .get("_pluginDef")
                    .and_then(|d| d.get("typeId"))
                    .and_then(|v| v.as_str())
                {
                    plugin_type_id = type_id.to_string();
                    node_type = &plugin_type_id;
                }
            }

            // Same translation for subflow call nodes: React Flow type is
            // "subflowCall" but the registered subflow type_id lives in
            // data._subflowDef.typeId (format: "fn:<name>").
            let subflow_type_id;
            if node_type == "subflowCall" {
                if let Some(type_id) = node
                    .data
                    .get("_subflowDef")
                    .and_then(|d| d.get("typeId"))
                    .and_then(|v| v.as_str())
                {
                    subflow_type_id = type_id.to_string();
                    node_type = &subflow_type_id;
                }
            }

            // Dispatch to registered node implementation
            if let Some(node_impl) = opts.registry.get(node_type) {
                let ctx = NodeCtx {
                    node_id,
                    node_data: &node.data,
                    opts: &opts,
                    outputs: &outputs,
                    tap_logs: &tap_logs,
                    bg_tasks: &bg_tasks,
                    index: &opts.index,
                };

                (opts.on_status)(node_id, StatusEvent::running());
                let result = node_impl.execute(ctx).await;

                match result {
                    NodeResult::Continue { output } => {
                        (opts.on_status)(node_id, StatusEvent::ok(output));
                    }
                    NodeResult::Branch { handle, output } => {
                        (opts.on_status)(node_id, StatusEvent::ok(output));
                        if let Some(next) = opts.index.next_exec(node_id, &handle) {
                            run_chain(
                                next.to_owned(),
                                opts.clone(),
                                outputs.clone(),
                                bg_tasks.clone(),
                                tap_logs.clone(),
                            )
                            .await?;
                        }
                        return Ok(());
                    }
                    NodeResult::Error {
                        message,
                        raw_response,
                    } => {
                        if let Some(raw) = raw_response {
                            (opts.on_status)(node_id, StatusEvent::schema_error(&message, raw));
                        } else {
                            (opts.on_status)(node_id, StatusEvent::error(&message));
                        }
                        return Err(message); // halt chain, propagate error for Try/Catch
                    }
                    NodeResult::Data(_) => {
                        // Pure data node — skip in exec chain
                    }
                    NodeResult::Process => {
                        // Process node spawned its background task and returned.
                        // Keep it marked as "running" (don't emit ok/error).
                        // Don't advance to exec-out — the chain stops here.
                        return Ok(());
                    }
                }
            } else {
                // Unknown node type — pass through
                (opts.on_status)(node_id, StatusEvent::ok(None));
            }

            // Advance to next exec-out
            current_id = opts
                .index
                .next_exec(node_id, "exec-out")
                .map(|s| s.to_owned());
        }

        Ok(())
    }) // end Box::pin(async move {
}

// ── Lazy pin value resolution ───────────────────────────────────────

/// Walk back through the data graph to find the actual value behind a pin.
/// Handles BreakObject, Convert, MakeObject, Tap chains recursively.
pub fn resolve_pin_value<'a>(
    source_id: &'a str,
    source_handle: &'a str,
    opts: &'a Arc<RunFlowOpts>,
    outputs: &'a Arc<Mutex<Outputs>>,
    tap_logs: &'a Arc<Mutex<TapLogs>>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + 'a>> {
    Box::pin(async move {
        let source_pin = source_handle.strip_prefix("out:").unwrap_or(source_handle);
        let source_node = opts.index.get_node(source_id)?;

        // Check cache first
        {
            let out = outputs.lock().await;
            if let Some(node_out) = out.get(source_id) {
                if let Some(val) = node_out.get(source_pin) {
                    return Some(val.clone());
                }
            }
        }

        let mut node_type = source_node.node_type.as_deref().unwrap_or("");

        // Resolve plugin type_id from data
        let plugin_type_id;
        if node_type == "pluginNode" {
            if let Some(type_id) = source_node
                .data
                .get("_pluginDef")
                .and_then(|d| d.get("typeId"))
                .and_then(|v| v.as_str())
            {
                plugin_type_id = type_id.to_string();
                node_type = &plugin_type_id;
            }
        }

        // Same for subflow call nodes
        let subflow_type_id;
        if node_type == "subflowCall" {
            if let Some(type_id) = source_node
                .data
                .get("_subflowDef")
                .and_then(|d| d.get("typeId"))
                .and_then(|v| v.as_str())
            {
                subflow_type_id = type_id.to_string();
                node_type = &subflow_type_id;
            }
        }

        // Dispatch to registered data node implementation
        if let Some(node_impl) = opts.registry.get(node_type) {
            // Create a fake bg_tasks for the context (data nodes don't spawn tasks)
            let bg_tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> =
                Arc::new(Mutex::new(Vec::new()));
            let ctx = NodeCtx {
                node_id: source_id,
                node_data: &source_node.data,
                opts,
                outputs,
                tap_logs,
                bg_tasks: &bg_tasks,
                index: &opts.index,
            };
            let result = node_impl.execute(ctx).await;
            match result {
                NodeResult::Data(value) => {
                    // For breakObject: the node returns the full object,
                    // we extract the specific field requested by source_pin.
                    if node_type == "breakObject" {
                        if let Some(Value::Object(map)) = &value {
                            return map.get(source_pin).cloned();
                        }
                        return None;
                    }
                    // If the node populated its outputs cache (most data nodes
                    // do via ctx.set_outputs), return the specific pin the caller
                    // asked for. Otherwise fall back to the raw NodeResult::Data
                    // value for legacy single-output data nodes.
                    {
                        let out = outputs.lock().await;
                        if let Some(node_out) = out.get(source_id) {
                            if let Some(val) = node_out.get(source_pin) {
                                return Some(val.clone());
                            }
                        }
                    }
                    value
                }
                NodeResult::Error { message, .. } => {
                    (opts.on_status)(source_id, StatusEvent::error(message));
                    None
                }
                _ => None,
            }
        } else {
            None
        }
    }) // end Box::pin(async move {
}

// All node implementations are now in twistedflow-nodes crate,
// dispatched via the registry. No inline node code remains here.
//
// To add a new node type:
// 1. Create a struct in twistedflow-nodes/src/
// 2. Apply #[node(...)] macro
// 3. Implement the Node trait
// The inventory crate auto-registers it.
