//! Launch-at-login reconciliation.
//!
//! Windows keeps this in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`,
//! matching the current-user installer: no elevation, no machine-wide state.
//! Other platforms keep the setting but apply nothing yet.

pub(crate) const RUN_VALUE_NAME: &str = "TextLens";
#[cfg(target_os = "windows")]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// Command line written to the Run key. Quoted because an install path can
/// contain spaces (`D:\My Apps\TextLens`).
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
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // CREATE_NO_WINDOW: the toggle must not flash a console.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut command = Command::new("reg.exe");
    if enabled {
        command.args([
            "add",
            RUN_KEY,
            "/v",
            RUN_VALUE_NAME,
            "/t",
            "REG_SZ",
            "/d",
            &run_command(executable),
            "/f",
        ]);
    } else {
        command.args(["delete", RUN_KEY, "/v", RUN_VALUE_NAME, "/f"]);
    }
    let output = command
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("无法更新开机启动项：{error}"))?;

    if output.status.success() {
        return Ok(());
    }
    // `reg delete` exits non-zero when the value is already absent; that is the
    // desired end state, not a failure.
    if !enabled {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(if stderr.is_empty() {
        "无法写入开机启动项".to_owned()
    } else {
        format!("无法写入开机启动项：{stderr}")
    })
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
        assert_eq!(run_command(r"C:\TextLens\textlens.exe"), r#""C:\TextLens\textlens.exe""#);
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
