//! ParseArgs node — parses CLI arguments into structured data.
//!
//! Pure data node. Reads std::env::args(), parses --flags, -f shorthand,
//! and positional arguments. Outputs a structured object.
//!
//! Output pins:
//!   - args:     full object { flags: {...}, positional: [...], raw: [...] }
//!   - flags:    just the flag object (--name=value or --name value)
//!   - positional: array of positional (non-flag) arguments

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Parse Args",
    type_id = "parseArgs",
    category = "CLI",
    description = "Parse CLI arguments into flags and positional args"
)]
pub struct ParseArgsNode;

impl Node for ParseArgsNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            // Skip the first arg (binary name) and any twistedflow-cli subcommands
            let raw_args: Vec<String> = std::env::args().collect();

            // Find where user args start:
            // For `twistedflow run flow.json -- --myarg`, skip past "--"
            // For compiled binaries, args start at index 1
            let user_args: Vec<String> = if let Some(pos) = raw_args.iter().position(|a| a == "--")
            {
                raw_args[pos + 1..].to_vec()
            } else {
                // Compiled binary: skip binary name only
                // CLI mode: skip twistedflow, run, flow.json, and known CLI flags
                let mut start = 1;
                for (i, arg) in raw_args.iter().enumerate().skip(1) {
                    if arg == "run"
                        || arg.ends_with(".flow.json")
                        || arg.ends_with(".json")
                        || arg == "-q"
                        || arg == "--quiet"
                        || arg == "-e"
                        || arg.starts_with("--env=")
                        || arg.starts_with("--plugins=")
                        || arg.starts_with("--base-url=")
                        || arg == "--base-url"
                        || arg == "--plugins"
                    {
                        start = i + 1;
                        // If this flag takes a value arg, skip next too
                        if (arg == "-e" || arg == "--base-url" || arg == "--plugins")
                            && i + 1 < raw_args.len()
                        {
                            start = i + 2;
                        }
                        continue;
                    }
                    // Also skip values for -e flags
                    if i > 0 && (raw_args[i - 1] == "-e") {
                        start = i + 1;
                        continue;
                    }
                    break;
                }
                raw_args[start..].to_vec()
            };

            // Parse flags and positional args
            let mut flags: HashMap<String, Value> = HashMap::new();
            let mut positional: Vec<Value> = Vec::new();
            let mut i = 0;

            while i < user_args.len() {
                let arg = &user_args[i];

                if arg.starts_with("--") {
                    let flag = &arg[2..];
                    if let Some((key, val)) = flag.split_once('=') {
                        // --key=value
                        flags.insert(key.to_string(), parse_value(val));
                    } else if i + 1 < user_args.len() && !user_args[i + 1].starts_with('-') {
                        // --key value
                        flags.insert(flag.to_string(), parse_value(&user_args[i + 1]));
                        i += 1;
                    } else {
                        // --flag (boolean)
                        flags.insert(flag.to_string(), Value::Bool(true));
                    }
                } else if arg.starts_with('-') && arg.len() > 1 {
                    let short = &arg[1..];
                    // Handle bundled short flags: -abc → a=true, b=true, c=true
                    if short.len() > 1 && !short.contains('=') {
                        if i + 1 >= user_args.len() || user_args[i + 1].starts_with('-') {
                            // All boolean flags
                            for ch in short.chars() {
                                flags.insert(ch.to_string(), Value::Bool(true));
                            }
                        } else {
                            // Last char takes the value, rest are boolean
                            let chars: Vec<char> = short.chars().collect();
                            for &ch in &chars[..chars.len() - 1] {
                                flags.insert(ch.to_string(), Value::Bool(true));
                            }
                            flags.insert(
                                chars.last().unwrap().to_string(),
                                parse_value(&user_args[i + 1]),
                            );
                            i += 1;
                        }
                    } else if let Some((key, val)) = short.split_once('=') {
                        flags.insert(key.to_string(), parse_value(val));
                    } else if i + 1 < user_args.len() && !user_args[i + 1].starts_with('-') {
                        flags.insert(short.to_string(), parse_value(&user_args[i + 1]));
                        i += 1;
                    } else {
                        flags.insert(short.to_string(), Value::Bool(true));
                    }
                } else {
                    positional.push(parse_value(arg));
                }

                i += 1;
            }

            let flags_value = serde_json::to_value(&flags).unwrap_or(json!({}));
            let positional_value = Value::Array(positional.clone());
            let raw_value =
                Value::Array(user_args.iter().map(|s| Value::String(s.clone())).collect());

            let result = json!({
                "flags": flags_value,
                "positional": positional_value,
                "raw": raw_value,
            });

            let mut out = HashMap::new();
            out.insert("args".to_string(), result);
            out.insert("flags".to_string(), flags_value);
            out.insert("positional".to_string(), positional_value);
            out.insert("raw".to_string(), raw_value);
            ctx.set_outputs(out).await;

            NodeResult::Data(Some(json!({
                "flags": flags,
                "positional": positional,
                "raw": user_args,
            })))
        })
    }
}

/// Try to parse a string value as number or boolean, else keep as string.
fn parse_value(s: &str) -> Value {
    if s == "true" {
        return Value::Bool(true);
    }
    if s == "false" {
        return Value::Bool(false);
    }
    if let Ok(n) = s.parse::<i64>() {
        return Value::Number(n.into());
    }
    if let Ok(n) = s.parse::<f64>() {
        if let Some(n) = serde_json::Number::from_f64(n) {
            return Value::Number(n);
        }
    }
    Value::String(s.to_string())
}
