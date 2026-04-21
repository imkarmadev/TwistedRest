//! Env Var node — reads a value from the .env file (selected environment).
//!
//! Pre-seeded by the executor from `ExecContext::env_vars` before the chain
//! starts. Missing keys return null (not an error — env vars are optional config).

use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Env Var",
    type_id = "envVar",
    category = "Variables",
    description = "Read an environment variable"
)]
pub struct EnvVarNode;

impl Node for EnvVarNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            // The value was pre-seeded (and may have been patched by EnvSetter).
            // Read it directly from the shared outputs cache.
            let value = ctx
                .get_outputs(ctx.node_id)
                .await
                .and_then(|map| map.get("value").cloned());

            NodeResult::Data(value)
        })
    }
}
