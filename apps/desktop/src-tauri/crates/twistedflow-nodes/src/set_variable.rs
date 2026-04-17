//! Set Variable node — writes a named, typed runtime variable.
//! Exec node: exec-in → exec-out, data input "in:value".

use twistedflow_macros::node;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use serde_json::Value;
use std::future::Future;
use std::pin::Pin;

#[node(
    name = "Set Variable",
    type_id = "setVariable",
    category = "Variables",
    description = "Set a runtime variable within the flow"
)]
pub struct SetVariableNode;

impl Node for SetVariableNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let var_name = ctx
                .node_data
                .get("varName")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if var_name.is_empty() {
                return NodeResult::Error {
                    message: "Set Variable: no variable name specified".into(),
                    raw_response: None,
                };
            }

            // Resolve value: prefer wired input pin, fall back to literal config.
            // Check if there's actually a data edge to in:value first — if not,
            // skip the resolve entirely (avoids potential re-execution via the
            // lazy data resolution system which can't handle exec nodes).
            let has_value_edge = ctx.index.data_source(ctx.node_id, "in:value").is_some();

            let value = if has_value_edge {
                ctx.resolve_input("in:value").await.unwrap_or(Value::Null)
            } else {
                // Read literal value from node config
                let raw = ctx.node_data.get("value")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let val_type = ctx.node_data.get("valueType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("string");
                if raw.is_empty() {
                    Value::Null
                } else {
                    match val_type {
                        "number" => raw.parse::<f64>()
                            .map(|n| serde_json::json!(n))
                            .unwrap_or(Value::String(raw.to_string())),
                        "boolean" => match raw {
                            "true" | "1" => Value::Bool(true),
                            _ => Value::Bool(false),
                        },
                        "json" => serde_json::from_str(raw)
                            .unwrap_or(Value::String(raw.to_string())),
                        _ => Value::String(raw.to_string()),
                    }
                }
            };

            // Store in the runtime variables namespace.
            // We use a special prefix "__var:" in the outputs to distinguish
            // flow variables from node outputs. Get Variable reads from this.
            {
                let mut out = ctx.outputs.lock().await;
                out.entry("__variables__".to_string())
                    .or_default()
                    .insert(var_name.to_string(), value.clone());
            }

            NodeResult::Continue {
                output: Some(serde_json::json!({ "variable": var_name, "value": value })),
            }
        })
    }
}
