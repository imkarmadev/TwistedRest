//! Merge node — combine objects or arrays.
//!
//! Pure data node. Two inputs: in:a and in:b.
//! Modes:
//!   - "deep":   deep-merge two objects (b overwrites a on conflict)
//!   - "shallow": shallow merge (Object.assign style)
//!   - "concat": concatenate two arrays
//!   - "auto":   detect types — merge objects, concat arrays

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Merge",
    type_id = "merge",
    category = "Data",
    description = "Deep-merge objects or concatenate arrays"
)]
pub struct MergeNode;

impl Node for MergeNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let a = ctx.resolve_input("in:a").await.unwrap_or(Value::Null);
            let b = ctx.resolve_input("in:b").await.unwrap_or(Value::Null);

            let mode = ctx
                .node_data
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("auto");

            let result = match mode {
                "deep" => deep_merge(a, b),
                "shallow" => shallow_merge(a, b),
                "concat" => concat_values(a, b),
                "auto" | _ => match (&a, &b) {
                    (Value::Object(_), Value::Object(_)) => deep_merge(a, b),
                    (Value::Array(_), Value::Array(_)) => concat_values(a, b),
                    (Value::Object(_), _) => deep_merge(a, json!({})),
                    (Value::Array(_), _) => {
                        let mut arr = if let Value::Array(arr) = a {
                            arr
                        } else {
                            vec![]
                        };
                        if b != Value::Null {
                            arr.push(b);
                        }
                        Value::Array(arr)
                    }
                    _ => a,
                },
            };

            let mut out: HashMap<String, Value> = HashMap::new();
            out.insert("result".into(), result);
            ctx.set_outputs(out).await;

            NodeResult::Data(
                ctx.get_outputs(ctx.node_id)
                    .await
                    .map(|o| serde_json::to_value(o).unwrap_or(Value::Null)),
            )
        })
    }
}

fn deep_merge(a: Value, b: Value) -> Value {
    match (a, b) {
        (Value::Object(mut a_map), Value::Object(b_map)) => {
            for (key, b_val) in b_map {
                let merged = if let Some(a_val) = a_map.remove(&key) {
                    deep_merge(a_val, b_val)
                } else {
                    b_val
                };
                a_map.insert(key, merged);
            }
            Value::Object(a_map)
        }
        (_, b) => b,
    }
}

fn shallow_merge(a: Value, b: Value) -> Value {
    match (a, b) {
        (Value::Object(mut a_map), Value::Object(b_map)) => {
            for (key, val) in b_map {
                a_map.insert(key, val);
            }
            Value::Object(a_map)
        }
        (_, b) => b,
    }
}

fn concat_values(a: Value, b: Value) -> Value {
    let mut result = match a {
        Value::Array(arr) => arr,
        v => vec![v],
    };
    match b {
        Value::Array(arr) => result.extend(arr),
        v => result.push(v),
    }
    Value::Array(result)
}
