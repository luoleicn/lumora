// OS integration: vetted external-URL opening, revealing stored files, and
// the Linux graphics capability probe the PDF render policy consumes.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinuxGraphicsCapability {
    tier: &'static str,
}


/// Detect Linux graphics hardware outside WebKit. Creating a WebGL context just
/// to probe the renderer can itself trigger WebKitGTK driver bugs, so the
/// frontend receives a conservative capability tier derived from DRM/sysfs.
#[tauri::command]
pub(crate) fn linux_graphics_capability() -> LinuxGraphicsCapability {
    #[cfg(target_os = "linux")]
    {
        let software_requested = [
            "LIBGL_ALWAYS_SOFTWARE",
            "GALLIUM_DRIVER",
            "MESA_LOADER_DRIVER_OVERRIDE",
        ]
        .iter()
        .any(|name| {
            std::env::var(name).is_ok_and(|value| {
                let value = value.to_ascii_lowercase();
                value == "1"
                    || value == "true"
                    || value.contains("llvmpipe")
                    || value.contains("softpipe")
                    || value.contains("swrast")
            })
        });
        let has_render_node = std::fs::read_dir("/dev/dri").is_ok_and(|entries| {
            entries.flatten().any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("renderD")
            })
        });
        let mut vendors = Vec::new();
        let mut has_large_dedicated_vram = false;
        if let Ok(entries) = std::fs::read_dir("/sys/class/drm") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !name.starts_with("card") || name.contains('-') {
                    continue;
                }
                let device = entry.path().join("device");
                if let Ok(vendor) = std::fs::read_to_string(device.join("vendor")) {
                    vendors.push(vendor.trim().to_ascii_lowercase());
                }
                if let Ok(vram) = std::fs::read_to_string(device.join("mem_info_vram_total")) {
                    has_large_dedicated_vram |= vram
                        .trim()
                        .parse::<u64>()
                        .is_ok_and(|bytes| bytes >= 2 * 1024 * 1024 * 1024);
                }
            }
        }

        return LinuxGraphicsCapability {
            tier: classify_linux_graphics_capability(
                &vendors,
                has_render_node,
                has_large_dedicated_vram,
                software_requested,
            ),
        };
    }

    #[cfg(not(target_os = "linux"))]
    LinuxGraphicsCapability { tier: "unknown" }
}

#[cfg(any(target_os = "linux", test))]
fn classify_linux_graphics_capability(
    vendors: &[String],
    has_render_node: bool,
    has_large_dedicated_vram: bool,
    software_requested: bool,
) -> &'static str {
    if software_requested || !has_render_node || vendors.is_empty() {
        return "software";
    }
    if vendors.iter().any(|vendor| vendor == "0x10de")
        || (vendors.iter().any(|vendor| vendor == "0x1002") && has_large_dedicated_vram)
    {
        return "discrete";
    }
    "hardware"
}

#[tauri::command]
pub(crate) fn open_external_url(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|error| format!("Invalid URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("Only HTTP and HTTPS web URLs can be opened externally.".to_string());
    }

    open_url_with_system(&url)
}

#[cfg(target_os = "macos")]
pub(crate) fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("Failed to open URL: {error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn()
        .map_err(|error| format!("Failed to open URL: {error}"))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn open_url_with_system(url: &str) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|error| format!("Failed to open URL: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn open_file_with_system(dir: String, file_name: String) -> Result<(), String> {
    let path = crate::file_storage::resolve_stored_file_path(&dir, &file_name)?;
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))
}

#[tauri::command]
pub(crate) fn reveal_file_in_folder(dir: String, file_name: String) -> Result<(), String> {
    let path = crate::file_storage::resolve_stored_file_path(&dir, &file_name)?;
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|error| format!("Failed to reveal {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::classify_linux_graphics_capability;

    #[test]
    fn classifies_linux_graphics_without_initializing_webgl() {
        assert_eq!(
            classify_linux_graphics_capability(&["0x10de".into()], true, false, false),
            "discrete"
        );
        assert_eq!(
            classify_linux_graphics_capability(&["0x1002".into()], true, true, false),
            "discrete"
        );
        assert_eq!(
            classify_linux_graphics_capability(&["0x8086".into()], true, false, false),
            "hardware"
        );
        assert_eq!(
            classify_linux_graphics_capability(&["0x8086".into()], true, false, true),
            "software"
        );
        assert_eq!(
            classify_linux_graphics_capability(&[], false, false, false),
            "software"
        );
    }
}
