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
use std::time::{Duration, Instant};
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[derive(Clone)]
struct RateLimitBucket {
    timestamps: Vec<Instant>,
    last_seen: Instant,
}

/// Global rate limit state: run/node/client bucket → request timestamps.
static RATE_LIMIT_STATE: std::sync::LazyLock<std::sync::Mutex<HashMap<String, RateLimitBucket>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

const RATE_LIMIT_IDLE_TTL: Duration = Duration::from_secs(60 * 60);

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
            let bucket_key = rate_limit_bucket_key(&ctx.opts.run_key, ctx.node_id, &key);

            let (count, remaining, reset_ms) = {
                let mut state = RATE_LIMIT_STATE.lock().unwrap();
                prune_rate_limit_state(&mut state, now);
                let bucket = state.entry(bucket_key).or_insert_with(|| RateLimitBucket {
                    timestamps: Vec::new(),
                    last_seen: now,
                });
                bucket.last_seen = now;

                // Remove expired entries
                bucket.timestamps.retain(|t| now.duration_since(*t) < window);

                let count = bucket.timestamps.len() as u64;
                let remaining = max_requests.saturating_sub(count + 1);

                // Approximate reset time: when the oldest entry expires
                let reset_ms = if let Some(oldest) = bucket.timestamps.first() {
                    let elapsed = now.duration_since(*oldest);
                    window.saturating_sub(elapsed).as_millis() as u64
                } else {
                    window_ms
                };

                if count < max_requests {
                    bucket.timestamps.push(now);
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

fn rate_limit_bucket_key(run_key: &str, node_id: &str, client_key: &str) -> String {
    format!("{}\u{1f}{}\u{1f}{}", run_key, node_id, client_key)
}

fn prune_rate_limit_state(state: &mut HashMap<String, RateLimitBucket>, now: Instant) {
    state.retain(|_, bucket| {
        !bucket.timestamps.is_empty() || now.duration_since(bucket.last_seen) < RATE_LIMIT_IDLE_TTL
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_key_is_scoped_by_run_and_node() {
        let a = rate_limit_bucket_key("run-a", "node-1", "client");
        let b = rate_limit_bucket_key("run-b", "node-1", "client");
        let c = rate_limit_bucket_key("run-a", "node-2", "client");

        assert_ne!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn prune_removes_idle_empty_buckets() {
        let now = Instant::now();
        let mut state = HashMap::from([
            (
                "stale".to_string(),
                RateLimitBucket {
                    timestamps: Vec::new(),
                    last_seen: now - (RATE_LIMIT_IDLE_TTL + Duration::from_secs(1)),
                },
            ),
            (
                "active".to_string(),
                RateLimitBucket {
                    timestamps: vec![now],
                    last_seen: now,
                },
            ),
        ]);

        prune_rate_limit_state(&mut state, now);

        assert!(!state.contains_key("stale"));
        assert!(state.contains_key("active"));
    }
}
