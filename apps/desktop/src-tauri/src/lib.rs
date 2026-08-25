//! The Orchestrator — native shell.
//!
//! Owns desktop lifecycle, the engine sidecar, native menus, and the secure
//! IPC boundary. Product logic lives in the engine and the UI; this layer stays
//! deliberately thin.

mod engine;
mod menu;

use engine::EngineSupervisor;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

/// Set once the UI has confirmed quitting (or no sessions were running).
/// Until then, ExitRequested is intercepted so running agents cannot be
/// killed by a stray Cmd+Q.
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

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

/// Quit for real, after the UI has confirmed (or found nothing running).
#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    app.exit(0);
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
    // Without an installed logger every log::error!/debug! (including engine
    // stderr) is silently discarded. Level via RUST_LOG, default info.
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    tauri::Builder::default()
        // Must be the first plugin registered (its own requirement). A second
        // launch would otherwise clobber the first instance's usage index;
        // instead it just fronts the existing window and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            engine_send,
            engine_start,
            engine_restart,
            engine_running,
            app_diagnostics,
            app_quit,
        ])
        .setup(|app| {
            let supervisor = EngineSupervisor::new(app.handle().clone());
            app.manage(supervisor.clone());

            menu::install(app.handle())?;

            // tao registers the NSWindow as a drag destination and its
            // `draggingEntered:` unwraps the deprecated NSFilenamesPboardType,
            // which modern Finder drags may not populate — a drag merely
            // passing over the window then aborts the whole app (tao 0.35.3
            // window_delegate.rs:424, still present upstream). We never use
            // window-level drops (the composer handles HTML5 drops in the
            // webview, which keeps its own registration), so unregister the
            // window and the fragile handlers can never fire.
            #[cfg(target_os = "macos")]
            if let Some(w) = app.get_webview_window("main") {
                if let Ok(ns_window) = w.ns_window() {
                    unsafe {
                        use objc2::msg_send;
                        let ns_window = ns_window as *mut objc2::runtime::AnyObject;
                        let _: () = msg_send![&*ns_window, unregisterDraggedTypes];
                    }
                }
            }

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
            RunEvent::ExitRequested { api, .. } => {
                // Intercept quit until the UI confirms: only it knows whether
                // sessions are still running. It answers via `app_quit`.
                if !QUIT_CONFIRMED.load(Ordering::SeqCst) {
                    // The window may be hidden (Cmd+W hides, not closes); the
                    // confirmation dialog would otherwise be invisible and the
                    // app would look unquittable.
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    api.prevent_exit();
                    let _ = app.emit("app://exit-requested", ());
                }
            }
            RunEvent::Exit => {
                // The plugin's own save hook fires on window close, but close
                // is intercepted into a hide here, so save explicitly on exit.
                {
                    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                    let _ = app.save_window_state(StateFlags::all());
                }
                if let Some(s) = app.try_state::<EngineSupervisor>() {
                    s.shutdown();
                }
            }
            _ => {}
        });
}
