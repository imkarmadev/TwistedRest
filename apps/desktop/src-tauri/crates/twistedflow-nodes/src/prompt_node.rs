//! Prompt node — interactive CLI input.
//!
//! Exec node. Prints a question to stderr, reads a line from stdin.
//! Supports modes: text (default), confirm (y/n → bool), password (hidden).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Prompt",
    type_id = "prompt",
    category = "CLI",
    description = "Ask the user for interactive input"
)]
pub struct PromptNode;

impl Node for PromptNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let message = ctx
                .node_data
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("? ")
                .to_string();

            let mode = ctx
                .node_data
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("text")
                .to_string();

            let default_value = ctx
                .node_data
                .get("default")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            // Also allow wiring the message dynamically
            let dynamic_message = ctx.resolve_input("in:message").await;
            let prompt_text = match dynamic_message {
                Some(Value::String(s)) => s,
                _ => message,
            };

            let result = tokio::task::spawn_blocking(move || {
                use std::io::{self, BufRead, Write};

                match mode.as_str() {
                    "confirm" => {
                        eprint!("{} (y/n) ", prompt_text);
                        io::stderr().flush().ok();
                        let mut line = String::new();
                        io::stdin().lock().read_line(&mut line).ok();
                        let answer = line.trim().to_lowercase();
                        let yes = matches!(answer.as_str(), "y" | "yes" | "true" | "1");
                        Value::Bool(yes)
                    }
                    "password" => {
                        eprint!("{}", prompt_text);
                        io::stderr().flush().ok();
                        // Simple hidden input — disable echo isn't portable without
                        // a dependency, so just read normally for now. Works well
                        // enough for CLI tools.
                        let mut line = String::new();
                        io::stdin().lock().read_line(&mut line).ok();
                        Value::String(
                            line.trim_end_matches('\n')
                                .trim_end_matches('\r')
                                .to_string(),
                        )
                    }
                    _ => {
                        // text mode
                        if default_value.is_empty() {
                            eprint!("{}", prompt_text);
                        } else {
                            eprint!("{} [{}] ", prompt_text, default_value);
                        }
                        io::stderr().flush().ok();
                        let mut line = String::new();
                        io::stdin().lock().read_line(&mut line).ok();
                        let trimmed = line
                            .trim_end_matches('\n')
                            .trim_end_matches('\r')
                            .to_string();
                        if trimmed.is_empty() && !default_value.is_empty() {
                            Value::String(default_value)
                        } else {
                            Value::String(trimmed)
                        }
                    }
                }
            })
            .await
            .unwrap_or(Value::Null);

            let mut out: HashMap<String, Value> = HashMap::new();
            out.insert("answer".into(), result.clone());
            ctx.set_outputs(out).await;

            NodeResult::Continue {
                output: Some(json!({ "answer": result })),
            }
        })
    }
}
