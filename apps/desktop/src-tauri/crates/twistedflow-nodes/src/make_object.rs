//! Make Object node — assemble a JSON object from individual field pins.
//!
//! Reads the `fields` array from node_data. Each entry has at minimum a `key`
//! string. For every field with a non-empty key a data edge `in:{key}` is
//! resolved and the result inserted into the output object. Missing pins
//! resolve to `null`.

use serde_json::{Map, Value};
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Make Object",
    type_id = "makeObject",
    category = "Data",
    description = "Assemble an object from individual fields"
)]
pub struct MakeObjectNode;

impl Node for MakeObjectNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let fields = ctx
                .node_data
                .get("fields")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let mut obj = Map::new();

            for field in &fields {
                let key = match field.get("key").and_then(|v| v.as_str()) {
                    Some(k) if !k.is_empty() => k.to_string(),
                    _ => continue,
                };

                let handle = format!("in:{}", key);
                let val = ctx.resolve_input(&handle).await.unwrap_or(Value::Null);

                obj.insert(key, val);
            }

            NodeResult::Data(Some(Value::Object(obj)))
        })
    }
}
