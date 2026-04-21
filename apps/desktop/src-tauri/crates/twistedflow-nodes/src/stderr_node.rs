//! Stderr node — writes a value to stderr.
//!
//! Exec node. Like Print but targets stderr instead of stdout.
//! Essential for CLI tools: data goes to stdout, messages go to stderr.

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Stderr",
    type_id = "stderr",
    category = "CLI",
    description = "Write a value to stderr"
)]
pub struct StderrNode;

impl Node for StderrNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let value = ctx.resolve_input("in:value").await.unwrap_or(Value::Null);

            match &value {
                Value::String(s) => eprintln!("{}", s),
                Value::Null => eprintln!("null"),
                Value::Bool(b) => eprintln!("{}", b),
                Value::Number(n) => eprintln!("{}", n),
                v => match serde_json::to_string_pretty(v) {
                    Ok(pretty) => eprintln!("{}", pretty),
                    Err(_) => eprintln!("{}", v),
                },
            }

            ctx.emit_log("Stderr", value.clone());

            NodeResult::Continue {
                output: Some(json!({ "value": value })),
            }
        })
    }
}
