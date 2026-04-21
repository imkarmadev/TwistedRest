//! Serve Static node — serves a file from disk based on the request path.
//!
//! Reads the file, detects MIME type from extension, and sends it as
//! an HTTP response via the response channel.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

use crate::http_listen;

#[node(
    name = "Serve Static",
    type_id = "serveStatic",
    category = "HTTP Server",
    description = "Serve static files from disk with MIME type detection"
)]
pub struct ServeStaticNode;

impl Node for ServeStaticNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let root_dir = ctx
                .node_data
                .get("rootDir")
                .and_then(|v| v.as_str())
                .unwrap_or("./public");
            let index_file = ctx
                .node_data
                .get("indexFile")
                .and_then(|v| v.as_str())
                .unwrap_or("index.html");
            let strip_prefix = ctx
                .node_data
                .get("stripPrefix")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            let raw_path = ctx
                .resolve_input("in:path")
                .await
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or("/".to_string());

            // Strip prefix
            let rel_path = if !strip_prefix.is_empty() {
                raw_path
                    .strip_prefix(strip_prefix)
                    .unwrap_or(&raw_path)
                    .to_string()
            } else {
                raw_path.clone()
            };

            // Sanitize: reject path traversal
            let rel_path = rel_path.trim_start_matches('/');
            if rel_path.contains("..") {
                return NodeResult::Error {
                    message: "Path traversal rejected".into(),
                    raw_response: None,
                };
            }

            let base = PathBuf::from(root_dir);

            let mut file_path = base.join(rel_path);

            // If path is a directory, try index file
            if file_path.is_dir() {
                file_path = file_path.join(index_file);
            }

            // If no extension and file doesn't exist, try with index
            if !file_path.exists() && file_path.extension().is_none() {
                let with_index = file_path.join(index_file);
                if with_index.exists() {
                    file_path = with_index;
                }
            }

            // Read file
            let content = match tokio::fs::read(&file_path).await {
                Ok(bytes) => bytes,
                Err(_) => {
                    // File not found — don't send response, let exec-out
                    // continue to a 404 handler
                    {
                        let mut out = ctx.outputs.lock().await;
                        let entry = out.entry(ctx.node_id.to_string()).or_default();
                        entry.insert("filePath".into(), Value::Null);
                        entry.insert("contentType".into(), Value::Null);
                        entry.insert("found".into(), Value::Bool(false));
                    }
                    return NodeResult::Continue {
                        output: Some(json!({ "found": false })),
                    };
                }
            };

            let mime = detect_mime(&file_path);
            let content_len = content.len();

            // Store outputs
            {
                let mut out = ctx.outputs.lock().await;
                let entry = out.entry(ctx.node_id.to_string()).or_default();
                entry.insert(
                    "filePath".into(),
                    Value::String(file_path.to_string_lossy().into_owned()),
                );
                entry.insert("contentType".into(), Value::String(mime.clone()));
                entry.insert("found".into(), Value::Bool(true));
            }

            // Find _requestId and send response
            let request_id = {
                let out = ctx.outputs.lock().await;
                let mut found = None;
                for (_node_id, node_out) in out.iter() {
                    if let Some(Value::String(id)) = node_out.get("_requestId") {
                        found = Some(id.clone());
                        break;
                    }
                }
                found
            };

            if let Some(req_id) = &request_id {
                let mut headers = HashMap::new();
                headers.insert("Content-Type".to_string(), mime.clone());
                headers.insert("Content-Length".to_string(), content_len.to_string());

                // For text types, decode as UTF-8. For binary, preserve
                // bytes via Latin-1 mapping (each byte → one char) so
                // write_all(as_bytes()) on the socket reproduces them exactly.
                let is_text = mime.starts_with("text/")
                    || mime.contains("json")
                    || mime.contains("javascript")
                    || mime.contains("xml")
                    || mime.contains("svg")
                    || mime.contains("css");

                let body = if is_text {
                    String::from_utf8_lossy(&content).into_owned()
                } else {
                    content.iter().map(|&b| b as char).collect::<String>()
                };

                let sent = http_listen::send_response(
                    req_id,
                    http_listen::HttpResponseData {
                        status: 200,
                        headers,
                        body,
                    },
                );
                if !sent {
                    return NodeResult::Error {
                        message: format!("Response channel not found for request {}", req_id),
                        raw_response: None,
                    };
                }
            }

            NodeResult::Continue {
                output: Some(json!({
                    "found": true,
                    "filePath": file_path.to_string_lossy(),
                    "contentType": mime,
                    "bytes": content_len,
                })),
            }
        })
    }
}

/// Detect MIME type from file extension.
fn detect_mime(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "application/javascript",
        "json" => "application/json",
        "xml" => "application/xml",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "wasm" => "application/wasm",
        "map" => "application/json",
        _ => "application/octet-stream",
    }
    .to_string()
}
