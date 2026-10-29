fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "request_json",
            "post_json",
            "request_text",
            "request_bytes",
            "request_range",
            "download_folder",
            "download_start",
            "download_cancel",
            "download_remove",
            "download_reveal",
            "open_external",
            "launch_external_player",
            "service_installed",
            "service_start",
            "hardware_decoding_get",
            "hardware_decoding_set",
            "secret_get",
            "secret_set",
            "secret_delete",
            "update_check",
            "update_install",
        ]),
    ))
    .expect("could not prepare Vela desktop assets");
}
