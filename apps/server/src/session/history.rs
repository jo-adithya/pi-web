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
    let projection = history::project_page_images(file, leaf, 0, |entry| {
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
    result.older = projection.older_cursor.is_some();
    result.file = Some((path, before));
    Ok(result)
}
pub(super) struct ReadScan {
    pub head: HistoryHead,
    pub revision: u64,
    pub file: (PathBuf, Fingerprint),
    pub response: crate::protocol::HistoryResponse,
    pub strict: bool,
}

/// Reads one replacement page on a blocking worker, scoped to the validated Pi file.
pub(super) fn read(
    head: HistoryHead, revision: u64, epoch: String, roots: Vec<PathBuf>, cwd: PathBuf,
    images: crate::images::Images, formatter: crate::response_format::Formatter,
    request: crate::protocol::HistoryRequest, skip: usize,
) -> Result<ReadScan, String> {
    use crate::protocol::{HistoryRequest, HistoryResponse};
    let path = head.session_file.as_deref().ok_or("No saved history is available")?;
    let latest = head.leaf_id.as_deref().ok_or("No saved history is available")?;
    let path = metadata::validate_session(Path::new(path), &roots, &cwd).map_err(|_| "History path/header validation failed")?;
    let before = fingerprint(&path)?;
    let cursor = match &request { HistoryRequest::Page { cursor, .. } | HistoryRequest::Original { cursor, .. } => cursor.as_deref().unwrap_or(latest) };
    let file = File::open(&path).map_err(|_| "History file is unavailable")?;
    let project = |entry: &mut serde_json::Value| {
        if entry["type"] == "message" { images.project_message(&mut entry["message"]); }
        else if entry["type"] == "custom_message" { images.project_message(entry); }
    };
    let resumed = match &request { HistoryRequest::Page { cursor, .. } | HistoryRequest::Original { cursor, .. } => cursor.is_some() };
    let page = if resumed { history::resume_page_images(file, cursor, project) } else { history::project_page_images(file, cursor, skip, project) }
        .map_err(|_| "History page could not be read within safe limits")?;
    if fingerprint(&path)? != before { return Err("History changed while loading; try again".into()); }
    let strict = matches!(&request, HistoryRequest::Page { cursor: None, .. });
    let response = match request {
        HistoryRequest::Original { source_key, .. } => {
            let text = formatter.original_text(&page.entries, &source_key, page.older_cursor.is_some()).map_err(str::to_owned)?;
            HistoryResponse::Original { epoch, text }
        }
        HistoryRequest::Page { .. } => {
            let mut messages = Vec::new();
            for entry in page.entries { if let Some(message) = display_entry(entry)? { messages.push(message); } }
            formatter.restore(&mut messages, page.older_cursor.is_some());
            for message in &mut messages {
                if let Some(crate::response_format::ResponsePresentation::Error { message, retryable, .. }) = &mut message.presentation {
                    *retryable = false;
                    if message == "This saved reply has not been simplified. Retry or choose Original." { *message = "This saved reply has not been simplified. View Original.".into(); }
                }
            }
            crate::view::compact_ready(&mut messages, page.older_cursor.is_some());
            if serde_json::to_vec(&messages).map_err(|_| "History serialization failed")?.len() > crate::view::MAX_DISPLAY_BYTES { return Err("This page exceeds the display memory budget".into()); }
            HistoryResponse::Page { epoch, cursor: page.cursor.ok_or("No earlier exchanges are available")?, latest_cursor: latest.to_owned(), older_cursor: page.older_cursor, messages }
        }
    };
    Ok(ReadScan { head, revision, file: (path, before), response, strict })
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
