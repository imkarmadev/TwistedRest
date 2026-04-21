//! Encode/Decode node — base64, URL-encode, hex encoding.
//!
//! Pure data node. Configurable encoding + direction (encode/decode).

use base64::Engine;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Encode/Decode",
    type_id = "encodeDecode",
    category = "String",
    description = "Encode or decode: base64, URL-encode, hex"
)]
pub struct EncodeDecodeNode;

impl Node for EncodeDecodeNode {
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

            let encoding = ctx
                .node_data
                .get("encoding")
                .and_then(|v| v.as_str())
                .unwrap_or("base64");

            let direction = ctx
                .node_data
                .get("direction")
                .and_then(|v| v.as_str())
                .unwrap_or("encode");

            let result = match (encoding, direction) {
                ("base64", "encode") => {
                    Ok(base64::engine::general_purpose::STANDARD.encode(input_str.as_bytes()))
                }
                ("base64", "decode") => base64::engine::general_purpose::STANDARD
                    .decode(input_str.trim())
                    .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
                    .map_err(|e| format!("base64 decode error: {}", e)),
                ("base64url", "encode") => {
                    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD
                        .encode(input_str.as_bytes()))
                }
                ("base64url", "decode") => base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(input_str.trim())
                    .map(|bytes| String::from_utf8_lossy(&bytes).to_string())
                    .map_err(|e| format!("base64url decode error: {}", e)),
                ("hex", "encode") => Ok(input_str.bytes().map(|b| format!("{:02x}", b)).collect()),
                ("hex", "decode") => {
                    let clean = input_str.replace(' ', "");
                    let bytes: Result<Vec<u8>, _> = (0..clean.len())
                        .step_by(2)
                        .map(|i| {
                            u8::from_str_radix(&clean[i..i.min(clean.len() - 1) + 2], 16)
                                .map_err(|e| format!("hex decode error: {}", e))
                        })
                        .collect();
                    bytes.map(|b| String::from_utf8_lossy(&b).to_string())
                }
                ("url", "encode") => Ok(urlencoding::encode(&input_str).to_string()),
                ("url", "decode") => urlencoding::decode(&input_str)
                    .map(|s| s.to_string())
                    .map_err(|e| format!("URL decode error: {}", e)),
                _ => Err(format!(
                    "Unknown encoding '{}' or direction '{}'",
                    encoding, direction
                )),
            };

            match result {
                Ok(output) => {
                    let mut out: HashMap<String, Value> = HashMap::new();
                    out.insert("result".into(), Value::String(output));
                    ctx.set_outputs(out).await;

                    NodeResult::Data(
                        ctx.get_outputs(ctx.node_id)
                            .await
                            .map(|o| serde_json::to_value(o).unwrap_or(Value::Null)),
                    )
                }
                Err(msg) => NodeResult::Error {
                    message: format!("Encode/Decode: {}", msg),
                    raw_response: None,
                },
            }
        })
    }
}
