//! Break Object node — destructure an object into individual pins.
//!
//! The executor's `resolve_pin_value` handles BreakObject inline: it resolves
//! `in:object` and extracts `object[source_pin]` using the requested output pin
//! name. This node struct exists for registry/metadata. Its `execute` method
//! resolves the upstream object and returns it whole; the executor extracts the
//! specific field by pin name.

use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

use std::future::Future;
use std::pin::Pin;

#[node(
    name = "Break Object",
    type_id = "breakObject",
    category = "Data",
    description = "Destructure an object into individual pins"
)]
pub struct BreakObjectNode;

impl Node for BreakObjectNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            // Resolve the upstream object. The executor's resolve_pin_value
            // extracts the specific field by matching the requested output pin
            // name against the object's keys — so we return the whole object
            // and let it do that work.
            let object = ctx.resolve_input("in:object").await;
            NodeResult::Data(object)
        })
    }
}
