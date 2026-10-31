//! mpv inside Vela's window, for files WebView2 cannot decode (HEVC, AC-3/DTS/TrueHD, AVI…).
//!
//! libmpv is not linked or shipped: it is loaded at run time from a copy already on the machine
//! (the `libmpv-2.dll` that Stremio installs, or one next to the configured mpv). A native child
//! window covers the video area of the page, above the WebView, and mpv draws into it (`wid`);
//! the page keeps its top bar (back, title, window buttons) and mpv's own on-screen controller
//! handles the rest, with YouTube-style keys bound on top of mpv's defaults. Progress, the end of
//! the file, errors and the keys that need Vela (Escape, fullscreen, next episode) reach the page
//! as `mpv-embedded` events.

use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

type Handle = *mut c_void;

#[repr(C)]
struct Event {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct EventProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct EventEndFile {
    reason: c_int,
    error: c_int,
}

#[repr(C)]
struct EventClientMessage {
    num_args: c_int,
    args: *const *const c_char,
}

const EVENT_SHUTDOWN: c_int = 1;
const EVENT_END_FILE: c_int = 7;
const EVENT_FILE_LOADED: c_int = 8;
const EVENT_CLIENT_MESSAGE: c_int = 16;
const EVENT_PROPERTY_CHANGE: c_int = 22;
const FORMAT_FLAG: c_int = 3;
const FORMAT_DOUBLE: c_int = 5;
const END_EOF: c_int = 0;
const END_ERROR: c_int = 4;

/// The handful of client API functions Vela uses; all exist since libmpv 1.x.
struct Api {
    _library: libloading::Library,
    create: unsafe extern "C" fn() -> Handle,
    initialize: unsafe extern "C" fn(Handle) -> c_int,
    set_option_string: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    command: unsafe extern "C" fn(Handle, *const *const c_char) -> c_int,
    observe_property: unsafe extern "C" fn(Handle, u64, *const c_char, c_int) -> c_int,
    wait_event: unsafe extern "C" fn(Handle, f64) -> *mut Event,
    wakeup: unsafe extern "C" fn(Handle),
    terminate_destroy: unsafe extern "C" fn(Handle),
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
}

impl Api {
    fn load(path: &Path) -> Result<Self, String> {
        // SAFETY: loading a DLL runs its initialisers; the candidates are libmpv builds that
        // Stremio or mpv installed, found at fixed locations (never a path from a web page).
        let library = unsafe { load_library(path) }
            .map_err(|error| format!("No se pudo cargar {}: {error}", path.display()))?;
        macro_rules! symbol {
            ($name:literal) => {
                // SAFETY: the signatures match mpv/client.h.
                *unsafe { library.get($name) }.map_err(|_| {
                    format!(
                        "{} no es una libmpv compatible (falta {}).",
                        path.display(),
                        String::from_utf8_lossy(&$name[..$name.len() - 1])
                    )
                })?
            };
        }
        Ok(Self {
            create: symbol!(b"mpv_create\0"),
            initialize: symbol!(b"mpv_initialize\0"),
            set_option_string: symbol!(b"mpv_set_option_string\0"),
            command: symbol!(b"mpv_command\0"),
            observe_property: symbol!(b"mpv_observe_property\0"),
            wait_event: symbol!(b"mpv_wait_event\0"),
            wakeup: symbol!(b"mpv_wakeup\0"),
            terminate_destroy: symbol!(b"mpv_terminate_destroy\0"),
            error_string: symbol!(b"mpv_error_string\0"),
            _library: library,
        })
    }
}

#[cfg(windows)]
unsafe fn load_library(path: &Path) -> Result<libloading::Library, libloading::Error> {
    // Its own folder first for any DLL it depends on.
    const LOAD_WITH_ALTERED_SEARCH_PATH: u32 = 0x8;
    unsafe {
        libloading::os::windows::Library::load_with_flags(path, LOAD_WITH_ALTERED_SEARCH_PATH)
    }
    .map(Into::into)
}

#[cfg(not(windows))]
unsafe fn load_library(path: &Path) -> Result<libloading::Library, libloading::Error> {
    unsafe { libloading::Library::new(path) }
}

/// A libmpv instance. The client API is thread-safe, so the handle is shared between the event
/// thread and the commands.
struct Mpv {
    api: Api,
    handle: Handle,
}

// SAFETY: libmpv's client API may be called from any thread (mpv/client.h, "Thread safety").
unsafe impl Send for Mpv {}
// SAFETY: as above.
unsafe impl Sync for Mpv {}

fn text(value: &str) -> CString {
    CString::new(value.replace('\0', "")).unwrap_or_default()
}

impl Mpv {
    fn error(&self, code: c_int) -> String {
        // SAFETY: mpv_error_string returns a static string for any code.
        unsafe { CStr::from_ptr((self.api.error_string)(code)) }
            .to_string_lossy()
            .into_owned()
    }

    fn option(&self, name: &str, value: &str) -> Result<(), String> {
        let (name, value) = (text(name), text(value));
        // SAFETY: valid handle and NUL-terminated strings that outlive the call.
        let code =
            unsafe { (self.api.set_option_string)(self.handle, name.as_ptr(), value.as_ptr()) };
        if code < 0 {
            return Err(format!(
                "mpv rechazó la opción {}: {}",
                name.to_string_lossy(),
                self.error(code)
            ));
        }
        Ok(())
    }

    fn command(&self, args: &[&str]) -> Result<(), String> {
        let owned: Vec<CString> = args.iter().map(|arg| text(arg)).collect();
        let mut pointers: Vec<*const c_char> = owned.iter().map(|arg| arg.as_ptr()).collect();
        pointers.push(std::ptr::null());
        // SAFETY: a NULL-terminated array of valid strings that outlive the call.
        let code = unsafe { (self.api.command)(self.handle, pointers.as_ptr()) };
        if code < 0 {
            return Err(self.error(code));
        }
        Ok(())
    }

    fn observe(&self, id: u64, name: &str, format: c_int) {
        let name = text(name);
        // SAFETY: valid handle and string.
        unsafe { (self.api.observe_property)(self.handle, id, name.as_ptr(), format) };
    }
}

impl Drop for Mpv {
    fn drop(&mut self) {
        // SAFETY: the handle is destroyed exactly once, here.
        unsafe { (self.api.terminate_destroy)(self.handle) };
    }
}

/// Where the video goes, in physical pixels of the window's client area.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOptions {
    url: String,
    #[serde(default)]
    headers: std::collections::BTreeMap<String, String>,
    title: Option<String>,
    start: Option<f64>,
    #[serde(default)]
    subtitles: Vec<String>,
    /// mpv language lists, e.g. `spa,es,eng,en`.
    audio_languages: Option<String>,
    subtitle_languages: Option<String>,
    #[serde(default)]
    subtitles_auto: bool,
    volume: Option<f64>,
    rect: Rect,
    /// The configured external player, whose folder may hold a libmpv.
    player_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Message {
    Progress {
        time: f64,
        duration: f64,
        paused: bool,
    },
    Ended,
    Error {
        message: String,
    },
    Action {
        name: String,
    },
    Closed {
        time: f64,
        duration: f64,
    },
}

const EVENT: &str = "mpv-embedded";

struct Session {
    mpv: Arc<Mpv>,
    window: isize,
    events: std::thread::JoinHandle<()>,
    /// Set by `close` so the event thread does not report the shutdown as an error.
    closing: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct EmbeddedMpv {
    session: Mutex<Option<Session>>,
    /// Opening and closing run one at a time, so a slow open cannot outlive a newer one.
    busy: tokio::sync::Mutex<()>,
}

/// libmpv builds Vela knows how to find, most likely first.
fn candidates(player_path: Option<&str>) -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let Some(path) = std::env::var_os("VELA_LIBMPV") {
        list.push(PathBuf::from(path));
    }
    if let Some(folder) = player_path
        .filter(|path| !path.trim().is_empty())
        .and_then(|path| Path::new(path).parent().map(Path::to_path_buf))
    {
        list.push(folder.join("libmpv-2.dll"));
        list.push(folder.join("mpv-2.dll"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        let programs = local.join("Programs");
        list.push(programs.join("Stremio").join("libmpv-2.dll"));
        list.push(programs.join("mpv").join("libmpv-2.dll"));
    }
    if let Some(programs) = std::env::var_os("ProgramFiles") {
        let programs = PathBuf::from(programs);
        list.push(programs.join("Stremio/libmpv-2.dll"));
        list.push(programs.join("mpv/libmpv-2.dll"));
    }
    list
}

fn find(player_path: Option<&str>) -> Option<PathBuf> {
    candidates(player_path)
        .into_iter()
        .find(|path| path.is_file())
}

/// Characters mpv's key and header syntax treat specially are refused rather than escaped.
fn valid_header(name: &str, value: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
        && !value.chars().any(|c| c.is_control())
}

/// Keys on top of mpv's defaults, so the player answers like Vela's own (and YouTube's).
const BINDINGS: &[(&str, &str)] = &[
    ("ESC", "script-message vela-close"),
    // mpv's own quit would leave the page with an empty player.
    ("q", "script-message vela-close"),
    ("Q", "script-message vela-close"),
    ("f", "script-message vela-fullscreen"),
    ("MBTN_LEFT_DBL", "script-message vela-fullscreen"),
    ("n", "script-message vela-next"),
    ("k", "cycle pause"),
    ("j", "seek -10"),
    ("l", "seek 10"),
    ("c", "cycle sub"),
    ("a", "cycle audio"),
    ("g", "add sub-delay -0.1"),
    ("h", "add sub-delay 0.1"),
    ("G", "add sub-delay -1"),
    ("H", "add sub-delay 1"),
    ("<", "add speed -0.25"),
    (">", "add speed 0.25"),
    ("HOME", "seek 0 absolute"),
    ("0", "seek 0 absolute-percent"),
    ("1", "seek 10 absolute-percent"),
    ("2", "seek 20 absolute-percent"),
    ("3", "seek 30 absolute-percent"),
    ("4", "seek 40 absolute-percent"),
    ("5", "seek 50 absolute-percent"),
    ("6", "seek 60 absolute-percent"),
    ("7", "seek 70 absolute-percent"),
    ("8", "seek 80 absolute-percent"),
    ("9", "seek 90 absolute-percent"),
];

fn configure(mpv: &Mpv, options: &OpenOptions, window: isize) -> Result<(), String> {
    // Vela's own settings only: the user's mpv.conf, scripts and key bindings stay out.
    mpv.option("config", "no")?;
    mpv.option("terminal", "no")?;
    mpv.option("wid", &window.to_string())?;
    mpv.option("force-window", "yes")?;
    mpv.option("idle", "yes")?;
    mpv.option("keep-open", "no")?;
    mpv.option("osc", "yes")?;
    mpv.option("input-default-bindings", "yes")?;
    mpv.option("input-vo-keyboard", "yes")?;
    mpv.option("ytdl", "no")?;
    mpv.option("hwdec", "auto-safe")?;
    mpv.option("osd-bar", "yes")?;
    for (name, value) in &options.headers {
        if !valid_header(name, value) {
            return Err("La fuente indicó una cabecera HTTP no válida.".to_owned());
        }
        mpv.option("http-header-fields-append", &format!("{name}: {value}"))?;
    }
    if let Some(title) = &options.title {
        let title: String = title
            .chars()
            .filter(|c| !c.is_control())
            .take(200)
            .collect();
        mpv.option("force-media-title", &title)?;
    }
    if let Some(start) = options
        .start
        .filter(|start| start.is_finite() && *start > 0.0)
    {
        mpv.option("start", &format!("{start:.3}"))?;
    }
    if let Some(languages) = options.audio_languages.as_deref().filter(|l| !l.is_empty()) {
        mpv.option("alang", languages)?;
    }
    if let Some(languages) = options
        .subtitle_languages
        .as_deref()
        .filter(|l| !l.is_empty())
    {
        mpv.option("slang", languages)?;
    }
    mpv.option("sid", if options.subtitles_auto { "auto" } else { "no" })?;
    if let Some(volume) = options.volume.filter(|v| v.is_finite()) {
        mpv.option(
            "volume",
            &format!("{:.0}", (volume * 100.0).clamp(0.0, 100.0)),
        )?;
    }
    Ok(())
}

fn event_loop(app: AppHandle, mpv: Arc<Mpv>, subtitles: Vec<String>, closing: Arc<AtomicBool>) {
    let (mut time, mut duration, mut paused) = (0.0_f64, 0.0_f64, false);
    let mut last = Instant::now() - Duration::from_secs(1);
    loop {
        // SAFETY: the handle lives as long as `mpv`; the event belongs to libmpv until the next call.
        let event = unsafe { &*(mpv.api.wait_event)(mpv.handle, 0.5) };
        match event.event_id {
            EVENT_SHUTDOWN => break,
            EVENT_FILE_LOADED => {
                // «auto» lets `sid`/`slang` decide: none with sid=no, the preferred language otherwise.
                for url in &subtitles {
                    let _ = mpv.command(&["sub-add", url, "auto"]);
                }
            }
            EVENT_END_FILE if !event.data.is_null() => {
                // SAFETY: END_FILE events carry an mpv_event_end_file.
                let end = unsafe { &*(event.data as *const EventEndFile) };
                if end.reason == END_EOF {
                    let _ = app.emit(EVENT, Message::Ended);
                } else if end.reason == END_ERROR && !closing.load(Ordering::Relaxed) {
                    let message = format!("mpv no pudo abrir la fuente: {}", mpv.error(end.error));
                    crate::logging::log_warn!("embedded mpv: {message}");
                    let _ = app.emit(EVENT, Message::Error { message });
                }
            }
            EVENT_CLIENT_MESSAGE if !event.data.is_null() => {
                // SAFETY: CLIENT_MESSAGE events carry an mpv_event_client_message.
                let message = unsafe { &*(event.data as *const EventClientMessage) };
                if message.num_args > 0 && !message.args.is_null() {
                    // SAFETY: `num_args` valid strings.
                    let name = unsafe { CStr::from_ptr(*message.args) }
                        .to_string_lossy()
                        .into_owned();
                    if let Some(name) = name.strip_prefix("vela-") {
                        let _ = app.emit(
                            EVENT,
                            Message::Action {
                                name: name.to_owned(),
                            },
                        );
                    }
                }
            }
            EVENT_PROPERTY_CHANGE if !event.data.is_null() => {
                // SAFETY: PROPERTY_CHANGE events carry an mpv_event_property.
                let property = unsafe { &*(event.data as *const EventProperty) };
                if !property.data.is_null() {
                    match (event.reply_userdata, property.format) {
                        // SAFETY: the format says what `data` points to.
                        (1, FORMAT_DOUBLE) => time = unsafe { *(property.data as *const f64) },
                        (2, FORMAT_DOUBLE) => duration = unsafe { *(property.data as *const f64) },
                        (3, FORMAT_FLAG) => {
                            paused = unsafe { *(property.data as *const c_int) } != 0
                        }
                        _ => {}
                    }
                }
                if last.elapsed() >= Duration::from_millis(500) {
                    last = Instant::now();
                    let _ = app.emit(
                        EVENT,
                        Message::Progress {
                            time,
                            duration,
                            paused,
                        },
                    );
                }
            }
            _ => {}
        }
    }
    let _ = app.emit(EVENT, Message::Closed { time, duration });
}

#[cfg(windows)]
mod native {
    use super::Rect;
    use std::sync::Once;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{BLACK_BRUSH, GetStockObject, HBRUSH};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyWindow, GW_CHILD,
        GetWindow, HWND_TOP, RegisterClassW, SWP_NOACTIVATE, SWP_SHOWWINDOW, SetWindowPos,
        WM_SETFOCUS, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_VISIBLE,
    };

    const CLASS: &[u16] = &[
        b'V' as u16,
        b'e' as u16,
        b'l' as u16,
        b'a' as u16,
        b'M' as u16,
        b'p' as u16,
        b'v' as u16,
        0,
    ];
    static REGISTER: Once = Once::new();

    unsafe extern "system" fn procedure(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_SETFOCUS {
            // mpv's own window is our child: keys go to it, so its bindings work.
            // SAFETY: plain Win32 calls on windows of this process.
            let child = unsafe { GetWindow(window, GW_CHILD) };
            if !child.is_null() {
                unsafe { SetFocus(child) };
                return 0;
            }
        }
        // SAFETY: default handling.
        unsafe { DefWindowProcW(window, message, wparam, lparam) }
    }

    /// A black child window of `parent`, above the WebView. Must run on the UI thread.
    pub fn create(parent: isize, rect: Rect) -> Result<isize, String> {
        // SAFETY: Win32 calls with valid arguments on the UI thread.
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            REGISTER.call_once(|| {
                let class = WNDCLASSW {
                    style: CS_HREDRAW | CS_VREDRAW,
                    lpfnWndProc: Some(procedure),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: instance,
                    hIcon: std::ptr::null_mut(),
                    hCursor: std::ptr::null_mut(),
                    hbrBackground: GetStockObject(BLACK_BRUSH) as HBRUSH,
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: CLASS.as_ptr(),
                };
                RegisterClassW(&class);
            });
            let window = CreateWindowExW(
                0,
                CLASS.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                rect.x,
                rect.y,
                rect.width.max(1),
                rect.height.max(1),
                parent as HWND,
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if window.is_null() {
                return Err("No se pudo crear la ventana del reproductor.".to_owned());
            }
            SetWindowPos(
                window,
                HWND_TOP,
                rect.x,
                rect.y,
                rect.width.max(1),
                rect.height.max(1),
                SWP_SHOWWINDOW,
            );
            Ok(window as isize)
        }
    }

    pub fn place(window: isize, rect: Rect) {
        // SAFETY: a window this module created; harmless if it is already gone.
        unsafe {
            SetWindowPos(
                window as HWND,
                HWND_TOP,
                rect.x,
                rect.y,
                rect.width.max(1),
                rect.height.max(1),
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }

    pub fn focus(window: isize) {
        // SAFETY: as above.
        unsafe { SetFocus(window as HWND) };
    }

    pub fn destroy(window: isize) {
        // SAFETY: as above.
        unsafe { DestroyWindow(window as HWND) };
    }
}

#[cfg(not(windows))]
mod native {
    use super::Rect;
    pub fn create(_parent: isize, _rect: Rect) -> Result<isize, String> {
        Err("mpv integrado solo está disponible en Windows.".to_owned())
    }
    pub fn place(_window: isize, _rect: Rect) {}
    pub fn focus(_window: isize) {}
    pub fn destroy(_window: isize) {}
}

/// Runs `job` on the UI thread (window creation and placement need it) and waits for its result.
async fn on_ui<T: Send + 'static>(
    app: &AppHandle,
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(job());
    })
    .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "La ventana no respondió.".to_owned())
}

fn parent_window(app: &AppHandle) -> Result<isize, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("No se encontró la ventana principal.")?;
    #[cfg(windows)]
    {
        window
            .hwnd()
            .map(|hwnd| hwnd.0 as isize)
            .map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err("mpv integrado solo está disponible en Windows.".to_owned())
    }
}

impl EmbeddedMpv {
    fn take(&self) -> Option<Session> {
        self.session
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }

    /// Stops playback and removes the window; waits a moment for mpv to finish.
    async fn shutdown(app: &AppHandle, session: Session) {
        let Session {
            mpv,
            window,
            events,
            closing,
        } = session;
        closing.store(true, Ordering::Relaxed);
        let _ = mpv.command(&["quit"]);
        // SAFETY: valid handle; wakes the event thread so it sees the shutdown.
        unsafe { (mpv.api.wakeup)(mpv.handle) };
        let _ = tokio::time::timeout(
            Duration::from_secs(3),
            tauri::async_runtime::spawn_blocking(move || events.join()),
        )
        .await;
        // mpv is destroyed (the event thread's reference is gone) before the window it draws in.
        let _ = tauri::async_runtime::spawn_blocking(move || drop(mpv)).await;
        let _ = on_ui(app, move || native::destroy(window)).await;
    }

    /// Ends the session at exit.
    pub fn stop_blocking(&self) {
        if let Some(session) = self.take() {
            session.closing.store(true, Ordering::Relaxed);
            let _ = session.mpv.command(&["quit"]);
        }
    }
}

/// The libmpv Vela would use, if any.
#[tauri::command]
pub fn mpv_embedded_library(player_path: Option<String>) -> Option<String> {
    find(player_path.as_deref()).map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn mpv_embedded_open(
    app: AppHandle,
    state: State<'_, EmbeddedMpv>,
    options: OpenOptions,
) -> Result<String, String> {
    let _busy = state.busy.lock().await;
    if let Some(previous) = state.take() {
        EmbeddedMpv::shutdown(&app, previous).await;
    }
    // A web source, or a file Vela downloaded (only inside Downloads\Vela).
    let source = if crate::transport::checked_url(&options.url).is_ok() {
        options.url.clone()
    } else {
        crate::downloads::inside(&app, &options.url)
            .map_err(|_| "La fuente no es una URL ni una descarga de Vela.".to_owned())?
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .to_owned()
    };
    let library = find(options.player_path.as_deref()).ok_or(
        "No se encontró libmpv. Instala Stremio (incluye libmpv-2.dll) o coloca libmpv-2.dll junto a mpv.exe.",
    )?;
    let api = Api::load(&library)?;
    // SAFETY: creating a handle has no preconditions.
    let handle = unsafe { (api.create)() };
    if handle.is_null() {
        return Err("libmpv no pudo crear el reproductor.".to_owned());
    }
    let mpv = Arc::new(Mpv { api, handle });
    let parent = parent_window(&app)?;
    let rect = options.rect;
    let window = on_ui(&app, move || native::create(parent, rect)).await??;
    let started = (|| {
        configure(&mpv, &options, window)?;
        // SAFETY: valid, configured handle.
        let code = unsafe { (mpv.api.initialize)(mpv.handle) };
        if code < 0 {
            return Err(format!("libmpv no se pudo iniciar: {}", mpv.error(code)));
        }
        for (key, command) in BINDINGS {
            let _ = mpv.command(&["keybind", key, command]);
        }
        mpv.observe(1, "time-pos", FORMAT_DOUBLE);
        mpv.observe(2, "duration", FORMAT_DOUBLE);
        mpv.observe(3, "pause", FORMAT_FLAG);
        mpv.command(&["loadfile", &source])
            .map_err(|error| format!("mpv no pudo abrir la fuente: {error}"))
    })();
    if let Err(error) = started {
        drop(mpv);
        let _ = on_ui(&app, move || native::destroy(window)).await;
        crate::logging::log_warn!("embedded mpv: {error}");
        return Err(error);
    }
    let closing = Arc::new(AtomicBool::new(false));
    let events = {
        let (app, mpv, closing) = (app.clone(), mpv.clone(), closing.clone());
        // Only web subtitles; the page already filters them, this is a second check.
        let subtitles: Vec<String> = options
            .subtitles
            .iter()
            .filter(|url| crate::transport::checked_url(url).is_ok())
            .cloned()
            .collect();
        std::thread::Builder::new()
            .name("vela-mpv-events".into())
            .spawn(move || event_loop(app, mpv, subtitles, closing))
            .map_err(|error| error.to_string())?
    };
    *state.session.lock().unwrap_or_else(|p| p.into_inner()) = Some(Session {
        mpv,
        window,
        events,
        closing,
    });
    // mpv creates its window shortly after the file starts; give it the keyboard then.
    let app_focus = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let _ = on_ui(&app_focus, move || native::focus(window)).await;
    });
    crate::logging::log_info!("embedded mpv started with {}", library.display());
    Ok(library.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn mpv_embedded_place(
    app: AppHandle,
    state: State<'_, EmbeddedMpv>,
    rect: Rect,
) -> Result<(), String> {
    let window = state
        .session
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|session| session.window);
    if let Some(window) = window {
        on_ui(&app, move || native::place(window, rect)).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn mpv_embedded_focus(
    app: AppHandle,
    state: State<'_, EmbeddedMpv>,
) -> Result<(), String> {
    let window = state
        .session
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|session| session.window);
    if let Some(window) = window {
        on_ui(&app, move || native::focus(window)).await?;
    }
    Ok(())
}

/// A few controls the page needs (pause before the window loses focus, toggling from buttons).
#[tauri::command]
pub async fn mpv_embedded_command(
    state: State<'_, EmbeddedMpv>,
    action: String,
    key: Option<String>,
) -> Result<(), String> {
    let args: Vec<String> = match action.as_str() {
        "pause" => vec!["set".into(), "pause".into(), "yes".into()],
        "play" => vec!["set".into(), "pause".into(), "no".into()],
        "toggle" => vec!["cycle".into(), "pause".into()],
        // A key pressed while the page has the focus, run through mpv's bindings.
        "key" => {
            let key = key.filter(|key| valid_key(key)).ok_or("Tecla no válida.")?;
            vec!["keypress".into(), key]
        }
        _ => return Err("Acción desconocida.".to_owned()),
    };
    let mpv = state
        .session
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|session| session.mpv.clone())
        .ok_or("No hay ningún vídeo en mpv.")?;
    // mpv_command waits for the core; not on the UI thread, not under the lock.
    tauri::async_runtime::spawn_blocking(move || {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        mpv.command(&args)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// An mpv key name (`SPACE`, `LEFT`, `k`, `<`…): short, printable, no spaces or separators.
fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 12
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "<>,.[]{}/-+=*!?#_".contains(c))
}

#[tauri::command]
pub async fn mpv_embedded_close(
    app: AppHandle,
    state: State<'_, EmbeddedMpv>,
) -> Result<(), String> {
    let _busy = state.busy.lock().await;
    if let Some(session) = state.take() {
        EmbeddedMpv::shutdown(&app, session).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_next_to_the_configured_player_first() {
        let list = candidates(Some(r"C:\Tools\mpv\mpv.exe"));
        let first = list
            .iter()
            .position(|path| path.ends_with("libmpv-2.dll") && path.starts_with(r"C:\Tools\mpv"));
        let stremio = list
            .iter()
            .position(|path| path.to_string_lossy().contains("Stremio"));
        assert!(first.is_some());
        if let (Some(first), Some(stremio)) = (first, stremio) {
            assert!(first < stremio);
        }
        assert!(candidates(Some("  ")).iter().all(|p| !p.starts_with("  ")));
    }

    #[test]
    fn refuses_headers_that_could_break_mpv_options() {
        assert!(valid_header("Referer", "https://example.com/a,b"));
        assert!(!valid_header("Bad Name", "x"));
        assert!(!valid_header("X", "line\nbreak"));
        assert!(!valid_header("", "x"));
    }

    #[test]
    fn accepts_only_plain_key_names() {
        for key in ["SPACE", "LEFT", "k", "<", "G", "0"] {
            assert!(valid_key(key), "{key}");
        }
        for key in ["", "a b", "quit;", "x\n", "VERYLONGKEYNAME"] {
            assert!(!valid_key(key), "{key}");
        }
    }

    #[test]
    fn binds_the_keys_vela_needs() {
        let keys: Vec<&str> = BINDINGS.iter().map(|(key, _)| *key).collect();
        for key in ["ESC", "f", "n", "k", "j", "l", "c", "a"] {
            assert!(keys.contains(&key), "{key}");
        }
        assert!(
            BINDINGS
                .iter()
                .filter(|(_, command)| command.starts_with("script-message"))
                .all(|(_, command)| command.contains("vela-"))
        );
    }
}
