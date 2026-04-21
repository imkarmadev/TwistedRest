//! Log node — emits a labelled value to the console.

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Log",
    type_id = "log",
    category = "Data",
    description = "Log a value to the console"
)]
pub struct LogNode;

impl Node for LogNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let value = ctx.resolve_input("in:value").await.unwrap_or(Value::Null);

            let label = ctx
                .node_data
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or("Log");
            let label = if label.is_empty() { "Log" } else { label };

            ctx.emit_log(label, value.clone());

            NodeResult::Continue {
                output: Some(json!({ "value": value })),
            }
        })
    }
}
