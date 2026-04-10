//! Get Variable node — reads a named runtime variable.
//! Data node: resolved lazily. Returns error if variable was never set.

use twistedflow_macros::node;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use std::future::Future;
use std::pin::Pin;

#[node(
    name = "Get Variable",
    type_id = "getVariable",
    category = "Variables",
    description = "Read a runtime variable set by Set Variable"
)]
pub struct GetVariableNode;

impl Node for GetVariableNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let var_name = ctx
                .node_data
                .get("varName")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if var_name.is_empty() {
                return NodeResult::Error {
                    message: "Get Variable: no variable name specified".into(),
                    raw_response: None,
                };
            }

            // Read from the runtime variables namespace
            let value = {
                let out = ctx.outputs.lock().await;
                out.get("__variables__")
                    .and_then(|vars| vars.get(var_name))
                    .cloned()
            };

            match value {
                Some(val) => {
                    // Cache as this node's output so downstream can read it
                    let mut out = ctx.outputs.lock().await;
                    out.entry(ctx.node_id.to_string())
                        .or_default()
                        .insert("value".into(), val.clone());
                    NodeResult::Data(Some(val))
                }
                None => {
                    // Variable was never set — runtime error
                    ctx.emit_status(twistedflow_engine::node::StatusEvent::error(
                        format!("Variable '{}' is undefined — no Set Variable wrote to it", var_name),
                    ));
                    NodeResult::Data(None)
                }
            }
        })
    }
}
