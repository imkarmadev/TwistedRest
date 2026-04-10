//! Assert Type node — checks that a value has the expected type.
//! Halts the flow (error) if the type doesn't match.

use twistedflow_macros::node;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;

#[node(
    name = "Assert Type",
    type_id = "assertType",
    category = "Testing",
    description = "Assert that a value has the expected type. Fails if not."
)]
pub struct AssertTypeNode;

impl Node for AssertTypeNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let value = ctx.resolve_input("in:value").await.unwrap_or(Value::Null);

            let expected_type = ctx.node_data.get("expectedType")
                .and_then(|v| v.as_str())
                .unwrap_or("string");

            let label = ctx.node_data.get("label")
                .and_then(|v| v.as_str())
                .unwrap_or("Assert Type");

            let actual_type = match &value {
                Value::Null => "null",
                Value::Bool(_) => "boolean",
                Value::Number(n) => {
                    if n.is_f64() && n.as_f64().map(|f| f.fract() != 0.0).unwrap_or(false) {
                        "number"
                    } else {
                        "number" // integer is also number
                    }
                }
                Value::String(_) => "string",
                Value::Array(_) => "array",
                Value::Object(_) => "object",
            };

            // Allow "integer" to match numbers that are whole
            let passed = match expected_type {
                "integer" => {
                    value.as_f64().map(|f| f.fract() == 0.0).unwrap_or(false)
                }
                "number" => value.is_number(),
                other => actual_type == other,
            };

            if passed {
                NodeResult::Continue {
                    output: Some(json!({
                        "passed": true,
                        "label": label,
                        "type": actual_type,
                    })),
                }
            } else {
                NodeResult::Error {
                    message: format!(
                        "Type assertion failed: {}\n  expected type: {}\n  actual type:   {} (value: {})",
                        label, expected_type, actual_type,
                        serde_json::to_string(&value).unwrap_or_default()
                    ),
                    raw_response: None,
                }
            }
        })
    }
}
