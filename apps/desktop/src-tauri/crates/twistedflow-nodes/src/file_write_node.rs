//! File Write node — writes content to a file, creating parent directories as needed.

use twistedflow_macros::node;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_engine::render_template;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;

#[node(
    name = "File Write",
    type_id = "fileWrite",
    category = "System",
    description = "Write content to a file"
)]
pub struct FileWriteNode;

impl Node for FileWriteNode {
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
                        message: "File Write: no path specified".into(),
                        raw_response: None,
                    };
                }
            };

            // Resolve in:content first, then all inputs for template rendering
            let content_value = ctx.resolve_input("in:content").await.unwrap_or(Value::Null);
            let input_values = ctx.resolve_all_inputs().await;
            let rendered_path = render_template(&path_template, &input_values);

            // Serialise content to a string
            let content_string = match &content_value {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                v => match serde_json::to_string_pretty(v) {
                    Ok(s) => s,
                    Err(e) => {
                        return NodeResult::Error {
                            message: format!("File Write: failed to serialise content: {}", e),
                            raw_response: None,
                        };
                    }
                },
            };

            // Ensure parent directories exist
            if let Some(parent) = Path::new(&rendered_path).parent() {
                if !parent.as_os_str().is_empty() {
                    if let Err(e) = tokio::fs::create_dir_all(parent).await {
                        return NodeResult::Error {
                            message: format!(
                                "File Write: could not create directories '{}': {}",
                                parent.display(),
                                e
                            ),
                            raw_response: None,
                        };
                    }
                }
            }

            let bytes = content_string.as_bytes().len();

            // Write the file
            if let Err(e) = tokio::fs::write(&rendered_path, content_string.as_bytes()).await {
                return NodeResult::Error {
                    message: format!("File Write: could not write '{}': {}", rendered_path, e),
                    raw_response: None,
                };
            }

            let mut out: HashMap<String, Value> = HashMap::new();
            out.insert("path".into(), json!(rendered_path));
            out.insert("bytes".into(), json!(bytes));

            ctx.set_outputs(out.clone()).await;

            NodeResult::Continue {
                output: serde_json::to_value(&out).ok(),
            }
        })
    }
}
