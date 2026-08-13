//! Native macOS menu bar.
//!
//! Menu items emit `menu://<id>` to the webview rather than acting directly,
//! so keyboard shortcuts and menu clicks funnel through the same UI commands.

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let about = AboutMetadata {
        name: Some("The Orchestrator".into()),
        version: Some(app.package_info().version.to_string()),
        comments: Some("An unofficial desktop interface for OhMyPi".into()),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        "The Orchestrator",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About The Orchestrator"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "settings", "Settings…", true, Some("Cmd+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "new-session", "New Session", true, Some("Cmd+N"))?,
            &MenuItem::with_id(app, "open-project", "Open Project…", true, Some("Cmd+O"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("Close Window"))?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let session_menu = Submenu::with_items(
        app,
        "Session",
        true,
        &[
            &MenuItem::with_id(app, "session-abort", "Abort Run", true, Some("Cmd+."))?,
            &MenuItem::with_id(app, "session-compact", "Compact Session", true, None::<&str>)?,
            &MenuItem::with_id(app, "session-fork", "Fork Session", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "session-model", "Change Model…", true, Some("Cmd+Shift+M"))?,
            &MenuItem::with_id(app, "session-advisors", "Configure Advisors…", true, Some("Cmd+Shift+A"))?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "toggle-sidebar", "Toggle Sidebar", true, Some("Cmd+1"))?,
            &MenuItem::with_id(app, "toggle-inspector", "Toggle Inspector", true, Some("Cmd+2"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "view-usage", "Usage", true, Some("Cmd+U"))?,
            &MenuItem::with_id(app, "view-changes", "Changes", true, Some("Cmd+G"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "command-palette", "Command Palette", true, Some("Cmd+Shift+P"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &session_menu, &view_menu, &window_menu],
    )?;

    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id().0.as_str();
        // The UI decides what each command means for the current selection.
        let _ = app.emit(&format!("menu://{id}"), ());
    });

    Ok(())
}
