//! Set Headers node — builds a response headers object from config + templates.
//!
//! Pure data node. Wire the `out:headers` output into Send Response's
//! `in:headers` pin to compose dynamic response headers.
//!
//!   Env Var (token) ──→ Set Headers out:headers ──→ Send Response in:headers

use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Set Headers",
    type_id = "setHeaders",
    category = "HTTP Server",
    description = "Build response headers from key-value pairs with #{template} support"
)]
pub struct SetHeadersNode;

impl Node for SetHeadersNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let inputs = ctx.resolve_all_inputs().await;

            // Start with merge base (if wired)
            let mut headers = serde_json::Map::new();
            if let Some(Value::Object(base)) = inputs.get("merge") {
                for (k, v) in base {
                    let val_str = match v {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    headers.insert(k.clone(), Value::String(val_str));
                }
            }

            // Apply configured headers with template rendering
            if let Some(Value::Array(arr)) = ctx.node_data.get("headers") {
                for h in arr {
                    let enabled = h.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                    if !enabled {
                        continue;
                    }

                    let key = h.get("key").and_then(|v| v.as_str()).unwrap_or("");
                    let val_template = h.get("value").and_then(|v| v.as_str()).unwrap_or("");

                    if key.is_empty() {
                        continue;
                    }

                    // Render #{name} tokens from input pins
                    let rendered = render_template(val_template, &inputs);
                    headers.insert(key.to_string(), Value::String(rendered));
                }
            }

            let result = Value::Object(headers.clone());

            {
                let mut out = ctx.outputs.lock().await;
                let entry = out.entry(ctx.node_id.to_string()).or_default();
                entry.insert("headers".into(), result.clone());
            }

            NodeResult::Data(Some(result))
        })
    }
}

/// Simple #{name} template renderer using resolved input values.
fn render_template(template: &str, inputs: &std::collections::HashMap<String, Value>) -> String {
    let mut result = template.to_string();
    for (key, val) in inputs {
        let placeholder = format!("#{{{}}}", key);
        let replacement = match val {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        result = result.replace(&placeholder, &replacement);
    }
    result
}
