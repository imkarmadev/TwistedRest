//! File Read node — reads a file from disk, parses JSON if possible.

use twistedflow_macros::node;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_engine::render_template;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

#[node(
    name = "File Read",
    type_id = "fileRead",
    category = "System",
    description = "Read a file from disk"
)]
pub struct FileReadNode;

impl Node for FileReadNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let path_template = match ctx
                .node_data
                .get("path")
                .and_then(|v| v.as_str())
            {
                Some(p) if !p.is_empty() => p.to_string(),
                _ => {
                    return NodeResult::Error {
                        message: "File Read: no path specified".into(),
                        raw_response: None,
                    };
                }
            };

            // Resolve all in:* inputs for template rendering
            let input_values = ctx.resolve_all_inputs().await;
            let rendered_path = render_template(&path_template, &input_values);

            // Read the file
            let raw: String = match tokio::fs::read_to_string(&rendered_path).await {
                Ok(s) => s,
                Err(e) => {
                    return NodeResult::Error {
                        message: format!("File Read: could not read '{}': {}", rendered_path, e),
                        raw_response: None,
                    };
                }
            };

            // Try to parse as JSON; fall back to plain string
            let content: Value = serde_json::from_str(&raw)
                .unwrap_or_else(|_| Value::String(raw));

            let mut out: HashMap<String, Value> = HashMap::new();
            out.insert("content".into(), content);
            out.insert("path".into(), json!(rendered_path));

            ctx.set_outputs(out.clone()).await;

            NodeResult::Continue {
                output: serde_json::to_value(&out).ok(),
            }
        })
    }
}
