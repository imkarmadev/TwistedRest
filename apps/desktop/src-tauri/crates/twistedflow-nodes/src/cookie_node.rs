//! Cookie node — parse incoming cookies or build Set-Cookie headers.
//!
//! Pure data node with two modes:
//!   - parse: reads Cookie header → out:cookies object
//!   - set:   builds Set-Cookie header strings → out:setCookieHeaders

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Cookie",
    type_id = "cookie",
    category = "HTTP Server",
    description = "Parse incoming cookies or build Set-Cookie response headers"
)]
pub struct CookieNode;

impl Node for CookieNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let mode = ctx
                .node_data
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("parse");

            match mode {
                "set" => execute_set(&ctx).await,
                _ => execute_parse(&ctx).await,
            }
        })
    }
}

/// Parse mode: read Cookie header, split into name=value pairs.
async fn execute_parse(ctx: &NodeCtx<'_>) -> NodeResult {
    let headers = ctx.resolve_input("in:headers").await.unwrap_or(Value::Null);

    let cookie_str = headers
        .get("cookie")
        .or_else(|| headers.get("Cookie"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let mut cookies = serde_json::Map::new();
    for pair in cookie_str.split(';') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let mut parts = pair.splitn(2, '=');
        let name = parts.next().unwrap_or("").trim();
        let value = parts.next().unwrap_or("").trim();
        if !name.is_empty() {
            cookies.insert(name.to_string(), Value::String(value.to_string()));
        }
    }

    let result = Value::Object(cookies.clone());

    {
        let mut out = ctx.outputs.lock().await;
        let entry = out.entry(ctx.node_id.to_string()).or_default();
        entry.insert("cookies".into(), result.clone());
    }

    NodeResult::Data(Some(result))
}

/// Set mode: build Set-Cookie header strings from config.
async fn execute_set(ctx: &NodeCtx<'_>) -> NodeResult {
    let inputs = ctx.resolve_all_inputs().await;

    let set_cookies = ctx
        .node_data
        .get("setCookies")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut cookie_strings: Vec<String> = Vec::new();

    for cookie in &set_cookies {
        let name = cookie.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }

        let value_template = cookie.get("value").and_then(|v| v.as_str()).unwrap_or("");
        let value = render_template(value_template, &inputs);

        let mut parts = vec![format!("{}={}", name, value)];

        if let Some(path) = cookie.get("path").and_then(|v| v.as_str()) {
            if !path.is_empty() {
                parts.push(format!("Path={}", path));
            }
        }
        if let Some(domain) = cookie.get("domain").and_then(|v| v.as_str()) {
            if !domain.is_empty() {
                parts.push(format!("Domain={}", domain));
            }
        }
        if let Some(max_age) = cookie.get("maxAge").and_then(|v| v.as_u64()) {
            parts.push(format!("Max-Age={}", max_age));
        }
        if cookie
            .get("httpOnly")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            parts.push("HttpOnly".to_string());
        }
        if cookie
            .get("secure")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            parts.push("Secure".to_string());
        }
        if let Some(same_site) = cookie.get("sameSite").and_then(|v| v.as_str()) {
            if !same_site.is_empty() {
                parts.push(format!("SameSite={}", same_site));
            }
        }

        cookie_strings.push(parts.join("; "));
    }

    // Each Set-Cookie must be its own HTTP header line (RFC 6265).
    // We join with "\n" and the HTTP Listen header writer splits them back.
    let header_value = cookie_strings.join("\n");
    let result = json!({ "Set-Cookie": header_value });

    {
        let mut out = ctx.outputs.lock().await;
        let entry = out.entry(ctx.node_id.to_string()).or_default();
        entry.insert("cookies".into(), Value::Null);
        entry.insert("setCookieHeaders".into(), result.clone());
    }

    NodeResult::Data(Some(result))
}

fn render_template(template: &str, inputs: &std::collections::HashMap<String, Value>) -> String {
    let mut result = template.to_string();
    for (key, val) in inputs {
        let placeholder = format!("#{{{}}}", key);
        let replacement = match val {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        result = result.replace(&placeholder, &replacement);
    }
    result
}
