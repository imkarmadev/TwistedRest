//! Route Match node — filters HTTP requests by method and path pattern.
//!
//! Used in combination with If/Else to route requests:
//!   HTTP Listen → Route Match (GET /health) → If/Else → handler chain

use serde_json::Value;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Route Match",
    type_id = "routeMatch",
    category = "HTTP Server",
    description = "Check if a request matches a method and path pattern"
)]
pub struct RouteMatchNode;

impl Node for RouteMatchNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let expected_method = ctx
                .node_data
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("GET")
                .to_uppercase();
            let expected_path = ctx
                .node_data
                .get("path")
                .and_then(|v| v.as_str())
                .unwrap_or("/");

            let actual_method = ctx
                .resolve_input("in:method")
                .await
                .and_then(|v| v.as_str().map(|s| s.to_uppercase()))
                .unwrap_or_default();
            let actual_path = ctx
                .resolve_input("in:path")
                .await
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_default();

            // Simple path matching — exact match or wildcard "*"
            let method_match = expected_method == "*" || expected_method == actual_method;
            let path_match = expected_path == "*"
                || expected_path == actual_path
                || (expected_path.ends_with("/*")
                    && actual_path.starts_with(&expected_path[..expected_path.len() - 1]));

            let matched = method_match && path_match;

            // Store result as output
            {
                let mut out = ctx.outputs.lock().await;
                out.entry(ctx.node_id.to_string())
                    .or_default()
                    .insert("matched".into(), Value::Bool(matched));
            }

            NodeResult::Data(Some(Value::Bool(matched)))
        })
    }
}
