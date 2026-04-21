//! Try/Catch node — error handling for sub-chains.
//!
//! Runs the `exec-try` branch. If any node in that branch errors,
//! catches the error and fires the `exec-catch` branch instead of
//! halting the flow. The error message is available on `out:error`.
//!
//! After try (success) or catch (recovery), continues to `exec-out`.

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Try/Catch",
    type_id = "tryCatch",
    category = "Flow Control",
    description = "Run a chain, catch errors instead of halting"
)]
pub struct TryCatchNode;

impl Node for TryCatchNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            // Find the try branch start
            let try_start = ctx.index.next_exec(ctx.node_id, "exec-try");

            let mut error_msg: Option<String> = None;

            if let Some(try_id) = try_start {
                // Run the try branch — if it errors, we catch it
                let result = ctx.run_chain_sync(try_id.to_owned()).await;
                if let Err(msg) = result {
                    error_msg = Some(msg);
                }
            }

            // Store the error (or null) as output
            {
                let mut out = ctx.outputs.lock().await;
                let entry = out.entry(ctx.node_id.to_string()).or_default();
                entry.insert(
                    "error".to_string(),
                    match &error_msg {
                        Some(msg) => Value::String(msg.clone()),
                        None => Value::Null,
                    },
                );
            }

            if let Some(ref msg) = error_msg {
                // Error occurred — fire catch branch
                let catch_start = ctx.index.next_exec(ctx.node_id, "exec-catch");
                if let Some(catch_id) = catch_start {
                    // Ignore errors in the catch branch itself
                    let _ = ctx.run_chain_sync(catch_id.to_owned()).await;
                }

                // Report that we caught an error but recovered
                NodeResult::Continue {
                    output: Some(json!({
                        "caught": true,
                        "error": msg,
                    })),
                }
            } else {
                // No error — continue normally
                NodeResult::Continue {
                    output: Some(json!({
                        "caught": false,
                        "error": null,
                    })),
                }
            }
        })
    }
}
