//! Template node — string interpolation with #{var} syntax.
//!
//! Pure data node. Takes a template string and resolves #{name} tokens
//! from wired input pins — same syntax as HTTP Request templates.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_engine::render_template;
use twistedflow_macros::node;

#[node(
    name = "Template",
    type_id = "template",
    category = "String",
    description = "String interpolation with #{var} tokens from wired inputs"
)]
pub struct TemplateNode;

impl Node for TemplateNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let template = ctx
                .node_data
                .get("template")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let input_values = ctx.resolve_all_inputs().await;
            let rendered = render_template(&template, &input_values);

            let mut out: HashMap<String, Value> = HashMap::new();
            out.insert("result".into(), Value::String(rendered.clone()));
            ctx.set_outputs(out).await;

            NodeResult::Data(Some(json!({ "result": rendered })))
        })
    }
}
