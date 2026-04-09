//! Backend HTTP transport for the flow executor.
//!
//! The frontend executor (in packages/core) builds a request and invokes
//! `http_request`. We perform the call via reqwest from the Rust process —
//! no CORS, no preflights, no webview restrictions. Returns the raw status,
//! headers, and body so the frontend can parse JSON and validate against
//! the node's Zod schema.

use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    /// Pairs of (header name, header value). Vec of tuples keeps the
    /// JSON shape compact and matches the frontend's preferred format.
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

#[tauri::command]
pub async fn http_request(req: HttpRequest) -> Result<HttpResponse, String> {
    let client = reqwest::Client::builder()
        .user_agent("TwistedRest/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let method = reqwest::Method::from_str(&req.method.to_uppercase())
        .map_err(|e| format!("invalid method: {}", e))?;

    let mut builder = client.request(method, &req.url);
    for (k, v) in &req.headers {
        if !k.trim().is_empty() {
            builder = builder.header(k, v);
        }
    }
    if let Some(body) = req.body {
        if !body.is_empty() {
            builder = builder.body(body);
        }
    }

    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    Ok(HttpResponse {
        status,
        headers,
        body,
    })
}

// ─── OAuth2 Client Credentials ────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuth2TokenResult {
    pub access_token: String,
    pub expires_at: u64,
}

/// Exchange client credentials for an access token via the OAuth2
/// client_credentials grant. Returns the token + expiry timestamp
/// so the frontend can cache it in the environment auth config.
#[tauri::command]
pub async fn oauth2_client_credentials(
    token_url: String,
    client_id: String,
    client_secret: String,
    scopes: String,
) -> Result<OAuth2TokenResult, String> {
    let client = reqwest::Client::builder()
        .user_agent("TwistedRest/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let mut params = vec![
        ("grant_type", "client_credentials".to_string()),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ];
    if !scopes.is_empty() {
        params.push(("scope", scopes));
    }

    let resp = client
        .post(&token_url)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("token request failed: {}", e))?;

    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("failed to read token response: {}", e))?;

    if status >= 400 {
        return Err(format!("OAuth2 token error ({}): {}", status, body));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("invalid token JSON: {}", e))?;

    let access_token = parsed["access_token"]
        .as_str()
        .ok_or("missing access_token in response")?
        .to_string();

    let expires_in = parsed["expires_in"].as_u64().unwrap_or(3600);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    Ok(OAuth2TokenResult {
        access_token,
        expires_at: now + expires_in,
    })
}
