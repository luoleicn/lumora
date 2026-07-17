// Mendeley direct integration. See the section banner below; tokens and
// client credentials live in the library meta table so the WebView never
// sees them.

use tauri::{AppHandle, Runtime};

// --- Mendeley direct integration -------------------------------------------
// The desktop app talks to api.mendeley.com itself: OAuth authorization-code
// flow with a fixed loopback redirect (the URI registered at dev.mendeley.com
// must match exactly, so the port is fixed), tokens stored in the library
// database's meta table, and an authenticated request proxy that refreshes the
// access token transparently.

const MENDELEY_REDIRECT_PORT: u16 = 53682;
const MENDELEY_REDIRECT_PATH: &str = "/mendeley/callback";
const MENDELEY_META_ACCESS_TOKEN: &str = "mendeleyAccessToken";
const MENDELEY_META_REFRESH_TOKEN: &str = "mendeleyRefreshToken";
const MENDELEY_META_EXPIRES_AT: &str = "mendeleyTokenExpiresAt";
const MENDELEY_META_DISPLAY_NAME: &str = "mendeleyDisplayName";
const MENDELEY_META_CLIENT_ID: &str = "mendeleyClientId";
const MENDELEY_META_CLIENT_SECRET: &str = "mendeleyClientSecret";

#[derive(serde::Deserialize)]
struct MendeleyTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MendeleyStatus {
    connected: bool,
    display_name: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MendeleyResponse {
    status: u16,
    body: String,
    link_next: Option<String>,
}

fn mendeley_redirect_uri() -> String {
    format!("http://localhost:{MENDELEY_REDIRECT_PORT}{MENDELEY_REDIRECT_PATH}")
}

fn clear_mendeley_tokens(connection: &rusqlite::Connection) {
    for key in [
        MENDELEY_META_ACCESS_TOKEN,
        MENDELEY_META_REFRESH_TOKEN,
        MENDELEY_META_EXPIRES_AT,
        MENDELEY_META_DISPLAY_NAME,
        MENDELEY_META_CLIENT_ID,
        MENDELEY_META_CLIENT_SECRET,
    ] {
        let _ = connection.execute("DELETE FROM meta WHERE key = ?1", [key]);
    }
}

fn store_mendeley_tokens<R: Runtime>(app: &AppHandle<R>, tokens: &MendeleyTokenResponse) -> Result<(), String> {
    let connection = crate::db::open_library_db(app)?;
    crate::db::set_meta_value(&connection, MENDELEY_META_ACCESS_TOKEN, &tokens.access_token)?;
    if let Some(refresh_token) = &tokens.refresh_token {
        crate::db::set_meta_value(&connection, MENDELEY_META_REFRESH_TOKEN, refresh_token)?;
    }
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64 + tokens.expires_in.unwrap_or(3600))
        .unwrap_or(0);
    crate::db::set_meta_value(&connection, MENDELEY_META_EXPIRES_AT, &expires_at.to_string())?;
    Ok(())
}

// Waits for the OAuth redirect on the loopback listener and extracts the
// `code`/`state` query parameters from the request line.
fn await_oauth_callback(listener: std::net::TcpListener) -> Result<(String, String), String> {
    use std::io::{BufRead, BufReader, Write};

    listener
        .set_nonblocking(false)
        .map_err(|error| error.to_string())?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(180);
    for stream in listener.incoming() {
        if std::time::Instant::now() > deadline {
            return Err("Timed out waiting for the Mendeley authorization redirect.".to_string());
        }

        let mut stream = stream.map_err(|error| error.to_string())?;
        let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
        let mut request_line = String::new();
        reader.read_line(&mut request_line).map_err(|error| error.to_string())?;

        let path = request_line.split_whitespace().nth(1).unwrap_or_default().to_string();
        let responded_ok = path.starts_with(MENDELEY_REDIRECT_PATH);
        let body = if responded_ok {
            "<html><body><h2>lumora</h2><p>Mendeley authorization complete. You can close this window.</p></body></html>"
        } else {
            "<html><body><p>Unexpected request.</p></body></html>"
        };
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );

        if !responded_ok {
            continue;
        }

        let query = path.split_once('?').map(|(_, query)| query).unwrap_or_default();
        let mut code = None;
        let mut state = None;
        for pair in query.split('&') {
            match pair.split_once('=') {
                Some(("code", value)) => code = Some(value.to_string()),
                Some(("state", value)) => state = Some(value.to_string()),
                _ => {}
            }
        }

        return match (code, state) {
            (Some(code), Some(state)) => Ok((code, state)),
            _ => Err("Mendeley redirect did not include an authorization code.".to_string()),
        };
    }

    Err("Authorization listener closed unexpectedly.".to_string())
}

#[tauri::command]
pub(crate) async fn mendeley_connect(app: AppHandle, client_id: String, client_secret: String) -> Result<MendeleyStatus, String> {
    let client_id = client_id.trim().to_string();
    let client_secret = client_secret.trim().to_string();
    if client_id.is_empty() {
        return Err("Enter the Mendeley client ID first.".to_string());
    }

    let listener = std::net::TcpListener::bind(("127.0.0.1", MENDELEY_REDIRECT_PORT))
        .map_err(|error| format!("Port {MENDELEY_REDIRECT_PORT} is unavailable for the OAuth callback: {error}"))?;

    let state = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default()
    );

    let mut authorize_url = reqwest::Url::parse("https://api.mendeley.com/oauth/authorize")
        .map_err(|error| error.to_string())?;
    authorize_url
        .query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &mendeley_redirect_uri())
        .append_pair("response_type", "code")
        .append_pair("scope", "all")
        .append_pair("state", &state);
    crate::system::open_url_with_system(authorize_url.as_str())?;

    let (code, returned_state) = tauri::async_runtime::spawn_blocking(move || await_oauth_callback(listener))
        .await
        .map_err(|error| error.to_string())??;
    if returned_state != state {
        return Err("OAuth state mismatch; aborting for safety.".to_string());
    }

    let client = crate::proxy::network_client(&app)?;
    let token_response = client
        .post("https://api.mendeley.com/oauth/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", &mendeley_redirect_uri()),
            ("client_id", &client_id),
            ("client_secret", &client_secret),
        ])
        .send()
        .await
        .map_err(|error| format!("Token exchange failed: {error}"))?;

    if !token_response.status().is_success() {
        let status = token_response.status();
        let body = token_response.text().await.unwrap_or_default();
        return Err(format!("Token exchange failed ({status}): {body}"));
    }

    let tokens: MendeleyTokenResponse = token_response
        .json()
        .await
        .map_err(|error| format!("Failed to parse token response: {error}"))?;
    store_mendeley_tokens(&app, &tokens)?;

    // Confirm the connection and capture the profile name for display.
    let profile_response = client
        .get("https://api.mendeley.com/profiles/me")
        .bearer_auth(&tokens.access_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let display_name = if profile_response.status().is_success() {
        let profile: serde_json::Value = profile_response.json().await.unwrap_or_default();
        profile
            .get("display_name")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string)
            .or_else(|| profile.get("email").and_then(serde_json::Value::as_str).map(ToString::to_string))
    } else {
        None
    };

    let connection = crate::db::open_library_db(&app)?;
    crate::db::set_meta_value(&connection, MENDELEY_META_DISPLAY_NAME, display_name.as_deref().unwrap_or(""))?;
    crate::db::set_meta_value(&connection, MENDELEY_META_CLIENT_ID, &client_id)?;
    crate::db::set_meta_value(&connection, MENDELEY_META_CLIENT_SECRET, &client_secret)?;

    Ok(MendeleyStatus { connected: true, display_name })
}

#[tauri::command]
pub(crate) async fn mendeley_status(app: AppHandle) -> Result<MendeleyStatus, String> {
    let (has_refresh_token, display_name, token_fresh, client_id, client_secret) = {
        let connection = crate::db::open_library_db(&app)?;
        let has_refresh_token = crate::db::get_meta_value(&connection, MENDELEY_META_REFRESH_TOKEN).is_some();
        let display_name = crate::db::get_meta_value(&connection, MENDELEY_META_DISPLAY_NAME)
            .filter(|name| !name.is_empty());
        let expires_at = crate::db::get_meta_value(&connection, MENDELEY_META_EXPIRES_AT)
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        let token_fresh = expires_at - now > 60;
        let client_id = crate::db::get_meta_value(&connection, MENDELEY_META_CLIENT_ID).unwrap_or_default();
        let client_secret = crate::db::get_meta_value(&connection, MENDELEY_META_CLIENT_SECRET).unwrap_or_default();
        (has_refresh_token, display_name, token_fresh, client_id, client_secret)
    };

    if !has_refresh_token {
        return Ok(MendeleyStatus { connected: false, display_name: None });
    }

    // Fast path: access token is still valid — no network call needed.
    if token_fresh {
        return Ok(MendeleyStatus { connected: true, display_name });
    }

    // Token is near or past expiry. Try refreshing to verify the refresh token
    // is still good. If client credentials were never stored (pre-migration DB),
    // err on the side of showing "connected" rather than forcing re-auth.
    if client_id.is_empty() {
        return Ok(MendeleyStatus { connected: true, display_name });
    }

    match refresh_mendeley_token(&app, &client_id, &client_secret).await {
        Ok(_) => {
            let connection = crate::db::open_library_db(&app)?;
            let display_name = crate::db::get_meta_value(&connection, MENDELEY_META_DISPLAY_NAME)
                .filter(|name| !name.is_empty());
            Ok(MendeleyStatus { connected: true, display_name })
        }
        Err(_) => {
            // refresh_mendeley_token clears tokens on authentication failures
            // (4xx), so re-reading the DB gives the correct post-clear state.
            // Network errors leave tokens intact — connected stays true.
            let connection = crate::db::open_library_db(&app)?;
            let still_connected = crate::db::get_meta_value(&connection, MENDELEY_META_REFRESH_TOKEN).is_some();
            let display_name = crate::db::get_meta_value(&connection, MENDELEY_META_DISPLAY_NAME)
                .filter(|name| !name.is_empty());
            Ok(MendeleyStatus { connected: still_connected, display_name })
        }
    }
}

#[tauri::command]
pub(crate) async fn mendeley_disconnect(app: AppHandle) -> Result<(), String> {
    let connection = crate::db::open_library_db(&app)?;
    clear_mendeley_tokens(&connection);
    Ok(())
}

async fn refresh_mendeley_token<R: Runtime>(
    app: &AppHandle<R>,
    client_id: &str,
    client_secret: &str,
) -> Result<String, String> {
    let refresh_token = {
        let connection = crate::db::open_library_db(app)?;
        crate::db::get_meta_value(&connection, MENDELEY_META_REFRESH_TOKEN)
            .ok_or_else(|| "Not connected to Mendeley.".to_string())?
    };

    let response = crate::proxy::network_client(app)?
        .post("https://api.mendeley.com/oauth/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", client_id),
            ("client_secret", client_secret),
        ])
        .send()
        .await
        .map_err(|error| format!("Token refresh failed: {error}"))?;

    if !response.status().is_success() {
        let status = response.status();
        // When the refresh token itself is invalid or expired, clear all stored
        // tokens so the app reports "disconnected" without manual intervention.
        if status == reqwest::StatusCode::BAD_REQUEST || status == reqwest::StatusCode::UNAUTHORIZED {
            if let Ok(connection) = crate::db::open_library_db(app) {
                clear_mendeley_tokens(&connection);
            }
        }
        return Err(format!("Token refresh failed ({}). Reconnect Mendeley.", status));
    }

    let tokens: MendeleyTokenResponse = response
        .json()
        .await
        .map_err(|error| format!("Failed to parse refresh response: {error}"))?;
    store_mendeley_tokens(app, &tokens)?;
    Ok(tokens.access_token)
}

// Authenticated proxy to api.mendeley.com so the frontend never handles tokens
// or CORS. Refreshes the access token once on 401.
#[tauri::command]
pub(crate) async fn mendeley_request(
    app: AppHandle,
    client_id: String,
    client_secret: String,
    method: String,
    path: String,
    body: Option<String>,
    content_type: Option<String>,
) -> Result<MendeleyResponse, String> {
    if !path.starts_with('/') {
        return Err("Mendeley API path must start with '/'.".to_string());
    }

    let mut access_token = {
        let connection = crate::db::open_library_db(&app)?;
        let expires_at = crate::db::get_meta_value(&connection, MENDELEY_META_EXPIRES_AT)
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        let token = crate::db::get_meta_value(&connection, MENDELEY_META_ACCESS_TOKEN);
        if expires_at - now < 60 { None } else { token }
    };

    if access_token.is_none() {
        access_token = Some(refresh_mendeley_token(&app, &client_id, &client_secret).await?);
    }

    let url = format!("https://api.mendeley.com{path}");
    let client = crate::proxy::network_client(&app)?;

    for attempt in 0..2 {
        let mut request = match method.as_str() {
            "GET" => client.get(&url),
            "POST" => client.post(&url),
            "PATCH" => client.patch(&url),
            "DELETE" => client.delete(&url),
            _ => return Err(format!("Unsupported method: {method}")),
        }
        .bearer_auth(access_token.as_deref().unwrap_or_default());

        if let Some(content_type) = &content_type {
            request = request.header("content-type", content_type).header("accept", content_type);
        }
        if let Some(body) = &body {
            request = request.body(body.clone());
        }

        let response = request
            .send()
            .await
            .map_err(|error| format!("Mendeley request failed: {error}"))?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            access_token = Some(refresh_mendeley_token(&app, &client_id, &client_secret).await?);
            continue;
        }

        let status = response.status().as_u16();
        let link_next = response
            .headers()
            .get("link")
            .and_then(|value| value.to_str().ok())
            .and_then(parse_next_link);
        let response_body = response.text().await.unwrap_or_default();
        return Ok(MendeleyResponse { status, body: response_body, link_next });
    }

    Err("Mendeley request failed after token refresh.".to_string())
}

// Downloads the attachment bytes after Mendeley's short-lived 303 redirect.
// Keeping this in Rust means OAuth tokens and signed URLs never enter WebView JS.
#[tauri::command]
pub(crate) async fn mendeley_download_file(
    app: AppHandle,
    client_id: String,
    client_secret: String,
    file_id: String,
) -> Result<tauri::ipc::Response, String> {
    let token = {
        let connection = crate::db::open_library_db(&app)?;
        let expires_at = crate::db::get_meta_value(&connection, MENDELEY_META_EXPIRES_AT)
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(0);
        if expires_at - now >= 60 {
            crate::db::get_meta_value(&connection, MENDELEY_META_ACCESS_TOKEN)
        } else {
            None
        }
    };
    let mut access_token = match token {
        Some(token) => token,
        None => refresh_mendeley_token(&app, &client_id, &client_secret).await?,
    };
    for attempt in 0..2 {
        let response = crate::proxy::network_client(&app)?
            .get(format!("https://api.mendeley.com/files/{file_id}"))
            .bearer_auth(&access_token)
            .send()
            .await
            .map_err(|error| format!("Mendeley file download failed: {error}"))?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            access_token = refresh_mendeley_token(&app, &client_id, &client_secret).await?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("Mendeley file download failed ({})", response.status()));
        }
        let bytes = response.bytes().await
            .map_err(|error| format!("Failed to read Mendeley file: {error}"))?;
        return Ok(tauri::ipc::Response::new(bytes.to_vec()));
    }
    Err("Mendeley file download failed after token refresh.".to_string())
}

// Extracts the rel="next" URL from an RFC 5988 Link header and returns it as a
// path+query relative to api.mendeley.com.
fn parse_next_link(header: &str) -> Option<String> {
    for part in header.split(',') {
        let (url_part, params) = part.split_once(';')?;
        if params.contains("rel=\"next\"") {
            let url = url_part.trim().trim_start_matches('<').trim_end_matches('>');
            return url.strip_prefix("https://api.mendeley.com").map(ToString::to_string);
        }
    }
    None
}
