//! Local, plaintext result history.
//!
//! The result window is destroyed on close and keeps no answer on disk, so a
//! reader who loses an answer had to pay for the same request again. This
//! module appends each successfully completed answer to a JSONL file next to
//! `settings.json`. The user explicitly agreed to plaintext storage; entries can
//! be deleted individually or cleared at any time from the settings window.
//!
//! Invariants:
//! - Only completed answers are written. Failures and cancellations never are.
//! - A write failure is reported with `eprintln!` and never reaches the result
//!   window.
//! - Reads tolerate corrupt lines: each line is parsed on its own and bad lines
//!   are skipped (and counted), so one truncated write cannot destroy history.

use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};
use uuid::Uuid;

use crate::{openai_protocol::TokenUsage, runtime::ensure_settings_caller};

/// Ring size: appending beyond this rewrites the file with the newest entries.
pub(crate) const RESULT_HISTORY_LIMIT: usize = 200;
/// Per-entry content cap. Larger answers are truncated to this many UTF-8 bytes.
pub(crate) const CONTENT_LIMIT_BYTES: usize = 200 * 1024;
/// Per-entry source-selection cap.
pub(crate) const SOURCE_TEXT_LIMIT_BYTES: usize = 20 * 1024;
/// Default page size for the settings list.
pub(crate) const DEFAULT_LIST_LIMIT: usize = 50;

const RESULT_HISTORY_FILE: &str = "results.jsonl";
const HISTORY_TEMP_SUFFIX: &str = ".next";

/// Serializes history file mutations. Commands and the completion hook can
/// run concurrently; a read-modify-write must not interleave. Single-instance
/// handling already guarantees one process per user.
static HISTORY_IO_LOCK: Mutex<()> = Mutex::new(());

/// Token usage re-shaped for both serialization and later deserialization.
/// `TokenUsage` is write-only in the protocol module, so history owns this copy
/// instead of widening that type's surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    pub total_tokens: u64,
}

impl From<TokenUsage> for HistoryUsage {
    fn from(usage: TokenUsage) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResultHistoryEntry {
    pub id: String,
    /// ISO8601 UTC, e.g. `2026-11-26T08:30:00Z`.
    pub created_at: String,
    pub action_id: String,
    pub action_name: String,
    pub provider_id: String,
    pub model_id: String,
    pub source_text: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<HistoryUsage>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Everything the runtime knows when an answer completes. Identity and
/// timestamp are assigned by [`build_entry`] so tests can pin them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NewResultHistoryEntry {
    pub action_id: String,
    pub action_name: String,
    pub provider_id: String,
    pub model_id: String,
    pub source_text: String,
    pub content: String,
    pub usage: Option<TokenUsage>,
}

/// Cuts `value` to at most `limit` UTF-8 bytes without splitting a character.
fn truncate_utf8(value: &str, limit: usize) -> (&str, bool) {
    if value.len() <= limit {
        return (value, false);
    }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (&value[..end], true)
}

pub(crate) fn build_entry(
    new: NewResultHistoryEntry,
    id: String,
    created_at: String,
) -> ResultHistoryEntry {
    let (content, content_truncated) = truncate_utf8(&new.content, CONTENT_LIMIT_BYTES);
    let (source_text, source_truncated) = truncate_utf8(&new.source_text, SOURCE_TEXT_LIMIT_BYTES);
    ResultHistoryEntry {
        id,
        created_at,
        action_id: new.action_id,
        action_name: new.action_name,
        provider_id: new.provider_id,
        model_id: new.model_id,
        source_text: source_text.to_owned(),
        content: content.to_owned(),
        usage: new.usage.map(HistoryUsage::from),
        truncated: content_truncated || source_truncated,
    }
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    // Howard Hinnant's `civil_from_days`; every step is exact integer math.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn utc_timestamp(now: SystemTime) -> String {
    let seconds = now
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let remainder = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = remainder / 3_600;
    let minute = (remainder % 3_600) / 60;
    let second = remainder % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn utc_timestamp_now() -> String {
    utc_timestamp(SystemTime::now())
}

/// Fields that must be present for an entry to be usable by the settings UI.
fn is_usable(entry: &ResultHistoryEntry) -> bool {
    !entry.id.is_empty()
        && !entry.created_at.is_empty()
        && !entry.action_id.is_empty()
        && entry.content.len() <= CONTENT_LIMIT_BYTES
        && entry.source_text.len() <= SOURCE_TEXT_LIMIT_BYTES
}

pub(crate) struct HistoryRead {
    pub entries: Vec<ResultHistoryEntry>,
    /// Lines that were not valid entries. Kept for diagnostics and tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub skipped_lines: usize,
}

/// Reads every usable entry in file (oldest-first) order. A missing file is an
/// empty history. Corrupt or partially written lines are skipped one by one.
pub(crate) fn read_entries(path: &Path) -> io::Result<HistoryRead> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(HistoryRead {
                entries: Vec::new(),
                skipped_lines: 0,
            })
        }
        Err(error) => return Err(error),
    };
    let mut entries = Vec::new();
    let mut skipped_lines = 0;
    for line in raw.split(|byte| *byte == b'\n') {
        let Ok(line) = std::str::from_utf8(line) else {
            skipped_lines += 1;
            continue;
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<ResultHistoryEntry>(line) {
            Ok(entry) if is_usable(&entry) => entries.push(entry),
            _ => skipped_lines += 1,
        }
    }
    Ok(HistoryRead {
        entries,
        skipped_lines,
    })
}

/// Newest-first window of at most `limit` entries.
pub(crate) fn list_recent(path: &Path, limit: usize) -> io::Result<Vec<ResultHistoryEntry>> {
    let mut entries = read_entries(path)?.entries;
    entries.reverse();
    entries.truncate(limit);
    Ok(entries)
}

fn parent_of(path: &Path) -> Option<&Path> {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
}

fn write_entries_atomically(path: &Path, entries: &[ResultHistoryEntry]) -> io::Result<()> {
    if let Some(parent) = parent_of(path) {
        fs::create_dir_all(parent)?;
    }
    let mut buffer = String::new();
    for entry in entries {
        let line = serde_json::to_string(entry).map_err(|error| {
            io::Error::other(format!("history entry is not serializable: {error}"))
        })?;
        buffer.push_str(&line);
        buffer.push('\n');
    }
    let file_name = path.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "history path has no file name")
    })?;
    let mut temp_name = file_name.to_os_string();
    temp_name.push(HISTORY_TEMP_SUFFIX);
    let temp = path.with_file_name(temp_name);
    if let Err(error) = fs::write(&temp, buffer.as_bytes()) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if let Err(error) = crate::settings::atomic_file::replace_file(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

fn append_locked(path: &Path, entry: ResultHistoryEntry) -> io::Result<()> {
    let existing = read_entries(path)?.entries;
    if existing.len() >= RESULT_HISTORY_LIMIT {
        let mut entries = existing;
        entries.push(entry);
        let drop_count = entries.len() - RESULT_HISTORY_LIMIT;
        entries.drain(..drop_count);
        return write_entries_atomically(path, &entries);
    }
    if let Some(parent) = parent_of(path) {
        fs::create_dir_all(parent)?;
    }
    let mut line = serde_json::to_string(&entry)
        .map_err(|error| io::Error::other(format!("history entry is not serializable: {error}")))?;
    line.push('\n');
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(line.as_bytes())
}

pub(crate) fn append_entry(path: &Path, entry: ResultHistoryEntry) -> io::Result<()> {
    let _guard = HISTORY_IO_LOCK.lock();
    append_locked(path, entry)
}

/// Builds an entry with a fresh UUID and timestamp, then appends it.
#[cfg(test)]
pub(crate) fn append_generated(
    path: &Path,
    new: NewResultHistoryEntry,
) -> io::Result<ResultHistoryEntry> {
    let entry = build_entry(new, Uuid::new_v4().to_string(), utc_timestamp_now());
    append_entry(path, entry.clone())?;
    Ok(entry)
}

pub(crate) fn delete_entry(path: &Path, id: &str) -> io::Result<bool> {
    let _guard = HISTORY_IO_LOCK.lock();
    let entries = read_entries(path)?.entries;
    let total = entries.len();
    let remaining: Vec<ResultHistoryEntry> =
        entries.into_iter().filter(|entry| entry.id != id).collect();
    if remaining.len() == total {
        return Ok(false);
    }
    write_entries_atomically(path, &remaining)?;
    Ok(true)
}

pub(crate) fn clear_entries(path: &Path) -> io::Result<()> {
    let _guard = HISTORY_IO_LOCK.lock();
    write_entries_atomically(path, &[])
}

/// The stored entry behind a copy request. `None` means it was already deleted.
pub(crate) fn find_entry(path: &Path, id: &str) -> io::Result<Option<ResultHistoryEntry>> {
    Ok(read_entries(path)?
        .entries
        .into_iter()
        .find(|entry| entry.id == id))
}

/// `%APPDATA%/com.local.textlens/results.jsonl` on Windows (the same directory
/// as `settings.json`), the platform equivalent elsewhere.
pub(crate) fn history_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(RESULT_HISTORY_FILE))
        .map_err(|error| format!("无法定位历史记录文件：{error}"))
}

/// Appends one completed answer in the background. The result window must never
/// wait for, or fail because of, this write.
pub(crate) fn record_completed(app: &AppHandle, new: NewResultHistoryEntry) {
    let path = match history_path(app) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("failed to save result history: {error}");
            return;
        }
    };
    let entry = build_entry(new, Uuid::new_v4().to_string(), utc_timestamp_now());
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = append_entry(&path, entry) {
            eprintln!("failed to save result history: {error}");
        }
    });
}

#[tauri::command]
pub async fn list_result_history(
    app: AppHandle,
    window: WebviewWindow,
    limit: Option<usize>,
) -> Result<Vec<ResultHistoryEntry>, String> {
    ensure_settings_caller(&window)?;
    let path = history_path(&app)?;
    let limit = limit
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, RESULT_HISTORY_LIMIT);
    tauri::async_runtime::spawn_blocking(move || list_recent(&path, limit))
        .await
        .map_err(|error| format!("历史记录任务调度失败：{error}"))?
        .map_err(|error| format!("无法读取历史记录：{error}"))
}

#[tauri::command]
pub async fn delete_result_history_entry(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<bool, String> {
    ensure_settings_caller(&window)?;
    let id = id.trim().to_owned();
    if id.is_empty() || id.len() > 128 {
        return Err("历史记录标识无效".to_owned());
    }
    let path = history_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || delete_entry(&path, &id))
        .await
        .map_err(|error| format!("历史记录任务调度失败：{error}"))?
        .map_err(|error| format!("无法删除历史记录：{error}"))
}

#[tauri::command]
pub async fn clear_result_history(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    ensure_settings_caller(&window)?;
    let path = history_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || clear_entries(&path))
        .await
        .map_err(|error| format!("历史记录任务调度失败：{error}"))?
        .map_err(|error| format!("无法清空历史记录：{error}"))
}

/// Copies a stored answer from the settings window.
///
/// `copy_text` is deliberately restricted to result windows, so the settings
/// renderer needs its own settings-only entry point. The clipboard receives the
/// stored text, which may already be truncated.
#[tauri::command]
pub async fn copy_result_history_entry(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<(), String> {
    ensure_settings_caller(&window)?;
    let id = id.trim().to_owned();
    if id.is_empty() || id.len() > 128 {
        return Err("历史记录标识无效".to_owned());
    }
    let path = history_path(&app)?;
    let entry = tauri::async_runtime::spawn_blocking(move || find_entry(&path, &id))
        .await
        .map_err(|error| format!("历史记录任务调度失败：{error}"))?
        .map_err(|error| format!("无法读取历史记录：{error}"))?;
    let Some(entry) = entry else {
        return Err("历史记录不存在或已被删除".to_owned());
    };
    crate::clipboard::write_text(&entry.content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample(content: &str) -> NewResultHistoryEntry {
        NewResultHistoryEntry {
            action_id: "translate".to_owned(),
            action_name: "翻译".to_owned(),
            provider_id: "provider-1".to_owned(),
            model_id: "model-1".to_owned(),
            source_text: "source text".to_owned(),
            content: content.to_owned(),
            usage: Some(TokenUsage {
                input_tokens: Some(12),
                output_tokens: Some(34),
                total_tokens: 46,
            }),
        }
    }

    fn entry_at(path: &Path, content: &str) -> ResultHistoryEntry {
        append_generated(path, sample(content)).unwrap()
    }

    #[test]
    fn appends_entries_and_lists_newest_first() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("results.jsonl");
        let first = entry_at(&path, "first answer");
        let second = entry_at(&path, "second answer");

        let listed = list_recent(&path, DEFAULT_LIST_LIMIT).unwrap();

        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, second.id);
        assert_eq!(listed[1].id, first.id);
        assert_eq!(listed[0].action_name, "翻译");
        assert_eq!(listed[0].model_id, "model-1");
        assert_eq!(listed[0].source_text, "source text");
        assert_eq!(
            listed[0].usage,
            Some(HistoryUsage {
                input_tokens: Some(12),
                output_tokens: Some(34),
                total_tokens: 46,
            })
        );
        assert!(!listed[0].truncated);
    }

    #[test]
    fn lists_only_the_requested_limit() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("results.jsonl");
        for index in 0..5 {
            entry_at(&path, &format!("answer {index}"));
        }

        let listed = list_recent(&path, 2).unwrap();

        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].content, "answer 4");
        assert_eq!(listed[1].content, "answer 3");
    }

    #[test]
    fn keeps_only_the_newest_entries_after_the_ring_limit() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("results.jsonl");
        for index in 0..(RESULT_HISTORY_LIMIT + 5) {
            entry_at(&path, &format!("answer {index}"));
        }

        let listed = list_recent(&path, RESULT_HISTORY_LIMIT).unwrap();

        assert_eq!(listed.len(), RESULT_HISTORY_LIMIT);
        assert_eq!(listed[0].content, "answer 204");
        assert_eq!(listed[RESULT_HISTORY_LIMIT - 1].content, "answer 5");
        let line_count = fs::read_to_string(&path).unwrap().lines().count();
        assert_eq!(line_count, RESULT_HISTORY_LIMIT);
        // The atomic rewrite must not leave its staging file behind.
        assert!(!path.with_file_name("results.jsonl.next").exists());
    }

    #[test]
    fn skips_corrupt_lines_instead_of_failing_the_read() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("results.jsonl");
        let valid = build_entry(
            sample("kept answer"),
            "id-1".to_owned(),
            "2026-01-01T00:00:00Z".to_owned(),
        );
        let mut raw = Vec::new();
        raw.extend_from_slice(serde_json::to_string(&valid).unwrap().as_bytes());
        raw.push(b'\n');
        raw.extend_from_slice(b"{\"id\":\"truncated");
        raw.push(b'\n');
        raw.extend_from_slice(&[0xff, 0xfe, b'\n']);
        raw.extend_from_slice(b"not json at all\n");
        raw.push(b'\n');
        fs::write(&path, raw).unwrap();

        let read = read_entries(&path).unwrap();

        assert_eq!(read.entries.len(), 1);
        assert_eq!(read.entries[0].content, "kept answer");
        assert_eq!(read.skipped_lines, 3);
        assert_eq!(list_recent(&path, 10).unwrap().len(), 1);
    }

    #[test]
    fn treats_a_missing_file_as_an_empty_history() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("results.jsonl");

        let read = read_entries(&path).unwrap();

        assert!(read.entries.is_empty());
        assert_eq!(read.skipped_lines, 0);
        assert!(list_recent(&path, 10).unwrap().is_empty());
    }

    #[test]
    fn truncates_oversized_content_and_source_text() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("results.jsonl");
        let mut new = sample(&"a".repeat(CONTENT_LIMIT_BYTES + 64));
        new.source_text = "源".repeat(SOURCE_TEXT_LIMIT_BYTES);
        let entry = append_generated(&path, new).unwrap();

        assert!(entry.truncated);
        assert_eq!(entry.content.len(), CONTENT_LIMIT_BYTES);
        // The source is three-byte characters, so the prefix backs off to a
        // character boundary below the byte cap.
        assert!(entry.source_text.len() <= SOURCE_TEXT_LIMIT_BYTES);
        assert!(entry.source_text.len() > SOURCE_TEXT_LIMIT_BYTES - 3);
        let stored = list_recent(&path, 10).unwrap();
        assert_eq!(stored[0].content.len(), CONTENT_LIMIT_BYTES);
        assert!(stored[0].truncated);
    }

    #[test]
    fn keeps_values_exactly_at_the_limit_untruncated() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("results.jsonl");
        let mut new = sample(&"a".repeat(CONTENT_LIMIT_BYTES));
        new.source_text = "b".repeat(SOURCE_TEXT_LIMIT_BYTES);

        let entry = append_generated(&path, new).unwrap();

        assert!(!entry.truncated);
        assert_eq!(entry.content.len(), CONTENT_LIMIT_BYTES);
    }

    #[test]
    fn truncation_never_splits_a_utf8_character() {
        // U+4E2D is three bytes; a 4-byte budget must back off to one character.
        let (text, truncated) = truncate_utf8("中文", 4);

        assert!(truncated);
        assert_eq!(text, "中");
        // A budget below the first character's width yields an empty prefix.
        let (empty, truncated) = truncate_utf8("中", 1);
        assert!(truncated);
        assert_eq!(empty, "");
    }

    #[test]
    fn deletes_one_entry_and_reports_unknown_ids() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("results.jsonl");
        let first = entry_at(&path, "first");
        let second = entry_at(&path, "second");

        assert!(delete_entry(&path, &first.id).unwrap());
        let remaining = list_recent(&path, 10).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, second.id);
        assert!(!delete_entry(&path, &first.id).unwrap());
        assert!(!delete_entry(&path, "missing").unwrap());
        assert_eq!(list_recent(&path, 10).unwrap().len(), 1);
    }

    #[test]
    fn finds_a_stored_entry_by_id_for_copying() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("results.jsonl");
        let first = entry_at(&path, "first");
        let second = entry_at(&path, "second");

        let found = find_entry(&path, &first.id).unwrap().unwrap();
        assert_eq!(found.content, "first");
        assert_eq!(
            find_entry(&path, &second.id).unwrap().unwrap().content,
            "second"
        );
        assert!(find_entry(&path, "missing").unwrap().is_none());
    }

    #[test]
    fn clears_every_entry() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("results.jsonl");
        entry_at(&path, "first");
        entry_at(&path, "second");

        clear_entries(&path).unwrap();

        assert!(list_recent(&path, 10).unwrap().is_empty());
        assert!(path.exists());
    }

    #[test]
    fn write_failures_are_returned_without_panicking() {
        let directory = tempdir().unwrap();
        // The parent "directory" is a regular file, so every write path fails.
        let blocker = directory.path().join("blocker");
        fs::write(&blocker, b"not a directory").unwrap();
        let path = blocker.join("results.jsonl");

        let error = append_generated(&path, sample("answer")).unwrap_err();

        assert!(!error.to_string().is_empty());
        // A later attempt against a valid path still works after the failure.
        let healthy = directory.path().join("results.jsonl");
        append_generated(&healthy, sample("answer")).unwrap();
        assert_eq!(list_recent(&healthy, 10).unwrap().len(), 1);
    }

    #[test]
    fn timestamps_are_iso8601_utc() {
        let epoch = UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);

        assert_eq!(utc_timestamp(epoch), "2023-11-14T22:13:20Z");
        // Leap-day handling (2024-02-29).
        let leap = UNIX_EPOCH + std::time::Duration::from_secs(1_709_164_800);
        assert_eq!(utc_timestamp(leap), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn generated_entries_have_a_uuid_and_a_timestamp() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("results.jsonl");
        let entry = entry_at(&path, "answer");

        assert!(Uuid::parse_str(&entry.id).is_ok());
        assert_eq!(entry.created_at.len(), 20);
        assert!(entry.created_at.ends_with('Z'));
        assert_eq!(entry.created_at.as_bytes()[4], b'-');
        assert_eq!(entry.created_at.as_bytes()[10], b'T');
    }
}
