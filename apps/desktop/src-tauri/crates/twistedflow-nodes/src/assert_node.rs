//! Assert node — checks that a value equals an expected value.
//! Halts the flow (error) if the assertion fails.

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Assert",
    type_id = "assert",
    category = "Testing",
    description = "Assert that a value equals expected. Fails the flow if not."
)]
pub struct AssertNode;

impl Node for AssertNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let actual = ctx.resolve_input("in:actual").await.unwrap_or(Value::Null);
            let expected = ctx.resolve_input("in:expected").await;

            // If no expected input wired, check against node_data.expected
            let expected = expected.unwrap_or_else(|| {
                ctx.node_data
                    .get("expected")
                    .cloned()
                    .unwrap_or(Value::Null)
            });

            let label = ctx
                .node_data
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or("Assert");

            // Compare: normalize numbers for comparison (1.0 == 1)
            let passed = values_equal(&actual, &expected);

            if passed {
                NodeResult::Continue {
                    output: Some(json!({
                        "passed": true,
                        "label": label,
                        "actual": actual,
                    })),
                }
            } else {
                let actual_str = format_value(&actual);
                let expected_str = format_value(&expected);
                NodeResult::Error {
                    message: format!(
                        "Assertion failed: {}\n  expected: {}\n  actual:   {}",
                        label, expected_str, actual_str
                    ),
                    raw_response: None,
                }
            }
        })
    }
}

fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => {
            a.as_f64().unwrap_or(f64::NAN) == b.as_f64().unwrap_or(f64::NAN)
        }
        // String comparison: trim whitespace for convenience (shell output has \n)
        (Value::String(a), Value::String(b)) => a.trim() == b.trim(),
        _ => a == b,
    }
}

fn format_value(v: &Value) -> String {
    match v {
        Value::String(s) => format!("\"{}\"", s),
        Value::Null => "null".into(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}
