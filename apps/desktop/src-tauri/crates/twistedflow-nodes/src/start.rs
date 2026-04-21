//! Start node — flow entry point. Does nothing; the executor marks it ok before chain starts.

use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Start",
    type_id = "start",
    category = "Flow Control",
    description = "Flow entry point"
)]
pub struct StartNode;

impl Node for StartNode {
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
