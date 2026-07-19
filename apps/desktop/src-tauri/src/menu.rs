// Application menu: construction, the menu/workspace event IDs shared with
// the frontend, and the dispatcher that turns menu clicks into events.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub(crate) const PDF_VIEW_EVENT: &str = "lumora-pdf-view-command";
const PDF_VIEW_FIT_WIDTH: &str = "pdf-view-fit-width";
const PDF_VIEW_GO_TO_PAGE: &str = "pdf-view-go-to-page";
const PDF_VIEW_BACK_TO_LINK_ORIGIN: &str = "pdf-view-back-to-link-origin";
const PDF_VIEW_ZOOM_PREFIX: &str = "pdf-view-zoom-";
pub(crate) const WORKSPACE_EVENT: &str = "lumora-workspace-command";
const WORKSPACE_CLOSE_ACTIVE_TAB: &str = "workspace-close-active-tab";
const HELP_KEYBOARD_SHORTCUTS: &str = "help-keyboard-shortcuts";
const HELP_CHECK_FOR_UPDATES: &str = "help-check-for-updates";
const APP_ABOUT: &str = "app-about";
const APP_FILE_STORAGE_SETTINGS: &str = "app-file-storage-settings";
const APP_MENDELEY_SYNC: &str = "app-mendeley-sync";
const APP_PROXY_SETTINGS: &str = "app-proxy-settings";
const APP_SYNC_SETTINGS: &str = "app-sync-settings";
const APP_DUPLICATE_DOCUMENTS: &str = "app-duplicate-documents";
const FILES_REFRESH_LIBRARY: &str = "files-refresh-library";
const FILES_DOWNLOAD_ARXIV_FILES: &str = "files-download-arxiv-files";

pub(crate) fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    if id == FILES_REFRESH_LIBRARY {
        let _ = app.emit(WORKSPACE_EVENT, "refresh-library");
    } else if id == PDF_VIEW_FIT_WIDTH {
        #[cfg(target_os = "macos")]
        crate::macos::reset_native_magnification(app);
        let _ = app.emit(PDF_VIEW_EVENT, "fit-width");
    } else if id == PDF_VIEW_GO_TO_PAGE {
        let _ = app.emit(PDF_VIEW_EVENT, "go-to-page");
    } else if id == PDF_VIEW_BACK_TO_LINK_ORIGIN {
        let _ = app.emit(PDF_VIEW_EVENT, "back-to-link-origin");
    } else if id == WORKSPACE_CLOSE_ACTIVE_TAB {
        let _ = app.emit(WORKSPACE_EVENT, "close-active-tab");
    } else if id == HELP_KEYBOARD_SHORTCUTS {
        let _ = app.emit(WORKSPACE_EVENT, "show-shortcuts-help");
    } else if id == HELP_CHECK_FOR_UPDATES {
        let _ = app.emit(WORKSPACE_EVENT, "check-for-updates");
    } else if id == APP_ABOUT {
        let _ = app.emit(WORKSPACE_EVENT, "show-about");
    } else if id == APP_FILE_STORAGE_SETTINGS {
        let _ = app.emit(WORKSPACE_EVENT, "show-file-storage-settings");
    } else if id == APP_MENDELEY_SYNC {
        let _ = app.emit(WORKSPACE_EVENT, "show-mendeley-sync");
    } else if id == APP_PROXY_SETTINGS {
        let _ = app.emit(WORKSPACE_EVENT, "show-proxy-settings");
    } else if id == APP_SYNC_SETTINGS {
        let _ = app.emit(WORKSPACE_EVENT, "show-sync-settings");
    } else if id == APP_DUPLICATE_DOCUMENTS {
        let _ = app.emit(WORKSPACE_EVENT, "show-duplicate-documents");
    } else if id == FILES_DOWNLOAD_ARXIV_FILES {
        let _ = app.emit(WORKSPACE_EVENT, "download-arxiv-files");
    } else if let Some(zoom) = id.strip_prefix(PDF_VIEW_ZOOM_PREFIX) {
        let _ = app.emit(PDF_VIEW_EVENT, format!("zoom:{zoom}"));
    }
}

#[cfg(desktop)]
pub(crate) fn build_menu<R: Runtime>(app_handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app_handle.package_info();

    // The application ("apple") submenu. `services` and `hide_others` are
    // macOS-only conventions (they render as dead/no-op entries elsewhere), so
    // they are included only on macOS. The macOS item sequence is kept
    // byte-for-byte identical to preserve the existing, verified menu.
    let about_item = MenuItem::with_id(app_handle, APP_ABOUT, format!("About {}", pkg_info.name), true, None::<&str>)?;
    let about_sep = PredefinedMenuItem::separator(app_handle)?;
    let mendeley_item = MenuItem::with_id(app_handle, APP_MENDELEY_SYNC, "Mendeley Sync...", true, None::<&str>)?;
    let sync_item = MenuItem::with_id(app_handle, APP_SYNC_SETTINGS, "Sync Settings...", true, None::<&str>)?;
    let proxy_item = MenuItem::with_id(app_handle, APP_PROXY_SETTINGS, "Proxy...", true, None::<&str>)?;
    let settings_sep = PredefinedMenuItem::separator(app_handle)?;
    #[cfg(target_os = "macos")]
    let services_item = PredefinedMenuItem::services(app_handle, None)?;
    #[cfg(target_os = "macos")]
    let services_sep = PredefinedMenuItem::separator(app_handle)?;
    let hide_item = PredefinedMenuItem::hide(app_handle, None)?;
    #[cfg(target_os = "macos")]
    let hide_others_item = PredefinedMenuItem::hide_others(app_handle, None)?;
    let quit_sep = PredefinedMenuItem::separator(app_handle)?;
    let quit_item = PredefinedMenuItem::quit(app_handle, None)?;

    let mut app_items: Vec<&dyn tauri::menu::IsMenuItem<R>> = vec![
        &about_item,
        &about_sep,
        &mendeley_item,
        &sync_item,
        &proxy_item,
        &settings_sep,
    ];
    #[cfg(target_os = "macos")]
    {
        app_items.push(&services_item);
        app_items.push(&services_sep);
    }
    app_items.push(&hide_item);
    #[cfg(target_os = "macos")]
    app_items.push(&hide_others_item);
    app_items.push(&quit_sep);
    app_items.push(&quit_item);

    let app_menu = Submenu::with_items(app_handle, pkg_info.name.clone(), true, &app_items)?;

    let files_menu = Submenu::with_items(
        app_handle,
        "Files",
        true,
        &[
            &MenuItem::with_id(app_handle, FILES_REFRESH_LIBRARY, "Refresh Library", true, Some("CmdOrCtrl+R"))?,
            &PredefinedMenuItem::separator(app_handle)?,
            &MenuItem::with_id(app_handle, APP_FILE_STORAGE_SETTINGS, "File Storage Settings...", true, None::<&str>)?,
            &MenuItem::with_id(app_handle, FILES_DOWNLOAD_ARXIV_FILES, "Download arXiv Files", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &MenuItem::with_id(app_handle, APP_DUPLICATE_DOCUMENTS, "Duplicate Documents...", true, None::<&str>)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app_handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app_handle, None)?,
            &PredefinedMenuItem::redo(app_handle, None)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &PredefinedMenuItem::cut(app_handle, None)?,
            &PredefinedMenuItem::copy(app_handle, None)?,
            &PredefinedMenuItem::paste(app_handle, None)?,
            &PredefinedMenuItem::select_all(app_handle, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app_handle,
        "View",
        true,
        &[
            &MenuItem::with_id(app_handle, PDF_VIEW_BACK_TO_LINK_ORIGIN, "Back to Previous Location", true, Some("CmdOrCtrl+O"))?,
            &PredefinedMenuItem::separator(app_handle)?,
            &MenuItem::with_id(app_handle, PDF_VIEW_FIT_WIDTH, "Fit Width", true, Some("CmdOrCtrl+;"))?,
            &zoom_menu(app_handle)?,
            &MenuItem::with_id(app_handle, PDF_VIEW_GO_TO_PAGE, "Go to Page...", true, Some("CmdOrCtrl+G"))?,
            &PredefinedMenuItem::separator(app_handle)?,
            &PredefinedMenuItem::fullscreen(app_handle, None)?,
        ],
    )?;

    let window_menu = Submenu::with_id_and_items(
        app_handle,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app_handle, None)?,
            &PredefinedMenuItem::maximize(app_handle, None)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &MenuItem::with_id(app_handle, WORKSPACE_CLOSE_ACTIVE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app_handle,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            &MenuItem::with_id(app_handle, HELP_CHECK_FOR_UPDATES, "Check for Updates…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &MenuItem::with_id(app_handle, HELP_KEYBOARD_SHORTCUTS, "Keyboard Shortcuts", true, None::<&str>)?,
        ],
    )?;

    Menu::with_items(app_handle, &[&app_menu, &files_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
}

#[cfg(desktop)]
fn zoom_menu<R: Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Submenu<R>> {
    Submenu::with_items(
        manager,
        "Zoom",
        true,
        &[
            &MenuItem::with_id(manager, "pdf-view-zoom-0.75", "75%", true, None::<&str>)?,
            &MenuItem::with_id(manager, "pdf-view-zoom-0.9", "90%", true, None::<&str>)?,
            // No accelerator: Cmd+1..9 switch workspace tabs (handled in App.tsx).
            &MenuItem::with_id(manager, "pdf-view-zoom-1", "100%", true, None::<&str>)?,
            &MenuItem::with_id(manager, "pdf-view-zoom-1.1", "110%", true, None::<&str>)?,
            &MenuItem::with_id(manager, "pdf-view-zoom-1.25", "125%", true, None::<&str>)?,
            &MenuItem::with_id(manager, "pdf-view-zoom-1.5", "150%", true, None::<&str>)?,
            &MenuItem::with_id(manager, "pdf-view-zoom-1.75", "175%", true, None::<&str>)?,
            &MenuItem::with_id(manager, "pdf-view-zoom-2", "200%", true, None::<&str>)?,
        ],
    )
}
