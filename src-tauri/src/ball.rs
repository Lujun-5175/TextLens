//! Floating "ask" orb.
//!
//! A small always-on-top window that opens a blank Ask session in one click.
//! It deliberately has no relationship to selection capture: the toolbar owns
//! "ask about this selection", the orb owns "ask about nothing in particular".
//!
//! Orb visibility, position and size live in `ball.json` next to
//! `settings.json` instead of the settings file itself. That keeps this
//! cosmetic feature out of the versioned settings schema, where every new field
//! costs a migration and a rejected file used to panic the whole app at startup.

use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::windows::{self, Point, WindowSize};

pub const BALL_LABEL: &str = "selection-ball";
/// Right-click panel opened next to the orb. Unlike the orb it is focusable:
/// it hosts real controls, so it must accept keyboard input.
pub const BALL_MENU_LABEL: &str = "selection-ball-menu";
/// Logical size of that panel. The renderer fills the whole window.
pub const BALL_MENU_WIDTH: f64 = 248.0;
pub const BALL_MENU_HEIGHT: f64 = 300.0;
const BALL_MENU_GAP: f64 = 8.0;
/// Default orb diameter in CSS pixels. The renderer draws the circle at 100%
/// of the window, so a size change is a window resize.
pub const BALL_LOGICAL_SIZE: f64 = 56.0;
/// Supported orb diameters. The tray's size submenu maps one item per size.
pub const BALL_SMALL_SIZE: f64 = 44.0;
pub const BALL_MEDIUM_SIZE: f64 = 56.0;
pub const BALL_LARGE_SIZE: f64 = 72.0;
const BALL_FILE_NAME: &str = "ball.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BallState {
    pub visible: bool,
    /// Persisted native window position. `None` places the orb at the
    /// bottom-left of the pointer's display.
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// Orb diameter in CSS pixels. `None` means the default size, so a file
    /// written by an older build keeps working.
    pub size: Option<f64>,
    /// Hide the orb while a fullscreen application owns the foreground.
    pub hide_in_fullscreen: bool,
    /// Ask action the orb opens, by id. `None` means "the first enabled Ask
    /// action", which is what every build before this setting used.
    pub ask_action_id: Option<String>,
}

impl Default for BallState {
    fn default() -> Self {
        // New installs and existing users both start with the orb visible: it
        // is the feature's only entry point, and the tray menu can hide it.
        Self {
            visible: true,
            x: None,
            y: None,
            size: None,
            hide_in_fullscreen: true,
            ask_action_id: None,
        }
    }
}

/// The subset of orb state the settings window edits.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BallSettings {
    pub visible: bool,
    pub size: f64,
    pub hide_in_fullscreen: bool,
    pub ask_action_id: Option<String>,
}

impl From<&BallState> for BallSettings {
    fn from(state: &BallState) -> Self {
        Self {
            visible: state.visible,
            size: state.diameter(),
            hide_in_fullscreen: state.hide_in_fullscreen,
            ask_action_id: state.ask_action_id.clone(),
        }
    }
}

/// Partial update from the settings window. An empty `ask_action_id` clears
/// the selection and returns the orb to "first enabled Ask action".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BallSettingsUpdate {
    pub visible: Option<bool>,
    pub size: Option<f64>,
    pub hide_in_fullscreen: Option<bool>,
    pub ask_action_id: Option<String>,
}

/// Clamps a stored or requested diameter to a size the orb can actually use.
pub fn normalized_size(size: Option<f64>) -> f64 {
    match size {
        Some(value) if value.is_finite() => value.clamp(BALL_SMALL_SIZE, BALL_LARGE_SIZE * 1.5),
        _ => BALL_LOGICAL_SIZE,
    }
}

impl BallState {
    fn position(&self) -> Option<Point> {
        self.x.zip(self.y).map(|(x, y)| Point {
            x: f64::from(x),
            y: f64::from(y),
        })
    }

    pub fn diameter(&self) -> f64 {
        normalized_size(self.size)
    }
}

/// Temporary reasons the orb is off-screen even though the user wants it.
///
/// These are not preferences: they end by themselves, and the orb comes back
/// when the last one is released.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BallSuppression {
    /// An ask conversation launched from the orb is open.
    Conversation,
    /// A fullscreen application owns the foreground.
    Fullscreen,
}

pub struct BallStore {
    path: PathBuf,
    state: Mutex<BallState>,
    suppressions: Mutex<HashSet<BallSuppression>>,
}

impl BallStore {
    pub fn load(path: PathBuf) -> Self {
        let state = read_state(&path).unwrap_or_default();
        Self {
            path,
            state: Mutex::new(state),
            suppressions: Mutex::new(HashSet::new()),
        }
    }

    pub fn snapshot(&self) -> BallState {
        self.state.lock().clone()
    }

    pub fn settings(&self) -> BallSettings {
        BallSettings::from(&*self.state.lock())
    }

    pub fn set_visible(&self, visible: bool) -> BallState {
        self.update(|state| state.visible = visible)
    }

    pub fn set_position(&self, x: i32, y: i32) -> BallState {
        self.update(|state| {
            state.x = Some(x);
            state.y = Some(y);
        })
    }

    pub fn set_size(&self, size: f64) -> BallState {
        self.update(|state| state.size = Some(normalized_size(Some(size))))
    }

    pub fn set_hide_in_fullscreen(&self, hide: bool) -> BallState {
        self.update(|state| state.hide_in_fullscreen = hide)
    }

    /// `None` (or an empty id) means "first enabled Ask action".
    pub fn set_ask_action(&self, action_id: Option<String>) -> BallState {
        self.update(|state| {
            state.ask_action_id = action_id
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty());
        })
    }

    /// Forgets the dragged position so the orb returns to the default corner.
    pub fn reset_position(&self) -> BallState {
        self.update(|state| {
            state.x = None;
            state.y = None;
        })
    }

    fn update(&self, change: impl FnOnce(&mut BallState)) -> BallState {
        let snapshot = {
            let mut state = self.state.lock();
            change(&mut state);
            state.clone()
        };
        self.persist(snapshot.clone());
        snapshot
    }

    pub fn suppress(&self, reason: BallSuppression) {
        self.suppressions.lock().insert(reason);
    }

    pub fn resume(&self, reason: BallSuppression) {
        self.suppressions.lock().remove(&reason);
    }

    pub fn is_suppressed(&self) -> bool {
        !self.suppressions.lock().is_empty()
    }

    /// Whether the orb should currently be on screen.
    fn should_show(&self) -> bool {
        self.state.lock().visible && !self.is_suppressed()
    }

    fn persist(&self, state: BallState) {
        // A failed write costs only the remembered position; reporting it to
        // the user would be noise, so keep it on stderr next to the other
        // best-effort persistence paths.
        if let Err(error) = write_state(&self.path, state) {
            eprintln!("[ball] stage=persist error_class=io: {error}");
        }
    }

    #[cfg(test)]
    fn path(&self) -> &Path {
        &self.path
    }
}

/// Default on-disk location, alongside `settings.json`.
pub fn state_path(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join(BALL_FILE_NAME))
}

fn read_state(path: &Path) -> Option<BallState> {
    let bytes = fs::read(path).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    // Tolerate an editor-added BOM: `settings.json` was once corrupted by one
    // and the failure mode there was a startup panic, so never assume clean
    // input for a file a user may have opened by hand.
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

fn write_state(path: &Path, state: BallState) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("悬浮球状态路径无效"))?;
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(&state).map_err(std::io::Error::other)?)?;
        file.sync_all()?;
    }
    crate::settings::atomic_file::replace_file(&temporary, path)
}

/// Creates the orb window the first time it is needed.
///
/// The window is `focusable(false)` and gets `WS_EX_NOACTIVATE` below: a click
/// must not steal focus from the document the user is reading, and the ask
/// window that opens afterwards is the only thing that should take focus.
fn create_window(app: &AppHandle, diameter: f64) -> tauri::Result<WebviewWindow> {
    let window =
        WebviewWindowBuilder::new(app, BALL_LABEL, WebviewUrl::App("ball/index.html".into()))
            .title("TextLens")
            .inner_size(diameter, diameter)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .fullscreen(false)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .skip_taskbar(true)
            .accept_first_mouse(true)
            .focusable(false)
            .focused(false)
            .visible(false)
            .build()?;
    windows::configure_overlay_window(&window)?;
    Ok(window)
}

/// Hides the orb window without touching the user's preference.
fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(BALL_LABEL) {
        let _ = window.hide();
    }
    // The panel is anchored to the orb: hiding one without the other leaves a
    // floating menu pointing at nothing.
    if let Some(window) = app.get_webview_window(BALL_MENU_LABEL) {
        let _ = window.hide();
    }
}

/// Opens the orb's right-click panel next to it, or closes it when it is
/// already showing. Ctrl-free toggle: the orb's right button is the only path.
pub fn toggle_menu(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(BALL_MENU_LABEL) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return Ok(());
        }
    }
    let Some(window) = app.get_webview_window(BALL_MENU_LABEL) else {
        // First open: the window is created visible at its final position. A
        // `show()` right after `build()` races WebView2 creation on Windows
        // ("FailedToReceiveMessage") — the same trap the result window solves
        // by deferring every native call to the renderer's prepare handshake.
        return create_menu_window(app).map_err(|error| format!("无法创建悬浮球菜单：{error}"));
    };
    // Re-opens are safe: the window (and its WebView) already exist.
    reveal_menu(app)
}

fn create_menu_window(app: &AppHandle) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(
        app,
        BALL_MENU_LABEL,
        WebviewUrl::App("ball/index.html?menu=1".into()),
    )
    .title("TextLens")
    .inner_size(BALL_MENU_WIDTH, BALL_MENU_HEIGHT)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .fullscreen(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .accept_first_mouse(true)
    .focusable(true)
    .focused(false)
    .visible(false)
    .build()?;
    Ok(())
}

/// Shows the panel once its renderer is alive.
///
/// Creating a transparent window visible used to hand back a window whose
/// WebView never navigated: the page stayed blank because the window appeared
/// before WebView2 finished constructing. Waiting for this call is the same
/// contract the result window follows with its prepare handshake.
pub fn reveal_menu(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(BALL_MENU_LABEL)
        .ok_or_else(|| "悬浮球菜单尚未创建".to_owned())?;
    if let Err(error) = position_menu(app, &window) {
        eprintln!("[ball] stage=menu-position error_class=window: {error}");
    }
    window.show().map_err(|error| error.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

fn position_menu(app: &AppHandle, menu: &WebviewWindow) -> tauri::Result<()> {
    let Some(orb) = app.get_webview_window(BALL_LABEL) else {
        return Ok(());
    };
    // A non-activating tool window may not report a monitor it belongs to;
    // every one of these is advisory, the default position is still usable.
    let Ok(orb_position) = orb.outer_position() else {
        return Ok(());
    };
    let Ok(orb_size) = orb.outer_size() else {
        return Ok(());
    };
    let scale = menu.scale_factor().unwrap_or(1.0);
    let menu_width = (BALL_MENU_WIDTH * scale).round() as i32;
    let menu_height = (BALL_MENU_HEIGHT * scale).round() as i32;
    let gap = (BALL_MENU_GAP * scale).round() as i32;
    let monitor = orb
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| menu.current_monitor().ok().flatten());
    let work_area = monitor.map(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        (
            position.x,
            position.y,
            size.width as i32,
            size.height as i32,
        )
    });
    let (x, y) = menu_position(
        (
            orb_position.x,
            orb_position.y,
            orb_size.width as i32,
            orb_size.height as i32,
        ),
        (menu_width, menu_height),
        work_area,
        gap,
    );
    menu.set_position(tauri::PhysicalPosition::new(x, y))
}

/// Places the panel above the orb, or below when there is no room, clamped so
/// a corner-docked orb never pushes it off the screen.
fn menu_position(
    orb: (i32, i32, i32, i32),
    menu: (i32, i32),
    monitor: Option<(i32, i32, i32, i32)>,
    gap: i32,
) -> (i32, i32) {
    let (orb_x, orb_y, _orb_width, orb_height) = orb;
    let (menu_width, menu_height) = menu;
    let Some((left, top, width, height)) = monitor else {
        return (orb_x, orb_y - gap - menu_height);
    };
    let right = left + width;
    let bottom = top + height;
    let x = orb_x.clamp(left, (right - menu_width).max(left));
    let above = orb_y - gap - menu_height;
    let below = orb_y + orb_height + gap;
    let y = if above >= top {
        above
    } else {
        below.clamp(top, (bottom - menu_height).max(top))
    };
    (x, y)
}

/// Shows, resizes or hides the orb to match the persisted state and the
/// current suppression reasons.
pub fn apply(app: &AppHandle, store: &BallStore) -> tauri::Result<()> {
    if !store.should_show() {
        // Hiding instead of closing keeps the tray toggle and the
        // fullscreen watcher instant; the WebView is reused on the way back.
        hide_window(app);
        return Ok(());
    }
    let state = store.snapshot();
    let diameter = state.diameter();
    let window = match app.get_webview_window(BALL_LABEL) {
        Some(window) => window,
        None => create_window(app, diameter)?,
    };
    let anchor = app
        .cursor_position()
        .map(|point| Point {
            x: point.x,
            y: point.y,
        })
        .unwrap_or(Point { x: 0.0, y: 0.0 });
    windows::place_ball_window(
        &window,
        anchor,
        state.position(),
        WindowSize {
            width: diameter,
            height: diameter,
        },
    )?;
    windows::show_overlay_window(&window)
}

/// Hides the orb for a reason that will end on its own.
///
/// Used while an orb-launched conversation is open: the orb is the launcher,
/// and leaving it floating above the answer window only adds clutter.
pub fn suppress(app: &AppHandle, store: &BallStore, reason: BallSuppression) {
    store.suppress(reason);
    hide_window(app);
}

/// Releases a temporary suppression and brings the orb back if nothing else is
/// holding it down. Cosmetic failures stay silent: the orb returns on the next
/// launch at the latest.
pub fn resume(app: &AppHandle, store: &BallStore, reason: BallSuppression) {
    store.resume(reason);
    if let Err(error) = apply(app, store) {
        eprintln!("[ball] stage=resume error_class=window: {error}");
    }
}

/// Runtime entry points used by the tray menu.
pub fn set_visible(app: &AppHandle, store: &BallStore, visible: bool) -> Result<(), String> {
    store.set_visible(visible);
    apply(app, store).map_err(|error| format!("无法切换悬浮球：{error}"))
}

pub fn set_size(app: &AppHandle, store: &BallStore, size: f64) -> Result<(), String> {
    store.set_size(size);
    apply(app, store).map_err(|error| format!("无法调整悬浮球大小：{error}"))
}

/// Watches the foreground application and hides the orb over fullscreen video,
/// games and presentations.
///
/// A 700 ms poll is deliberate: the alternative (a `SetWinEventHook` on
/// foreground changes plus per-window fullscreen tracking) is a lot of native
/// state for a cosmetic preference, and polling cannot miss a window that
/// resizes into fullscreen without changing focus.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn spawn_fullscreen_watcher(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::thread::Builder::new()
            .name("textlens-ball-fullscreen".to_owned())
            .spawn(move || {
                let mut hidden = false;
                loop {
                    std::thread::sleep(std::time::Duration::from_millis(700));
                    let Some(store) = app.try_state::<BallStore>() else {
                        break;
                    };
                    // A hidden-by-preference orb, or one whose fullscreen rule
                    // was just switched off, never comes back from here.
                    let state = store.snapshot();
                    if !state.visible || !state.hide_in_fullscreen {
                        if hidden {
                            hidden = false;
                            store.resume(BallSuppression::Fullscreen);
                        }
                        continue;
                    }
                    let fullscreen = foreground_is_fullscreen_app();
                    if fullscreen == hidden {
                        continue;
                    }
                    hidden = fullscreen;
                    if fullscreen {
                        suppress(&app, &store, BallSuppression::Fullscreen);
                    } else {
                        resume(&app, &store, BallSuppression::Fullscreen);
                    }
                }
            });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

/// Whether the foreground window is a fullscreen application that is not us.
#[cfg(target_os = "windows")]
fn foreground_is_fullscreen_app() -> bool {
    // `windows` in this module names the crate's own window helpers, so the
    // Win32 bindings are reached through the absolute path.
    use ::windows::Win32::Foundation::RECT;
    use ::windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use ::windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    };

    unsafe {
        let window = GetForegroundWindow();
        if window.0.is_null() || !IsWindowVisible(window).as_bool() || IsIconic(window).as_bool() {
            return false;
        }
        let mut process_id = 0u32;
        GetWindowThreadProcessId(window, Some(&mut process_id));
        // Maximized settings/result windows are not "another application".
        if process_id == std::process::id() {
            return false;
        }
        let extended_style = GetWindowLongW(window, GWL_EXSTYLE) as u32;
        // Tray flyouts, IME candidates and overlay helpers can be monitor-sized
        // without being an application the user is watching.
        if extended_style & (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) != 0 {
            return false;
        }
        // The desktop itself owns the foreground whenever nothing else does.
        let mut class_name = [0u16; 64];
        let length = GetClassNameW(window, &mut class_name);
        let class_name = String::from_utf16_lossy(&class_name[..length.max(0) as usize]);
        if matches!(class_name.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") {
            return false;
        }

        let mut rect = RECT::default();
        if GetWindowRect(window, &mut rect).is_err() {
            return false;
        }
        let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return false;
        }
        let monitor = info.rcMonitor;
        // A borderless fullscreen window usually starts exactly at the monitor
        // origin; a few pixels of slack absorb shadow and rounding differences
        // without accepting a merely maximized window on a smaller work area.
        const SLACK: i32 = 2;
        rect.left <= monitor.left + SLACK
            && rect.top <= monitor.top + SLACK
            && rect.right >= monitor.right - SLACK
            && rect.bottom >= monitor.bottom - SLACK
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_path(directory: &tempfile::TempDir) -> PathBuf {
        directory.path().join("ball.json")
    }

    #[test]
    fn a_missing_file_starts_visible_without_a_position() {
        let directory = tempfile::tempdir().unwrap();
        let store = BallStore::load(temporary_path(&directory));
        assert_eq!(store.snapshot(), BallState::default());
        assert!(store.snapshot().visible);
        assert_eq!(store.snapshot().position(), None);
        assert_eq!(store.snapshot().diameter(), BALL_MEDIUM_SIZE);
    }

    #[test]
    fn position_visibility_and_size_survive_a_reload() {
        let directory = tempfile::tempdir().unwrap();
        let path = temporary_path(&directory);
        let store = BallStore::load(path.clone());
        store.set_position(-1200, 640);
        store.set_visible(false);
        store.set_size(BALL_LARGE_SIZE);
        store.set_hide_in_fullscreen(false);
        store.set_ask_action(Some("ask-ai".to_owned()));

        let reloaded = BallStore::load(path);
        assert_eq!(
            reloaded.snapshot(),
            BallState {
                visible: false,
                x: Some(-1200),
                y: Some(640),
                size: Some(BALL_LARGE_SIZE),
                hide_in_fullscreen: false,
                ask_action_id: Some("ask-ai".to_owned()),
            }
        );
    }

    #[test]
    fn an_older_ball_file_keeps_its_position_and_gains_the_new_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = temporary_path(&directory);
        fs::write(
            &path,
            b"{\"visible\":true,\"x\":40,\"y\":1552,\"size\":44.0}",
        )
        .unwrap();

        let state = BallStore::load(path).snapshot();
        assert_eq!(state.position(), Some(Point { x: 40.0, y: 1552.0 }));
        assert!(state.hide_in_fullscreen);
        assert_eq!(state.ask_action_id, None);
    }

    #[test]
    fn the_orb_can_be_reset_to_its_default_corner_and_follow_a_specific_action() {
        let directory = tempfile::tempdir().unwrap();
        let store = BallStore::load(temporary_path(&directory));
        store.set_position(120, 80);
        store.set_ask_action(Some("  ask-deep  ".to_owned()));
        assert_eq!(store.snapshot().ask_action_id.as_deref(), Some("ask-deep"));

        store.reset_position();
        assert_eq!(store.snapshot().position(), None);

        // An empty id means "first enabled Ask action", stored as `None`.
        store.set_ask_action(Some("   ".to_owned()));
        assert_eq!(store.snapshot().ask_action_id, None);
        assert_eq!(
            store.settings(),
            BallSettings {
                visible: true,
                size: BALL_MEDIUM_SIZE,
                hide_in_fullscreen: true,
                ask_action_id: None,
            }
        );
    }

    #[test]
    fn a_corrupt_file_falls_back_to_defaults_instead_of_failing() {
        let directory = tempfile::tempdir().unwrap();
        let path = temporary_path(&directory);
        fs::write(&path, b"{ not json").unwrap();
        assert_eq!(BallStore::load(path).snapshot(), BallState::default());
    }

    #[test]
    fn a_byte_order_mark_is_tolerated() {
        let directory = tempfile::tempdir().unwrap();
        let path = temporary_path(&directory);
        fs::write(&path, b"\xEF\xBB\xBF{\"visible\":false}").unwrap();
        assert!(!BallStore::load(path).snapshot().visible);
    }

    #[test]
    fn a_partial_file_keeps_the_missing_fields_at_their_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = temporary_path(&directory);
        fs::write(&path, b"{\"x\":120,\"y\":80}").unwrap();
        let state = BallStore::load(path).snapshot();
        assert!(state.visible);
        assert_eq!(state.position(), Some(Point { x: 120.0, y: 80.0 }));
        assert_eq!(state.diameter(), BALL_MEDIUM_SIZE);
    }

    #[test]
    fn a_write_creates_the_config_directory() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested").join("ball.json");
        let store = BallStore::load(path.clone());
        store.set_position(10, 20);
        assert!(path.exists());
        assert_eq!(store.path(), path.as_path());
    }

    #[test]
    fn a_size_outside_the_supported_range_is_clamped_not_rejected() {
        assert_eq!(normalized_size(Some(10.0)), BALL_SMALL_SIZE);
        assert_eq!(normalized_size(Some(500.0)), BALL_LARGE_SIZE * 1.5);
        assert_eq!(normalized_size(Some(f64::NAN)), BALL_LOGICAL_SIZE);
        assert_eq!(normalized_size(None), BALL_LOGICAL_SIZE);

        let directory = tempfile::tempdir().unwrap();
        let store = BallStore::load(temporary_path(&directory));
        assert_eq!(store.set_size(4.0).size, Some(BALL_SMALL_SIZE));
    }

    #[test]
    fn several_suppressions_hold_the_orb_down_until_the_last_one_ends() {
        let directory = tempfile::tempdir().unwrap();
        let store = BallStore::load(temporary_path(&directory));
        assert!(store.should_show());

        store.suppress(BallSuppression::Conversation);
        assert!(!store.should_show());
        store.suppress(BallSuppression::Fullscreen);
        store.resume(BallSuppression::Conversation);
        // Fullscreen still owns it: the conversation ending must not pop the
        // orb over a fullscreen game.
        assert!(!store.should_show());
        store.resume(BallSuppression::Fullscreen);
        assert!(store.should_show());
    }

    #[test]
    fn the_menu_sits_above_the_orb_and_flips_below_near_the_top() {
        // Orb docked at the bottom-left: the panel goes above it.
        assert_eq!(
            menu_position((20, 1200, 56, 56), (248, 300), Some((0, 0, 1920, 1300)), 8),
            (20, 892)
        );
        // No room above: the panel flips below the orb.
        assert_eq!(
            menu_position((20, 120, 56, 56), (248, 300), Some((0, 0, 1920, 1300)), 8),
            (20, 184)
        );
    }

    #[test]
    fn the_menu_is_clamped_to_the_monitor() {
        // Orb at the right edge: the panel shifts left instead of overflowing.
        assert_eq!(
            menu_position(
                (1800, 1200, 56, 56),
                (248, 300),
                Some((0, 0, 1920, 1300)),
                8
            ),
            (1672, 892)
        );
        // A tiny monitor leaves the panel at its top-left rather than negative.
        assert_eq!(
            menu_position((10, 10, 44, 44), (248, 300), Some((0, 0, 200, 260)), 8),
            (0, 0)
        );
    }

    #[test]
    fn a_hidden_orb_stays_hidden_when_every_suppression_ends() {
        let directory = tempfile::tempdir().unwrap();
        let store = BallStore::load(temporary_path(&directory));
        store.set_visible(false);
        store.suppress(BallSuppression::Fullscreen);
        store.resume(BallSuppression::Fullscreen);
        assert!(!store.should_show());
    }
}
