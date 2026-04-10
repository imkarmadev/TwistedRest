//! HTTP Listen — process node that runs an HTTP server.
//!
//! Returns `NodeResult::Process`. Stays running in background.
//! For each request, writes method/path/headers/body to its own
//! output pins, runs the `exec-request` sub-chain, reads response
//! from Send Response via per-request channel, sends it back.
//!
//! Flow pattern (simple, direct wiring — no events needed):
//!   Start → HTTP Listen :4567
//!                 ├── out:method ──→ ...
//!                 ├── out:path ────→ Route Match → If/Else
//!                 └── exec-request → Log → Send Response

use twistedflow_macros::node;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult, StatusEvent};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Per-request response channel.
static RESPONSE_CHANNELS: std::sync::LazyLock<
    std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<HttpResponseData>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

#[derive(Clone)]
pub struct HttpResponseData {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

fn register_response_channel(request_id: &str) -> tokio::sync::oneshot::Receiver<HttpResponseData> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    RESPONSE_CHANNELS.lock().unwrap().insert(request_id.to_string(), tx);
    rx
}

pub fn send_response(request_id: &str, response: HttpResponseData) -> bool {
    if let Some(tx) = RESPONSE_CHANNELS.lock().unwrap().remove(request_id) {
        tx.send(response).is_ok()
    } else {
        false
    }
}

#[node(
    name = "HTTP Listen",
    type_id = "httpListen",
    category = "HTTP Server",
    description = "Start an HTTP server. Each request fires exec-request with method/path/body pins."
)]
pub struct HttpListenNode;

impl Node for HttpListenNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let port = ctx.node_data.get("port")
                .and_then(|v| v.as_u64())
                .unwrap_or(3000) as u16;

            let listener = match TcpListener::bind(format!("0.0.0.0:{}", port)).await {
                Ok(l) => l,
                Err(e) => {
                    return NodeResult::Error {
                        message: format!("Failed to bind port {}: {}", port, e),
                        raw_response: None,
                    };
                }
            };

            println!("[HTTP Listen] Serving on http://0.0.0.0:{}", port);

            let cancel = ctx.opts.cancel.clone();
            let opts = ctx.opts.clone();
            let outputs = ctx.outputs.clone();
            let bg_tasks = ctx.bg_tasks.clone();
            let tap_logs = ctx.tap_logs.clone();
            let index = ctx.index.clone();
            let node_id = ctx.node_id.to_string();

            ctx.spawn_process(async move {
                let mut request_count: u64 = 0;

                loop {
                    if cancel.is_cancelled() { break; }

                    let mut stream = tokio::select! {
                        result = listener.accept() => {
                            match result {
                                Ok((stream, _)) => stream,
                                Err(e) => {
                                    eprintln!("[HTTP Listen] Accept error: {}", e);
                                    continue;
                                }
                            }
                        }
                        _ = cancel.cancelled() => { break; }
                    };

                    // Parse request
                    let mut buf = vec![0u8; 65536];
                    let n = match stream.read(&mut buf).await {
                        Ok(n) if n > 0 => n,
                        _ => continue,
                    };
                    let raw = String::from_utf8_lossy(&buf[..n]);
                    let (head, body_str) = raw.split_once("\r\n\r\n").unwrap_or((&raw, ""));
                    let mut lines = head.lines();
                    let request_line = lines.next().unwrap_or("");
                    let parts: Vec<&str> = request_line.split_whitespace().collect();
                    let method = parts.first().unwrap_or(&"GET").to_string();
                    let full_path = parts.get(1).unwrap_or(&"/").to_string();
                    let (path, query) = full_path.split_once('?').unwrap_or((&full_path, ""));

                    let mut headers = HashMap::new();
                    for line in lines {
                        if let Some((k, v)) = line.split_once(':') {
                            headers.insert(k.trim().to_lowercase(), v.trim().to_string());
                        }
                    }

                    let body: Value = if body_str.is_empty() {
                        Value::Null
                    } else {
                        serde_json::from_str(body_str).unwrap_or(Value::String(body_str.to_string()))
                    };

                    request_count += 1;
                    let request_id = format!("{}:{}", node_id, request_count);

                    // Create response channel
                    let response_rx = register_response_channel(&request_id);

                    // Write request data to THIS node's output pins
                    {
                        let mut out = outputs.lock().await;
                        let entry = out.entry(node_id.clone()).or_default();
                        entry.insert("method".into(), Value::String(method.clone()));
                        entry.insert("path".into(), Value::String(path.to_string()));
                        entry.insert("query".into(), Value::String(query.to_string()));
                        entry.insert("headers".into(), json!(headers));
                        entry.insert("body".into(), body);
                        entry.insert("_requestId".into(), Value::String(request_id.clone()));
                    }

                    // Run the exec-request sub-chain (like ForEach runs exec-body)
                    if let Some(next_id) = index.next_exec(&node_id, "exec-request") {
                        let opts2 = opts.clone();
                        let outputs2 = outputs.clone();
                        let bg2 = bg_tasks.clone();
                        let tl2 = tap_logs.clone();
                        let next = next_id.to_owned();
                        let handle = tokio::spawn(async move {
                            let _ = twistedflow_engine::executor::run_chain(
                                next, opts2, outputs2, bg2, tl2,
                            ).await;
                        });
                        bg_tasks.lock().await.push(handle);
                    }

                    // Wait for response (30s timeout)
                    let resp = tokio::select! {
                        result = response_rx => {
                            result.unwrap_or(HttpResponseData {
                                status: 500,
                                headers: HashMap::new(),
                                body: r#"{"error":"No response from handler"}"#.into(),
                            })
                        }
                        _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                            RESPONSE_CHANNELS.lock().unwrap().remove(&request_id);
                            HttpResponseData {
                                status: 504,
                                headers: HashMap::new(),
                                body: r#"{"error":"Request handler timeout"}"#.into(),
                            }
                        }
                        _ = cancel.cancelled() => {
                            RESPONSE_CHANNELS.lock().unwrap().remove(&request_id);
                            break;
                        }
                    };

                    // Send HTTP response
                    let mut resp_hdrs = String::new();
                    for (k, v) in &resp.headers {
                        resp_hdrs.push_str(&format!("{}: {}\r\n", k, v));
                    }
                    if !resp.headers.contains_key("content-type") {
                        resp_hdrs.push_str("Content-Type: application/json\r\n");
                    }
                    resp_hdrs.push_str(&format!("Content-Length: {}\r\n", resp.body.len()));
                    resp_hdrs.push_str("Connection: close\r\n");

                    let response_str = format!(
                        "HTTP/1.1 {} {}\r\n{}\r\n{}",
                        resp.status, status_text(resp.status), resp_hdrs, resp.body,
                    );
                    let _ = stream.write_all(response_str.as_bytes()).await;
                    let _ = stream.flush().await;
                }

                println!("[HTTP Listen] Server stopped after {} request(s)", request_count);
                (opts.on_status)(&node_id, StatusEvent::ok(Some(json!({
                    "port": port,
                    "requestsHandled": request_count,
                }))));
            }).await;

            NodeResult::Process
        })
    }
}

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK", 201 => "Created", 204 => "No Content",
        301 => "Moved Permanently", 302 => "Found",
        400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden",
        404 => "Not Found", 500 => "Internal Server Error",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}
