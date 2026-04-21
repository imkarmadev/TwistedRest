//! Subflow loader + `SubflowNode` adapter.
//!
//! A subflow is a `.flow.json` file in `{project}/flows/` with top-level
//! field `"kind": "subflow"`. The file declares an `interface` (input and
//! output pins); at project load time, each subflow is wrapped in a
//! `SubflowNode` and merged into the registry under the type_id
//! `"fn:<name>"`. Callers see subflows as regular palette nodes.
//!
//! Execution is recursive: when a `SubflowNode` fires, it spins up a
//! nested `run_flow` call with its own outputs cache and variable scope,
//! walks the chain, reads the `subflowOutputs` node's return slot, and
//! propagates the branch + data values back to the caller.

use crate::executor::{run_chain, RunFlowOpts};
use crate::flow_file::{FlowFile, FlowKind, Interface};
use crate::graph::GraphIndex;
use crate::node::{
    LogEntry, Node, NodeCtx, NodeMetadata, NodeResult, Outputs, PinDef, StatusEvent, TapLogs,
};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Max nested subflow depth. Guards against accidental infinite recursion.
pub const MAX_SUBFLOW_DEPTH: u32 = 64;

/// Scan a project's `flows/` directory, parse each `kind: "subflow"` file,
/// and return the adapters keyed by type_id (`"fn:<name>"`).
///
/// Subflows involved in a call cycle are dropped with a warning — runtime
/// still has a depth guard (MAX_SUBFLOW_DEPTH) as belt-and-suspenders.
///
/// Errors in individual files are logged via `on_warn` but do not abort
/// the load — a project with one broken subflow still opens.
pub fn load_subflows<F: Fn(&str)>(
    project_path: &Path,
    on_warn: F,
) -> Vec<(String, Box<dyn Node>, NodeMetadata)> {
    let flows_dir = project_path.join("flows");
    let mut parsed: Vec<FlowFile> = Vec::new();

    let entries = match std::fs::read_dir(&flows_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                on_warn(&format!(
                    "[subflow] failed to read {}: {}",
                    path.display(),
                    e
                ));
                continue;
            }
        };

        let flow = match FlowFile::parse(&content) {
            Ok(f) => f,
            Err(e) => {
                on_warn(&format!("[subflow] invalid {}: {}", path.display(), e));
                continue;
            }
        };

        if flow.kind != FlowKind::Subflow {
            continue;
        }

        if flow.name.is_empty() {
            on_warn(&format!(
                "[subflow] skipping {} — missing name",
                path.display()
            ));
            continue;
        }

        parsed.push(flow);
    }

    // Cycle detection: build call graph (fn:X → set of fn:Y it calls).
    let mut call_graph: HashMap<String, Vec<String>> = HashMap::new();
    for flow in &parsed {
        let self_tid = format!("fn:{}", flow.name);
        let mut callees = Vec::new();
        for node in &flow.nodes {
            if node.kind.starts_with("fn:") {
                callees.push(node.kind.clone());
            }
        }
        call_graph.insert(self_tid, callees);
    }

    let cyclic = detect_cyclic_subflows(&call_graph);
    if !cyclic.is_empty() {
        on_warn(&format!(
            "[subflow] dropping {} subflow(s) in a call cycle: {:?}",
            cyclic.len(),
            cyclic
        ));
    }

    let mut out = Vec::new();
    for flow in parsed {
        let type_id = format!("fn:{}", flow.name);
        if cyclic.contains(&type_id) {
            continue;
        }
        let interface = flow.interface.clone().unwrap_or_default();
        let meta = metadata_from(&flow.name, &flow.category, &interface, &type_id);
        let node: Box<dyn Node> = Box::new(SubflowNode {
            flow: Arc::new(flow),
            interface,
        });
        out.push((type_id, node, meta));
    }

    out
}

/// DFS cycle detection. Returns the set of subflow type_ids involved in
/// any cycle (including self-loops).
fn detect_cyclic_subflows(
    graph: &HashMap<String, Vec<String>>,
) -> std::collections::HashSet<String> {
    use std::collections::HashSet;
    enum Color {
        Gray,
        Black,
    }
    let mut color: HashMap<&str, Color> = HashMap::new();
    let mut cyclic: HashSet<String> = HashSet::new();

    fn visit<'a>(
        node: &'a str,
        graph: &'a HashMap<String, Vec<String>>,
        color: &mut HashMap<&'a str, Color>,
        stack: &mut Vec<&'a str>,
        cyclic: &mut HashSet<String>,
    ) {
        if let Some(Color::Black) = color.get(node) {
            return;
        }
        if let Some(Color::Gray) = color.get(node) {
            // Back-edge — mark every node on the current stack as cyclic.
            if let Some(pos) = stack.iter().position(|&n| n == node) {
                for n in &stack[pos..] {
                    cyclic.insert(n.to_string());
                }
                cyclic.insert(node.to_string());
            }
            return;
        }
        color.insert(node, Color::Gray);
        stack.push(node);
        if let Some(callees) = graph.get(node) {
            for callee in callees {
                visit(callee, graph, color, stack, cyclic);
            }
        }
        stack.pop();
        color.insert(node, Color::Black);
    }

    for node in graph.keys() {
        let mut stack: Vec<&str> = Vec::new();
        visit(node, graph, &mut color, &mut stack, &mut cyclic);
    }

    cyclic
}

/// Build NodeMetadata from a subflow's interface so the frontend palette
/// can render it. `type_id` is embedded so frontend can look it up later.
fn metadata_from(
    name: &str,
    category: &Option<String>,
    iface: &Interface,
    type_id: &str,
) -> NodeMetadata {
    let inputs = iface
        .inputs
        .iter()
        .map(|p| PinDef {
            key: p.key.clone(),
            data_type: p.pin_type.clone(),
        })
        .collect();
    let outputs = iface
        .outputs
        .iter()
        .map(|p| PinDef {
            key: p.key.clone(),
            data_type: p.pin_type.clone(),
        })
        .collect();

    NodeMetadata {
        name: name.to_string(),
        type_id: type_id.to_string(),
        category: category.clone().unwrap_or_else(|| "Project".into()),
        description: format!("Subflow: {}", name),
        inputs,
        outputs,
    }
}

/// A loaded subflow ready to be called from another flow.
pub struct SubflowNode {
    pub flow: Arc<FlowFile>,
    pub interface: Interface,
}

impl Node for SubflowNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let inputs = ctx.resolve_all_inputs().await;
            match call_subflow(&self.flow, &self.interface, inputs, ctx.opts.clone()).await {
                Ok(ret) => {
                    ctx.set_outputs(ret.data.clone()).await;

                    // Route the caller's matching exec-out branch. The subflow
                    // interface can declare 0..N exec outputs; whichever the
                    // inner Outputs node's `branch` config named, we fire on
                    // the caller. Handle id mirrors SubflowCallNode render:
                    // single exec → "exec-out"; multiple → "out:<branch>".
                    let exec_outputs: Vec<&str> = self
                        .interface
                        .outputs
                        .iter()
                        .filter(|p| p.pin_type == "exec")
                        .map(|p| p.key.as_str())
                        .collect();

                    if !ret.branch.is_empty() && exec_outputs.contains(&ret.branch.as_str()) {
                        let handle = if exec_outputs.len() > 1 {
                            format!("out:{}", ret.branch)
                        } else {
                            "exec-out".to_string()
                        };
                        return NodeResult::Branch {
                            handle,
                            output: Some(serde_json::to_value(&ret.data).unwrap_or(Value::Null)),
                        };
                    }

                    // Fallback: single exec-out (0-exec-output subflows or
                    // unconfigured Outputs nodes just flow through).
                    NodeResult::Continue {
                        output: Some(serde_json::to_value(&ret.data).unwrap_or(Value::Null)),
                    }
                }
                Err(e) => NodeResult::Error {
                    message: e,
                    raw_response: None,
                },
            }
        })
    }
}

/// Result of running a subflow — data values returned + which branch was
/// picked by the Outputs node that fired.
pub struct SubflowReturn {
    pub branch: String,
    pub data: HashMap<String, Value>,
}

/// Execute a subflow recursively.
///
/// Isolated scope: the nested run gets its own `outputs` cache, so variable
/// state (`__variables__`) doesn't leak back to the parent. Input values
/// are seeded onto the subflow's `subflowInputs` node; after the chain
/// completes, the `subflowOutputs` node's cached outputs carry the return.
pub async fn call_subflow(
    flow: &FlowFile,
    interface: &Interface,
    inputs: HashMap<String, Value>,
    parent_opts: Arc<RunFlowOpts>,
) -> Result<SubflowReturn, String> {
    // Depth guard
    let next_depth = parent_opts.depth + 1;
    if next_depth > MAX_SUBFLOW_DEPTH {
        return Err(format!(
            "subflow depth limit exceeded (> {})",
            MAX_SUBFLOW_DEPTH
        ));
    }

    // Build the nested graph.
    let graph = flow.to_graph();
    let index = Arc::new(GraphIndex::build(&graph));

    // Find the Inputs node — entry point of the subflow.
    let inputs_node = index
        .nodes
        .values()
        .find(|n| n.node_type.as_deref() == Some("subflowInputs"))
        .ok_or_else(|| "Subflow missing `subflowInputs` node".to_string())?;
    let inputs_id = inputs_node.id.clone();

    // Fresh outputs cache (isolated scope).
    let outputs: Arc<Mutex<Outputs>> = Arc::new(Mutex::new(HashMap::new()));
    let tap_logs: Arc<Mutex<TapLogs>> = Arc::new(Mutex::new(HashMap::new()));
    let bg_tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>> = Arc::new(Mutex::new(Vec::new()));

    // Seed the Inputs node's outputs with the caller's input values.
    {
        let mut out = outputs.lock().await;
        out.insert(inputs_id.clone(), inputs);
    }

    // Pre-seed subflow-local variable defaults into the nested __variables__
    // store. This mirrors run_flow's pre-seed but scoped to the subflow's
    // own variables — the parent's __variables__ is NOT visible here.
    if let Some(var_decls) = &flow.variables {
        if !var_decls.is_empty() {
            let mut out = outputs.lock().await;
            let var_store = out.entry("__variables__".to_string()).or_default();
            for decl in var_decls {
                if let Some(default_str) = &decl.default {
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

    // Build nested context — share only what's truly ambient (env vars,
    // http base/headers, auth). Variables are scoped to the subflow's own
    // declarations so Set/Get Variable nodes inside can't leak state.
    let nested_context = crate::node::ExecContext {
        project_base_url: parent_opts.context.project_base_url.clone(),
        env_base_url: parent_opts.context.env_base_url.clone(),
        project_headers: parent_opts.context.project_headers.clone(),
        env_headers: parent_opts.context.env_headers.clone(),
        env_vars: parent_opts.context.env_vars.clone(),
        auth: parent_opts.context.auth.clone(),
        variables: flow.variables.clone(),
    };

    // Run the subflow with its own graph index, outputs cache, tap logs,
    // background task list, context, and recursion depth while sharing the
    // parent's immutable registry, HTTP client, cancellation token, process
    // list, and event callbacks.

    run_subchain_with_index(
        inputs_id.clone(),
        parent_opts.clone(),
        index.clone(),
        outputs.clone(),
        bg_tasks.clone(),
        tap_logs.clone(),
        nested_context,
        next_depth,
    )
    .await?;

    // After the chain finishes, collect the first-reached Outputs node's
    // cached values + its branch marker. Multiple Outputs nodes may live
    // on the canvas (one per return branch) — only the first one whose
    // cache was populated this run counts.
    let _ = interface;
    let mut branch = String::new();
    let mut data: HashMap<String, Value> = HashMap::new();
    {
        let out = outputs.lock().await;
        let outputs_nodes: Vec<String> = index
            .nodes
            .values()
            .filter(|n| n.node_type.as_deref() == Some("subflowOutputs"))
            .map(|n| n.id.clone())
            .collect();

        for id in &outputs_nodes {
            if let Some(node_out) = out.get(id) {
                if let Some(br) = node_out.get("__branch__").and_then(|v| v.as_str()) {
                    branch = br.to_string();
                }
                for (k, v) in node_out {
                    if k == "__branch__" {
                        continue;
                    }
                    data.insert(k.clone(), v.clone());
                }
                break;
            }
        }
    }

    Ok(SubflowReturn { branch, data })
}

/// Helper: run a chain using the parent's registry but a fresh index +
/// context. Implemented as a thin wrapper around `run_chain` by
/// substituting fields on a nested `RunFlowOpts` built to share parent's
/// registry + http_client + cancel.
async fn run_subchain_with_index(
    start_id: String,
    parent: Arc<RunFlowOpts>,
    index: Arc<GraphIndex>,
    outputs: Arc<Mutex<Outputs>>,
    bg_tasks: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    tap_logs: Arc<Mutex<TapLogs>>,
    context: crate::node::ExecContext,
    depth: u32,
) -> Result<(), String> {
    let nested_opts = Arc::new(RunFlowOpts {
        index: index.clone(),
        context,
        run_key: parent.run_key.clone(),
        on_status: {
            let parent = parent.clone();
            Box::new(move |node_id: &str, event: StatusEvent| {
                (parent.on_status)(node_id, event);
            })
        },
        on_log: {
            let parent_log = parent.on_log.clone();
            Arc::new(move |entry: LogEntry| {
                (parent_log)(LogEntry {
                    node_id: format!("subflow:{}", entry.node_id),
                    label: entry.label,
                    value: entry.value,
                });
            })
        },
        cancel: parent.cancel.clone(),
        http_client: parent.http_client.clone(),
        // Share the parent's registry so the nested chain can dispatch
        // built-in nodes + WASM plugins + other subflows.
        registry: parent.registry.clone(),
        processes: parent.processes.clone(),
        depth,
    });

    run_chain(start_id, nested_opts, outputs, bg_tasks, tap_logs).await
}
