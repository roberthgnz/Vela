fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "request_json",
            "post_json",
            "request_text",
            "request_bytes",
            "open_external",
            "launch_external_player",
            "secret_get",
            "secret_set",
            "secret_delete",
        ]),
    ))
    .expect("could not prepare Vela desktop assets");
}
