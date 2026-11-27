use enigo::Keyboard;
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![show_bar, hide_bar, insert_text])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

            // Alt+W is a global shortcut: it works even when the bar is hidden
            // and another application has focus. The Rust side only forwards
            // the keypress; the webview owns the recording and transcription
            // state machine so the UI can finish before the window closes.
            app.global_shortcut()
                .on_shortcut("Alt+W", |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit("wispr-toggle", ());
                    }
                })?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building WisprType");
}

#[tauri::command]
fn show_bar(window: tauri::Window) {
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn hide_bar(window: tauri::Window) {
    let _ = window.hide();
}

/// Types the finished transcript into whichever field had focus before the
/// bar opened. The window is hidden first so focus returns to that field.
#[tauri::command]
fn insert_text(text: String, window: tauri::Window) -> Result<(), String> {
    let _ = window.hide();

    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_millis(180));

        let settings = enigo::Settings::default();
        let mut enigo = enigo::Enigo::new(&settings).map_err(|error| error.to_string())?;
        enigo.text(&text).map_err(|error| error.to_string())?;

        Ok::<(), String>(())
    });

    Ok(())
}
