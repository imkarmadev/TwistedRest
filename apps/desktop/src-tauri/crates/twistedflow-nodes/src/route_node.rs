//! Route node — multi-route dispatcher with path parameter extraction.
//!
//! Replaces cascading Route Match + If/Else chains with a single branch
//! node that dispatches to `exec-route:N` handles based on method + path:
//!
//!   HTTP Listen → Route → exec-route:0 (GET /users)
//!                       → exec-route:1 (GET /users/:id)
//!                       → exec-route:2 (POST /users)
//!                       → exec-notFound

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Route",
    type_id = "route",
    category = "HTTP Server",
    description = "Dispatch requests by method + path pattern with parameter extraction"
)]
pub struct RouteNode;

impl Node for RouteNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
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
            let raw_query = ctx
                .resolve_input("in:query")
                .await
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_default();

            let routes = ctx
                .node_data
                .get("routes")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            // Try each route in order
            for (i, route) in routes.iter().enumerate() {
                let method = route
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("GET")
                    .to_uppercase();
                let pattern = route.get("path").and_then(|v| v.as_str()).unwrap_or("/");

                let method_ok = method == "*" || method == actual_method;
                if !method_ok {
                    continue;
                }

                if let Some(params) = match_path(pattern, &actual_path) {
                    let query = parse_query(&raw_query);

                    // Store extracted params + query in outputs
                    {
                        let mut out = ctx.outputs.lock().await;
                        let entry = out.entry(ctx.node_id.to_string()).or_default();
                        entry.insert("params".into(), json!(params));
                        entry.insert("query".into(), json!(query));
                    }

                    return NodeResult::Branch {
                        handle: format!("exec-route:{}", i),
                        output: Some(json!({
                            "matched": i,
                            "params": params,
                            "query": query,
                        })),
                    };
                }
            }

            // No route matched — store empty params/query and go to notFound
            {
                let mut out = ctx.outputs.lock().await;
                let entry = out.entry(ctx.node_id.to_string()).or_default();
                entry.insert("params".into(), json!({}));
                entry.insert("query".into(), parse_query(&raw_query).into());
            }

            NodeResult::Branch {
                handle: "exec-notFound".to_string(),
                output: Some(json!({ "matched": null })),
            }
        })
    }
}

/// Match a route pattern against an actual path. Returns extracted params
/// if matched, or None if no match.
///
/// Supported patterns:
///   - `/users`           → exact match
///   - `/users/:id`       → captures `id` param
///   - `/users/:id/posts` → multiple segments with param
///   - `*`                → matches anything
///   - `/api/*`           → prefix match (wildcard tail)
fn match_path(pattern: &str, actual: &str) -> Option<HashMap<String, String>> {
    if pattern == "*" {
        return Some(HashMap::new());
    }

    let pat_segs: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let act_segs: Vec<&str> = actual.split('/').filter(|s| !s.is_empty()).collect();

    // Trailing wildcard: `/api/*` matches `/api/anything/here`
    if pat_segs.last() == Some(&"*") {
        let prefix = &pat_segs[..pat_segs.len() - 1];
        if act_segs.len() < prefix.len() {
            return None;
        }
        let mut params = HashMap::new();
        for (p, a) in prefix.iter().zip(act_segs.iter()) {
            if p.starts_with(':') {
                params.insert(p[1..].to_string(), a.to_string());
            } else if *p != *a {
                return None;
            }
        }
        return Some(params);
    }

    // Exact segment count required for non-wildcard patterns
    if pat_segs.len() != act_segs.len() {
        return None;
    }

    let mut params = HashMap::new();
    for (p, a) in pat_segs.iter().zip(act_segs.iter()) {
        if p.starts_with(':') {
            params.insert(p[1..].to_string(), a.to_string());
        } else if *p != *a {
            return None;
        }
    }

    Some(params)
}

/// Parse a query string like `page=2&limit=10` into a JSON object.
fn parse_query(raw: &str) -> Value {
    let raw = raw.trim_start_matches('?');
    if raw.is_empty() {
        return json!({});
    }

    let mut map = serde_json::Map::new();
    for pair in raw.split('&') {
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
