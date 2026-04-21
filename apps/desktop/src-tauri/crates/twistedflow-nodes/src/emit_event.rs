//! Emit Event node — dispatches a named event to all matching OnEvent listeners.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult, StatusEvent};
use twistedflow_macros::node;

#[node(
    name = "Emit Event",
    type_id = "emitEvent",
    category = "Events",
    description = "Emit a named event to listeners"
)]
pub struct EmitEventNode;

impl Node for EmitEventNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let event_name = match ctx.node_data.get("name").and_then(|v| v.as_str()) {
                Some(n) if !n.is_empty() => n.to_string(),
                _ => {
                    return NodeResult::Continue { output: None };
                }
            };

            // Resolve payload fields declared on the node
            let payload_fields = ctx
                .node_data
                .get("payload")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let mut payload: HashMap<String, Value> = HashMap::new();
            for field in &payload_fields {
                let key = match field.get("key").and_then(|v| v.as_str()) {
                    Some(k) if !k.is_empty() => k.to_string(),
                    _ => continue,
                };
                let handle = format!("in:{}", key);
                if let Some(val) = ctx.resolve_input(&handle).await {
                    payload.insert(key, val);
                }
            }

            // Collect matching onEvent listener IDs before any async work
            let listener_ids: Vec<String> = ctx
                .index
                .nodes
                .values()
                .filter(|n| {
                    n.node_type.as_deref() == Some("onEvent")
                        && n.data.get("name").and_then(|v| v.as_str()).unwrap_or("") == event_name
                })
                .map(|n| n.id.clone())
                .collect();

            let listener_count = listener_ids.len();

            // Write payload to each listener's output slot, then spawn its chain
            for listener_id in &listener_ids {
                {
                    let mut out = ctx.outputs.lock().await;
                    let entry = out.entry(listener_id.clone()).or_default();
                    for (k, v) in &payload {
                        entry.insert(k.clone(), v.clone());
                    }
                }

                // Mark listener as ok so the frontend shows it ran
                (ctx.opts.on_status)(
                    listener_id,
                    StatusEvent::ok(Some(serde_json::to_value(&payload).unwrap_or(Value::Null))),
                );

                // Spawn the listener's exec-out chain in the background
                if let Some(next_id) = ctx.index.next_exec(listener_id, "exec-out") {
                    ctx.spawn_chain(next_id).await;
                }
            }

            // Build output: payload fields + listenerCount
            let mut output_map = payload.clone();
            output_map.insert("listenerCount".into(), json!(listener_count));
            let output_val = serde_json::to_value(&output_map).ok();

            NodeResult::Continue { output: output_val }
        })
    }
}
