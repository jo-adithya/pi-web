//! Stable-file half of history adoption. The runtime separately checks Pi's head
//! and its live-event revision before installing this projection.
use crate::{
    history, metadata,
    protocol::HistoryHead,
    view::{DisplayMessage, normalize_message},
};
use serde_json::json;
use std::{
    fs::{self, File},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Fingerprint(u64, u64, u64, i64, i64, i64, i64);
pub(super) fn fingerprint(path: &Path) -> Result<Fingerprint, String> {
    let stat = fs::metadata(path).map_err(|_| "History file is unavailable")?;
    Ok(Fingerprint(
        stat.dev(),
        stat.ino(),
        stat.len(),
        stat.mtime(),
        stat.mtime_nsec(),
        stat.ctime(),
        stat.ctime_nsec(),
    ))
}
#[derive(Debug)]
pub(super) struct Scan {
    pub head: HistoryHead,
    pub revision: u64,
    pub file: Option<(PathBuf, Fingerprint)>,
    pub messages: Vec<DisplayMessage>,
    pub older: bool,
}
/// Runs on a blocking worker, never the async runtime event loop. Empty/unpersisted
/// sessions are valid; malformed, changed or unbounded files produce a history-only error.
pub(super) fn scan(
    head: HistoryHead,
    revision: u64,
    roots: Vec<PathBuf>,
    cwd: PathBuf,
    images: crate::images::Images,
) -> Result<Scan, String> {
    let mut result = Scan {
        head,
        revision,
        file: None,
        messages: Vec::new(),
        older: false,
    };
    let (Some(path), Some(leaf)) = (&result.head.session_file, &result.head.leaf_id) else {
        return Ok(result);
    };
    if !Path::new(path).exists() {
        return Ok(result);
    }
    let path = metadata::validate_session(Path::new(path), &roots, &cwd)
        .map_err(|_| "History path/header validation failed")?;
    let before = fingerprint(&path)?;
    let file = File::open(&path).map_err(|_| "History file could not be opened")?;
    let projection = history::project_images(file, leaf, |entry| {
        if entry["type"] == "message" { images.project_message(&mut entry["message"]); }
        else if entry["type"] == "custom_message" { images.project_message(entry); }
    })
        .map_err(|_| "History could not be projected within safe limits")?;
    if fingerprint(&path)? != before {
        return Err("History changed while loading".into());
    }
    for entry in projection.entries {
        if let Some(message) = display_entry(entry)? {
            result.messages.push(message);
        }
    }
    result.older = projection.older_history;
    result.file = Some((path, before));
    Ok(result)
}
/// Converts the bounded projection's entries into browser presentation, preserving
/// explicit omission markers instead of silently hiding unavailable content.
fn display_entry(entry: serde_json::Value) -> Result<Option<DisplayMessage>, String> {
    let id = entry["id"]
        .as_str()
        .ok_or("History entry has no identity")?
        .to_owned();
    let message = if entry["truncated"] == true {
        json!({"role":"custom","content":"[Oversized historical entry omitted]"})
    } else if entry["type"] == "message" {
        entry["message"].clone()
    } else if entry["type"] == "compaction" || entry["type"] == "branch_summary" {
        json!({"role": if entry["type"] == "compaction" { "compactionSummary" } else { "branchSummary" }, "content": entry["summary"].as_str().unwrap_or("[History summary]")})
    } else if entry["type"] == "custom_message" {
        json!({"role":"custom", "content":entry["content"], "display":entry["display"]})
    } else {
        json!({"role":"custom","content":"[Historical entry omitted from this preview]"})
    };
    Ok(normalize_message(id, &message, true))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_message_retains_a_visible_omission_marker() {
        let value = display_entry(
            json!({"id":"large","type":"message","message":{"role":"assistant"},"truncated":true}),
        )
        .unwrap()
        .unwrap();
        assert!(
            value
                .blocks
                .iter()
                .any(|block| block.text.contains("Oversized"))
        );
    }
}
