//! Send Response node — sends an HTTP response back to the client.
//!
//! Reads _requestId from the OnEvent payload to find the correct
//! response channel, then writes status + body to it.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

use crate::http_listen;

#[node(
    name = "Send Response",
    type_id = "sendResponse",
    category = "HTTP Server",
    description = "Send an HTTP response back to the client"
)]
pub struct SendResponseNode;

impl Node for SendResponseNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            // Read status
            let status = if let Some(val) = ctx.resolve_input("in:status").await {
                val.as_u64().unwrap_or(200) as u16
            } else {
                ctx.node_data
                    .get("status")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(200) as u16
            };

            // Read body
            let body = ctx.resolve_input("in:body").await.unwrap_or(Value::Null);
            let body_str = match &body {
                Value::String(s) => s.clone(),
                Value::Null => String::new(),
                other => serde_json::to_string(other).unwrap_or_default(),
            };

            // Read headers from config
            let mut headers = HashMap::new();
            if let Some(Value::Array(arr)) = ctx.node_data.get("headers") {
                for h in arr {
                    let key = h.get("key").and_then(|v| v.as_str()).unwrap_or("");
                    let val = h.get("value").and_then(|v| v.as_str()).unwrap_or("");
                    if !key.is_empty() {
                        headers.insert(key.to_string(), val.to_string());
                    }
                }
            }

            // Merge dynamically wired headers (overrides static config)
            if let Some(Value::Object(obj)) = ctx.resolve_input("in:headers").await {
                for (k, v) in obj {
                    let val_str = match &v {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    headers.insert(k, val_str);
                }
            }

            // Find the _requestId from the OnEvent listener's outputs.
            // The HTTP Listen node puts it in the event payload.
            let request_id = {
                let out = ctx.outputs.lock().await;
                let mut found = None;
                for (_node_id, node_out) in out.iter() {
                    if let Some(Value::String(id)) = node_out.get("_requestId") {
                        found = Some(id.clone());
                        break;
                    }
                }
                found
            };

            if let Some(req_id) = &request_id {
                let sent = http_listen::send_response(
                    req_id,
                    http_listen::HttpResponseData {
                        status,
                        headers,
                        body: body_str.clone(),
                    },
                );
                if !sent {
                    return NodeResult::Error {
                        message: format!("Response channel not found for request {}", req_id),
                        raw_response: None,
                    };
                }
            } else {
                return NodeResult::Error {
                    message: "No _requestId found — Send Response must be inside an HTTP Listen handler chain".into(),
                    raw_response: None,
                };
            }

            NodeResult::Continue {
                output: Some(json!({
                    "status": status,
                    "bodyLength": body_str.len(),
                })),
            }
        })
    }
}
