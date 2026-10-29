fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "request_json",
            "request_text",
            "open_external",
            "launch_external_player",
        ]),
    ))
    .expect("could not prepare Vela desktop assets");
}
