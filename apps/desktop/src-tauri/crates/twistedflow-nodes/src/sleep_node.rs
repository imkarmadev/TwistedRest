//! Sleep node — pauses exec-chain execution for a configurable number of milliseconds.

use twistedflow_macros::node;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

#[node(
    name = "Sleep",
    type_id = "sleep",
    category = "System",
    description = "Pause execution for a duration"
)]
pub struct SleepNode;

impl Node for SleepNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            // Determine ms: in:ms data input overrides node_data
            let ms_from_input = ctx.resolve_input("in:ms").await.and_then(|v| match v {
                Value::Number(n) => n.as_u64(),
                Value::String(s) => s.parse::<u64>().ok(),
                _ => None,
            });

            let ms = ms_from_input
                .or_else(|| {
                    ctx.node_data
                        .get("ms")
                        .and_then(|v| match v {
                            Value::Number(n) => n.as_u64(),
                            Value::String(s) => s.parse::<u64>().ok(),
                            _ => None,
                        })
                })
                .unwrap_or(1000);

            tokio::time::sleep(Duration::from_millis(ms)).await;

            NodeResult::Continue {
                output: Some(json!({ "slept": ms })),
            }
        })
    }
}
