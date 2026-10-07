// The desktop shell is only a window around the web app (index.html). The opener plugin lets the app send
// venue pages, Gmail and mailto: links to the system browser and mail app instead of the app window; the
// clipboard plugin backs "Copy" buttons, since the web view's own clipboard API isn't reliable here.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .run(tauri::generate_context!())
        .expect("error while running Second Name");
}
