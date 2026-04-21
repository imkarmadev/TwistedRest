//! CORS node — handles cross-origin resource sharing.
//!
//! Branch node that splits OPTIONS preflight from normal requests:
//!
//!   HTTP Listen → CORS
//!                  ├── exec-preflight → Send Response (204, corsHeaders)
//!                  └── exec-request  → Route → ... handlers
//!
//! The `out:corsHeaders` output provides headers to merge into every response.

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "CORS",
    type_id = "cors",
    category = "HTTP Server",
    description = "Handle CORS preflight and inject Access-Control headers"
)]
pub struct CorsNode;

impl Node for CorsNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let method = ctx
                .resolve_input("in:method")
                .await
                .and_then(|v| v.as_str().map(|s| s.to_uppercase()))
                .unwrap_or_default();

            let headers = ctx.resolve_input("in:headers").await.unwrap_or(Value::Null);

            // Read config
            let allow_origins = ctx
                .node_data
                .get("allowOrigins")
                .and_then(|v| v.as_str())
                .unwrap_or("*");
            let allow_methods = ctx
                .node_data
                .get("allowMethods")
                .and_then(|v| v.as_str())
                .unwrap_or("GET, POST, PUT, DELETE, PATCH, OPTIONS");
            let allow_headers = ctx
                .node_data
                .get("allowHeaders")
                .and_then(|v| v.as_str())
                .unwrap_or("Content-Type, Authorization");
            let max_age = ctx
                .node_data
                .get("maxAge")
                .and_then(|v| v.as_u64())
                .unwrap_or(86400);
            let allow_credentials = ctx
                .node_data
                .get("allowCredentials")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            // Determine the Origin header from the request
            let origin = headers
                .get("origin")
                .or_else(|| headers.get("Origin"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            // Build Access-Control-Allow-Origin
            let resolved_origin = if allow_origins == "*" && !allow_credentials {
                "*".to_string()
            } else if allow_origins == "*" {
                // credentials + wildcard: reflect the request origin
                origin.to_string()
            } else {
                // Check if request origin is in the allowed list
                let allowed: Vec<&str> = allow_origins.split(',').map(|s| s.trim()).collect();
                if allowed.contains(&origin) {
                    origin.to_string()
                } else {
                    // Origin not allowed — still set headers but with empty origin
                    String::new()
                }
            };

            // Build CORS headers object
            let mut cors = serde_json::Map::new();
            if !resolved_origin.is_empty() {
                cors.insert(
                    "Access-Control-Allow-Origin".into(),
                    Value::String(resolved_origin),
                );
            }
            cors.insert(
                "Access-Control-Allow-Methods".into(),
                Value::String(allow_methods.to_string()),
            );
            cors.insert(
                "Access-Control-Allow-Headers".into(),
                Value::String(allow_headers.to_string()),
            );
            cors.insert(
                "Access-Control-Max-Age".into(),
                Value::String(max_age.to_string()),
            );
            if allow_credentials {
                cors.insert(
                    "Access-Control-Allow-Credentials".into(),
                    Value::String("true".into()),
                );
            }

            let cors_headers = Value::Object(cors);

            // Store output
            {
                let mut out = ctx.outputs.lock().await;
                let entry = out.entry(ctx.node_id.to_string()).or_default();
                entry.insert("corsHeaders".into(), cors_headers.clone());
            }

            // Branch: OPTIONS → preflight, everything else → request
            if method == "OPTIONS" {
                NodeResult::Branch {
                    handle: "exec-preflight".to_string(),
                    output: Some(json!({ "preflight": true, "corsHeaders": cors_headers })),
                }
            } else {
                NodeResult::Branch {
                    handle: "exec-request".to_string(),
                    output: Some(json!({ "preflight": false, "corsHeaders": cors_headers })),
                }
            }
        })
    }
}
