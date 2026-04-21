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

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use twistedflow_engine::node::{
    Node, NodeCtx, NodeResult, Outputs, StatusEvent, REQUEST_CONTEXT_NODE_ID,
};
use twistedflow_macros::node;

const HEADER_TERMINATOR: &[u8] = b"\r\n\r\n";
const MAX_HEADER_BYTES: usize = 64 * 1024;
const READ_CHUNK_SIZE: usize = 8 * 1024;

/// Per-request response channel.
static RESPONSE_CHANNELS: std::sync::LazyLock<
    std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<HttpResponseData>>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

#[derive(Clone)]
pub struct HttpResponseData {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
struct ParsedHttpRequest {
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
    body: Value,
}

fn register_response_channel(request_id: &str) -> tokio::sync::oneshot::Receiver<HttpResponseData> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    RESPONSE_CHANNELS
        .lock()
        .unwrap()
        .insert(request_id.to_string(), tx);
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
            let port = ctx
                .node_data
                .get("port")
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
                    if cancel.is_cancelled() {
                        break;
                    }

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

                    let request = match read_http_request(&mut stream).await {
                        Ok(request) => request,
                        Err(message) => {
                            eprintln!("[HTTP Listen] Bad request: {}", message);
                            let response = HttpResponseData {
                                status: 400,
                                headers: HashMap::from([(
                                    "Content-Type".to_string(),
                                    "application/json".to_string(),
                                )]),
                                body: serde_json::to_vec(&json!({ "error": message }))
                                    .unwrap_or_else(|_| br#"{"error":"Bad Request"}"#.to_vec()),
                            };
                            let _ = write_http_response(&mut stream, &response).await;
                            continue;
                        }
                    };

                    request_count += 1;
                    let request_id = format!("{}:{}", node_id, request_count);

                    // Create response channel
                    let response_rx = register_response_channel(&request_id);
                    let local_outputs = {
                        let shared = outputs.lock().await;
                        tokio::sync::Mutex::new(build_request_outputs(
                            &shared,
                            &node_id,
                            &request_id,
                            &request,
                        ))
                    };
                    let local_outputs = std::sync::Arc::new(local_outputs);

                    // Run the exec-request sub-chain (like ForEach runs exec-body)
                    if let Some(next_id) = index.next_exec(&node_id, "exec-request") {
                        let opts2 = opts.clone();
                        let outputs2 = local_outputs.clone();
                        let bg2 = bg_tasks.clone();
                        let tl2 = tap_logs.clone();
                        let next = next_id.to_owned();
                        let handle = tokio::spawn(async move {
                            let _ = twistedflow_engine::executor::run_chain(
                                next, opts2, outputs2, bg2, tl2,
                            )
                            .await;
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
                    let _ = write_http_response(&mut stream, &resp).await;
                }

                println!(
                    "[HTTP Listen] Server stopped after {} request(s)",
                    request_count
                );
                (opts.on_status)(
                    &node_id,
                    StatusEvent::ok(Some(json!({
                        "port": port,
                        "requestsHandled": request_count,
                    }))),
                );
            })
            .await;

            NodeResult::Process
        })
    }
}

async fn read_http_request<S>(stream: &mut S) -> Result<ParsedHttpRequest, String>
where
    S: AsyncRead + Unpin,
{
    let mut buffer = Vec::with_capacity(READ_CHUNK_SIZE);
    let headers_end = loop {
        if let Some(pos) = find_headers_end(&buffer) {
            break pos;
        }
        if buffer.len() >= MAX_HEADER_BYTES {
            return Err("HTTP headers exceeded 64 KiB".into());
        }

        let mut chunk = vec![0u8; READ_CHUNK_SIZE];
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|e| format!("Failed to read request: {}", e))?;
        if read == 0 {
            if buffer.is_empty() {
                return Err("Connection closed before request data arrived".into());
            }
            return Err("Connection closed before HTTP headers completed".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let (method, full_path, headers) = parse_request_head(&buffer[..headers_end])?;
    let body_start = headers_end + HEADER_TERMINATOR.len();
    let content_length = headers
        .get("content-length")
        .map(|value| {
            value
                .parse::<usize>()
                .map_err(|_| format!("Invalid Content-Length header '{}'", value))
        })
        .transpose()?;

    if let Some(len) = content_length {
        while buffer.len() < body_start + len {
            let mut chunk = vec![0u8; READ_CHUNK_SIZE];
            let read = stream
                .read(&mut chunk)
                .await
                .map_err(|e| format!("Failed to read request body: {}", e))?;
            if read == 0 {
                return Err("Connection closed before HTTP body completed".into());
            }
            buffer.extend_from_slice(&chunk[..read]);
        }
    }

    let body_bytes = if let Some(len) = content_length {
        buffer[body_start..body_start + len].to_vec()
    } else {
        buffer[body_start..].to_vec()
    };

    let body = parse_request_body(&body_bytes);
    let (path, query) = full_path.split_once('?').unwrap_or((&full_path, ""));

    Ok(ParsedHttpRequest {
        method,
        path: path.to_string(),
        query: query.to_string(),
        headers,
        body,
    })
}

fn parse_request_head(bytes: &[u8]) -> Result<(String, String, HashMap<String, String>), String> {
    let head = std::str::from_utf8(bytes).map_err(|_| "HTTP headers are not valid UTF-8")?;
    let mut lines = head.lines();
    let request_line = lines.next().ok_or("Missing HTTP request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("Missing HTTP method")?.to_string();
    let full_path = parts.next().ok_or("Missing HTTP path")?.to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_lowercase(), v.trim().to_string());
        }
    }

    Ok((method, full_path, headers))
}

fn parse_request_body(bytes: &[u8]) -> Value {
    if bytes.is_empty() {
        return Value::Null;
    }

    serde_json::from_slice(bytes).unwrap_or_else(|_| {
        Value::String(String::from_utf8_lossy(bytes).into_owned())
    })
}

fn find_headers_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(HEADER_TERMINATOR.len())
        .position(|window| window == HEADER_TERMINATOR)
}

fn build_request_outputs(
    parent: &Outputs,
    listener_node_id: &str,
    request_id: &str,
    request: &ParsedHttpRequest,
) -> Outputs {
    let mut local = parent.clone();
    local.insert(
        REQUEST_CONTEXT_NODE_ID.to_string(),
        HashMap::from([("id".to_string(), Value::String(request_id.to_string()))]),
    );
    local.insert(
        listener_node_id.to_string(),
        HashMap::from([
            ("method".to_string(), Value::String(request.method.clone())),
            ("path".to_string(), Value::String(request.path.clone())),
            ("query".to_string(), Value::String(request.query.clone())),
            ("headers".to_string(), json!(request.headers)),
            ("body".to_string(), request.body.clone()),
            ("_requestId".to_string(), Value::String(request_id.to_string())),
        ]),
    );
    local
}

async fn write_http_response<S>(stream: &mut S, response: &HttpResponseData) -> std::io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    let mut header_block = String::new();
    for (key, value) in &response.headers {
        if value.contains('\n') {
            for part in value.split('\n') {
                header_block.push_str(&format!("{}: {}\r\n", key, part));
            }
        } else {
            header_block.push_str(&format!("{}: {}\r\n", key, value));
        }
    }
    if !response
        .headers
        .keys()
        .any(|key| key.eq_ignore_ascii_case("content-type"))
    {
        header_block.push_str("Content-Type: application/json\r\n");
    }
    header_block.push_str(&format!("Content-Length: {}\r\n", response.body.len()));
    header_block.push_str("Connection: close\r\n");

    let status_line = format!(
        "HTTP/1.1 {} {}\r\n{}\r\n",
        response.status,
        status_text(response.status),
        header_block,
    );

    stream.write_all(status_line.as_bytes()).await?;
    stream.write_all(&response.body).await?;
    stream.flush().await
}

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncWriteExt};

    #[tokio::test]
    async fn reads_request_body_across_multiple_reads() {
        let (mut client, mut server) = duplex(256);
        let writer = tokio::spawn(async move {
            client
                .write_all(b"POST /submit?x=1 HTTP/1.1\r\nHost: example.test\r\nContent-Length: 11\r\n\r\n")
                .await
                .unwrap();
            client.write_all(br#"{"ok":true}"#).await.unwrap();
        });

        let request = read_http_request(&mut server).await.unwrap();
        writer.await.unwrap();

        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/submit");
        assert_eq!(request.query, "x=1");
        assert_eq!(request.body, json!({ "ok": true }));
    }

    #[tokio::test]
    async fn writes_binary_responses_without_reencoding() {
        let body = vec![0x00, 0x7f, 0x80, 0xff, 0x41];
        let (mut client, mut server) = duplex(256);
        let response = HttpResponseData {
            status: 200,
            headers: HashMap::from([("Content-Type".to_string(), "application/octet-stream".to_string())]),
            body: body.clone(),
        };

        let writer = tokio::spawn(async move {
            write_http_response(&mut server, &response).await.unwrap();
        });

        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.unwrap();
        writer.await.unwrap();

        let headers_end = find_headers_end(&raw).unwrap() + HEADER_TERMINATOR.len();
        assert_eq!(&raw[headers_end..], body.as_slice());
        assert!(String::from_utf8_lossy(&raw[..headers_end]).contains("Content-Length: 5"));
    }

    #[test]
    fn request_outputs_are_built_from_an_isolated_snapshot() {
        let parent = HashMap::from([(
            "__variables__".to_string(),
            HashMap::from([("counter".to_string(), json!(1))]),
        )]);
        let request = ParsedHttpRequest {
            method: "GET".to_string(),
            path: "/users".to_string(),
            query: String::new(),
            headers: HashMap::from([("host".to_string(), "example.test".to_string())]),
            body: Value::Null,
        };

        let outputs = build_request_outputs(&parent, "listener", "listener:1", &request);

        assert_eq!(
            outputs
                .get(REQUEST_CONTEXT_NODE_ID)
                .and_then(|entry| entry.get("id")),
            Some(&Value::String("listener:1".to_string()))
        );
        assert_eq!(
            outputs
                .get("listener")
                .and_then(|entry| entry.get("path")),
            Some(&Value::String("/users".to_string()))
        );
        assert!(parent.get(REQUEST_CONTEXT_NODE_ID).is_none());
    }
}
