//! Regex node — match, extract, replace, split using regular expressions.
//!
//! Pure data node. Mode is configured via node_data.mode:
//!   - "match":   returns boolean (did it match?) + captured groups
//!   - "extract": returns array of all matches / capture groups
//!   - "replace": replaces matches with a replacement string
//!   - "split":   splits string by pattern

use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Regex",
    type_id = "regex",
    category = "String",
    description = "Match, extract, replace, or split using regular expressions"
)]
pub struct RegexNode;

impl Node for RegexNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let input = ctx.resolve_input("in:value").await;
            let input_str = match &input {
                Some(Value::String(s)) => s.clone(),
                Some(v) => v.to_string(),
                None => String::new(),
            };

            let pattern = ctx
                .node_data
                .get("pattern")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let mode = ctx
                .node_data
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("match");

            let case_insensitive = ctx
                .node_data
                .get("caseInsensitive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let re_pattern = if case_insensitive {
                format!("(?i){}", pattern)
            } else {
                pattern.clone()
            };

            let re = match regex::Regex::new(&re_pattern) {
                Ok(r) => r,
                Err(e) => {
                    return NodeResult::Error {
                        message: format!("Regex: invalid pattern '{}': {}", pattern, e),
                        raw_response: None,
                    };
                }
            };

            let mut out: HashMap<String, Value> = HashMap::new();

            match mode {
                "match" => {
                    let matched = re.is_match(&input_str);
                    let groups: Vec<Value> = if let Some(caps) = re.captures(&input_str) {
                        caps.iter()
                            .map(|m| match m {
                                Some(m) => Value::String(m.as_str().to_string()),
                                None => Value::Null,
                            })
                            .collect()
                    } else {
                        vec![]
                    };
                    out.insert("matched".into(), Value::Bool(matched));
                    out.insert("groups".into(), Value::Array(groups));
                }
                "extract" => {
                    let matches: Vec<Value> = re
                        .captures_iter(&input_str)
                        .map(|caps| {
                            let groups: Vec<Value> = caps
                                .iter()
                                .map(|m| match m {
                                    Some(m) => Value::String(m.as_str().to_string()),
                                    None => Value::Null,
                                })
                                .collect();
                            if groups.len() == 1 {
                                groups.into_iter().next().unwrap_or(Value::Null)
                            } else {
                                Value::Array(groups)
                            }
                        })
                        .collect();
                    out.insert("matches".into(), Value::Array(matches));
                }
                "replace" => {
                    let replacement = ctx
                        .node_data
                        .get("replacement")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");

                    let global = ctx
                        .node_data
                        .get("global")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);

                    let result = if global {
                        re.replace_all(&input_str, replacement).to_string()
                    } else {
                        re.replace(&input_str, replacement).to_string()
                    };
                    out.insert("result".into(), Value::String(result));
                }
                "split" => {
                    let parts: Vec<Value> = re
                        .split(&input_str)
                        .map(|s| Value::String(s.to_string()))
                        .collect();
                    out.insert("parts".into(), Value::Array(parts));
                }
                _ => {
                    return NodeResult::Error {
                        message: format!("Regex: unknown mode '{}'", mode),
                        raw_response: None,
                    };
                }
            }

            ctx.set_outputs(out.clone()).await;

            NodeResult::Data(Some(serde_json::to_value(&out).unwrap_or(Value::Null)))
        })
    }
}
