//! ForEach nodes — sequential and parallel array iteration.

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Mutex;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult, Outputs};
use twistedflow_macros::node;

// ── Sequential ───────────────────────────────────────────────────────

#[node(
    name = "ForEach Sequential",
    type_id = "forEachSequential",
    category = "Flow Control",
    description = "Iterate an array sequentially"
)]
pub struct ForEachSeqNode;

impl Node for ForEachSeqNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let array_value = ctx.resolve_input("in:array").await;

            let items = match array_value {
                Some(Value::Array(arr)) => arr,
                other => {
                    let got = other
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "null".into());
                    return NodeResult::Error {
                        message: format!("ForEach input is not an array (got {})", got),
                        raw_response: None,
                    };
                }
            };

            let body_start = ctx
                .index
                .next_exec(ctx.node_id, "exec-body")
                .map(|s| s.to_owned());
            let node_id = ctx.node_id.to_owned();

            for (i, item) in items.iter().enumerate() {
                {
                    let mut out = ctx.outputs.lock().await;
                    let entry = out.entry(node_id.clone()).or_default();
                    entry.insert("item".into(), item.clone());
                    entry.insert("index".into(), json!(i));
                }

                if let Some(ref body_id) = body_start {
                    let _ = ctx.run_chain_sync(body_id.clone()).await;
                }
            }

            // Clear iteration state
            {
                let mut out = ctx.outputs.lock().await;
                let entry = out.entry(node_id.clone()).or_default();
                entry.insert("item".into(), Value::Null);
                entry.insert("index".into(), Value::Null);
            }

            NodeResult::Continue { output: None }
        })
    }
}

// ── Parallel ─────────────────────────────────────────────────────────

#[node(
    name = "ForEach Parallel",
    type_id = "forEachParallel",
    category = "Flow Control",
    description = "Iterate an array in parallel"
)]
pub struct ForEachParNode;

impl Node for ForEachParNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let array_value = ctx.resolve_input("in:array").await;

            let items = match array_value {
                Some(Value::Array(arr)) => arr,
                other => {
                    let got = other
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "null".into());
                    return NodeResult::Error {
                        message: format!("ForEach input is not an array (got {})", got),
                        raw_response: None,
                    };
                }
            };

            let body_start = ctx
                .index
                .next_exec(ctx.node_id, "exec-body")
                .map(|s| s.to_owned());
            let node_id = ctx.node_id.to_owned();

            let mut handles = Vec::with_capacity(items.len());

            for (i, item) in items.iter().enumerate() {
                // Clone parent outputs into an isolated map for this iteration
                let local_outputs: Arc<Mutex<Outputs>> = {
                    let parent = ctx.outputs.lock().await;
                    let mut local = parent.clone();
                    let entry = local.entry(node_id.clone()).or_default();
                    entry.insert("item".into(), item.clone());
                    entry.insert("index".into(), json!(i));
                    Arc::new(Mutex::new(local))
                };

                if let Some(ref body_id) = body_start {
                    let opts = ctx.opts.clone();
                    let bg = ctx.bg_tasks.clone();
                    let tl = ctx.tap_logs.clone();
                    let body_id = body_id.clone();
                    handles.push(tokio::spawn(async move {
                        let _ = twistedflow_engine::executor::run_chain(
                            body_id,
                            opts,
                            local_outputs,
                            bg,
                            tl,
                        )
                        .await;
                    }));
                }
            }

            for h in handles {
                let _ = h.await;
            }

            // Clear iteration state on the parent outputs
            {
                let mut out = ctx.outputs.lock().await;
                let entry = out.entry(node_id).or_default();
                entry.insert("item".into(), Value::Null);
                entry.insert("index".into(), Value::Null);
            }

            NodeResult::Continue { output: None }
        })
    }
}
