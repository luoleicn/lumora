use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const PDF_VIEW_EVENT: &str = "lumora-pdf-view-command";
const PDF_VIEW_FIT_WIDTH: &str = "pdf-view-fit-width";
const PDF_VIEW_GO_TO_PAGE: &str = "pdf-view-go-to-page";
const PDF_VIEW_ZOOM_PREFIX: &str = "pdf-view-zoom-";
const WORKSPACE_EVENT: &str = "lumora-workspace-command";
const WORKSPACE_CLOSE_ACTIVE_TAB: &str = "workspace-close-active-tab";
const HELP_KEYBOARD_SHORTCUTS: &str = "help-keyboard-shortcuts";
const APP_ABOUT: &str = "app-about";

#[tauri::command]
fn ping() -> &'static str {
    "lumora-ready"
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArxivAuthor {
    full_name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArxivMetadata {
    arxiv_id: String,
    title: String,
    authors: Vec<ArxivAuthor>,
    year: Option<i32>,
    #[serde(rename = "abstract")]
    abstract_: String,
    doi: Option<String>,
    url: String,
    published_at: Option<String>,
    updated_at: Option<String>,
    venue: String,
    categories: Vec<String>,
    score: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct YoudaoTranslation {
    query: String,
    phonetic: Option<String>,
    explains: Vec<String>,
    page_url: String,
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|error| format!("Invalid URL: {error}"))?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("dict.youdao.com") {
        return Err("Only Youdao dictionary URLs are allowed.".to_string());
    }

    open_url_with_system(&url)
}

#[cfg(target_os = "macos")]
fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("Failed to open URL: {error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map_err(|error| format!("Failed to open URL: {error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("Failed to open URL: {error}"))?;
    Ok(())
}

#[tauri::command]
async fn translate_with_youdao(query: String) -> Result<YoudaoTranslation, String> {
    let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
    if query.is_empty() {
        return Err("No text selected.".to_string());
    }

    let query = query.chars().take(200).collect::<String>();
    let mut url = reqwest::Url::parse("https://dict.youdao.com/suggest")
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("num", "5")
        .append_pair("ver", "3.0")
        .append_pair("doctype", "json")
        .append_pair("cache", "false")
        .append_pair("le", "en")
        .append_pair("q", &query);

    let response = reqwest::Client::new()
        .get(url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Youdao request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("Youdao lookup failed: {}", response.status()));
    }

    let text = response
        .text()
        .await
        .map_err(|error| format!("Failed to read Youdao response: {error}"))?;
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| format!("Failed to parse Youdao response: {error}"))?;

    Ok(parse_youdao_translation(&value, query))
}

#[tauri::command]
async fn search_arxiv_by_title(title: String) -> Result<Vec<ArxivMetadata>, String> {
    let query = title.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let mut url = reqwest::Url::parse("https://export.arxiv.org/api/query")
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("search_query", &format!("ti:\"{}\"", query.replace('"', "")))
        .append_pair("start", "0")
        .append_pair("max_results", "3")
        .append_pair("sortBy", "relevance")
        .append_pair("sortOrder", "descending");

    let response = reqwest::Client::new()
        .get(url)
        .header("accept", "application/atom+xml")
        .send()
        .await
        .map_err(|error| format!("arXiv request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!("arXiv lookup failed: {}", response.status()));
    }

    let xml = response
        .text()
        .await
        .map_err(|error| format!("Failed to read arXiv response: {error}"))?;

    let mut results = parse_arxiv_feed(&xml, query);
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    Ok(results)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                enable_trackpad_pinch_zoom(app);
                install_fit_width_shortcut_monitor(app.handle().clone());
            }
            Ok(())
        })
        .menu(build_menu)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == PDF_VIEW_FIT_WIDTH {
                #[cfg(target_os = "macos")]
                reset_native_magnification(app);
                let _ = app.emit(PDF_VIEW_EVENT, "fit-width");
            } else if id == PDF_VIEW_GO_TO_PAGE {
                let _ = app.emit(PDF_VIEW_EVENT, "go-to-page");
            } else if id == WORKSPACE_CLOSE_ACTIVE_TAB {
                let _ = app.emit(WORKSPACE_EVENT, "close-active-tab");
            } else if id == HELP_KEYBOARD_SHORTCUTS {
                let _ = app.emit(WORKSPACE_EVENT, "show-shortcuts-help");
            } else if id == APP_ABOUT {
                let _ = app.emit(WORKSPACE_EVENT, "show-about");
            } else if let Some(zoom) = id.strip_prefix(PDF_VIEW_ZOOM_PREFIX) {
                let _ = app.emit(PDF_VIEW_EVENT, format!("zoom:{zoom}"));
            }
        })
        .invoke_handler(tauri::generate_handler![ping, open_external_url, translate_with_youdao, search_arxiv_by_title])
        .run(tauri::generate_context!())
        .expect("error while running lumora");
}

// WKWebView disables trackpad pinch-to-zoom by default (`allowsMagnification` is false).
// Enabling it lets WebKit dispatch `gesturestart`/`gesturechange` DOM events for the pinch
// gesture, which PdfReader listens for; it also calls `preventDefault()` on those events so
// WebKit's own whole-page magnification never kicks in.
#[cfg(target_os = "macos")]
fn enable_trackpad_pinch_zoom<R: Runtime>(app: &tauri::App<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let _ = window.with_webview(|webview| unsafe {
        let view = &*(webview.inner() as *const objc2_web_kit::WKWebView);
        view.setAllowsMagnification(true);
    });
}

// WKWebView claims macOS text-editing key equivalents (Cmd+Z is Undo, Cmd+; is
// spell-check's "Check Document Now") inside its own performKeyEquivalent: pass,
// which macOS runs before both the menu-bar accelerators and DOM keydown
// listeners — so neither layer ever sees those chords. An NSApplication-level
// local event monitor is the one hook that runs ahead of the responder chain,
// so the Fit Width shortcut is intercepted here and forwarded as the same event
// the View menu item emits. Returning null consumes the NSEvent, which also
// keeps WebKit's built-in spell-check action from firing.
#[cfg(target_os = "macos")]
fn install_fit_width_shortcut_monitor(app_handle: AppHandle) {
    use core::ptr::NonNull;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};

    // kVK_ANSI_Semicolon: match the physical key, not the produced character —
    // under a CJK input source charactersIgnoringModifiers can yield the
    // full-width "；", which would break a string comparison against ";".
    const SEMICOLON_KEY_CODE: u16 = 41;

    let handler: block2::RcBlock<dyn Fn(NonNull<NSEvent>) -> *mut NSEvent> =
        block2::RcBlock::new(move |event: NonNull<NSEvent>| {
            let key_event = unsafe { event.as_ref() };
            let flags = key_event.modifierFlags();
            let is_semicolon_key = key_event.keyCode() == SEMICOLON_KEY_CODE
                || key_event
                    .charactersIgnoringModifiers()
                    .is_some_and(|characters| matches!(characters.to_string().as_str(), ";" | "；"));
            let is_fit_width_chord = flags.contains(NSEventModifierFlags::Command)
                && !flags.intersects(
                    NSEventModifierFlags::Shift | NSEventModifierFlags::Control | NSEventModifierFlags::Option,
                )
                && is_semicolon_key;

            if is_fit_width_chord {
                reset_native_magnification(&app_handle);
                let _ = app_handle.emit(PDF_VIEW_EVENT, "fit-width");
                return core::ptr::null_mut();
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
fn reset_native_magnification<R: Runtime>(app_handle: &AppHandle<R>) {
    let Some(window) = app_handle.get_webview_window("main") else {
        return;
    };

    let _ = window.with_webview(|webview| unsafe {
        let view = &*(webview.inner() as *const objc2_web_kit::WKWebView);
        view.setMagnification(1.0);
    });
}

#[cfg(desktop)]
fn build_menu<R: Runtime>(app_handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app_handle.package_info();
    let app_menu = Submenu::with_items(
        app_handle,
        pkg_info.name.clone(),
        true,
        &[
            &MenuItem::with_id(app_handle, APP_ABOUT, format!("About {}", pkg_info.name), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &PredefinedMenuItem::services(app_handle, None)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &PredefinedMenuItem::hide(app_handle, None)?,
            &PredefinedMenuItem::hide_others(app_handle, None)?,
            &PredefinedMenuItem::separator(app_handle)?,
            &PredefinedMenuItem::quit(app_handle, None)?,
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
        &[&MenuItem::with_id(app_handle, HELP_KEYBOARD_SHORTCUTS, "Keyboard Shortcuts", true, None::<&str>)?],
    )?;

    Menu::with_items(app_handle, &[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
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

fn parse_arxiv_feed(xml: &str, query_title: &str) -> Vec<ArxivMetadata> {
    let mut results = Vec::new();
    let mut rest = xml;

    while let Some(start) = rest.find("<entry>") {
        let after_start = &rest[start + "<entry>".len()..];
        let Some(end) = after_start.find("</entry>") else {
            break;
        };
        let entry = &after_start[..end];
        rest = &after_start[end + "</entry>".len()..];

        let id_url = clean_text(&read_tag(entry, "id"));
        let arxiv_id = normalize_arxiv_id(&id_url);
        let title = clean_text(&read_tag(entry, "title"));
        if arxiv_id.is_empty() || title.is_empty() {
            continue;
        }

        let abstract_ = clean_text(&read_tag(entry, "summary"));
        let published_at = optional_clean_text(read_tag(entry, "published"));
        let updated_at = optional_clean_text(read_tag(entry, "updated"));
        let doi = optional_clean_text(read_tag(entry, "arxiv:doi"));
        let journal_ref = optional_clean_text(read_tag(entry, "arxiv:journal_ref"));
        let authors = read_authors(entry);
        let categories = read_categories(entry);
        let year = published_at
            .as_ref()
            .and_then(|value| value.get(0..4))
            .and_then(|value| value.parse::<i32>().ok());
        let score = score_title_match(query_title, &title);

        results.push(ArxivMetadata {
            url: format!("https://arxiv.org/abs/{arxiv_id}"),
            arxiv_id,
            title,
            authors,
            year,
            abstract_,
            doi,
            published_at,
            updated_at,
            venue: journal_ref.unwrap_or_else(|| "arXiv".to_string()),
            categories,
            score,
        });
    }

    results
}

fn read_authors(entry: &str) -> Vec<ArxivAuthor> {
    let mut authors = Vec::new();
    let mut rest = entry;

    while let Some(start) = rest.find("<author>") {
        let after_start = &rest[start + "<author>".len()..];
        let Some(end) = after_start.find("</author>") else {
            break;
        };
        let author = &after_start[..end];
        let full_name = clean_text(&read_tag(author, "name"));
        if !full_name.is_empty() {
            authors.push(ArxivAuthor { full_name });
        }
        rest = &after_start[end + "</author>".len()..];
    }

    authors
}

fn read_categories(entry: &str) -> Vec<String> {
    entry
        .split("<category")
        .skip(1)
        .filter_map(|chunk| {
            let term_start = chunk.find("term=\"")? + "term=\"".len();
            let term_rest = &chunk[term_start..];
            let term_end = term_rest.find('"')?;
            Some(term_rest[..term_end].to_string())
        })
        .collect()
}

fn parse_youdao_translation(value: &serde_json::Value, fallback_query: String) -> YoudaoTranslation {
    let query = value
        .pointer("/data/query")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.pointer("/query").and_then(serde_json::Value::as_str))
        .unwrap_or(&fallback_query)
        .to_string();
    let phonetic = value
        .pointer("/data/phonetic")
        .and_then(serde_json::Value::as_str)
        .or_else(|| value.pointer("/basic/phonetic").and_then(serde_json::Value::as_str))
        .map(ToString::to_string);
    let mut explains = Vec::new();

    if let Some(entries) = value.pointer("/data/entries").and_then(serde_json::Value::as_array) {
        for entry in entries {
            if let Some(explain) = entry.get("explain").and_then(serde_json::Value::as_str) {
                push_unique_explain(&mut explains, explain);
            }
        }
    }

    if let Some(basic_explains) = value.pointer("/basic/explains").and_then(serde_json::Value::as_array) {
        for explain in basic_explains {
            if let Some(explain) = explain.as_str() {
                push_unique_explain(&mut explains, explain);
            }
        }
    }

    YoudaoTranslation {
        page_url: build_youdao_page_url(&query),
        query,
        phonetic,
        explains,
    }
}

fn build_youdao_page_url(query: &str) -> String {
    let mut url = reqwest::Url::parse("https://dict.youdao.com/result").expect("static Youdao URL is valid");
    url.query_pairs_mut()
        .append_pair("word", query)
        .append_pair("lang", "en");
    url.to_string()
}

fn push_unique_explain(explains: &mut Vec<String>, value: &str) {
    let explain = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if !explain.is_empty() && !explains.iter().any(|item| item == &explain) {
        explains.push(explain);
    }
}

fn read_tag(xml: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let Some(start) = xml.find(&open) else {
        return String::new();
    };
    let Some(open_end) = xml[start..].find('>') else {
        return String::new();
    };
    let content_start = start + open_end + 1;
    let close = format!("</{tag}>");
    let Some(content_end) = xml[content_start..].find(&close) else {
        return String::new();
    };
    xml[content_start..content_start + content_end].to_string()
}

fn optional_clean_text(value: String) -> Option<String> {
    let cleaned = clean_text(&value);
    (!cleaned.is_empty()).then_some(cleaned)
}

fn clean_text(value: &str) -> String {
    decode_xml_entities(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_xml_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn normalize_arxiv_id(value: &str) -> String {
    let id = value
        .split("arxiv.org/abs/")
        .nth(1)
        .unwrap_or(value)
        .split(['?', '#', ' '])
        .next()
        .unwrap_or(value)
        .trim_start_matches("arXiv:");

    if let Some(version_index) = id.rfind('v') {
        if id[version_index + 1..].chars().all(|char| char.is_ascii_digit()) {
            return id[..version_index].to_string();
        }
    }

    id.to_string()
}

fn score_title_match(query_title: &str, candidate_title: &str) -> f64 {
    let query_tokens = tokenize(query_title);
    let candidate_tokens = tokenize(candidate_title);
    if query_tokens.is_empty() || candidate_tokens.is_empty() {
        return 0.0;
    }

    let hits = query_tokens
        .iter()
        .filter(|token| candidate_tokens.contains(token))
        .count();
    let coverage = hits as f64 / query_tokens.len() as f64;
    let length_penalty = query_tokens.len().abs_diff(candidate_tokens.len()) as f64
        / query_tokens.len().max(candidate_tokens.len()) as f64;
    (coverage - length_penalty * 0.15).max(0.0)
}

fn tokenize(value: &str) -> Vec<String> {
    value
        .to_lowercase()
        .split(|char: char| !char.is_alphanumeric())
        .filter(|token| token.len() > 2)
        .map(ToString::to_string)
        .collect()
}
