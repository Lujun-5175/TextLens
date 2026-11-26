//! Per-request audit log.
//!
//! The app spends the user's own API budget and, until now, kept no record of
//! what was sent where. This writes one line per finished request (success or
//! failure) so the user can answer "what did it actually do?".
//!
//! Deliberately narrow: metadata only. No prompt text, no answer text, no API
//! key, no request body — the selection text already lives in the result
//! history when the user opted into keeping it.

use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

pub(crate) const REQUEST_LOG_LIMIT: usize = 500;
pub(crate) const DEFAULT_LIST_LIMIT: usize = 100;

static LOG_IO_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestLogEntry {
    /// UTC ISO-8601, matching the result history format.
    pub created_at: String,
    pub action_name: String,
    pub provider_name: String,
    pub model_id: String,
    /// Host only: the user cares which service received the text, not the path.
    pub endpoint_host: String,
    pub character_count: u64,
    /// `completed` / `failed` / `cancelled`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u64>,
}

pub(crate) fn log_path(config_dir: &Path) -> PathBuf {
    config_dir.join("requests.jsonl")
}

/// Best-effort: a logging failure must never disturb a request.
pub(crate) fn record(path: &Path, entry: RequestLogEntry) {
    let _guard = LOG_IO_LOCK.lock();
    if let Err(error) = append_locked(path, entry) {
        eprintln!("failed to append request log: {error}");
    }
}

#[derive(Debug, Default)]
pub(crate) struct RequestLogRead {
    pub entries: Vec<RequestLogEntry>,
    pub skipped_lines: usize,
}

/// Newest first, capped at `limit`.
pub(crate) fn list_recent(path: &Path, limit: usize) -> io::Result<RequestLogRead> {
    let _guard = LOG_IO_LOCK.lock();
    let mut read = read_entries(path)?;
    read.entries.reverse();
    read.entries.truncate(limit.clamp(1, REQUEST_LOG_LIMIT));
    Ok(read)
}

pub(crate) fn clear(path: &Path) -> io::Result<()> {
    let _guard = LOG_IO_LOCK.lock();
    if !path.exists() {
        return Ok(());
    }
    replace_atomically(path, b"")
}

fn read_entries(path: &Path) -> io::Result<RequestLogRead> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(RequestLogRead::default())
        }
        Err(error) => return Err(error),
    };
    let mut read = RequestLogRead::default();
    for line in raw.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match std::str::from_utf8(line)
            .ok()
            .and_then(|line| serde_json::from_str::<RequestLogEntry>(line.trim()).ok())
        {
            Some(entry) => read.entries.push(entry),
            None => read.skipped_lines += 1,
        }
    }
    Ok(read)
}

fn append_locked(path: &Path, entry: RequestLogEntry) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let existing = read_entries(path)?.entries;
    if existing.len() >= REQUEST_LOG_LIMIT {
        let mut entries = existing;
        entries.push(entry);
        entries.drain(..entries.len() - REQUEST_LOG_LIMIT);
        let mut body = String::new();
        for entry in &entries {
            body.push_str(&serde_json::to_string(entry).map_err(io::Error::other)?);
            body.push('\n');
        }
        return replace_atomically(path, body.as_bytes());
    }
    let mut line = serde_json::to_string(&entry).map_err(io::Error::other)?;
    line.push('\n');
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .read(true)
        .open(path)?;
    // Close a partial trailing line left by a crash before appending.
    let length = file.metadata()?.len();
    if length > 0 {
        let mut last = [0u8; 1];
        file.seek(SeekFrom::Start(length - 1))?;
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            file.write_all(b"\n")?;
        }
    }
    file.write_all(line.as_bytes())
}

fn replace_atomically(path: &Path, body: &[u8]) -> io::Result<()> {
    let replacement = path.with_extension("jsonl.next");
    fs::write(&replacement, body)?;
    match crate::settings::atomic_file::replace_file(&replacement, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&replacement);
            Err(error)
        }
    }
}

pub(crate) fn now_iso8601() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (year, month, day, hour, minute, second) = civil_from_unix(seconds);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Days-from-civil inverse (Howard Hinnant's algorithm), UTC only.
fn civil_from_unix(seconds: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (seconds / 86_400) as i64;
    let remainder = seconds % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if month <= 2 { year + 1 } else { year };
    (
        year,
        month,
        day,
        (remainder / 3_600) as u32,
        ((remainder % 3_600) / 60) as u32,
        (remainder % 60) as u32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(index: u64) -> RequestLogEntry {
        RequestLogEntry {
            created_at: format!("2026-11-26T08:{index:02}:00Z"),
            action_name: "翻译".to_owned(),
            provider_name: "DeepSeek".to_owned(),
            model_id: "deepseek-flash".to_owned(),
            endpoint_host: "api.deepseek.com".to_owned(),
            character_count: 123,
            status: "completed".to_owned(),
            error_code: None,
            total_tokens: Some(456),
        }
    }

    #[test]
    fn keeps_only_the_newest_entries_after_the_ring_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = log_path(directory.path());
        for index in 0..(REQUEST_LOG_LIMIT as u64 + 5) {
            record(&path, entry(index % 60));
        }
        let read = read_entries(&path).unwrap();
        assert_eq!(read.entries.len(), REQUEST_LOG_LIMIT);
        assert_eq!(read.skipped_lines, 0);
        // Oldest five were dropped from the front.
        assert_eq!(
            read.entries.first().unwrap().created_at,
            entry(5).created_at
        );
    }

    #[test]
    fn lists_newest_first_and_skips_corrupt_lines() {
        let directory = tempfile::tempdir().unwrap();
        let path = log_path(directory.path());
        record(&path, entry(1));
        record(&path, entry(2));
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{not json\n").unwrap();
        drop(file);

        let listed = list_recent(&path, 10).unwrap();
        assert_eq!(listed.entries.len(), 2);
        assert_eq!(listed.skipped_lines, 1);
        assert_eq!(listed.entries[0].created_at, entry(2).created_at);
        assert_eq!(listed.entries[1].created_at, entry(1).created_at);
    }

    #[test]
    fn a_missing_file_reads_as_empty_and_clear_is_idempotent() {
        let directory = tempfile::tempdir().unwrap();
        let path = log_path(directory.path());
        assert!(list_recent(&path, 10).unwrap().entries.is_empty());
        clear(&path).unwrap();
        record(&path, entry(1));
        clear(&path).unwrap();
        assert!(read_entries(&path).unwrap().entries.is_empty());
    }

    #[test]
    fn timestamps_are_iso8601_utc() {
        assert_eq!(now_iso8601().len(), 20);
        // Known reference points rather than hand-computed ones.
        assert_eq!(civil_from_unix(1_700_000_000), (2023, 11, 14, 22, 13, 20));
        assert_eq!(civil_from_unix(0), (1970, 1, 1, 0, 0, 0));
        assert_eq!(civil_from_unix(951_782_400), (2000, 2, 29, 0, 0, 0));
    }
}
