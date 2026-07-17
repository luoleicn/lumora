// Network proxy settings (persisted in the library meta table) and the
// proxy-aware reqwest client factory used by every outbound integration.

use tauri::{AppHandle, Runtime};

const PROXY_SETTINGS_META_KEY: &str = "networkProxySettings";

#[derive(Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProxySettings {
    enabled: bool,
    url: String,
    username: String,
    password: String,
}

fn validate_proxy_settings(settings: &ProxySettings) -> Result<(), String> {
    if !settings.enabled {
        return Ok(());
    }
    let url = reqwest::Url::parse(settings.url.trim())
        .map_err(|error| format!("Invalid proxy URL: {error}"))?;
    match url.scheme() {
        "http" | "https" | "socks5" | "socks5h" => Ok(()),
        scheme => Err(format!("Unsupported proxy protocol: {scheme}")),
    }
}

fn load_proxy_settings<R: Runtime>(app: &AppHandle<R>) -> Result<ProxySettings, String> {
    let connection = crate::db::open_library_db(app)?;
    let Some(raw) = crate::db::get_meta_value(&connection, PROXY_SETTINGS_META_KEY) else {
        return Ok(ProxySettings::default());
    };
    serde_json::from_str(&raw).map_err(|error| format!("Failed to read proxy settings: {error}"))
}

pub(crate) fn network_client<R: Runtime>(app: &AppHandle<R>) -> Result<reqwest::Client, String> {
    let settings = load_proxy_settings(app)?;
    validate_proxy_settings(&settings)?;
    let mut builder = reqwest::Client::builder();
    if settings.enabled {
        let mut proxy = reqwest::Proxy::all(settings.url.trim())
            .map_err(|error| format!("Invalid proxy URL: {error}"))?;
        if !settings.username.is_empty() {
            proxy = proxy.basic_auth(&settings.username, &settings.password);
        }
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|error| format!("Failed to configure network client: {error}"))
}

#[tauri::command]
pub(crate) async fn proxy_settings(app: AppHandle) -> Result<ProxySettings, String> {
    load_proxy_settings(&app)
}

#[tauri::command]
pub(crate) async fn set_proxy_settings(app: AppHandle, settings: ProxySettings) -> Result<(), String> {
    validate_proxy_settings(&settings)?;
    let connection = crate::db::open_library_db(&app)?;
    let value = serde_json::to_string(&settings).map_err(|error| error.to_string())?;
    crate::db::set_meta_value(&connection, PROXY_SETTINGS_META_KEY, &value)
}

#[cfg(test)]
mod tests {
    use super::{validate_proxy_settings, ProxySettings};

    #[test]
    fn accepts_http_and_socks_proxy_urls() {
        for url in ["http://127.0.0.1:8080", "https://proxy.example:8443", "socks5://127.0.0.1:1080", "socks5h://localhost:1080"] {
            assert!(validate_proxy_settings(&ProxySettings {
                enabled: true,
                url: url.to_string(),
                username: String::new(),
                password: String::new(),
            }).is_ok());
        }
    }

    #[test]
    fn rejects_unsupported_proxy_protocols() {
        assert!(validate_proxy_settings(&ProxySettings {
            enabled: true,
            url: "ftp://localhost:21".to_string(),
            username: String::new(),
            password: String::new(),
        }).is_err());
    }
}
