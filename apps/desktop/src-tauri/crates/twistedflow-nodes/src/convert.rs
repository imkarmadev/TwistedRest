//! Convert node — coerce a value to a target type.
//!
//! Reads `targetType` from node_data and applies the same conversion logic
//! as the executor's inline `convert_value` helper. Supported target types:
//! "string", "number", "integer", "boolean", "json".

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Convert",
    type_id = "convert",
    category = "Data",
    description = "Convert a value to a different type"
)]
pub struct ConvertNode;

impl Node for ConvertNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let input = ctx.resolve_input("in:value").await.unwrap_or(Value::Null);

            let target_type = ctx.node_data.get("targetType").and_then(|v| v.as_str());

            let converted = convert_value(input, target_type);
            NodeResult::Data(Some(converted))
        })
    }
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        _ => serde_json::to_string(v).unwrap_or_default(),
    }
}

fn convert_value(value: Value, target: Option<&str>) -> Value {
    if value.is_null() {
        return value;
    }
    match target {
        Some("string") => match &value {
            Value::String(_) => value,
            Value::Object(_) | Value::Array(_) => {
                Value::String(serde_json::to_string(&value).unwrap_or_default())
            }
            _ => Value::String(value_to_string(&value)),
        },
        Some("number") => {
            let s = value_to_string(&value);
            match s.parse::<f64>() {
                Ok(n) => json!(n),
                Err(_) => Value::Null,
            }
        }
        Some("integer") => {
            let s = value_to_string(&value);
            match s.parse::<f64>() {
                Ok(n) if n.is_finite() => json!(n.trunc() as i64),
                _ => Value::Null,
            }
        }
        Some("boolean") => {
            if let Value::Bool(_) = &value {
                return value;
            }
            let s = value_to_string(&value).to_lowercase();
            match s.trim() {
                "true" | "1" => json!(true),
                "false" | "0" | "" => json!(false),
                _ => json!(!s.is_empty()),
            }
        }
        Some("json") => Value::String(serde_json::to_string(&value).unwrap_or_default()),
        // Unknown or missing target type — pass through unchanged
        _ => value,
    }
}
