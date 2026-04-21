//! Verify Auth node — validates incoming authentication credentials.
//!
//! Branch node that checks JWT (HS256), API key, Basic, or Bearer token:
//!
//!   HTTP Listen out:headers → Verify Auth
//!                              ├── exec-pass → Route → handlers (out:claims available)
//!                              └── exec-fail → Send Response (401)

use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use twistedflow_engine::node::{Node, NodeCtx, NodeResult};
use twistedflow_macros::node;

use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[node(
    name = "Verify Auth",
    type_id = "verifyAuth",
    category = "HTTP Server",
    description = "Validate JWT, API key, or Basic auth on incoming requests"
)]
pub struct VerifyAuthNode;

impl Node for VerifyAuthNode {
    fn execute<'a>(
        &'a self,
        ctx: NodeCtx<'a>,
    ) -> Pin<Box<dyn Future<Output = NodeResult> + Send + 'a>> {
        Box::pin(async move {
            let headers = ctx.resolve_input("in:headers").await.unwrap_or(Value::Null);

            let mode = ctx
                .node_data
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("bearer");

            let optional = ctx
                .node_data
                .get("optional")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let result = match mode {
                "jwt" => verify_jwt(&ctx, &headers).await,
                "apiKey" => verify_api_key(&ctx, &headers).await,
                "basic" => verify_basic(&headers),
                "bearer" => verify_bearer(&headers),
                _ => Err("Unknown auth mode".to_string()),
            };

            match result {
                Ok((claims, token)) => {
                    // Store outputs
                    {
                        let mut out = ctx.outputs.lock().await;
                        let entry = out.entry(ctx.node_id.to_string()).or_default();
                        entry.insert("claims".into(), claims.clone());
                        entry.insert("token".into(), Value::String(token.clone()));
                    }

                    NodeResult::Branch {
                        handle: "exec-pass".to_string(),
                        output: Some(json!({ "claims": claims, "token": token })),
                    }
                }
                Err(reason) => {
                    if optional {
                        // Optional mode: pass through with null claims
                        {
                            let mut out = ctx.outputs.lock().await;
                            let entry = out.entry(ctx.node_id.to_string()).or_default();
                            entry.insert("claims".into(), Value::Null);
                            entry.insert("token".into(), Value::Null);
                        }
                        NodeResult::Branch {
                            handle: "exec-pass".to_string(),
                            output: Some(json!({ "claims": null, "token": null })),
                        }
                    } else {
                        {
                            let mut out = ctx.outputs.lock().await;
                            let entry = out.entry(ctx.node_id.to_string()).or_default();
                            entry.insert("claims".into(), Value::Null);
                            entry.insert("token".into(), Value::Null);
                            entry.insert("error".into(), Value::String(reason.clone()));
                        }
                        NodeResult::Branch {
                            handle: "exec-fail".to_string(),
                            output: Some(json!({ "error": reason })),
                        }
                    }
                }
            }
        })
    }
}

/// Extract the Authorization header value.
fn get_auth_header(headers: &Value) -> Option<String> {
    headers
        .get("authorization")
        .or_else(|| headers.get("Authorization"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Bearer mode: just extract the token, no validation.
fn verify_bearer(headers: &Value) -> Result<(Value, String), String> {
    let auth = get_auth_header(headers).ok_or("Missing Authorization header")?;
    let token = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .ok_or("Authorization header must start with 'Bearer '")?;

    Ok((json!({ "token": token }), token.to_string()))
}

/// Basic auth: decode base64, split user:pass.
fn verify_basic(headers: &Value) -> Result<(Value, String), String> {
    let auth = get_auth_header(headers).ok_or("Missing Authorization header")?;
    let encoded = auth
        .strip_prefix("Basic ")
        .or_else(|| auth.strip_prefix("basic "))
        .ok_or("Authorization header must start with 'Basic '")?;

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map_err(|e| format!("Invalid base64: {}", e))?;
    let decoded_str = String::from_utf8(decoded).map_err(|e| format!("Invalid UTF-8: {}", e))?;

    let mut parts = decoded_str.splitn(2, ':');
    let username = parts.next().unwrap_or("").to_string();
    let password = parts.next().unwrap_or("").to_string();

    Ok((
        json!({ "username": username, "password": password }),
        encoded.to_string(),
    ))
}

/// API key: check a header against valid keys.
async fn verify_api_key(ctx: &NodeCtx<'_>, headers: &Value) -> Result<(Value, String), String> {
    let header_name = ctx
        .node_data
        .get("apiKeyHeader")
        .and_then(|v| v.as_str())
        .unwrap_or("X-API-Key");

    let key = headers
        .get(header_name)
        .or_else(|| headers.get(&header_name.to_lowercase()))
        .and_then(|v| v.as_str())
        .ok_or(format!("Missing {} header", header_name))?;

    // Get valid keys from config or input pin
    let valid_keys: Vec<String> =
        if let Some(Value::Array(arr)) = ctx.resolve_input("in:validKeys").await {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        } else {
            let keys_str = ctx
                .node_data
                .get("apiKeyValues")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            keys_str
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        };

    if valid_keys.is_empty() {
        // No validation list — just extract the key
        return Ok((json!({ "key": key }), key.to_string()));
    }

    if valid_keys.contains(&key.to_string()) {
        Ok((json!({ "key": key }), key.to_string()))
    } else {
        Err("Invalid API key".to_string())
    }
}

/// JWT (HS256): decode header.payload.signature, verify HMAC-SHA256.
async fn verify_jwt(ctx: &NodeCtx<'_>, headers: &Value) -> Result<(Value, String), String> {
    let auth = get_auth_header(headers).ok_or("Missing Authorization header")?;
    let token = auth
        .strip_prefix("Bearer ")
        .or_else(|| auth.strip_prefix("bearer "))
        .ok_or("Authorization header must start with 'Bearer '")?;

    // Get secret from input pin or config
    let secret = if let Some(Value::String(s)) = ctx.resolve_input("in:secret").await {
        s
    } else {
        ctx.node_data
            .get("jwtSecret")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };

    if secret.is_empty() {
        return Err("JWT secret is empty — configure jwtSecret or wire in:secret".to_string());
    }

    // Split token into parts
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("Invalid JWT: expected 3 parts (header.payload.signature)".to_string());
    }

    let header_b64 = parts[0];
    let payload_b64 = parts[1];
    let sig_b64 = parts[2];

    // Verify signature (HS256)
    let signing_input = format!("{}.{}", header_b64, payload_b64);
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|e| format!("HMAC key error: {}", e))?;
    mac.update(signing_input.as_bytes());

    let expected_sig = mac.finalize().into_bytes();
    let actual_sig = base64_url_decode(sig_b64)?;

    if expected_sig.as_slice() != actual_sig.as_slice() {
        return Err("Invalid JWT signature".to_string());
    }

    // Decode payload
    let payload_bytes = base64_url_decode(payload_b64)?;
    let payload_str = String::from_utf8(payload_bytes)
        .map_err(|e| format!("Invalid UTF-8 in JWT payload: {}", e))?;
    let claims: Value = serde_json::from_str(&payload_str)
        .map_err(|e| format!("Invalid JSON in JWT payload: {}", e))?;

    // Check expiration if present
    if let Some(exp) = claims.get("exp").and_then(|v| v.as_u64()) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if now > exp {
            return Err(format!("JWT expired at {}", exp));
        }
    }

    Ok((claims, token.to_string()))
}

/// Decode a base64url-encoded string (no padding).
fn base64_url_decode(input: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(input.as_bytes())
        .map_err(|e| format!("Invalid base64url: {}", e))
}
