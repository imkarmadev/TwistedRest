//! Filter node — filter array items by expression.
//!
//! Exec node. Takes an array input and a JavaScript-like expression.
//! Supported expressions:
//!   - Field access: item.status == 200, item.name != ""
//!   - Type checks: item.type == "error"
//!   - Truthiness: just "item.active" checks truthy
//!   - Contains: item.tags contains "urgent"

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Filter",
    type_id = "filter",
    category = "Data",
    description = "Filter array items by expression"
)]
pub struct FilterNode;

impl Node for FilterNode {
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
                        message: "Filter: input is not an array".into(),
                        raw_response: None,
                    };
                }
            };

            let expression = ctx
                .node_data
                .get("expression")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();

            if expression.is_empty() {
                // No expression = pass all non-null/non-false items (truthiness)
                let filtered: Vec<Value> = items.into_iter().filter(|v| is_truthy(v)).collect();
                let count = filtered.len();
                let mut out: HashMap<String, Value> = HashMap::new();
                out.insert("result".into(), Value::Array(filtered));
                out.insert("count".into(), json!(count));
                ctx.set_outputs(out.clone()).await;
                return NodeResult::Continue {
                    output: Some(serde_json::to_value(&out).unwrap_or(Value::Null)),
                };
            }

            let filtered: Vec<Value> = items
                .into_iter()
                .filter(|item| evaluate_filter(&expression, item))
                .collect();

            let count = filtered.len();
            let mut out: HashMap<String, Value> = HashMap::new();
            out.insert("result".into(), Value::Array(filtered));
            out.insert("count".into(), json!(count));
            ctx.set_outputs(out.clone()).await;

            NodeResult::Continue {
                output: Some(serde_json::to_value(&out).unwrap_or(Value::Null)),
            }
        })
    }
}

fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(_) => true,
    }
}

/// Simple expression evaluator for filter conditions.
/// Supports: field == value, field != value, field > value, field < value,
/// field contains value, and bare field (truthiness check).
fn evaluate_filter(expr: &str, item: &Value) -> bool {
    // Try comparison operators
    for (op, cmp_fn) in &[
        ("!=", compare_ne as fn(&Value, &str) -> bool),
        ("==", compare_eq as fn(&Value, &str) -> bool),
        (">=", compare_gte as fn(&Value, &str) -> bool),
        ("<=", compare_lte as fn(&Value, &str) -> bool),
        (">", compare_gt as fn(&Value, &str) -> bool),
        ("<", compare_lt as fn(&Value, &str) -> bool),
        (" contains ", compare_contains as fn(&Value, &str) -> bool),
    ] {
        if let Some((left, right)) = expr.split_once(op) {
            let left = left.trim();
            let right = right.trim().trim_matches('"').trim_matches('\'');
            let resolved = resolve_path(left, item);
            return cmp_fn(&resolved, right);
        }
    }

    // Bare expression — resolve path and check truthiness
    let resolved = resolve_path(expr.trim(), item);
    is_truthy(&resolved)
}

fn resolve_path(path: &str, item: &Value) -> Value {
    let path = path.strip_prefix("item.").unwrap_or(path);
    let path = path.strip_prefix("item").unwrap_or(path);
    if path.is_empty() {
        return item.clone();
    }
    let mut current = item.clone();
    for part in path.split('.') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        match &current {
            Value::Object(map) => {
                current = map.get(part).cloned().unwrap_or(Value::Null);
            }
            Value::Array(arr) => {
                if let Ok(idx) = part.parse::<usize>() {
                    current = arr.get(idx).cloned().unwrap_or(Value::Null);
                } else {
                    return Value::Null;
                }
            }
            _ => return Value::Null,
        }
    }
    current
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        _ => v.to_string(),
    }
}

fn compare_eq(v: &Value, expected: &str) -> bool {
    value_to_string(v) == expected
}

fn compare_ne(v: &Value, expected: &str) -> bool {
    value_to_string(v) != expected
}

fn compare_gt(v: &Value, expected: &str) -> bool {
    let a = v.as_f64().unwrap_or(0.0);
    let b = expected.parse::<f64>().unwrap_or(0.0);
    a > b
}

fn compare_lt(v: &Value, expected: &str) -> bool {
    let a = v.as_f64().unwrap_or(0.0);
    let b = expected.parse::<f64>().unwrap_or(0.0);
    a < b
}

fn compare_gte(v: &Value, expected: &str) -> bool {
    let a = v.as_f64().unwrap_or(0.0);
    let b = expected.parse::<f64>().unwrap_or(0.0);
    a >= b
}

fn compare_lte(v: &Value, expected: &str) -> bool {
    let a = v.as_f64().unwrap_or(0.0);
    let b = expected.parse::<f64>().unwrap_or(0.0);
    a <= b
}

fn compare_contains(v: &Value, expected: &str) -> bool {
    match v {
        Value::String(s) => s.contains(expected),
        Value::Array(arr) => arr.iter().any(|item| value_to_string(item) == expected),
        _ => false,
    }
}
