//! Bounded, read-only projection of a stable Pi v3 session and authoritative leaf.
//! Callers own session authorization, leaf discovery, and snapshot/live-state adoption.

use serde::Serialize;

mod metadata;
use metadata::{MAX_METADATA_BYTES, read_metadata};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};

const BLOCK_BYTES: usize = 64 * 1024;
const MAX_SCAN_BYTES: u64 = 128 * 1024 * 1024;
const MAX_RECORD_BYTES: u64 = 64 * 1024;
const MAX_ENTRIES: usize = 500;
const MAX_RETAINED_BYTES: usize = 8 * 1024 * 1024;
// JSON values and object keys also consume allocations even when their text is tiny.
const MAX_RETAINED_NODES: usize = 16 * 1024;

/// Projection and scanner failures, including underlying I/O and JSON errors.
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// A bounded recent window of visible ancestors, suitable for presentation.
#[derive(Debug, Serialize)]
pub struct Projection {
    /// Presentation records in chronological order, including truncation placeholders.
    pub entries: Vec<serde_json::Value>,
    /// True when retention limits leave older ancestry outside this window.
    pub older_history: bool,
}

struct Metadata {
    kind: String,
    id: Option<String>,
    parent_id: Option<String>,
    message: Option<MessageMetadata>,
    display: Option<bool>,
    internal_notification: bool,
}

struct MessageMetadata {
    role: String,
}

/// Finds LF-delimited ranges backwards using a fixed buffer, including huge records.
/// Seeks made by a consumer between calls do not affect the saved scan position.
struct ReverseLines<R> {
    reader: R,
    block: Vec<u8>,
    block_start: u64,
    cursor: u64,
    line_end: u64,
    size: u64,
}

impl<R: Read + Seek> ReverseLines<R> {
    fn new(mut reader: R) -> Result<Self> {
        let size = reader.seek(SeekFrom::End(0))?;
        Ok(Self {
            reader,
            block: vec![],
            block_start: size,
            cursor: size,
            line_end: size,
            size,
        })
    }

    /// Returns an offset/length pair, excluding LF. Stops with an error at the scan budget.
    fn next_range(&mut self) -> Result<Option<(u64, u64)>> {
        while self.cursor > 0 {
            if self.size - self.cursor >= MAX_SCAN_BYTES {
                return Err("history scan budget exceeded".into());
            }
            if self.cursor <= self.block_start {
                let start = self.cursor.saturating_sub(BLOCK_BYTES as u64);
                self.block.resize((self.cursor - start) as usize, 0);
                self.reader.seek(SeekFrom::Start(start))?;
                self.reader.read_exact(&mut self.block)?;
                self.block_start = start;
            }
            self.cursor -= 1;
            if self.block[(self.cursor - self.block_start) as usize] == b'\n' {
                let start = self.cursor + 1;
                let length = self.line_end - start;
                self.line_end = self.cursor;
                if length > 0 {
                    return Ok(Some((start, length)));
                }
            }
        }
        if self.line_end > 0 {
            let length = self.line_end;
            self.line_end = 0;
            return Ok(Some((0, length)));
        }
        Ok(None)
    }
}

/// Counts values and object keys to bound retained allocation overhead independently
/// of serialized bytes. Input depth and per-record bytes are already bounded.
fn preview_nodes(value: &serde_json::Value) -> usize {
    1 + match value {
        serde_json::Value::Array(values) => values.iter().map(preview_nodes).sum(),
        serde_json::Value::Object(fields) => {
            fields.len() + fields.values().map(preview_nodes).sum::<usize>()
        }
        _ => 0,
    }
}

/// Keeps an oversized entry visible without retaining its payload or block structure.
fn truncated_entry(metadata: &Metadata) -> serde_json::Value {
    serde_json::json!({"id": metadata.id, "type": metadata.kind,
        "message": {"role": metadata.message.as_ref().map(|m| &m.role)},
        "truncated": true, "notice": "Historical record exceeds preview limits; original retained in Pi storage"})
}

/// Projects recent visible ancestors of `leaf` in chronological order.
/// The reader must initially be positioned at the session header. The caller must
/// hold the v3 file stable and supply Pi's current leaf, not infer it from a tail.
/// Callers detect file/head races and invalidate stale results before adoption.
/// Oversized records become explicit placeholders without parsing their full
/// payload into a Value. Metadata is validated by a bounded streaming scanner.
///
/// Selected metadata and the initial leaf are limited to 1024 decoded UTF-8 bytes
/// per string; JSON nesting is limited to 64 containers. Retention stops at 500
/// entries, 8 MiB serialized bytes, or 16,384 JSON values/object keys. One record
/// above the node budget becomes a placeholder, preserving the recent suffix.
/// Full display decoding is limited to 64 KiB per record; larger records become
/// placeholders. Reverse scanning uses 64 KiB blocks and stops at 128 MiB.
///
/// # Errors
/// Returns an error on I/O failures, malformed scanned JSON, missing ancestry,
/// unsupported headers, selected metadata/depth limits, or scan exhaustion.
pub fn project<R: Read + Seek>(mut reader: R, leaf: &str) -> Result<Projection> {
    if leaf.len() > MAX_METADATA_BYTES {
        return Err("history leaf exceeds metadata limit".into());
    }
    let mut header = Vec::new();
    BufReader::new(reader.by_ref().take(MAX_RECORD_BYTES)).read_until(b'\n', &mut header)?;
    if header.last() != Some(&b'\n') {
        return Err("missing or oversized session header".into());
    }
    let header: serde_json::Value = serde_json::from_slice(&header)?;
    if header["type"] != "session" || header["version"] != 3 {
        return Err("history requires a migrated v3 session".into());
    }
    let mut lines = ReverseLines::new(reader)?;
    let mut wanted = Some(leaf.to_owned());
    let mut entries = Vec::new();
    let mut retained = 0;
    let mut retained_nodes = 0;
    while let Some(id) = wanted.as_ref() {
        let Some((offset, length)) = lines.next_range()? else {
            break;
        };
        lines.reader.seek(SeekFrom::Start(offset))?;
        let Some(mut metadata) =
            read_metadata(BufReader::new(lines.reader.by_ref().take(length)), id)?
        else {
            continue;
        };
        if metadata.kind == "session" {
            return Err("session header is not an entry".into());
        }
        wanted = metadata.parent_id.take();
        let visible = match metadata.kind.as_str() {
            "message" => metadata
                .message
                .as_ref()
                .is_some_and(|m| !matches!(m.role.as_str(), "system" | "toolResult")),
            "custom_message" => metadata.display != Some(false) && !metadata.internal_notification,
            "compaction" | "branch_summary" => true,
            _ => false,
        };
        if !visible {
            continue;
        }
        let mut value = if length > MAX_RECORD_BYTES {
            truncated_entry(&metadata)
        } else {
            lines.reader.seek(SeekFrom::Start(offset))?;
            let mut value: serde_json::Value =
                serde_json::from_reader(BufReader::new(lines.reader.by_ref().take(length)))?;
            // Only bounded presentation fields survive; omit signatures, images and details.
            if let Some(message) = value.get_mut("message").and_then(|m| m.as_object_mut()) {
                message.retain(|k, _| matches!(k.as_str(), "role" | "content" | "errorMessage"));
                if let Some(blocks) = message.get_mut("content").and_then(|c| c.as_array_mut()) {
                    blocks.retain(|block| {
                        matches!(block["type"].as_str(), Some("text" | "thinking"))
                    });
                    for block in blocks {
                        if let Some(block) = block.as_object_mut() {
                            block.retain(|k, _| matches!(k.as_str(), "type" | "text" | "thinking"));
                        }
                    }
                }
            }
            if value["message"]["role"] == "assistant"
                && value["message"]["content"]
                    .as_array()
                    .is_some_and(Vec::is_empty)
                && !value["message"]["errorMessage"].is_string()
            {
                continue;
            }
            if let Some(entry) = value.as_object_mut() {
                entry.retain(|k, _| {
                    matches!(
                        k.as_str(),
                        "id" | "type" | "message" | "summary" | "content" | "display"
                    )
                });
            }
            value
        };
        let mut nodes = preview_nodes(&value);
        if nodes > MAX_RETAINED_NODES {
            value = truncated_entry(&metadata);
            nodes = preview_nodes(&value);
        }
        let bytes = serde_json::to_vec(&value)?.len();
        if retained + bytes > MAX_RETAINED_BYTES || retained_nodes + nodes > MAX_RETAINED_NODES {
            entries.reverse();
            return Ok(Projection {
                entries,
                older_history: true,
            });
        }
        retained += bytes;
        retained_nodes += nodes;
        entries.push(value);
        if entries.len() == MAX_ENTRIES {
            break;
        }
    }
    if wanted.is_some() && entries.len() < MAX_ENTRIES {
        return Err("active ancestor missing from session file".into());
    }
    entries.reverse();
    Ok(Projection {
        entries,
        older_history: wanted.is_some(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn fixture(entries: &[serde_json::Value]) -> Vec<u8> {
        let mut bytes = b"{\"type\":\"session\",\"version\":3,\"id\":\"s\"}\n".to_vec();
        for entry in entries {
            serde_json::to_writer(&mut bytes, entry).unwrap();
            bytes.push(b'\n');
        }
        bytes
    }

    fn message(id: &str, parent: Option<&str>, text: &str) -> serde_json::Value {
        serde_json::json!({"type":"message", "id":id, "parentId":parent,
            "message":{"role":"user", "content":text}})
    }

    #[test]
    fn retains_summaries_and_original_text_but_hides_context_operations() {
        let file = fixture(&[
            message("a", None, "original historical text"),
            serde_json::json!({"type":"context_edit","id":"edit","parentId":"a", "details":{"replacement":"new model input"}}),
            serde_json::json!({"type":"compaction","id":"compact","parentId":"edit","summary":"checkpoint"}),
            serde_json::json!({"type":"custom_message","id":"hidden","parentId":"compact","display":false,"content":"hidden"}),
            serde_json::json!({"type":"branch_summary","id":"branch","parentId":"hidden","summary":"branch marker"}),
        ]);
        let result = project(Cursor::new(file), "branch").unwrap();
        assert_eq!(result.entries.len(), 3);
        assert_eq!(
            result.entries[0]["message"]["content"],
            "original historical text"
        );
        assert_eq!(result.entries[1]["summary"], "checkpoint");
        assert_eq!(result.entries[2]["summary"], "branch marker");
    }

    #[test]
    fn internal_task_notifications_are_hidden_without_breaking_ancestry() {
        let text = "<task-notification><status>Done</status></task-notification>";
        for content in [text.to_owned(), "x".repeat(BLOCK_BYTES * 4)] {
            let file = fixture(&[
                message("user", None, text),
                serde_json::json!({"type":"custom_message","id":"task","parentId":"user",
                    "customType":"subagent-notification","display":true,"content":content}),
                serde_json::json!({"type":"custom_message","id":"ordinary","parentId":"task",
                    "customType":"ordinary-extension","display":true,"content":text}),
            ]);
            let result = project(Cursor::new(file), "ordinary").unwrap();
            assert_eq!(result.entries.len(), 2);
            assert_eq!(result.entries[0]["id"], "user");
            assert_eq!(result.entries[0]["message"]["content"], text);
            assert_eq!(result.entries[1]["id"], "ordinary");
            assert_eq!(result.entries[1]["content"], text);
            assert!(!result.older_history);
        }
    }

    #[test]
    fn oversized_record_keeps_ancestry_and_a_visible_placeholder() {
        let file = fixture(&[
            message("a", None, "older"),
            message("b", Some("a"), &"x".repeat(BLOCK_BYTES * 4)),
        ]);
        let result = project(Cursor::new(file), "b").unwrap();
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[1]["truncated"], true);
        assert_eq!(result.entries[1]["id"], "b");
        assert!(serde_json::to_vec(&result).unwrap().len() < 1024);
    }

    #[test]
    fn entry_budget_keeps_latest_500_with_an_older_history_marker() {
        let entries: Vec<_> = (0..501)
            .map(|i| {
                message(
                    &i.to_string(),
                    (i > 0).then(|| (i - 1).to_string()).as_deref(),
                    "small",
                )
            })
            .collect();
        let result = project(Cursor::new(fixture(&entries)), "500").unwrap();
        assert_eq!(result.entries.len(), MAX_ENTRIES);
        assert_eq!(result.entries[0]["id"], "1");
        assert_eq!(result.entries[499]["id"], "500");
        assert!(result.older_history);
    }

    #[test]
    fn byte_budget_retains_a_contiguous_recent_suffix() {
        let text = "x".repeat(60 * 1024);
        let entries: Vec<_> = (0..150)
            .map(|i| {
                message(
                    &i.to_string(),
                    (i > 0).then(|| (i - 1).to_string()).as_deref(),
                    &text,
                )
            })
            .collect();
        let result = project(Cursor::new(fixture(&entries)), "149").unwrap();
        assert!(!result.entries.is_empty());
        assert!(result.entries.len() < 150);
        assert_eq!(result.entries.last().unwrap()["id"], "149");
        assert!(result.older_history);
        assert!(
            result
                .entries
                .iter()
                .map(|e| serde_json::to_vec(e).unwrap().len())
                .sum::<usize>()
                <= MAX_RETAINED_BYTES
        );
    }

    #[test]
    fn malformed_missing_ancestry_and_unmigrated_history_fail_explicitly() {
        for file in [
            b"{\"type\":\"session\",\"version\":2}\n".to_vec(),
            fixture(&[message("a", Some("missing"), "bad ancestry")]),
            fixture(&[message("a", Some("a"), "cycle")]),
            b"{\"type\":\"session\",\"version\":3}\n{broken}\n".to_vec(),
        ] {
            assert!(project(Cursor::new(file), "a").is_err());
        }
    }

    #[test]
    fn framing_preserves_unicode_crlf_and_nonterminated_last_record() {
        let bytes = fixture(&[message("a", None, "🌍\noriginal\rtext")]);
        let mut file = String::from_utf8(bytes).unwrap().replace('\n', "\r\n");
        file.truncate(file.len() - 2);
        let result = project(Cursor::new(file), "a").unwrap();
        assert_eq!(
            result.entries[0]["message"]["content"],
            "🌍\noriginal\rtext"
        );
    }

    #[test]
    fn omits_tool_history_and_oversized_results_without_losing_ancestors() {
        let file = fixture(&[
            message("a", None, "visible ancestor"),
            serde_json::json!({"type":"message","id":"b","parentId":"a",
                "message":{"role":"assistant","content":[{"type":"toolCall","id":"secret","name":"secret","arguments":{"secret":true}}]}}),
            serde_json::json!({"type":"message","id":"c","parentId":"b",
                "message":{"role":"toolResult","content":"secret".repeat(BLOCK_BYTES)}}),
            serde_json::json!({"type":"message","id":"d","parentId":"c",
                "message":{"role":"assistant","errorMessage":"failed","content":[{"type":"toolCall","name":"secret"}]}}),
        ]);
        let result = project(Cursor::new(file), "d").unwrap();
        assert_eq!(result.entries.len(), 2);
        assert_eq!(result.entries[0]["id"], "a");
        assert_eq!(result.entries[1]["message"]["errorMessage"], "failed");
        assert!(!serde_json::to_string(&result).unwrap().contains("secret"));
        assert!(!result.older_history);
    }

    #[test]
    fn removes_provider_signatures_and_image_data() {
        let file = fixture(&[
            serde_json::json!({"type":"message","id":"a","parentId":null,
            "message":{"role":"assistant","provider":"private", "content":[
                {"type":"text","text":"visible","textSignature":"signature"},
                {"type":"image","data":"secret-base64"}]}}),
        ]);
        let result = project(Cursor::new(file), "a").unwrap();
        assert_eq!(
            result.entries[0]["message"],
            serde_json::json!({"role":"assistant","content":[{"type":"text","text":"visible"}]})
        );
    }

    #[test]
    fn follows_ancestry_instead_of_the_file_tail() {
        let file = concat!(
            "{\"type\":\"session\",\"version\":3,\"id\":\"s\"}\n",
            "{\"type\":\"message\",\"id\":\"a\",\"parentId\":null,\"message\":{\"role\":\"user\",\"content\":\"original\"}}\n",
            "{\"type\":\"message\",\"id\":\"abandoned\",\"parentId\":\"a\",\"message\":{\"role\":\"assistant\",\"content\":[]}}\n",
            "{\"type\":\"message\",\"id\":\"b\",\"parentId\":\"a\",\"message\":{\"role\":\"assistant\",\"content\":[]}}\n"
        );
        let result = project(Cursor::new(file), "b").unwrap();
        let ids: Vec<_> = result
            .entries
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["a"]);
        assert_eq!(result.entries[0]["message"]["content"], "original");
        assert!(!result.older_history);
        let result = project(Cursor::new(file), "a").unwrap();
        assert_eq!(result.entries.len(), 1);
        assert_eq!(result.entries[0]["id"], "a");
    }
}

#[cfg(test)]
mod limits_tests;
