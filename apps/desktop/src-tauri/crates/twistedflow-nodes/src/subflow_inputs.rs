//! SubflowInputs — the entry node of a subflow. Its outputs are pre-seeded
//! by `call_subflow` with the values passed in from the caller, then the
//! exec chain starts from this node's `exec-out` (or the first exec output
//! pin in the interface).
//!
//! The node itself does nothing on execute — seeding happens upstream.

use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Inputs",
    type_id = "subflowInputs",
    category = "Subflow",
    description = "Subflow entry — exposes the declared input pins"
)]
pub struct SubflowInputsNode;

impl Node for SubflowInputsNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let _ = ctx;
            NodeResult::Continue { output: None }
        })
    }
}
