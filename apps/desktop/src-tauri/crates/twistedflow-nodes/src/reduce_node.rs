//! Reduce node — aggregate an array into a single value.
//!
//! Exec node. Built-in reducers:
//!   - "sum":    sum numeric values
//!   - "count":  count items
//!   - "join":   join strings with separator
//!   - "min":    minimum numeric value
//!   - "max":    maximum numeric value
//!   - "first":  first item
//!   - "last":   last item
//!   - "flatten": flatten nested arrays one level
//!   - "unique": deduplicate items
//!   - "groupBy": group items by a field into an object

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Reduce",
    type_id = "reduce",
    category = "Data",
    description = "Aggregate an array: sum, join, min, max, flatten, unique, groupBy"
)]
pub struct ReduceNode;

impl Node for ReduceNode {
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
                        message: "Reduce: input is not an array".into(),
                        raw_response: None,
                    };
                }
            };

            let operation = ctx
                .node_data
                .get("operation")
                .and_then(|v| v.as_str())
                .unwrap_or("sum");

            let result = match operation {
                "sum" => {
                    let total: f64 = items.iter().map(|v| v.as_f64().unwrap_or(0.0)).sum();
                    json!(total)
                }
                "count" => {
                    json!(items.len())
                }
                "join" => {
                    let separator = ctx
                        .node_data
                        .get("separator")
                        .and_then(|v| v.as_str())
                        .unwrap_or(", ");
                    let joined: String = items
                        .iter()
                        .map(|v| match v {
                            Value::String(s) => s.clone(),
                            _ => v.to_string(),
                        })
                        .collect::<Vec<_>>()
                        .join(separator);
                    Value::String(joined)
                }
                "min" => items
                    .iter()
                    .filter_map(|v| v.as_f64())
                    .min_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                    .map(|n| json!(n))
                    .unwrap_or(Value::Null),
                "max" => items
                    .iter()
                    .filter_map(|v| v.as_f64())
                    .max_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal))
                    .map(|n| json!(n))
                    .unwrap_or(Value::Null),
                "first" => items.first().cloned().unwrap_or(Value::Null),
                "last" => items.last().cloned().unwrap_or(Value::Null),
                "flatten" => {
                    let mut flat = Vec::new();
                    for item in &items {
                        match item {
                            Value::Array(arr) => flat.extend(arr.clone()),
                            v => flat.push(v.clone()),
                        }
                    }
                    Value::Array(flat)
                }
                "unique" => {
                    let mut seen = Vec::new();
                    let mut unique = Vec::new();
                    for item in &items {
                        let key = item.to_string();
                        if !seen.contains(&key) {
                            seen.push(key);
                            unique.push(item.clone());
                        }
                    }
                    Value::Array(unique)
                }
                "groupBy" => {
                    let field = ctx
                        .node_data
                        .get("field")
                        .and_then(|v| v.as_str())
                        .unwrap_or("id");
                    let mut groups: serde_json::Map<String, Value> = serde_json::Map::new();
                    for item in &items {
                        let key = match item.get(field) {
                            Some(Value::String(s)) => s.clone(),
                            Some(v) => v.to_string(),
                            None => "null".into(),
                        };
                        let group = groups
                            .entry(key)
                            .or_insert_with(|| Value::Array(Vec::new()));
                        if let Value::Array(arr) = group {
                            arr.push(item.clone());
                        }
                    }
                    Value::Object(groups)
                }
                _ => {
                    return NodeResult::Error {
                        message: format!("Reduce: unknown operation '{}'", operation),
                        raw_response: None,
                    };
                }
            };

            let mut out: HashMap<String, Value> = HashMap::new();
            out.insert("result".into(), result);
            ctx.set_outputs(out.clone()).await;

            NodeResult::Continue {
                output: Some(serde_json::to_value(&out).unwrap_or(Value::Null)),
            }
        })
    }
}
