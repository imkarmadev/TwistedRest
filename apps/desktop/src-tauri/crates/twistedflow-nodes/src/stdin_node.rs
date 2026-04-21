//! Stdin node — reads from standard input.
//!
//! Exec node. Reads all of stdin (blocking until EOF) and outputs the content.
//! For piped data: `echo "hello" | twistedflow-cli run flow.json`
//!
//! Output pins:
//!   - content: raw string content
//!   - lines:   array of lines
//!   - json:    parsed JSON (null if not valid JSON)

use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Stdin",
    type_id = "stdin",
    category = "CLI",
    description = "Read from standard input (piped data or interactive)"
)]
pub struct StdinNode;

impl Node for StdinNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            // Read stdin in a blocking task to not block the async runtime
            let content = tokio::task::spawn_blocking(|| {
                use std::io::Read;
                let mut buf = String::new();
                std::io::stdin().read_to_string(&mut buf).ok();
                buf
            })
            .await
            .unwrap_or_default();

            let lines: Vec<Value> = content
                .lines()
                .map(|l| Value::String(l.to_string()))
                .collect();

            let json_value = serde_json::from_str::<Value>(&content).unwrap_or(Value::Null);

            let mut out: HashMap<String, Value> = HashMap::new();
            out.insert("content".into(), Value::String(content.clone()));
            out.insert("lines".into(), Value::Array(lines));
            out.insert("json".into(), json_value);

            ctx.set_outputs(out.clone()).await;

            NodeResult::Continue {
                output: Some(serde_json::to_value(&out).unwrap_or(Value::Null)),
            }
        })
    }
}
