//! Parse Body node — parses request body by Content-Type.
//!
//! Pure data node that takes the raw body + headers from HTTP Listen
//! and returns the parsed value. Supports JSON, form-urlencoded, and text.
//!
//!   HTTP Listen out:body ──→ Parse Body out:parsed ──→ downstream
//!              out:headers ──→

use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Parse Body",
    type_id = "parseBody",
    category = "HTTP Server",
    description = "Parse request body as JSON, form-urlencoded, or text"
)]
pub struct ParseBodyNode;

impl Node for ParseBodyNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let body = ctx.resolve_input("in:body").await.unwrap_or(Value::Null);

            let body_str = match &body {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                other => serde_json::to_string(other).unwrap_or_default(),
            };

            let headers = ctx.resolve_input("in:headers").await.unwrap_or(Value::Null);

            let expect = ctx
                .node_data
                .get("expect")
                .and_then(|v| v.as_str())
                .unwrap_or("auto");

            // Determine content type
            let content_type = if expect == "auto" {
                detect_content_type(&headers)
            } else {
                expect.to_string()
            };

            let (parsed, actual_ct) = match content_type.as_str() {
                "json" => match serde_json::from_str::<Value>(&body_str) {
                    Ok(v) => (v, "application/json".to_string()),
                    Err(e) => {
                        return NodeResult::Error {
                            message: format!("Invalid JSON body: {}", e),
                            raw_response: Some(Value::String(body_str)),
                        };
                    }
                },
                "form" => {
                    let parsed = parse_form_urlencoded(&body_str);
                    (parsed, "application/x-www-form-urlencoded".to_string())
                }
                "text" => (Value::String(body_str), "text/plain".to_string()),
                _ => {
                    // Auto-detect: try JSON first, then treat as text
                    if let Ok(v) = serde_json::from_str::<Value>(&body_str) {
                        (v, "application/json".to_string())
                    } else {
                        (Value::String(body_str), "text/plain".to_string())
                    }
                }
            };

            // Store outputs
            {
                let mut out = ctx.outputs.lock().await;
                let entry = out.entry(ctx.node_id.to_string()).or_default();
                entry.insert("parsed".into(), parsed.clone());
                entry.insert("contentType".into(), Value::String(actual_ct));
            }

            NodeResult::Data(Some(parsed))
        })
    }
}

/// Detect content type from the headers object.
fn detect_content_type(headers: &Value) -> String {
    let ct = headers
        .get("content-type")
        .or_else(|| headers.get("Content-Type"))
        .or_else(|| headers.get("CONTENT-TYPE"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let ct_lower = ct.to_lowercase();
    if ct_lower.contains("application/json") {
        "json".to_string()
    } else if ct_lower.contains("application/x-www-form-urlencoded") {
        "form".to_string()
    } else if ct_lower.contains("text/") {
        "text".to_string()
    } else {
        "auto".to_string()
    }
}

/// Parse application/x-www-form-urlencoded body.
fn parse_form_urlencoded(body: &str) -> Value {
    let mut map = serde_json::Map::new();
    for pair in body.split('&') {
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or("");
        let val = parts.next().unwrap_or("");
        if !key.is_empty() {
            let decoded_key = urlencoding::decode(key).unwrap_or_else(|_| key.into());
            let decoded_val = urlencoding::decode(val).unwrap_or_else(|_| val.into());
            map.insert(
                decoded_key.into_owned(),
                Value::String(decoded_val.into_owned()),
            );
        }
    }
    Value::Object(map)
}
