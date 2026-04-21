//! Match node — routes execution to a branch based on a value comparison.

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Match",
    type_id = "match",
    category = "Flow Control",
    description = "Route execution based on a value"
)]
pub struct MatchNode;

impl Node for MatchNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let match_value = ctx.resolve_input("in:value").await;
            let match_str = value_to_string(match_value.as_ref().unwrap_or(&Value::Null));

            let cases = ctx
                .node_data
                .get("cases")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let mut matched_handle = "exec-default".to_string();
            for (i, case) in cases.iter().enumerate() {
                let case_val = case.get("value").and_then(|v| v.as_str()).unwrap_or("");
                if match_str == case_val {
                    matched_handle = format!("exec-case:{}", i);
                    break;
                }
            }

            NodeResult::Branch {
                handle: matched_handle.clone(),
                output: Some(json!({
                    "value": match_value,
                    "matched": matched_handle,
                })),
            }
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
