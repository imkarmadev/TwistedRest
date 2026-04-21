//! Rate Limit node — in-memory sliding window rate limiter.
//!
//! Branch node that checks request rate per client key:
//!
//!   Verify Auth → Rate Limit
//!                  ├── exec-pass    → Route → handlers
//!                  └── exec-limited → Send Response (429, rateLimitHeaders)

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

/// Global rate limit state: key → list of request timestamps.
static RATE_LIMIT_STATE: std::sync::LazyLock<std::sync::Mutex<HashMap<String, Vec<Instant>>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

#[node(
    name = "Rate Limit",
    type_id = "rateLimit",
    category = "HTTP Server",
    description = "Sliding window rate limiter with per-key tracking"
)]
pub struct RateLimitNode;

impl Node for RateLimitNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let window_ms = ctx
                .node_data
                .get("windowMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(60_000);
            let max_requests = ctx
                .node_data
                .get("maxRequests")
                .and_then(|v| v.as_u64())
                .unwrap_or(100);

            // Determine the rate limit key
            let key = if let Some(Value::String(k)) = ctx.resolve_input("in:key").await {
                k
            } else {
                let key_source = ctx
                    .node_data
                    .get("keySource")
                    .and_then(|v| v.as_str())
                    .unwrap_or("ip");

                let headers = ctx.resolve_input("in:headers").await.unwrap_or(Value::Null);

                match key_source {
                    "header" => {
                        let header_name = ctx
                            .node_data
                            .get("keyHeader")
                            .and_then(|v| v.as_str())
                            .unwrap_or("X-Forwarded-For");
                        headers
                            .get(header_name)
                            .or_else(|| headers.get(&header_name.to_lowercase()))
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string()
                    }
                    _ => {
                        // "ip" — try common forwarding headers
                        headers
                            .get("x-forwarded-for")
                            .or_else(|| headers.get("X-Forwarded-For"))
                            .or_else(|| headers.get("x-real-ip"))
                            .or_else(|| headers.get("X-Real-Ip"))
                            .and_then(|v| v.as_str())
                            .map(|s| {
                                // X-Forwarded-For can be comma-separated; use first
                                s.split(',').next().unwrap_or("unknown").trim().to_string()
                            })
                            .unwrap_or_else(|| "unknown".to_string())
                    }
                }
            };

            let window = std::time::Duration::from_millis(window_ms);
            let now = Instant::now();

            let (count, remaining, reset_ms) = {
                let mut state = RATE_LIMIT_STATE.lock().unwrap();
                let timestamps = state.entry(key.clone()).or_default();

                // Remove expired entries
                timestamps.retain(|t| now.duration_since(*t) < window);

                let count = timestamps.len() as u64;
                let remaining = max_requests.saturating_sub(count + 1);

                // Approximate reset time: when the oldest entry expires
                let reset_ms = if let Some(oldest) = timestamps.first() {
                    let elapsed = now.duration_since(*oldest);
                    window.saturating_sub(elapsed).as_millis() as u64
                } else {
                    window_ms
                };

                if count < max_requests {
                    timestamps.push(now);
                }

                (count, remaining, reset_ms)
            };

            // Build rate limit headers
            let rate_headers = json!({
                "X-RateLimit-Limit": max_requests.to_string(),
                "X-RateLimit-Remaining": remaining.to_string(),
                "X-RateLimit-Reset": (reset_ms / 1000).to_string(),
            });

            // Store outputs
            {
                let mut out = ctx.outputs.lock().await;
                let entry = out.entry(ctx.node_id.to_string()).or_default();
                entry.insert("remaining".into(), json!(remaining));
                entry.insert("resetMs".into(), json!(reset_ms));
                entry.insert("rateLimitHeaders".into(), rate_headers.clone());
            }

            if count < max_requests {
                NodeResult::Branch {
                    handle: "exec-pass".to_string(),
                    output: Some(json!({
                        "remaining": remaining,
                        "rateLimitHeaders": rate_headers,
                    })),
                }
            } else {
                NodeResult::Branch {
                    handle: "exec-limited".to_string(),
                    output: Some(json!({
                        "remaining": 0,
                        "rateLimitHeaders": rate_headers,
                    })),
                }
            }
        })
    }
}
