//! Pastes a finished answer back into the window the selection came from.
//!
//! Synthetic keystrokes are the risky part: if focus did not actually return,
//! Ctrl+V would land in whatever window is in front. The caller therefore only
//! presses keys after the foreground window verifies as the recorded source,
//! and the text is always on the clipboard first, so a refused paste still
//! leaves the user one keystroke away.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReinsertOutcome {
    /// Focus returned to the source window and Ctrl+V was sent.
    Pasted,
    /// The text is on the clipboard, but the paste was not attempted.
    CopiedOnly,
}

pub(crate) fn reinsert(source_window: Option<i64>, expected_app: Option<&str>) -> ReinsertOutcome {
    #[cfg(target_os = "windows")]
    {
        windows_impl::reinsert(source_window, expected_app)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (source_window, expected_app);
        ReinsertOutcome::CopiedOnly
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HWND};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYBD_EVENT_FLAGS};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
        GA_ROOT,
    };

    use super::ReinsertOutcome;

    const VK_CONTROL: u8 = 0x11;
    const VK_V: u8 = 0x56;
    const KEYEVENTF_KEYUP: u32 = 0x0002;

    /// Time for the previous foreground window to settle after ours hides.
    const FOCUS_SETTLE_MS: u64 = 90;

    pub(super) fn reinsert(
        source_window: Option<i64>,
        expected_app: Option<&str>,
    ) -> ReinsertOutcome {
        let Some(raw) = source_window else {
            return ReinsertOutcome::CopiedOnly;
        };
        if raw == 0 {
            return ReinsertOutcome::CopiedOnly;
        }
        let target = HWND(raw as *mut core::ffi::c_void);
        if !unsafe { IsWindow(Some(target)) }.as_bool() {
            // The source application closed while the answer was generating.
            return ReinsertOutcome::CopiedOnly;
        }
        // Windows recycles handles: the same value can belong to a different
        // application by now, and a verified foreground would not notice.
        if let (Some(expected), Some(actual)) = (expected_app, window_process_stem(target)) {
            if !expected.eq_ignore_ascii_case(&actual) {
                return ReinsertOutcome::CopiedOnly;
            }
        }

        unsafe {
            let _ = SetForegroundWindow(target);
        }
        std::thread::sleep(std::time::Duration::from_millis(FOCUS_SETTLE_MS));

        let foreground = unsafe { GetForegroundWindow() };
        let root = unsafe { GetAncestor(foreground, GA_ROOT) };
        if root != target {
            return ReinsertOutcome::CopiedOnly;
        }

        unsafe {
            keybd_event(VK_CONTROL, 0, KEYBD_EVENT_FLAGS(0), 0);
            keybd_event(VK_V, 0, KEYBD_EVENT_FLAGS(0), 0);
            keybd_event(VK_V, 0, KEYBD_EVENT_FLAGS(KEYEVENTF_KEYUP), 0);
            keybd_event(VK_CONTROL, 0, KEYBD_EVENT_FLAGS(KEYEVENTF_KEYUP), 0);
        }
        ReinsertOutcome::Pasted
    }

    /// Executable stem of the process owning `window`, lowercased.
    fn window_process_stem(window: HWND) -> Option<String> {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
        if pid == 0 {
            return None;
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        let queried = unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut size,
            )
        };
        let _ = unsafe { CloseHandle(process) };
        queried.ok()?;
        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        let stem = path
            .rsplit(['\\', '/'])
            .next()?
            .rsplit_once('.')
            .map(|(stem, _)| stem)
            .unwrap_or(path.as_str());
        Some(stem.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_source_window_only_copies() {
        assert_eq!(reinsert(None, None), ReinsertOutcome::CopiedOnly);
        assert_eq!(
            reinsert(Some(0), Some("chrome")),
            ReinsertOutcome::CopiedOnly
        );
    }
}
