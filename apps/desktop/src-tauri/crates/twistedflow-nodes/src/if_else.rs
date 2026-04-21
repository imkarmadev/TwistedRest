//! If/Else node — boolean branching.
//!
//! Resolves `in:condition`, evaluates truthiness, fires either
//! `exec-true` or `exec-false` branch. Terminates the current chain
//! (like Match — the branch runs its own sub-chain).

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "If/Else",
    type_id = "ifElse",
    category = "Flow Control",
    description = "Branch on a boolean condition"
)]
pub struct IfElseNode;

impl Node for IfElseNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let condition = ctx.resolve_input("in:condition").await;

            let is_true = match &condition {
                Some(Value::Bool(b)) => *b,
                Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
                Some(Value::String(s)) => {
                    let lower = s.to_lowercase();
                    lower != "false" && lower != "0" && !lower.is_empty()
                }
                Some(Value::Null) | None => false,
                Some(Value::Array(a)) => !a.is_empty(),
                Some(Value::Object(o)) => !o.is_empty(),
            };

            let handle = if is_true { "exec-true" } else { "exec-false" };

            NodeResult::Branch {
                handle: handle.to_string(),
                output: Some(json!({
                    "condition": condition,
                    "branch": handle,
                })),
            }
        })
    }
}
