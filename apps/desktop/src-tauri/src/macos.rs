// macOS-only WKWebView integration. Moved verbatim from lib.rs; behavior
// must not change without explicit confirmation (see project conventions).

#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter, Manager, Runtime};

// WKWebView disables trackpad pinch-to-zoom by default (`allowsMagnification` is false).
// Enabling it lets WebKit dispatch `gesturestart`/`gesturechange` DOM events for the pinch
// gesture, which PdfReader listens for; it also calls `preventDefault()` on those events so
// WebKit's own whole-page magnification never kicks in.
#[cfg(target_os = "macos")]
pub(crate) fn enable_trackpad_pinch_zoom<R: Runtime>(app: &tauri::App<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = window.with_webview(|webview| unsafe {
        let view = &*(webview.inner() as *const objc2_web_kit::WKWebView);
        view.setAllowsMagnification(true);
    });
}

// WKWebView claims macOS text-editing key equivalents (Cmd+Z is Undo, Cmd+; is
// spell-check's "Check Document Now", Cmd+F is Find) inside its own
// performKeyEquivalent: pass, which macOS runs before both the menu-bar
// accelerators and DOM keydown listeners — so neither layer ever sees those
// chords. An NSApplication-level local event monitor is the one hook that runs
// ahead of the responder chain, so shortcuts are intercepted here and forwarded
// as Tauri events. Returning null consumes the NSEvent, preventing WebKit's
// built-in actions from firing.
#[cfg(target_os = "macos")]
pub(crate) fn install_key_shortcut_monitor(app_handle: AppHandle) {
    use core::ptr::NonNull;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};

    // kVK_ANSI_Semicolon: match the physical key, not the produced character —
    // under a CJK input source charactersIgnoringModifiers can yield the
    // full-width "；", which would break a string comparison against ";".
    const SEMICOLON_KEY_CODE: u16 = 41;
    const F_KEY_CODE: u16 = 3;

    let handler: block2::RcBlock<dyn Fn(NonNull<NSEvent>) -> *mut NSEvent> =
        block2::RcBlock::new(move |event: NonNull<NSEvent>| {
            let key_event = unsafe { event.as_ref() };
            let flags = key_event.modifierFlags();
            let is_cmd_only = flags.contains(NSEventModifierFlags::Command)
                && !flags.intersects(
                    NSEventModifierFlags::Shift | NSEventModifierFlags::Control | NSEventModifierFlags::Option,
                );

            // Cmd+; → Fit Width
            if is_cmd_only {
                let is_semicolon_key = key_event.keyCode() == SEMICOLON_KEY_CODE
                    || key_event
                        .charactersIgnoringModifiers()
                        .is_some_and(|characters| matches!(characters.to_string().as_str(), ";" | "；"));
                if is_semicolon_key {
                    reset_native_magnification(&app_handle);
                    let _ = app_handle.emit(crate::menu::PDF_VIEW_EVENT, "fit-width");
                    return core::ptr::null_mut();
                }

                // Cmd+F → focus the toolbar search / find bar. Use both
                // keyCode and character detection for robustness, then
                // evaluate JS directly in the webview — this avoids the
                // Tauri event round-trip and works even when the event
                // listener hasn't been set up yet. The search input is located
                // by its semantic `data-search-input` marker (kept in sync with
                // focusToolbarSearch on the JS side), not a presentational
                // tag/type that can silently drift.
                let is_f_key = key_event.keyCode() == F_KEY_CODE
                    || key_event
                        .charactersIgnoringModifiers()
                        .is_some_and(|c| matches!(c.to_string().to_lowercase().as_str(), "f"));
                if is_f_key {
                    let js = "const el=document.querySelector('.app-toolbar input[data-search-input]');if(el){el.focus();el.select();}";
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.eval(js);
                    }
                    let _ = app_handle.emit(crate::menu::WORKSPACE_EVENT, "focus-toolbar-search");
                    return core::ptr::null_mut();
                }
            }

            event.as_ptr()
        });

    unsafe {
        if let Some(monitor) = NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler) {
            // The monitor must stay registered for the app's whole lifetime.
            std::mem::forget(monitor);
        }
    }
}

// With allowsMagnification enabled, a trackpad pinch may zoom via WKWebView's
// native whole-view magnification (in addition to, or instead of, the JS-side
// page zoom, depending on whether WebKit honors preventDefault on the gesture
// events). Fit Width must therefore reset both layers: this handles the native
// one, and the "fit-width" event handles the JS one.
#[cfg(target_os = "macos")]
pub(crate) fn reset_native_magnification<R: Runtime>(app_handle: &AppHandle<R>) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };

    let _ = window.with_webview(|webview| unsafe {
        let view = &*(webview.inner() as *const objc2_web_kit::WKWebView);
        view.setMagnification(1.0);
    });
}
