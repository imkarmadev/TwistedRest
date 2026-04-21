//! Backend HTTP transport for the flow executor.
//!
//! The frontend executor (in packages/core) builds a request and invokes
//! `http_request`. We perform the call via reqwest from the Rust process —
//! no CORS, no preflights, no webview restrictions. Returns the raw status,
//! headers, and body so the frontend can parse JSON and validate against
//! the node's Zod schema.

use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

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
        .user_agent("TwistedFlow/0.1")
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
    pub refresh_token: String,
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
        .user_agent("TwistedFlow/0.1")
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

    let refresh_token = parsed["refresh_token"].as_str().unwrap_or("").to_string();

    Ok(OAuth2TokenResult {
        access_token,
        refresh_token,
        expires_at: now + expires_in,
    })
}

// ─── OAuth2 Authorization Code ────────────────────────────────

/// Full OAuth2 Authorization Code flow:
///   1. Bind a local HTTP server on a random port
///   2. Open the browser to the authorization URL
///   3. Wait for the redirect callback (120s timeout)
///   4. Exchange the authorization code for tokens
///   5. Return access_token + refresh_token + expiry
#[tauri::command]
pub async fn oauth2_authorize(
    auth_url: String,
    token_url: String,
    client_id: String,
    client_secret: String,
    scopes: String,
) -> Result<OAuth2TokenResult, String> {
    // 1. Start local callback server
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind callback server: {}", e))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{}/callback", port);

    // 2. Build authorization URL with CSRF state
    let state = uuid::Uuid::new_v4().to_string();
    let full_auth_url = format!(
        "{}{}response_type=code&client_id={}&redirect_uri={}&scope={}&state={}",
        auth_url,
        if auth_url.contains('?') { "&" } else { "?" },
        urlencoding(&client_id),
        urlencoding(&redirect_uri),
        urlencoding(&scopes),
        &state,
    );

    // 3. Open browser
    open::that(&full_auth_url).map_err(|e| format!("Failed to open browser: {}", e))?;

    // 4. Wait for callback (120s timeout)
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(120), listener.accept())
        .await
        .map_err(|_| "Authorization timed out after 120 seconds. Try again.".to_string())?
        .map_err(|e| format!("Failed to accept callback: {}", e))?;

    // Read the HTTP request
    let mut buf = vec![0u8; 8192];
    let n = stream
        .read(&mut buf)
        .await
        .map_err(|e| format!("Failed to read callback: {}", e))?;
    let request = String::from_utf8_lossy(&buf[..n]).to_string();

    // Extract code and state from query string
    let code = extract_query_param(&request, "code")
        .ok_or("No authorization code in callback. User may have denied access.")?;
    let returned_state =
        extract_query_param(&request, "state").ok_or("No state parameter in callback.")?;

    if returned_state != state {
        return Err("State mismatch — possible CSRF attack. Try again.".into());
    }

    // Send success page to browser
    let html = "<html><body style='font-family:-apple-system,system-ui,sans-serif;text-align:center;padding:80px;background:#0a0d14;color:#e8e8ed'><h1 style='color:#4cc2ff'>Authorized!</h1><p style='color:#8e8e93'>You can close this tab and return to TwistedFlow.</p></body></html>";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    stream.write_all(response.as_bytes()).await.ok();
    stream.flush().await.ok();
    drop(stream);
    drop(listener);

    // 5. Exchange code for tokens
    let client = reqwest::Client::builder()
        .user_agent("TwistedFlow/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .post(&token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Token exchange failed: {}", e))?;

    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;

    if status >= 400 {
        return Err(format!("Token exchange error ({}): {}", status, body));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Invalid token JSON: {}", e))?;

    let access_token = parsed["access_token"]
        .as_str()
        .ok_or("Missing access_token in token response")?
        .to_string();
    let refresh_token = parsed["refresh_token"].as_str().unwrap_or("").to_string();
    let expires_in = parsed["expires_in"].as_u64().unwrap_or(3600);
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    Ok(OAuth2TokenResult {
        access_token,
        refresh_token,
        expires_at: now + expires_in,
    })
}

/// Minimal percent-encoding for URL query parameters.
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{:02X}", b));
            }
        }
    }
    out
}

/// Extract a query parameter from a raw HTTP request string.
/// Looks for "GET /callback?...&name=value..." pattern.
fn extract_query_param(request: &str, name: &str) -> Option<String> {
    let first_line = request.lines().next()?;
    let path = first_line.split_whitespace().nth(1)?;
    let query = path.split('?').nth(1)?;
    for pair in query.split('&') {
        let mut kv = pair.splitn(2, '=');
        let key = kv.next()?;
        let value = kv.next().unwrap_or("");
        if key == name {
            // Basic URL decoding
            return Some(
                value
                    .replace("%3A", ":")
                    .replace("%2F", "/")
                    .replace("+", " "),
            );
        }
    }
    None
}
