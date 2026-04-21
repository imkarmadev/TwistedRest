//! Retry node — re-execute a sub-chain with configurable retries and backoff.
//!
//! Exec node. Runs the exec-body sub-chain. If it fails, retries up to
//! maxRetries times with exponential backoff. If all attempts fail, either
//! errors out or takes the exec-failed branch.
//!
//! Flow pattern:
//!   Start → Retry
//!             ├── exec-body → HTTP Request → ... (may fail)
//!             ├── exec-out  → next (on success)
//!             └── exec-failed → error handler (optional)

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Retry",
    type_id = "retry",
    category = "Flow Control",
    description = "Retry a sub-chain with exponential backoff on failure"
)]
pub struct RetryNode;

impl Node for RetryNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let max_retries = ctx
                .node_data
                .get("maxRetries")
                .and_then(|v| v.as_u64())
                .unwrap_or(3) as u32;

            let initial_delay_ms = ctx
                .node_data
                .get("delayMs")
                .and_then(|v| v.as_u64())
                .unwrap_or(1000);

            let backoff_multiplier = ctx
                .node_data
                .get("backoffMultiplier")
                .and_then(|v| v.as_f64())
                .unwrap_or(2.0);

            // Find exec-body target
            let body_target = ctx.index.next_exec(ctx.node_id, "exec-body");
            if body_target.is_none() {
                return NodeResult::Error {
                    message: "Retry: no exec-body chain connected".into(),
                    raw_response: None,
                };
            }

            let mut last_error = String::new();
            let mut delay_ms = initial_delay_ms;

            for attempt in 0..=max_retries {
                if ctx.opts.cancel.is_cancelled() {
                    return NodeResult::Error {
                        message: "Retry: cancelled".into(),
                        raw_response: None,
                    };
                }

                if attempt > 0 {
                    ctx.emit_log(
                        "Retry",
                        json!({
                            "attempt": attempt,
                            "maxRetries": max_retries,
                            "delayMs": delay_ms,
                        }),
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    delay_ms = (delay_ms as f64 * backoff_multiplier) as u64;
                }

                let body_id = ctx
                    .index
                    .next_exec(ctx.node_id, "exec-body")
                    .unwrap()
                    .to_string();
                let result = ctx.run_chain_sync(body_id).await;

                match result {
                    Ok(()) => {
                        // Success — store attempt info and continue
                        let mut out: HashMap<String, Value> = HashMap::new();
                        out.insert("attempts".into(), json!(attempt + 1));
                        out.insert("succeeded".into(), Value::Bool(true));
                        ctx.set_outputs(out).await;

                        return NodeResult::Continue {
                            output: Some(json!({
                                "attempts": attempt + 1,
                                "succeeded": true,
                            })),
                        };
                    }
                    Err(e) => {
                        last_error = e;
                    }
                }
            }

            // All retries exhausted
            let mut out: HashMap<String, Value> = HashMap::new();
            out.insert("attempts".into(), json!(max_retries + 1));
            out.insert("succeeded".into(), Value::Bool(false));
            out.insert("error".into(), Value::String(last_error.clone()));
            ctx.set_outputs(out).await;

            // Check if there's an exec-failed branch
            if ctx.index.next_exec(ctx.node_id, "exec-failed").is_some() {
                return NodeResult::Branch {
                    handle: "exec-failed".into(),
                    output: Some(json!({
                        "attempts": max_retries + 1,
                        "succeeded": false,
                        "error": last_error,
                    })),
                };
            }

            NodeResult::Error {
                message: format!(
                    "Retry: all {} attempts failed. Last error: {}",
                    max_retries + 1,
                    last_error
                ),
                raw_response: None,
            }
        })
    }
}
