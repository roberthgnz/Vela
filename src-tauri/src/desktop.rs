//! Windows integration: the tray icon (and closing to it), and links that open Vela.
//!
//! Links: `vela://host/path/manifest.json` is always registered for the current user and opens
//! the add-on install dialog with `https://host/path/manifest.json` filled in; nothing is
//! installed without the user's confirmation. `stremio://` belongs to Stremio, so Vela takes it
//! only when the user asks in Settings, remembers the handler it replaced and puts it back when
//! the option is turned off. A link that starts Vela is kept until the page asks for it; a link
//! that arrives while Vela runs comes through the single-instance plugin as an event.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};

pub const LINK_EVENT: &str = "vela://link";
const TRAY_ID: &str = "vela-tray";

#[derive(Default)]
pub struct Desktop {
    /// Closing the window hides it to the tray instead of quitting.
    pub close_to_tray: AtomicBool,
    pending_link: Mutex<Option<String>>,
}

/// The first argument that is a Vela or Stremio link.
pub fn link_in<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().find(|arg| {
        let lower = arg.to_ascii_lowercase();
        (lower.starts_with("vela://") || lower.starts_with("stremio://")) && arg.len() <= 4096
    })
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

impl Desktop {
    pub fn remember_link(&self, link: String) {
        *self.pending_link.lock().unwrap_or_else(|p| p.into_inner()) = Some(link);
    }
}

/// A second launch (or a link while Vela runs): bring the window forward, pass the link on.
pub fn second_instance(app: &AppHandle, args: Vec<String>) {
    show_main(app);
    if let Some(link) = link_in(args) {
        let _ = app.emit(LINK_EVENT, link);
    }
}

/// The link Vela was started with, once.
#[tauri::command]
pub fn link_pending(state: State<'_, Desktop>) -> Option<String> {
    state
        .pending_link
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
}

/// Shows or removes the tray icon; with it, closing the window keeps Vela running there.
#[tauri::command]
pub fn tray_set(
    app: AppHandle,
    state: State<'_, Desktop>,
    enabled: bool,
    show: String,
    quit: String,
) -> Result<(), String> {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
    if !enabled {
        let _ = app.remove_tray_by_id(TRAY_ID);
        return Ok(());
    }
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }
    let label = |text: String, fallback: &str| {
        let text: String = text.chars().filter(|c| !c.is_control()).take(40).collect();
        if text.trim().is_empty() {
            fallback.to_owned()
        } else {
            text
        }
    };
    let show = MenuItem::with_id(&app, "show", label(show, "Vela"), true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(&app, "quit", label(quit, "Quit"), true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(&app, &[&show, &quit]).map_err(|error| error.to_string())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Vela")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => {
                // The page saves what is pending, then destroys the window (see main.rs).
                if let Some(desktop) = app.try_state::<Desktop>() {
                    desktop.close_to_tray.store(false, Ordering::Relaxed);
                }
                show_main(app);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(&app).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(windows)]
mod registry {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
        RRF_RT_REG_SZ, RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegGetValueW, RegSetValueExW,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Reads a string value (`None` = the key's default value).
    pub fn read(path: &str, name: Option<&str>) -> Option<String> {
        let path = wide(path);
        let name = name.map(wide);
        let mut size: u32 = 0;
        // SAFETY: first call asks for the size; buffers are sized from it.
        unsafe {
            let name_ptr = name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr());
            if RegGetValueW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                name_ptr,
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            ) != ERROR_SUCCESS
            {
                return None;
            }
            let mut buffer = vec![0u16; (size as usize).div_ceil(2) + 1];
            let mut bytes = (buffer.len() * 2) as u32;
            if RegGetValueW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                name_ptr,
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut bytes,
            ) != ERROR_SUCCESS
            {
                return None;
            }
            let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
            Some(String::from_utf16_lossy(&buffer[..end]))
        }
    }

    /// Writes a string value, creating the key.
    pub fn write(path: &str, name: Option<&str>, value: &str) -> bool {
        let path = wide(path);
        let name = name.map(wide);
        let value = wide(value);
        // SAFETY: valid NUL-terminated strings; the key is closed before returning.
        unsafe {
            let mut key: HKEY = std::ptr::null_mut();
            if RegCreateKeyExW(
                HKEY_CURRENT_USER,
                path.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_WRITE | KEY_READ,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            ) != ERROR_SUCCESS
            {
                return false;
            }
            let name_ptr = name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr());
            let ok = RegSetValueExW(
                key,
                name_ptr,
                0,
                REG_SZ,
                value.as_ptr().cast(),
                (value.len() * 2) as u32,
            ) == ERROR_SUCCESS;
            RegCloseKey(key);
            ok
        }
    }

    pub fn delete_tree(path: &str) {
        let path = wide(path);
        // SAFETY: valid string; deleting a missing key is a harmless error.
        unsafe {
            RegDeleteTreeW(HKEY_CURRENT_USER, path.as_ptr());
        }
    }
}

#[cfg(windows)]
fn command_for_this_exe() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    Some(format!(
        "\"{}\" \"%1\"",
        exe.to_string_lossy().trim_start_matches(r"\\?\")
    ))
}

/// Points `scheme://` links at this Vela (per user, no administrator rights needed).
#[cfg(windows)]
fn claim(scheme: &str) -> Result<(), String> {
    let command = command_for_this_exe().ok_or("No se encontró el ejecutable de Vela.")?;
    let base = format!(r"Software\Classes\{scheme}");
    // An existing key (Stremio's) keeps its name; only the command changes.
    let named = registry::read(&base, None).is_some()
        || registry::write(&base, None, &format!("URL:{scheme}"));
    let marked = registry::read(&base, Some("URL Protocol")).is_some()
        || registry::write(&base, Some("URL Protocol"), "");
    let ok =
        named && marked && registry::write(&format!(r"{base}\shell\open\command"), None, &command);
    if ok {
        Ok(())
    } else {
        Err("No se pudo registrar el enlace en Windows.".to_owned())
    }
}

/// Registers `vela://` for this executable (called at start; keeps the path current after updates).
pub fn register_own_scheme() {
    #[cfg(windows)]
    if let Err(error) = claim("vela") {
        crate::logging::log_warn!("vela:// link not registered: {error}");
    }
}

const STREMIO_KEY: &str = r"Software\Classes\stremio";
const SAVED_KEY: &str = r"Software\Vela\stremio-link";

/// Whether `stremio://` links currently open this Vela.
#[tauri::command]
pub fn stremio_links_get() -> bool {
    #[cfg(windows)]
    {
        let current = registry::read(&format!(r"{STREMIO_KEY}\shell\open\command"), None);
        current.is_some() && current == command_for_this_exe()
    }
    #[cfg(not(windows))]
    false
}

/// Takes `stremio://` links (remembering the previous handler) or gives them back.
#[tauri::command]
pub fn stremio_links_set(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let command_key = format!(r"{STREMIO_KEY}\shell\open\command");
        if enabled {
            if stremio_links_get() {
                return Ok(());
            }
            // The handler Stremio installed for this user, if any, to restore it later.
            let previous = registry::read(&command_key, None).unwrap_or_default();
            registry::write(SAVED_KEY, Some("command"), &previous);
            return claim("stremio");
        }
        if !stremio_links_get() {
            return Ok(());
        }
        match registry::read(SAVED_KEY, Some("command")).filter(|c| !c.is_empty()) {
            Some(previous) => {
                if !registry::write(&command_key, None, &previous) {
                    return Err("No se pudo devolver el enlace a Stremio.".to_owned());
                }
            }
            None => registry::delete_tree(STREMIO_KEY),
        }
        registry::delete_tree(SAVED_KEY);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("Solo en Windows.".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_links_among_arguments() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(link_in(args(&["vela.exe"])), None);
        assert_eq!(
            link_in(args(&["vela.exe", "vela://addon.example/manifest.json"])),
            Some("vela://addon.example/manifest.json".into())
        );
        assert_eq!(
            link_in(args(&["vela.exe", "--flag", "STREMIO://a.example/m.json"])),
            Some("STREMIO://a.example/m.json".into())
        );
        assert_eq!(
            link_in(args(&["vela.exe", "https://a.example/m.json"])),
            None
        );
        let long = format!("vela://{}", "a".repeat(5000));
        assert_eq!(link_in(vec![long]), None);
    }
}
