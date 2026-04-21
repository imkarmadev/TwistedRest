//! Map node — transform each array item via field selection/renaming.
//!
//! Exec node. Takes an array and transforms each item.
//! Modes:
//!   - "pick":   select specific fields from each object  (fields: ["name", "id"])
//!   - "pluck":  extract a single field as flat array      (field: "name")
//!   - "template": apply a template string to each item   (template: "#{name} (#{id})")
//!   - "exec":  run a sub-chain per item (like ForEach but returns mapped results)

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_engine::render_template;
use twistedflow_macros::node;

#[node(
    name = "Map",
    type_id = "map",
    category = "Data",
    description = "Transform each item in an array"
)]
pub struct MapNode;

impl Node for MapNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let input = ctx.resolve_input("in:array").await.unwrap_or(Value::Null);

            let items = match &input {
                Value::Array(arr) => arr.clone(),
                _ => {
                    return NodeResult::Error {
                        message: "Map: input is not an array".into(),
                        raw_response: None,
                    };
                }
            };

            let mode = ctx
                .node_data
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("pluck");

            let result: Vec<Value> = match mode {
                "pick" => {
                    let fields: Vec<String> = ctx
                        .node_data
                        .get("fields")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();

                    items
                        .iter()
                        .map(|item| {
                            if let Value::Object(map) = item {
                                let picked: serde_json::Map<String, Value> = map
                                    .iter()
                                    .filter(|(k, _)| fields.contains(k))
                                    .map(|(k, v)| (k.clone(), v.clone()))
                                    .collect();
                                Value::Object(picked)
                            } else {
                                item.clone()
                            }
                        })
                        .collect()
                }
                "pluck" => {
                    let field = ctx
                        .node_data
                        .get("field")
                        .and_then(|v| v.as_str())
                        .unwrap_or("value");

                    items
                        .iter()
                        .map(|item| {
                            if let Value::Object(map) = item {
                                map.get(field).cloned().unwrap_or(Value::Null)
                            } else {
                                item.clone()
                            }
                        })
                        .collect()
                }
                "template" => {
                    let template = ctx
                        .node_data
                        .get("template")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    items
                        .iter()
                        .map(|item| {
                            // Flatten item fields into a HashMap for render_template
                            let mut vars: HashMap<String, Value> = HashMap::new();
                            if let Value::Object(map) = item {
                                for (k, v) in map {
                                    vars.insert(k.clone(), v.clone());
                                }
                            }
                            vars.insert("item".into(), item.clone());
                            let rendered = render_template(template, &vars);
                            Value::String(rendered)
                        })
                        .collect()
                }
                _ => {
                    return NodeResult::Error {
                        message: format!("Map: unknown mode '{}'", mode),
                        raw_response: None,
                    };
                }
            };

            let count = result.len();
            let mut out: HashMap<String, Value> = HashMap::new();
            out.insert("result".into(), Value::Array(result));
            out.insert("count".into(), json!(count));
            ctx.set_outputs(out.clone()).await;

            NodeResult::Continue {
                output: Some(serde_json::to_value(&out).unwrap_or(Value::Null)),
            }
        })
    }
}
