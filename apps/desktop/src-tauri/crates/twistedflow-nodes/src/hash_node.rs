//! Hash node — compute SHA-256, SHA-1, MD5, or HMAC hashes.
//!
//! Pure data node. Algorithm configured via node_data.algorithm.
//! For HMAC, reads the key from the in:key pin or node_data.key.

use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

#[node(
    name = "Hash",
    type_id = "hash",
    category = "String",
    description = "Compute SHA-256, SHA-1, MD5, or HMAC hash"
)]
pub struct HashNode;

impl Node for HashNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let input = ctx.resolve_input("in:value").await;
            let input_bytes = match &input {
                Some(Value::String(s)) => s.as_bytes().to_vec(),
                Some(v) => v.to_string().into_bytes(),
                None => Vec::new(),
            };

            let algorithm = ctx
                .node_data
                .get("algorithm")
                .and_then(|v| v.as_str())
                .unwrap_or("sha256");

            let output_format = ctx
                .node_data
                .get("outputFormat")
                .and_then(|v| v.as_str())
                .unwrap_or("hex");

            use md5::Md5;
            use sha2::{Digest, Sha256, Sha512};

            let hash_bytes: Vec<u8> = match algorithm {
                "sha256" => {
                    let mut hasher = Sha256::new();
                    hasher.update(&input_bytes);
                    hasher.finalize().to_vec()
                }
                "sha512" => {
                    let mut hasher = Sha512::new();
                    hasher.update(&input_bytes);
                    hasher.finalize().to_vec()
                }
                "md5" => {
                    let mut hasher = Md5::new();
                    hasher.update(&input_bytes);
                    hasher.finalize().to_vec()
                }
                "hmac-sha256" => {
                    use hmac::{Hmac, Mac};
                    type HmacSha256 = Hmac<Sha256>;

                    let key = ctx.resolve_input("in:key").await;
                    let key_bytes = match &key {
                        Some(Value::String(s)) => s.as_bytes().to_vec(),
                        _ => ctx
                            .node_data
                            .get("key")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .as_bytes()
                            .to_vec(),
                    };

                    let mut mac = HmacSha256::new_from_slice(&key_bytes)
                        .map_err(|e| format!("HMAC key error: {}", e))
                        .unwrap();
                    mac.update(&input_bytes);
                    mac.finalize().into_bytes().to_vec()
                }
                _ => {
                    return NodeResult::Error {
                        message: format!("Hash: unknown algorithm '{}'", algorithm),
                        raw_response: None,
                    };
                }
            };

            let hash_string = match output_format {
                "hex" => hash_bytes.iter().map(|b| format!("{:02x}", b)).collect(),
                "base64" => {
                    use base64::Engine;
                    base64::engine::general_purpose::STANDARD.encode(&hash_bytes)
                }
                _ => hash_bytes.iter().map(|b| format!("{:02x}", b)).collect(),
            };

            let mut out: HashMap<String, Value> = HashMap::new();
            out.insert("hash".into(), Value::String(hash_string));
            ctx.set_outputs(out).await;

            NodeResult::Data(
                ctx.get_outputs(ctx.node_id)
                    .await
                    .map(|o| serde_json::to_value(o).unwrap_or(Value::Null)),
            )
        })
    }
}
