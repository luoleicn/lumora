// Composition root: module declarations, the liveness probe, and the Tauri
// builder wiring. All domain logic lives in the sibling modules.

mod arxiv;
mod cloud_sync;
mod db;
mod duplicates;
mod file_storage;
mod macos;
mod menu;
mod mendeley;
mod native_pdf;
mod proxy;
mod search;
mod system;
mod youdao;

#[tauri::command]
fn ping() -> &'static str {
    "lumora-ready"
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                macos::enable_trackpad_pinch_zoom(app);
                macos::install_key_shortcut_monitor(app.handle().clone());
            }
            // macOS uses `app` above; other platforms have no native setup yet.
            #[cfg(not(target_os = "macos"))]
            let _ = app;
            Ok(())
        })
        .menu(menu::build_menu)
        .on_menu_event(|app, event| menu::handle_menu_event(app, event))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            ping,
            system::linux_graphics_capability,
            native_pdf::native_pdf_open_path,
            native_pdf::native_pdf_stage_chunk,
            native_pdf::native_pdf_open_upload,
            native_pdf::native_pdf_render_page,
            native_pdf::native_pdf_page_text,
            native_pdf::native_pdf_search,
            system::open_external_url,
            system::open_file_with_system,
            system::reveal_file_in_folder,
            youdao::translate_with_youdao,
            arxiv::search_arxiv_by_title,
            file_storage::store_pdf,
            file_storage::list_stored_pdfs,
            file_storage::read_stored_pdf,
            file_storage::read_stored_pdf_range,
            file_storage::stored_pdf_metadata,
            file_storage::delete_stored_pdf,
            file_storage::move_stored_pdf,
            file_storage::clone_stored_pdf,
            db::db_load_library,
            db::db_upsert_entities,
            db::db_delete_entities,
            db::db_get_meta,
            db::db_set_meta,
            search::db_search_library,
            search::db_index_paper_body,
            search::db_search_index_status,
            proxy::proxy_settings,
            proxy::set_proxy_settings,
            mendeley::mendeley_connect,
            mendeley::mendeley_status,
            mendeley::mendeley_disconnect,
            mendeley::mendeley_request,
            mendeley::mendeley_download_file,
            arxiv::download_arxiv_pdf,
            arxiv::download_arxiv_pdf_silent,
            cloud_sync::qiniu_sync_config,
            cloud_sync::qiniu_save_sync_config,
            cloud_sync::qiniu_test_sync_connection,
            cloud_sync::qiniu_disconnect_sync,
            cloud_sync::qiniu_upload_blob,
            cloud_sync::qiniu_upload_stored_blob,
            cloud_sync::qiniu_object_exists,
            cloud_sync::qiniu_list_blobs,
            cloud_sync::qiniu_download_blob,
            cloud_sync::qiniu_download_blob_to_files,
            cloud_sync::qiniu_delete_blob,
            cloud_sync::qiniu_sync_library,
            duplicates::cleanup_duplicate_downloads
        ])
        .run(tauri::generate_context!())
        .expect("error while running lumora");
}
