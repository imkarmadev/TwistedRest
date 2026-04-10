//! TwistedFlow Tauri entry point.
//!
//! File-based project model — no SQLite. Projects are folders on disk
//! with twistedflow.toml, flows/*.flow.json, .env* files.

mod executor_commands;
mod http;
mod project;

// Ensure twistedflow-nodes is linked so inventory discovers all #[node] registrations.
extern crate twistedflow_nodes;
use std::sync::Mutex;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem, Submenu, PredefinedMenuItem};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // ── Native macOS menu ────────────────────────────────
            let handle = app.handle();

            let app_menu = Submenu::with_items(handle, "TwistedFlow", true, &[
                &PredefinedMenuItem::about(handle, Some("About TwistedFlow"), None)?,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::services(handle, None)?,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::hide(handle, None)?,
                &PredefinedMenuItem::hide_others(handle, None)?,
                &PredefinedMenuItem::show_all(handle, None)?,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::quit(handle, None)?,
            ])?;

            let edit_menu = Submenu::with_items(handle, "Edit", true, &[
                &PredefinedMenuItem::undo(handle, None)?,
                &PredefinedMenuItem::redo(handle, None)?,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::cut(handle, None)?,
                &PredefinedMenuItem::copy(handle, None)?,
                &PredefinedMenuItem::paste(handle, None)?,
                &PredefinedMenuItem::select_all(handle, None)?,
            ])?;

            let view_menu = Submenu::with_items(handle, "View", true, &[
                &PredefinedMenuItem::fullscreen(handle, None)?,
            ])?;

            let window_menu = Submenu::with_items(handle, "Window", true, &[
                &PredefinedMenuItem::minimize(handle, None)?,
                &PredefinedMenuItem::maximize(handle, None)?,
                &PredefinedMenuItem::separator(handle)?,
                &PredefinedMenuItem::close_window(handle, None)?,
            ])?;

            let help_menu = Submenu::with_items(handle, "Help", true, &[
                &MenuItem::with_id(handle, "github", "TwistedFlow on GitHub", true, None::<&str>)?,
            ])?;

            let menu = Menu::with_items(handle, &[
                &app_menu,
                &edit_menu,
                &view_menu,
                &window_menu,
                &help_menu,
            ])?;
            app.set_menu(menu)?;

            app.on_menu_event(move |_app_handle, event| {
                if event.id() == "github" {
                    let _ = open::that("https://github.com/imkarmadev/TwistedFlow");
                }
            });

            // Executor state (cancellation token for active run)
            app.manage(executor_commands::ExecutorState {
                cancel: Mutex::new(None),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Project (file-based)
            project::create_project,
            project::open_project,
            project::list_flows,
            project::get_flow,
            project::save_flow,
            project::create_flow,
            project::delete_flow,
            project::rename_flow,
            project::list_environments,
            project::save_environment,
            project::create_environment,
            project::delete_environment,
            // HTTP
            http::http_request,
            http::oauth2_client_credentials,
            http::oauth2_authorize,
            // Executor
            executor_commands::run_flow,
            executor_commands::stop_flow,
            executor_commands::list_node_types,
            executor_commands::build_flow,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
