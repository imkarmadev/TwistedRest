//! SQLite persistence for TwistedRest.
//!
//! Stored at the platform's app-data directory (resolved by Tauri at runtime
//! and passed in to `init`). Schema is identical to the Phase 0 bun:sqlite
//! version — UUID PKs, `updated_at`, soft-delete columns. The same rows are
//! sync-friendly so we can plug in cloud replication later without a
//! migration.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS projects (
            id           TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            base_url     TEXT NOT NULL DEFAULT '',
            headers_json TEXT NOT NULL DEFAULT '[]',
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL,
            deleted_at   TEXT
        );

        CREATE TABLE IF NOT EXISTS environments (
            id           TEXT PRIMARY KEY,
            project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name         TEXT NOT NULL,
            vars_json    TEXT NOT NULL DEFAULT '[]',
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL,
            deleted_at   TEXT
        );

        CREATE TABLE IF NOT EXISTS flows (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            nodes_json  TEXT NOT NULL DEFAULT '[]',
            edges_json  TEXT NOT NULL DEFAULT '[]',
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            deleted_at  TEXT
        );
        "#,
    )?;

    // Additive columns on environments — base_url + headers_json + auth_json.
    // Each env carries its own dev/staging/prod URL, env-specific header
    // overrides, and auth config. We use ALTER TABLE ADD COLUMN guarded
    // by a try-pattern because SQLite has no IF NOT EXISTS for ADD COLUMN.
    let _ = conn.execute(
        "ALTER TABLE environments ADD COLUMN base_url TEXT NOT NULL DEFAULT ''",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE environments ADD COLUMN headers_json TEXT NOT NULL DEFAULT '[]'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE environments ADD COLUMN auth_json TEXT NOT NULL DEFAULT '{}'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE flows ADD COLUMN viewport_json TEXT NOT NULL DEFAULT '{}'",
        [],
    );

    Ok(())
}

// ─── Project ──────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HeaderEntry {
    pub key: String,
    pub value: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub headers: Vec<HeaderEntry>,
    pub updated_at: String,
}

pub fn list_projects(conn: &Connection) -> Result<Vec<ProjectSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, updated_at FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ProjectSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_project(conn: &Connection, id: &str) -> Result<Option<ProjectDetail>> {
    let row = conn
        .query_row(
            "SELECT id, name, base_url, headers_json, updated_at FROM projects
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| {
                let headers_json: String = row.get(3)?;
                let headers: Vec<HeaderEntry> =
                    serde_json::from_str(&headers_json).unwrap_or_default();
                Ok(ProjectDetail {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    base_url: row.get(2)?,
                    headers,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedProject {
    pub id: String,
    pub name: String,
}

pub fn create_project(conn: &Connection, name: &str) -> Result<CreatedProject> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO projects (id, name, base_url, headers_json, created_at, updated_at)
         VALUES (?1, ?2, '', '[]', ?3, ?3)",
        params![id, name, now],
    )?;
    Ok(CreatedProject {
        id,
        name: name.into(),
    })
}

pub fn update_project(
    conn: &Connection,
    id: &str,
    name: &str,
    base_url: &str,
    headers: &[HeaderEntry],
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let headers_json = serde_json::to_string(headers).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "UPDATE projects SET name = ?1, base_url = ?2, headers_json = ?3, updated_at = ?4
         WHERE id = ?5",
        params![name, base_url, headers_json, now, id],
    )?;
    Ok(())
}

pub fn delete_project(conn: &Connection, id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE projects SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

// ─── Environment ──────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub key: String,
    pub value: String,
    #[serde(default)]
    pub secret: bool,
}

/// Auth configuration for an environment. Determines how requests are
/// authenticated when this environment is active.
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfig {
    /// "none" | "bearer" | "basic" | "apiKey" | "oauth2_client_credentials"
    #[serde(default = "default_auth_type")]
    pub auth_type: String,

    // Bearer
    #[serde(default)]
    pub bearer_token: String,

    // Basic
    #[serde(default)]
    pub basic_username: String,
    #[serde(default)]
    pub basic_password: String,

    // API Key
    #[serde(default)]
    pub api_key_name: String,
    #[serde(default)]
    pub api_key_value: String,
    /// "header" | "query"
    #[serde(default = "default_api_key_location")]
    pub api_key_location: String,

    // OAuth2 Client Credentials
    #[serde(default)]
    pub oauth2_token_url: String,
    #[serde(default)]
    pub oauth2_client_id: String,
    #[serde(default)]
    pub oauth2_client_secret: String,
    #[serde(default)]
    pub oauth2_scopes: String,
    /// Cached access token (fetched at runtime, persisted for convenience)
    #[serde(default)]
    pub oauth2_access_token: String,
    /// Unix timestamp (seconds) when the access token expires
    #[serde(default)]
    pub oauth2_expires_at: u64,
}

fn default_auth_type() -> String {
    "none".into()
}
fn default_api_key_location() -> String {
    "header".into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub vars: Vec<EnvVar>,
    pub base_url: String,
    pub headers: Vec<HeaderEntry>,
    pub auth: AuthConfig,
    pub updated_at: String,
}

pub fn list_environments(conn: &Connection, project_id: &str) -> Result<Vec<Environment>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, name, vars_json, base_url, headers_json, auth_json, updated_at
         FROM environments WHERE project_id = ?1 AND deleted_at IS NULL ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            let vars_json: String = row.get(3)?;
            let vars: Vec<EnvVar> = serde_json::from_str(&vars_json).unwrap_or_default();
            let headers_json: String = row.get(5)?;
            let headers: Vec<HeaderEntry> =
                serde_json::from_str(&headers_json).unwrap_or_default();
            let auth_json: String = row.get(6)?;
            let auth: AuthConfig =
                serde_json::from_str(&auth_json).unwrap_or_default();
            Ok(Environment {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                vars,
                base_url: row.get(4)?,
                headers,
                auth,
                updated_at: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn create_environment(conn: &Connection, project_id: &str, name: &str) -> Result<Environment> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO environments (id, project_id, name, vars_json, base_url, headers_json, auth_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, '[]', '', '[]', '{}', ?4, ?4)",
        params![id, project_id, name, now],
    )?;
    Ok(Environment {
        id,
        project_id: project_id.into(),
        name: name.into(),
        vars: vec![],
        base_url: String::new(),
        headers: vec![],
        auth: AuthConfig::default(),
        updated_at: now,
    })
}

pub fn update_environment(
    conn: &Connection,
    id: &str,
    name: &str,
    vars: &[EnvVar],
    base_url: &str,
    headers: &[HeaderEntry],
    auth: &AuthConfig,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    let vars_json = serde_json::to_string(vars).unwrap_or_else(|_| "[]".into());
    let headers_json = serde_json::to_string(headers).unwrap_or_else(|_| "[]".into());
    let auth_json = serde_json::to_string(auth).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "UPDATE environments SET name = ?1, vars_json = ?2, base_url = ?3, headers_json = ?4, auth_json = ?5, updated_at = ?6
         WHERE id = ?7",
        params![name, vars_json, base_url, headers_json, auth_json, now, id],
    )?;
    Ok(())
}

pub fn delete_environment(conn: &Connection, id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE environments SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}

// ─── Flow ─────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowSummary {
    pub id: String,
    pub name: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowDetail {
    pub id: String,
    pub name: String,
    pub nodes: serde_json::Value,
    pub edges: serde_json::Value,
    pub viewport: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedFlow {
    pub id: String,
    pub name: String,
}

pub fn list_flows(conn: &Connection, project_id: &str) -> Result<Vec<FlowSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, updated_at FROM flows
         WHERE project_id = ?1 AND deleted_at IS NULL
         ORDER BY created_at ASC",
    )?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(FlowSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get_flow(conn: &Connection, id: &str) -> Result<Option<FlowDetail>> {
    let row = conn
        .query_row(
            "SELECT id, name, nodes_json, edges_json, viewport_json FROM flows
             WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |row| {
                let nodes_json: String = row.get(2)?;
                let edges_json: String = row.get(3)?;
                let viewport_json: String = row.get(4)?;
                Ok(FlowDetail {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    nodes: serde_json::from_str(&nodes_json).unwrap_or(serde_json::json!([])),
                    edges: serde_json::from_str(&edges_json).unwrap_or(serde_json::json!([])),
                    viewport: serde_json::from_str(&viewport_json).unwrap_or(serde_json::json!({})),
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn create_flow(
    conn: &Connection,
    project_id: &str,
    name: &str,
    nodes: &serde_json::Value,
    edges: &serde_json::Value,
) -> Result<CreatedFlow> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO flows (id, project_id, name, nodes_json, edges_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            id,
            project_id,
            name,
            nodes.to_string(),
            edges.to_string(),
            now
        ],
    )?;
    Ok(CreatedFlow {
        id,
        name: name.into(),
    })
}

pub fn save_flow(
    conn: &Connection,
    id: &str,
    nodes: &serde_json::Value,
    edges: &serde_json::Value,
    viewport: &serde_json::Value,
) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE flows SET nodes_json = ?1, edges_json = ?2, viewport_json = ?3, updated_at = ?4 WHERE id = ?5",
        params![nodes.to_string(), edges.to_string(), viewport.to_string(), now, id],
    )?;
    Ok(())
}

pub fn rename_flow(conn: &Connection, id: &str, name: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE flows SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, now, id],
    )?;
    Ok(())
}

pub fn delete_flow(conn: &Connection, id: &str) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE flows SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2",
        params![now, id],
    )?;
    Ok(())
}
