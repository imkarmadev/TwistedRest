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
pub mod cookie_node;
pub mod cors_node;
pub mod emit_event;
pub mod exit_node;
pub mod file_read_node;
pub mod file_write_node;
pub mod for_each;
pub mod http_listen;
pub mod http_request;
pub mod if_else;
pub mod log_node;
pub mod match_node;
pub mod parse_body_node;
pub mod print_node;
pub mod rate_limit_node;
pub mod redirect_node;
pub mod route_match;
pub mod route_node;
pub mod send_response;
pub mod serve_static_node;
pub mod set_headers_node;
pub mod set_variable;
pub mod shell_exec_node;
pub mod sleep_node;
pub mod start;
pub mod try_catch;
pub mod verify_auth_node;

// ── CLI nodes ───────────────────────────────────────────────────────────────
pub mod parse_args;
pub mod prompt_node;
pub mod stderr_node;
pub mod stdin_node;

// ── String nodes ────────────────────────────────────────────────────────────
pub mod encode_decode_node;
pub mod hash_node;
pub mod regex_node;
pub mod template_node;

// ── Data transform nodes ────────────────────────────────────────────────────
pub mod filter_node;
pub mod map_node;
pub mod merge_node;
pub mod reduce_node;

// ── Flow control (new) ─────────────────────────────────────────────────────
pub mod retry_node;

// ── Subflow I/O (v1.5.0) ───────────────────────────────────────────────────
pub mod subflow_inputs;
pub mod subflow_outputs;

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
pub use cookie_node::CookieNode;
pub use cors_node::CorsNode;
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
pub use log_node::LogNode;
pub use make_object::MakeObjectNode;
pub use match_node::MatchNode;
pub use parse_body_node::ParseBodyNode;
pub use print_node::PrintNode;
pub use rate_limit_node::RateLimitNode;
pub use redirect_node::RedirectNode;
pub use route_match::RouteMatchNode;
pub use route_node::RouteNode;
pub use send_response::SendResponseNode;
pub use serve_static_node::ServeStaticNode;
pub use set_headers_node::SetHeadersNode;
pub use set_variable::SetVariableNode;
pub use shell_exec_node::ShellExecNode;
pub use sleep_node::SleepNode;
pub use start::StartNode;
pub use tap::TapNode;
pub use try_catch::TryCatchNode;
pub use verify_auth_node::VerifyAuthNode;

// CLI
pub use parse_args::ParseArgsNode;
pub use prompt_node::PromptNode;
pub use stderr_node::StderrNode;
pub use stdin_node::StdinNode;

// String
pub use encode_decode_node::EncodeDecodeNode;
pub use hash_node::HashNode;
pub use regex_node::RegexNode;
pub use template_node::TemplateNode;

// Data transform
pub use filter_node::FilterNode;
pub use map_node::MapNode;
pub use merge_node::MergeNode;
pub use reduce_node::ReduceNode;

// Flow control
pub use retry_node::RetryNode;

// Subflow I/O
pub use subflow_inputs::SubflowInputsNode;
pub use subflow_outputs::SubflowOutputsNode;
