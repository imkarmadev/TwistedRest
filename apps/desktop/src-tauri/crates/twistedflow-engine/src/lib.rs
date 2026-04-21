//! TwistedFlow execution engine.
//!
//! Pure async Rust — no Tauri dependency. Can be used standalone
//! for CLI execution or embedded in the Tauri desktop app.

pub mod executor;
pub mod flow_file;
pub mod graph;
pub mod node;
pub mod subflow;
pub mod template;
pub mod wasm_host;

pub use executor::{run_flow, RunFlowOpts};
pub use flow_file::{FlowFile, FlowKind, Interface, PinDecl};
pub use graph::{EdgeKind, FlowGraph, GraphEdge, GraphIndex, GraphNode};
pub use node::{
    all_node_metadata, build_registry, DataType, ExecAuth, ExecContext, HeaderEntry, HttpRequest,
    HttpResponse, LogEntry, Node, NodeCtx, NodeMeta, NodeMetadata, NodeRegistration, NodeResult,
    NodeStatus, Outputs, PinDef, StatusEvent, TapLogs, VariableDecl,
};
pub use subflow::{call_subflow, load_subflows, SubflowNode, SubflowReturn, MAX_SUBFLOW_DEPTH};
pub use template::{input_pins_for, render_template};
pub use wasm_host::{load_wasm_plugins, load_wasm_plugins_from_bytes, validate_wasm};
