//! Tap node — pass a value through unchanged while recording it for inspection.
//!
//! Each time the Tap's `out:value` pin is pulled, the upstream value is
//! appended to the shared `tap_logs` map under this node's ID, the result is
//! written into the outputs cache so subsequent pulls are served from cache,
//! and a status event is emitted carrying both the current value and the full
//! accumulated log.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult, StatusEvent};
use twistedflow_macros::node;

#[node(
    name = "Tap",
    type_id = "tap",
    category = "Data",
    description = "Pass through a value while logging it"
)]
pub struct TapNode;

impl Node for TapNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let upstream = ctx.resolve_input("in:value").await;
            let value = upstream.unwrap_or(Value::Null);

            // Append to the shared tap log for this node.
            let log = {
                let mut tl = ctx.tap_logs.lock().await;
                let entry = tl.entry(ctx.node_id.to_string()).or_default();
                entry.push(value.clone());
                entry.clone()
            };

            // Write into the outputs cache so the executor's cache-first
            // lookup hits on the next resolve for the same pin.
            let mut values = HashMap::new();
            values.insert("value".to_string(), value.clone());
            ctx.set_outputs(values).await;

            // Report to the frontend so the Tap inspector can update live.
            ctx.emit_status(StatusEvent::ok(Some(json!({
                "value": value,
                "_log": log,
            }))));

            NodeResult::Data(Some(value))
        })
    }
}
