//! Tauri command surface — the bridge between the React webview and the
//! Rust backend. Each `#[tauri::command]` function is invocable from JS via
//! `invoke('snake_case_name', { ...args })`.
//!
//! Database access is funneled through `AppState`, a `Mutex<Connection>`
//! injected via `tauri::State`. Commands are short and just delegate to
//! `db.rs` so the SQL stays in one place.

use crate::db;
use serde_json::Value;
use std::sync::Mutex;
use tauri::State;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
}

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ─── Projects ─────────────────────────────────────────────────

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Result<Vec<db::ProjectSummary>, String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::list_projects(&conn).map_err(map_err)
}

#[tauri::command]
pub fn get_project(
    id: String,
    state: State<'_, AppState>,
) -> Result<Option<db::ProjectDetail>, String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::get_project(&conn, &id).map_err(map_err)
}

#[tauri::command]
pub fn create_project(name: String, state: State<'_, AppState>) -> Result<db::CreatedProject, String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::create_project(&conn, &name).map_err(map_err)
}

#[tauri::command]
pub fn update_project(
    id: String,
    name: String,
    base_url: String,
    headers: Vec<db::HeaderEntry>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::update_project(&conn, &id, &name, &base_url, &headers).map_err(map_err)
}

#[tauri::command]
pub fn delete_project(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::delete_project(&conn, &id).map_err(map_err)
}

// ─── Environments ─────────────────────────────────────────────

#[tauri::command]
pub fn list_environments(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<db::Environment>, String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::list_environments(&conn, &project_id).map_err(map_err)
}

#[tauri::command]
pub fn create_environment(
    project_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<db::Environment, String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::create_environment(&conn, &project_id, &name).map_err(map_err)
}

#[tauri::command]
pub fn update_environment(
    id: String,
    name: String,
    vars: Vec<db::EnvVar>,
    base_url: String,
    headers: Vec<db::HeaderEntry>,
    auth: db::AuthConfig,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::update_environment(&conn, &id, &name, &vars, &base_url, &headers, &auth).map_err(map_err)
}

#[tauri::command]
pub fn delete_environment(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::delete_environment(&conn, &id).map_err(map_err)
}

// ─── Flows ────────────────────────────────────────────────────

#[tauri::command]
pub fn list_flows(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<db::FlowSummary>, String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::list_flows(&conn, &project_id).map_err(map_err)
}

#[tauri::command]
pub fn get_flow(id: String, state: State<'_, AppState>) -> Result<Option<db::FlowDetail>, String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::get_flow(&conn, &id).map_err(map_err)
}

#[tauri::command]
pub fn create_flow(
    project_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<db::CreatedFlow, String> {
    let conn = state.db.lock().map_err(map_err)?;

    // Seed every new flow with a Start node so the canvas isn't empty.
    let start_node = serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "kind": "start",
        "position": { "x": 120, "y": 160 },
        "config": { "environmentId": null }
    });
    let nodes = serde_json::json!([start_node]);
    let edges = serde_json::json!([]);

    db::create_flow(&conn, &project_id, &name, &nodes, &edges).map_err(map_err)
}

#[tauri::command]
pub fn save_flow(
    id: String,
    nodes: Value,
    edges: Value,
    viewport: Option<Value>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(map_err)?;
    let vp = viewport.unwrap_or(serde_json::json!({}));
    db::save_flow(&conn, &id, &nodes, &edges, &vp).map_err(map_err)
}

#[tauri::command]
pub fn rename_flow(id: String, name: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::rename_flow(&conn, &id, &name).map_err(map_err)
}

#[tauri::command]
pub fn delete_flow(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(map_err)?;
    db::delete_flow(&conn, &id).map_err(map_err)
}
