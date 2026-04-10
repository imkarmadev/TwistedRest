//! TwistedFlow built-in node implementations.
//!
//! Each node is declared in its own module and implements the `Node` trait via
//! the `#[node]` proc macro. The macro also registers each node into the
//! `inventory`-based registry so that `build_registry()` can discover them
//! without manual wiring.

pub use twistedflow_engine::*;

// ── Exec nodes ──────────────────────────────────────────────────────────────
pub mod assert_node;
pub mod assert_type_node;
pub mod emit_event;
pub mod exit_node;
pub mod file_read_node;
pub mod file_write_node;
pub mod for_each;
pub mod http_listen;
pub mod http_request;
pub mod if_else;
pub mod route_match;
pub mod send_response;
pub mod try_catch;
pub mod log_node;
pub mod match_node;
pub mod print_node;
pub mod set_variable;
pub mod shell_exec_node;
pub mod sleep_node;
pub mod start;

// ── Pure-data nodes ─────────────────────────────────────────────────────────
pub mod break_object;
pub mod convert;
pub mod env_var;
pub mod get_variable;
pub mod make_object;
pub mod tap;

// Convenient re-exports
pub use assert_node::AssertNode;
pub use assert_type_node::AssertTypeNode;
pub use break_object::BreakObjectNode;
pub use convert::ConvertNode;
pub use emit_event::EmitEventNode;
pub use env_var::EnvVarNode;
pub use exit_node::ExitNode;
pub use file_read_node::FileReadNode;
pub use file_write_node::FileWriteNode;
pub use for_each::{ForEachParNode, ForEachSeqNode};
pub use get_variable::GetVariableNode;
pub use http_listen::HttpListenNode;
pub use http_request::HttpRequestNode;
pub use if_else::IfElseNode;
pub use route_match::RouteMatchNode;
pub use send_response::SendResponseNode;
pub use try_catch::TryCatchNode;
pub use log_node::LogNode;
pub use make_object::MakeObjectNode;
pub use match_node::MatchNode;
pub use print_node::PrintNode;
pub use set_variable::SetVariableNode;
pub use shell_exec_node::ShellExecNode;
pub use sleep_node::SleepNode;
pub use start::StartNode;
pub use tap::TapNode;
