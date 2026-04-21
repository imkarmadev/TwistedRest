//! Redirect node — sends an HTTP redirect response.
//!
//! Thin wrapper around the response channel system. Sends a Location
//! header with the configured status code (301/302/307/308).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

use crate::http_listen;

#[node(
    name = "Redirect",
    type_id = "redirect",
    category = "HTTP Server",
    description = "Send an HTTP redirect (301/302/307/308) with Location header"
)]
pub struct RedirectNode;

impl Node for RedirectNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let status = ctx
                .node_data
                .get("status")
                .and_then(|v| v.as_u64())
                .unwrap_or(302) as u16;

            // Resolve URL from input pin or config
            let url = if let Some(Value::String(u)) = ctx.resolve_input("in:url").await {
                u
            } else {
                ctx.node_data
                    .get("url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("/")
                    .to_string()
            };

            // Find _requestId
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
                let mut headers = HashMap::new();
                headers.insert("Location".to_string(), url.clone());

                let sent = http_listen::send_response(
                    req_id,
                    http_listen::HttpResponseData {
                        status,
                        headers,
                        body: String::new(),
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
                    message:
                        "No _requestId found — Redirect must be inside an HTTP Listen handler chain"
                            .into(),
                    raw_response: None,
                };
            }

            NodeResult::Continue {
                output: Some(json!({
                    "status": status,
                    "location": url,
                })),
            }
        })
    }
}
