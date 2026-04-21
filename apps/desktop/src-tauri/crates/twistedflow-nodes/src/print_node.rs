//! Print node — prints a value to stdout and emits a log entry to the console panel.

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Print",
    type_id = "print",
    category = "System",
    description = "Print a value to stdout"
)]
pub struct PrintNode;

impl Node for PrintNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let value = ctx.resolve_input("in:value").await.unwrap_or(Value::Null);

            // Print to actual stdout
            match &value {
                Value::String(s) => println!("{}", s),
                Value::Null => println!("null"),
                Value::Bool(b) => println!("{}", b),
                Value::Number(n) => println!("{}", n),
                // Objects and arrays get pretty-printed
                v => match serde_json::to_string_pretty(v) {
                    Ok(pretty) => println!("{}", pretty),
                    Err(_) => println!("{}", v),
                },
            }

            // Also emit to the desktop UI console panel
            ctx.emit_log("Print", value.clone());

            NodeResult::Continue {
                output: Some(json!({ "value": value })),
            }
        })
    }
}
