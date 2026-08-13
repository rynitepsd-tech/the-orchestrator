//! The Orchestrator — native shell.
//!
//! Owns desktop lifecycle, the engine sidecar, native menus, and the secure
//! IPC boundary. Product logic lives in the engine and the UI; this layer stays
//! deliberately thin.

mod engine;
mod menu;

use engine::EngineSupervisor;
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

/// Send one protocol frame to the engine.
#[tauri::command]
fn engine_send(state: tauri::State<'_, EngineSupervisor>, frame: String) -> Result<(), String> {
    state.send(&frame)
}

/// Start the engine if it is not already running.
#[tauri::command]
fn engine_start(state: tauri::State<'_, EngineSupervisor>) -> Result<(), String> {
    state.spawn()
}

/// Restart the engine after a crash, or from Settings → Advanced.
#[tauri::command]
fn engine_restart(state: tauri::State<'_, EngineSupervisor>) -> Result<(), String> {
    state.shutdown();
    state.spawn()
}

#[tauri::command]
fn engine_running(state: tauri::State<'_, EngineSupervisor>) -> bool {
    state.is_running()
}

/// Sanitized environment summary for the About window and Copy Diagnostics.
/// Deliberately contains no credentials, paths to secrets, or env values.
#[tauri::command]
fn app_diagnostics(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "appVersion": app.package_info().version.to_string(),
        "arch": std::env::consts::ARCH,
        "os": std::env::consts::OS,
        "tauri": tauri::VERSION,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            engine_send,
            engine_start,
            engine_restart,
            engine_running,
            app_diagnostics,
        ])
        .setup(|app| {
            let supervisor = EngineSupervisor::new(app.handle().clone());
            app.manage(supervisor.clone());

            menu::install(app.handle())?;

            // Start the engine immediately; the UI shows staged progress from
            // the engine's own lifecycle events rather than a blank spinner.
            if let Err(e) = supervisor.spawn() {
                log::error!("engine failed to start: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // macOS convention: closing the window hides it and leaves the app
            // (and any running agents) alive. Cmd+Q is what truly quits.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if cfg!(target_os = "macos") {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building The Orchestrator")
        .run(|app, event| match event {
            // Re-show the window when the dock icon is clicked with no windows open.
            RunEvent::Reopen { .. } => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            RunEvent::ExitRequested { .. } => {
                // Ask the UI to confirm when agents are still running. The UI
                // owns that dialog because only it knows the session states.
                let _ = app.emit("app://exit-requested", ());
            }
            RunEvent::Exit => {
                if let Some(s) = app.try_state::<EngineSupervisor>() {
                    s.shutdown();
                }
            }
            _ => {}
        });
}
