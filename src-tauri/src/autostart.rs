//! Launch-at-login reconciliation.
//!
//! Windows keeps this in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
//! matching the current-user installer: no elevation, no machine-wide state.
//! The registry is written through `RegSetKeyValueW` rather than spawning
//! `reg.exe`, which endpoint-protection suites treat as suspicious behaviour.
//! Other platforms keep the setting but apply nothing yet.

pub(crate) const RUN_VALUE_NAME: &str = "TextLens";
#[cfg(target_os = "windows")]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// Value data written to the Run key. Quoted because an install path can
/// contain spaces (`D:\My Apps\TextLens`) and the value is executed as a
/// command line.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn run_command(executable: &str) -> String {
    format!("\"{executable}\"")
}

/// Makes the registry match `enabled`. Idempotent: writing the same value twice
/// is harmless, and deleting an absent value is treated as success so a fresh
/// profile does not report a failure.
pub(crate) fn reconcile(enabled: bool, executable: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        apply_windows(enabled, executable)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (enabled, executable);
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn apply_windows(enabled: bool, executable: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR};
    use windows::Win32::System::Registry::{
        RegDeleteKeyValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let key = wide(RUN_KEY);
    let name = wide(RUN_VALUE_NAME);
    let key_ptr = PCWSTR(key.as_ptr());
    let name_ptr = PCWSTR(name.as_ptr());

    let status: WIN32_ERROR = unsafe {
        if enabled {
            let data = wide(&run_command(executable));
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                key_ptr,
                name_ptr,
                REG_SZ.0,
                Some(data.as_ptr().cast()),
                u32::try_from(data.len() * std::mem::size_of::<u16>())
                    .map_err(|_| "开机启动项路径过长".to_owned())?,
            )
        } else {
            RegDeleteKeyValueW(HKEY_CURRENT_USER, key_ptr, name_ptr)
        }
    };

    if status == ERROR_SUCCESS {
        return Ok(());
    }
    // Deleting a value that was never written is the desired end state.
    if !enabled && status == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    Err(format!(
        "无法更新开机启动项（错误码 {}）",
        status.0
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_command_quotes_paths_with_spaces() {
        assert_eq!(
            run_command(r"D:\My Apps\TextLens\textlens.exe"),
            r#""D:\My Apps\TextLens\textlens.exe""#
        );
        assert_eq!(
            run_command(r"C:\TextLens\textlens.exe"),
            r#""C:\TextLens\textlens.exe""#
        );
    }

    #[test]
    fn run_value_name_matches_the_product_name() {
        // Changing this silently orphans the previous entry in the Run key.
        assert_eq!(RUN_VALUE_NAME, "TextLens");
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn reconcile_is_a_no_op_off_windows() {
        assert!(reconcile(true, "/Applications/TextLens.app").is_ok());
    }
}
