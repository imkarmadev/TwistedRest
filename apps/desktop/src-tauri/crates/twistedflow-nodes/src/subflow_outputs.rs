//! SubflowOutputs — terminal return node of a subflow. Resolves all its
//! data input pins, records them plus the configured branch name into the
//! outputs cache. `call_subflow` reads the cache after the chain finishes
//! and routes the caller's matching exec-out branch.
//!
//! Subflow shape (v1.5.0): 0 or 1 exec-in on the subflow side (single
//! entry, pure function), 0..N exec-outs (each a named return branch).
//! Config: `{ branch: "<name>" }` selects which exec output on the
//! caller fires when this node is reached. Defaults to the first declared
//! exec output when config is empty.

use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Outputs",
    type_id = "subflowOutputs",
    category = "Subflow",
    description = "Subflow return — collect values and pick the branch"
)]
pub struct SubflowOutputsNode;

impl Node for SubflowOutputsNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let data_inputs = ctx.resolve_all_inputs().await;
            let branch = ctx
                .node_data
                .get("branch")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // Cache data inputs + branch under this node's id. Keyed with a
            // leading underscore so it can't collide with a user-declared pin.
            let mut values = data_inputs;
            values.insert("__branch__".to_string(), serde_json::Value::String(branch));
            ctx.set_outputs(values).await;

            NodeResult::Continue { output: None }
        })
    }
}
