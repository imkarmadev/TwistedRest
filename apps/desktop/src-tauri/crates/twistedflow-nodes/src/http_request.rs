//! HTTP Request node — resolves input pins, renders templates, calls reqwest.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{
    ExecAuth, HeaderEntry, HttpRequest, HttpResponse, Node, NodeCtx, NodeResult,
};
use twistedflow_engine::render_template;
use twistedflow_macros::node;

#[node(
    name = "HTTP Request",
    type_id = "httpRequest",
    category = "HTTP",
    description = "Make an HTTP request"
)]
pub struct HttpRequestNode;

impl Node for HttpRequestNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let data = ctx.node_data;
            let exec_ctx = &ctx.opts.context;

            // Step 1: resolve all input pin values
            let input_values = ctx.resolve_all_inputs().await;

            // Step 2: render URL
            let base_url = exec_ctx
                .env_base_url
                .as_deref()
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    exec_ctx
                        .project_base_url
                        .as_deref()
                        .filter(|s| !s.is_empty())
                })
                .unwrap_or("");

            let url_template = data.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let rendered_url = render_template(url_template, &input_values);
            let mut final_url = resolve_url(&rendered_url, base_url);

            // Step 3: render body
            let body_template = data.get("body").and_then(|v| v.as_str()).unwrap_or("");
            let body = if body_template.is_empty() {
                String::new()
            } else {
                render_template(body_template, &input_values)
            };

            // Step 4: three-layer header merge (project → env → node)
            let mut header_map: HashMap<String, String> = HashMap::new();

            apply_header_layer(
                &mut header_map,
                exec_ctx.project_headers.as_deref(),
                &input_values,
            );
            apply_header_layer(
                &mut header_map,
                exec_ctx.env_headers.as_deref(),
                &input_values,
            );

            // Node-level headers
            if let Some(node_headers) = data.get("headers").and_then(|v| v.as_array()) {
                for h in node_headers {
                    let enabled = h.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                    let key = h.get("key").and_then(|v| v.as_str()).unwrap_or("");
                    if !enabled || key.is_empty() {
                        continue;
                    }
                    let val = h.get("value").and_then(|v| v.as_str()).unwrap_or("");
                    header_map.insert(key.to_string(), render_template(val, &input_values));
                }
            }

            // Step 5: auth injection
            if let Some(auth) = &exec_ctx.auth {
                apply_auth(auth, &mut header_map, &mut final_url);
            }

            let headers: Vec<(String, String)> = header_map.into_iter().collect();

            // Step 6: determine method and strip body for bodyless methods
            let method = data
                .get("method")
                .and_then(|v| v.as_str())
                .unwrap_or("GET")
                .to_uppercase();

            let send_body =
                if method == "GET" || method == "HEAD" || method == "OPTIONS" || body.is_empty() {
                    None
                } else {
                    Some(body)
                };

            // Step 7: execute HTTP (with timing)
            let start_time = std::time::Instant::now();
            let response = match exec_http(
                &ctx.opts.http_client,
                &HttpRequest {
                    method: method.clone(),
                    url: final_url.clone(),
                    headers: headers.clone(),
                    body: send_body,
                },
            )
            .await
            {
                Ok(r) => r,
                Err(msg) => {
                    return NodeResult::Error {
                        message: msg,
                        raw_response: None,
                    };
                }
            };
            let response_time_ms = start_time.elapsed().as_millis() as u64;

            // Step 8: parse response body
            let parsed: Value = if response.body.is_empty() {
                Value::Null
            } else {
                serde_json::from_str(&response.body).unwrap_or(Value::String(response.body.clone()))
            };

            // Step 9: project to output pins
            // Response body fields go in first so they can't overwrite the
            // fixed pins (status, responseTime, responseHeaders) that follow.
            let mut out: HashMap<String, Value> = HashMap::new();

            match &parsed {
                Value::Object(map) => {
                    for (k, v) in map {
                        out.insert(k.clone(), v.clone());
                    }
                }
                _ => {
                    out.insert("value".into(), parsed.clone());
                }
            }

            // Fixed output pins — inserted AFTER body fields so they always win
            out.insert("status".into(), json!(response.status));

            let resp_headers: HashMap<String, String> = response.headers.iter().cloned().collect();
            out.insert("responseHeaders".into(), json!(resp_headers));

            out.insert("responseTime".into(), json!(response_time_ms));

            let header_map_for_req: HashMap<String, String> = headers.iter().cloned().collect();
            out.insert(
                "_request".into(),
                json!({
                    "method": method,
                    "url": final_url,
                    "headers": header_map_for_req,
                    "status": response.status,
                    "responseTime": response_time_ms,
                }),
            );

            let output_val = serde_json::to_value(&out).ok();

            // Store in shared cache
            ctx.set_outputs(out).await;

            NodeResult::Continue { output: output_val }
        })
    }
}

// ── Private helpers ──────────────────────────────────────────────────

/// Apply a header layer (project / env / node) into the accumulator map.
fn apply_header_layer(
    map: &mut HashMap<String, String>,
    layer: Option<&[HeaderEntry]>,
    vals: &HashMap<String, Value>,
) {
    for h in layer.unwrap_or(&[]) {
        if !h.enabled || h.key.is_empty() {
            continue;
        }
        map.insert(h.key.clone(), render_template(&h.value, vals));
    }
}

/// Inject auth credentials into headers / URL.
fn apply_auth(auth: &ExecAuth, headers: &mut HashMap<String, String>, url: &mut String) {
    match auth.auth_type.as_str() {
        "bearer" => {
            if let Some(token) = &auth.bearer_token {
                headers.insert("Authorization".into(), format!("Bearer {}", token));
            }
        }
        "basic" => {
            if let Some(user) = &auth.basic_username {
                use base64::Engine;
                let pass = auth.basic_password.as_deref().unwrap_or("");
                let encoded =
                    base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", user, pass));
                headers.insert("Authorization".into(), format!("Basic {}", encoded));
            }
        }
        "apiKey" => {
            if let (Some(name), Some(value)) = (&auth.api_key_name, &auth.api_key_value) {
                let loc = auth.api_key_location.as_deref().unwrap_or("header");
                if loc == "query" {
                    let sep = if url.contains('?') { "&" } else { "?" };
                    *url = format!("{}{}{}={}", url, sep, name, value);
                } else {
                    headers.insert(name.clone(), value.clone());
                }
            }
        }
        "oauth2_client_credentials" | "oauth2_authorization_code" => {
            if let Some(token) = &auth.oauth2_access_token {
                headers.insert("Authorization".into(), format!("Bearer {}", token));
            }
        }
        _ => {}
    }
}

/// Execute an HTTP request via reqwest and return a structured response.
async fn exec_http(client: &reqwest::Client, req: &HttpRequest) -> Result<HttpResponse, String> {
    let method: reqwest::Method = req
        .method
        .parse()
        .map_err(|_| format!("Invalid HTTP method: {}", req.method))?;

    let mut builder = client.request(method, &req.url);
    for (k, v) in &req.headers {
        builder = builder.header(k, v);
    }
    if let Some(body) = &req.body {
        builder = builder.body(body.clone());
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", e))?;

    let status = resp.status().as_u16();
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

/// Combine a base URL with a (potentially relative) node URL.
fn resolve_url(node_url: &str, base_url: &str) -> String {
    if node_url.is_empty() {
        return node_url.to_string();
    }
    if node_url.starts_with("http://") || node_url.starts_with("https://") {
        return node_url.to_string();
    }
    if base_url.is_empty() {
        return node_url.to_string();
    }
    let base = base_url.trim_end_matches('/');
    let path = node_url.trim_start_matches('/');
    format!("{}/{}", base, path)
}
