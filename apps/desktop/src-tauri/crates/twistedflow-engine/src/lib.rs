//! TwistedFlow execution engine.
//!
//! Pure async Rust — no Tauri dependency. Can be used standalone
//! for CLI execution or embedded in the Tauri desktop app.

pub mod executor;
pub mod flow_file;
pub mod graph;
pub mod node;
pub mod template;
pub mod wasm_host;

pub use executor::{run_flow, RunFlowOpts};
pub use graph::{FlowGraph, GraphIndex, GraphNode, GraphEdge, EdgeKind};
pub use node::{
    DataType, ExecAuth, ExecContext, HeaderEntry, HttpRequest, HttpResponse, LogEntry,
    Node, NodeCtx, NodeMeta, NodeMetadata, NodeRegistration, NodeResult, NodeStatus, PinDef,
    Outputs, StatusEvent, TapLogs, VariableDecl, all_node_metadata, build_registry,
};
pub use flow_file::FlowFile;
pub use template::{input_pins_for, render_template};
pub use wasm_host::{load_wasm_plugins, validate_wasm, DEFAULT_PLUGINS_DIR};
