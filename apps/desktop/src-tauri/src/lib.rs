//! TwistedRest Tauri entry point.
//!
//! Wires the SQLite connection into Tauri state, applies a native macOS
//! NSVisualEffectView (Sidebar material) to the main window for true Apple
//! Liquid Glass — no CSS backdrop-filter required.

mod commands;
mod db;
mod http;

use commands::AppState;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // ── Database ─────────────────────────────────────────
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("could not resolve app_data_dir");
            std::fs::create_dir_all(&app_data_dir).ok();
            let db_path = app_data_dir.join("twistedrest.db");
            let conn = db::open(&db_path).expect("failed to open database");
            app.manage(AppState {
                db: Mutex::new(conn),
            });
            println!("[twistedrest] db at {:?}", db_path);

            // No vibrancy — the window is fully opaque, matching Mail.app's
            // solid dark window. Native macOS draws the rounded corners and
            // traffic lights via decorations:true + titleBarStyle:Overlay.
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::get_project,
            commands::create_project,
            commands::update_project,
            commands::delete_project,
            commands::list_environments,
            commands::create_environment,
            commands::update_environment,
            commands::delete_environment,
            commands::list_flows,
            commands::get_flow,
            commands::create_flow,
            commands::save_flow,
            commands::rename_flow,
            commands::delete_flow,
            http::http_request,
            http::oauth2_client_credentials,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
