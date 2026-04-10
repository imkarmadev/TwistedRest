//! Exit node — terminates the flow with a given exit code.
//! The CLI runner interprets NodeResult::Error as a non-zero exit.

use twistedflow_macros::node;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;

#[node(
    name = "Exit",
    type_id = "exit",
    category = "System",
    description = "Terminate the flow with an exit code"
)]
pub struct ExitNode;

impl Node for ExitNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            // Resolve exit code from in:code data input, default 0
            let code = ctx
                .resolve_input("in:code")
                .await
                .and_then(|v| match v {
                    Value::Number(n) => n.as_i64(),
                    Value::String(s) => s.parse::<i64>().ok(),
                    _ => None,
                })
                .unwrap_or(0);

            let message = ctx
                .node_data
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            if code != 0 {
                let err_message = if message.is_empty() {
                    format!("Exit {}", code)
                } else {
                    format!("Exit {}: {}", code, message)
                };

                return NodeResult::Error {
                    message: err_message,
                    raw_response: None,
                };
            }

            NodeResult::Continue {
                output: Some(json!({ "exitCode": 0 })),
            }
        })
    }
}
