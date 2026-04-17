//! Node trait and supporting types for TwistedFlow engine.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Data types for pins (mirrors the JS DataType).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataType {
    Unknown,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Null,
}

/// Node execution status.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeStatus {
    Idle,
    Pending,
    Running,
    Ok,
    Error,
}

impl std::fmt::Display for NodeStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NodeStatus::Idle => write!(f, "idle"),
            NodeStatus::Pending => write!(f, "pending"),
            NodeStatus::Running => write!(f, "running"),
            NodeStatus::Ok => write!(f, "ok"),
            NodeStatus::Error => write!(f, "error"),
        }
    }
}

/// Status event emitted to the frontend per node state transition.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEvent {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_response: Option<Value>,
}

impl StatusEvent {
    pub fn pending() -> Self {
        Self { status: "pending".into(), output: None, error: None, raw_response: None }
    }
    pub fn running() -> Self {
        Self { status: "running".into(), output: None, error: None, raw_response: None }
    }
    pub fn ok(output: Option<Value>) -> Self {
        Self { status: "ok".into(), output, error: None, raw_response: None }
    }
    pub fn error(msg: impl Into<String>) -> Self {
        Self { status: "error".into(), output: None, error: Some(msg.into()), raw_response: None }
    }
    pub fn schema_error(msg: impl Into<String>, raw: Value) -> Self {
        Self {
            status: "error".into(),
            output: None,
            error: Some(msg.into()),
            raw_response: Some(raw),
        }
    }
}

/// Log entry emitted when a Log node fires.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub node_id: String,
    pub label: String,
    pub value: Value,
}

/// Auth configuration from the active environment.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecAuth {
    #[serde(default)]
    pub auth_type: String,
    pub bearer_token: Option<String>,
    pub basic_username: Option<String>,
    pub basic_password: Option<String>,
    pub api_key_name: Option<String>,
    pub api_key_value: Option<String>,
    pub api_key_location: Option<String>,
    pub oauth2_access_token: Option<String>,
}

/// Header entry for project/env/node headers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeaderEntry {
    pub key: String,
    #[serde(default)]
    pub value: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool { true }

/// Per-run execution context from the frontend.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecContext {
    pub project_base_url: Option<String>,
    pub env_base_url: Option<String>,
    pub project_headers: Option<Vec<HeaderEntry>>,
    pub env_headers: Option<Vec<HeaderEntry>>,
    pub env_vars: Option<HashMap<String, Value>>,
    pub auth: Option<ExecAuth>,
    /// Flow-level variable declarations with types and defaults.
    #[serde(default)]
    pub variables: Option<Vec<VariableDecl>>,
}

/// A typed variable declaration from the flow's `variables` array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariableDecl {
    pub name: String,
    #[serde(rename = "type")]
    pub var_type: String,
    #[serde(default)]
    pub default: Option<String>,
}

/// HTTP request shape sent to reqwest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// HTTP response shape from reqwest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

/// Per-node output cache.
pub type Outputs = HashMap<String, HashMap<String, Value>>;

/// Shared per-run log of tap node values.
pub type TapLogs = HashMap<String, Vec<Value>>;

// ── Node trait system ───────────────────────────────────────────────

use crate::executor::RunFlowOpts;
use crate::graph::GraphIndex;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

/// Pin definition for metadata (used by WASM plugins to declare their pins).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinDef {
    pub key: String,
    #[serde(default = "default_pin_type")]
    pub data_type: String,
}

fn default_pin_type() -> String {
    "unknown".to_string()
}

/// Static metadata for a node type — name, category, description, pins.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMetadata {
    pub name: String,
    pub type_id: String,
    pub category: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<PinDef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outputs: Vec<PinDef>,
}

/// What the executor should do after a node runs.
pub enum NodeResult {
    /// Continue to "exec-out" (default for most exec nodes).
    Continue { output: Option<Value> },
    /// Fire a specific exec handle (e.g., Match → "exec-case:0").
    Branch { handle: String, output: Option<Value> },
    /// Error — halt the chain.
    Error { message: String, raw_response: Option<Value> },
    /// Pure data node — resolved lazily, returns a value.
    Data(Option<Value>),
    /// Long-running process node. The node spawned its own background task
    /// and returned immediately. Executor keeps the node marked as "running"
    /// and does NOT advance to exec-out. The process runs until cancelled.
    Process,
}

/// Runtime context available to every node during execution.
pub struct NodeCtx<'a> {
    pub node_id: &'a str,
    pub node_data: &'a Value,
    pub opts: &'a Arc<RunFlowOpts>,
    pub outputs: &'a Arc<Mutex<Outputs>>,
    pub tap_logs: &'a Arc<Mutex<TapLogs>>,
    pub bg_tasks: &'a Arc<Mutex<Vec<JoinHandle<()>>>>,
    pub index: &'a Arc<GraphIndex>,
}

impl<'a> NodeCtx<'a> {
    /// Resolve a single data input pin (e.g., "in:value").
    pub fn resolve_input(
        &'a self,
        target_handle: &'a str,
    ) -> Pin<Box<dyn Future<Output = Option<Value>> + Send + 'a>> {
        Box::pin(async move {
            if let Some((src_id, src_handle)) =
                self.index.data_source(self.node_id, target_handle)
            {
                crate::executor::resolve_pin_value(
                    src_id, src_handle, self.opts, self.outputs, self.tap_logs,
                )
                .await
            } else {
                None
            }
        })
    }

    /// Resolve all `in:*` data edges connected to this node.
    pub fn resolve_all_inputs(
        &'a self,
    ) -> Pin<Box<dyn Future<Output = HashMap<String, Value>> + Send + 'a>> {
        Box::pin(async move {
            let data_edges = self.index.data_edges_for(self.node_id);
            let mut values = HashMap::new();
            for (target_handle, src_id, src_handle) in &data_edges {
                if !target_handle.starts_with("in:") {
                    continue;
                }
                let pin_name = &target_handle[3..];
                if let Some(val) = crate::executor::resolve_pin_value(
                    src_id, src_handle, self.opts, self.outputs, self.tap_logs,
                )
                .await
                {
                    values.insert(pin_name.to_string(), val);
                }
            }
            values
        })
    }

    /// Emit a status event to the frontend.
    pub fn emit_status(&self, event: StatusEvent) {
        (self.opts.on_status)(self.node_id, event);
    }

    /// Emit a log entry to the frontend console.
    pub fn emit_log(&self, label: &str, value: Value) {
        (self.opts.on_log)(LogEntry {
            node_id: self.node_id.to_string(),
            label: label.to_string(),
            value,
        });
    }

    /// Store output values in the shared per-node cache.
    pub async fn set_outputs(&self, values: HashMap<String, Value>) {
        let mut out = self.outputs.lock().await;
        out.insert(self.node_id.to_string(), values);
    }

    /// Get a copy of current outputs for a node.
    pub async fn get_outputs(&self, node_id: &str) -> Option<HashMap<String, Value>> {
        let out = self.outputs.lock().await;
        out.get(node_id).cloned()
    }

    /// Update a single output field for a node.
    pub async fn set_output(&self, node_id: &str, key: &str, value: Value) {
        let mut out = self.outputs.lock().await;
        out.entry(node_id.to_string())
            .or_default()
            .insert(key.to_string(), value);
    }

    /// Spawn a background exec chain (for event listeners).
    pub async fn spawn_chain(&self, start_id: &str) {
        let opts = self.opts.clone();
        let outputs = self.outputs.clone();
        let bg = self.bg_tasks.clone();
        let tl = self.tap_logs.clone();
        let start = start_id.to_owned();
        let handle = tokio::spawn(async move {
            let _ = crate::executor::run_chain(start, opts, outputs, bg, tl).await;
        });
        self.bg_tasks.lock().await.push(handle);
    }

    /// Run a sub-chain synchronously (for ForEach sequential body).
    pub fn run_chain_sync(
        &'a self,
        start_id: String,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            crate::executor::run_chain(
                start_id,
                self.opts.clone(),
                self.outputs.clone(),
                self.bg_tasks.clone(),
                self.tap_logs.clone(),
            )
            .await
        })
    }

    /// Run a sub-chain with isolated outputs (for ForEach parallel body).
    pub fn run_chain_isolated(
        &'a self,
        start_id: String,
        local_outputs: Arc<Mutex<Outputs>>,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            crate::executor::run_chain(
                start_id,
                self.opts.clone(),
                local_outputs,
                self.bg_tasks.clone(),
                self.tap_logs.clone(),
            )
            .await
        })
    }

    /// Spawn a long-running process task. Unlike spawn_chain, this goes into
    /// the process registry which is NOT awaited by run_flow — it runs until
    /// the cancel token fires.
    pub async fn spawn_process<F>(&self, future: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let handle = tokio::spawn(future);
        self.opts.processes.lock().await.push(handle);
    }

    /// Emit a named event — finds all OnEvent listeners with matching name,
    /// writes payload to their outputs, and spawns their exec-out chains.
    /// This is the same mechanism as the EmitEvent node but callable from
    /// any node (especially process nodes).
    pub fn emit_event(
        &'a self,
        event_name: &'a str,
        payload: HashMap<String, Value>,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            // Find matching OnEvent listeners
            let listeners: Vec<String> = self
                .index
                .nodes
                .values()
                .filter(|n| {
                    n.node_type.as_deref() == Some("onEvent")
                        && n.data
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            == event_name
                })
                .map(|n| n.id.clone())
                .collect();

            // Write payload to each listener's outputs and spawn their chains
            for listener_id in &listeners {
                {
                    let mut out = self.outputs.lock().await;
                    let entry = out.entry(listener_id.clone()).or_default();
                    for (k, v) in &payload {
                        entry.insert(k.clone(), v.clone());
                    }
                }
                (self.opts.on_status)(
                    listener_id,
                    StatusEvent::ok(Some(
                        serde_json::to_value(&payload).unwrap_or(Value::Null),
                    )),
                );

                if let Some(next_id) = self.index.next_exec(listener_id, "exec-out") {
                    self.spawn_chain(next_id).await;
                }
            }
        })
    }
}

/// Trait for static metadata (generated by #[node] macro).
pub trait NodeMeta {
    fn metadata() -> &'static NodeMetadata
    where
        Self: Sized;
}

/// Trait for node execution. All nodes implement this.
pub trait Node: Send + Sync + 'static {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>>;
}

/// Registration entry used by the `inventory` crate for auto-discovery.
pub struct NodeRegistration {
    pub type_id: &'static str,
    pub create: fn() -> Box<dyn Node>,
    pub metadata_fn: fn() -> &'static NodeMetadata,
}

inventory::collect!(NodeRegistration);

/// Build a registry of all registered node types.
pub fn build_registry() -> HashMap<&'static str, Box<dyn Node>> {
    let mut map = HashMap::new();
    for reg in inventory::iter::<NodeRegistration> {
        map.insert(reg.type_id, (reg.create)());
    }
    map
}

/// Get metadata for all registered node types.
pub fn all_node_metadata() -> Vec<&'static NodeMetadata> {
    inventory::iter::<NodeRegistration>
        .into_iter()
        .map(|reg| (reg.metadata_fn)())
        .collect()
}
