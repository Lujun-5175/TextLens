pub mod actions;
mod autostart;
pub mod ball;
mod clipboard;
mod language_detection;
mod local_secrets;
pub mod models;
mod openai_protocol;
mod openai_transport;
mod protocols;
mod reinsert;
mod request_log;
mod result_history;
pub mod runtime;
pub mod selection;
pub mod settings;
mod thinking;
pub mod windows;

#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use actions::ActionService;
use runtime::RuntimeState;
use selection::SelectionMonitor;
use settings::SettingsRepository;
use tauri::Manager;

#[cfg(target_os = "windows")]
static PENDING_RUNNING_NOTICE: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "windows")]
static WINDOWS_RUNTIME_READY: AtomicBool = AtomicBool::new(false);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            runtime::handle_global_shortcut(app, shortcut, event);
        })
        .build();

    let builder = tauri::Builder::default();
    // Windows allows launching the same executable repeatedly from the Start
    // menu. Register this before every other plugin so only the first process
    // owns the tray, hooks and settings repository; another launch brings the
    // existing process to show a short, non-activating status notice instead.
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        // The single-instance plugin initializes before configured webviews.
        // Remember an exceptionally early second launch and consume it at the
        // end of the primary process setup instead of losing the request.
        PENDING_RUNNING_NOTICE.store(true, Ordering::Release);
        if WINDOWS_RUNTIME_READY.load(Ordering::Acquire)
            && windows::show_startup_notice(app, windows::StartupNoticeKind::AlreadyRunning).is_ok()
        {
            PENDING_RUNNING_NOTICE.store(false, Ordering::Release);
        }
    }));

    builder
        // Keep Tauri's native macOS menu so the focused WebView receives the
        // standard responder actions for Cmd+X/C/V/A and undo/redo. Without
        // an Edit menu, WKWebView text fields accept typing but those keyboard
        // shortcuts do not reach the active input in packaged builds.
        .enable_macos_default_menu(true)
        .plugin(shortcut_plugin)
        .setup(|app| {
            #[cfg(target_os = "windows")]
            windows::initialize_windows_ui_thread();

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let settings_path = app.path().app_config_dir()?.join("settings.json");
            // A damaged settings file must not abort startup: recover from the
            // backup (or defaults) and keep the bad file for the user.
            let settings = Arc::new(SettingsRepository::open_or_recover(settings_path)?);
            // Skip the reconcile entirely when the executable path is unknown: a
            // blank Run value would make Windows try to launch nothing at login.
            if let Ok(executable) = std::env::current_exe() {
                autostart::reconcile(
                    settings.get_settings().application.launch_at_login,
                    &executable.to_string_lossy(),
                )
                .ok();
            }
            let actions = ActionService::new(settings.clone())?;
            let mut monitor = SelectionMonitor::new(&app.config().identifier)?;
            let receiver = monitor
                .take_event_receiver()
                .ok_or("无法取得划词事件通道")?;

            app.manage(RuntimeState::new(settings, actions, monitor));
            // The orb's own state file keeps it out of the versioned settings
            // schema; a corrupt or missing file degrades to "visible, default
            // corner" instead of failing startup. Manage it before the tray so
            // the menu's checkmark reflects the real state at first paint.
            let ball_path = ball::state_path(app.handle())?;
            app.manage(ball::BallStore::load(ball_path));
            let handle = app.handle().clone();
            handle
                .state::<RuntimeState>()
                .windows
                .ensure_toolbar(&handle)?;
            runtime::spawn_selection_loop(handle.clone(), receiver)?;
            runtime::setup_tray(&handle)?;
            {
                let store = handle.state::<ball::BallStore>();
                if let Err(error) = ball::apply(&handle, &store) {
                    eprintln!("[ball] stage=startup error_class=window: {error}");
                }
            }
            // Restore the last settings-window size after the window exists
            // but before the user can open it.
            runtime::restore_settings_window_size(&handle);
            ball::spawn_fullscreen_watcher(handle.clone());

            let state = handle.state::<RuntimeState>();
            state.reconcile_capture(&handle);
            state.reconcile_shortcut(&handle);
            runtime::start_permission_poll(handle.clone());
            #[cfg(target_os = "macos")]
            if !SelectionMonitor::is_accessibility_trusted() {
                runtime::open_settings_window(&handle);
            }
            #[cfg(target_os = "windows")]
            {
                WINDOWS_RUNTIME_READY.store(true, Ordering::Release);
                if let Err(error) = windows::show_startup_notice(
                    &handle,
                    if PENDING_RUNNING_NOTICE.swap(false, Ordering::AcqRel) {
                        windows::StartupNoticeKind::AlreadyRunning
                    } else {
                        windows::StartupNoticeKind::Started
                    },
                ) {
                    eprintln!("failed to show Windows startup notice: {error}");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            app.state::<RuntimeState>()
                .handle_window_event(app, window.label(), event);
        })
        .invoke_handler(tauri::generate_handler![
            runtime::get_settings,
            runtime::settings_ready,
            runtime::set_settings_dirty,
            runtime::reinsert_result,
            runtime::list_request_log,
            runtime::clear_request_log,
            runtime::update_settings,
            runtime::reset_result_size,
            runtime::create_provider,
            runtime::update_provider,
            runtime::delete_provider,
            runtime::set_provider_api_key,
            runtime::clear_provider_api_key,
            runtime::get_provider_api_key,
            runtime::test_provider_connection,
            runtime::list_provider_models,
            runtime::sync_provider_models,
            runtime::get_accessibility_status,
            runtime::request_accessibility,
            runtime::open_settings,
            runtime::take_settings_guidance,
            runtime::quit_app,
            runtime::toolbar_ready,
            runtime::present_toolbar,
            runtime::recover_toolbar,
            runtime::run_action,
            runtime::open_ask_from_ball,
            runtime::move_ball,
            runtime::cycle_ball_size,
            runtime::open_ball_menu,
            runtime::show_ball_menu,
            runtime::close_ball_menu,
            runtime::get_ball_settings,
            runtime::update_ball_settings,
            runtime::reset_ball_position,
            runtime::hide_toolbar,
            runtime::report_toolbar_size,
            runtime::begin_result_ready,
            runtime::ack_result_ready,
            runtime::prepare_result_reveal,
            runtime::commit_result_reveal,
            runtime::fail_result_reveal,
            runtime::set_result_pinned,
            runtime::set_result_pointer_inside,
            runtime::show_result_selection,
            runtime::hide_result_selection,
            runtime::cancel_action,
            runtime::retry_action,
            runtime::continue_action,
            runtime::copy_text,
            runtime::open_external,
            runtime::hide_result,
            runtime::close_result,
            result_history::list_result_history,
            result_history::delete_result_history_entry,
            result_history::copy_result_history_entry,
            result_history::clear_result_history,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build TextLens")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                app.state::<RuntimeState>().shutdown(app);
            }
        });
}
