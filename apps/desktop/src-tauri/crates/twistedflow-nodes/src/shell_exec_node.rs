//! Shell Exec node — executes a shell command, captures stdout/stderr/exit code.

use twistedflow_macros::node;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_engine::render_template;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use tokio::process::Command;
use tokio::io::AsyncWriteExt;

#[node(
    name = "Shell Exec",
    type_id = "shellExec",
    category = "System",
    description = "Execute a shell command"
)]
pub struct ShellExecNode;

impl Node for ShellExecNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let command_template = match ctx
                .node_data
                .get("command")
                .and_then(|v| v.as_str())
            {
                Some(c) if !c.is_empty() => c.to_string(),
                _ => {
                    return NodeResult::Error {
                        message: "Shell Exec: no command specified".into(),
                        raw_response: None,
                    };
                }
            };

            let fail_on_error = ctx
                .node_data
                .get("failOnError")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            // Resolve all in:* inputs for template rendering
            let input_values = ctx.resolve_all_inputs().await;

            // Resolve optional stdin input
            let stdin_value = ctx.resolve_input("in:stdin").await;

            // Render the command template with resolved inputs
            let rendered_command = render_template(&command_template, &input_values);

            // Build the process
            let mut child = match Command::new("sh")
                .arg("-c")
                .arg(&rendered_command)
                .stdin(if stdin_value.is_some() {
                    std::process::Stdio::piped()
                } else {
                    std::process::Stdio::null()
                })
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    return NodeResult::Error {
                        message: format!("Shell Exec: failed to spawn process: {}", e),
                        raw_response: None,
                    };
                }
            };

            // Write stdin if provided
            if let Some(stdin_val) = stdin_value {
                if let Some(stdin_pipe) = child.stdin.take() {
                    let mut stdin_pipe = stdin_pipe;
                    let stdin_bytes = match &stdin_val {
                        Value::String(s) => s.as_bytes().to_vec(),
                        v => serde_json::to_string(v)
                            .unwrap_or_default()
                            .into_bytes(),
                    };
                    // Best-effort write; ignore errors
                    let _ = stdin_pipe.write_all(&stdin_bytes).await;
                    let _ = stdin_pipe.shutdown().await;
                }
            }

            // Wait for completion and capture output
            let output = match child.wait_with_output().await {
                Ok(o) => o,
                Err(e) => {
                    return NodeResult::Error {
                        message: format!("Shell Exec: failed to wait for process: {}", e),
                        raw_response: None,
                    };
                }
            };

            let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
            let exit_code = output.status.code().unwrap_or(-1) as i64;

            let mut out: HashMap<String, Value> = HashMap::new();
            out.insert("stdout".into(), json!(stdout));
            out.insert("stderr".into(), json!(stderr));
            out.insert("exitCode".into(), json!(exit_code));

            ctx.set_outputs(out.clone()).await;

            if exit_code != 0 && fail_on_error {
                return NodeResult::Error {
                    message: format!(
                        "Shell Exec: command exited with code {}{}",
                        exit_code,
                        if stderr.is_empty() {
                            String::new()
                        } else {
                            format!(": {}", stderr.trim())
                        }
                    ),
                    raw_response: None,
                };
            }

            NodeResult::Continue {
                output: serde_json::to_value(&out).ok(),
            }
        })
    }
}
