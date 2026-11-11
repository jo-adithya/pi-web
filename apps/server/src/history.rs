//! Bounded, read-only projection of a stable Pi v3 session and authoritative leaf.
//! Callers own session authorization, leaf discovery, and snapshot/live-state adoption.

use serde::Serialize;

mod metadata;
mod bounded_value;
use serde::de::DeserializeSeed;
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

/// One bounded exchange page with opaque ancestry cursors and explicit omission markers.
pub struct Page {
    pub entries: Vec<serde_json::Value>,
    pub cursor: Option<String>,
    pub older_cursor: Option<String>,
}

/// Reads at most ten exchanges from a Pi-owned ancestry cursor. `skip` is used
/// only when moving from the live view to its first older page.
pub fn project_page_images<R: Read + Seek>(reader: R, leaf: &str, skip: usize, project: impl FnMut(&mut serde_json::Value)) -> Result<Page> {
    project_inner(reader, leaf, 8 * 1024 * 1024, true, Some(skip), None, project)
}

/// Resumes at a server-issued byte/ancestry cursor, so older pages do not rescan the file tail.
pub fn resume_page_images<R: Read + Seek>(reader: R, cursor: &str, project: impl FnMut(&mut serde_json::Value)) -> Result<Page> {
    let mut fields = cursor.splitn(3, ':');
    if fields.next() != Some("p1") { return Err("invalid history cursor".into()); }
    let end = fields.next().ok_or("invalid history cursor")?.parse::<u64>()?;
    let leaf = fields.next().filter(|leaf| !leaf.is_empty()).ok_or("invalid history cursor")?;
    project_inner(reader, leaf, 8 * 1024 * 1024, true, Some(0), Some(end), project)
}
fn page_cursor(end: u64, id: &str) -> String { format!("p1:{end}:{id}") }

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
pub fn project<R: Read + Seek>(reader: R, leaf: &str) -> Result<Projection> {
    project_inner(reader, leaf, MAX_RECORD_BYTES, false, None, None, |_| {}).map(|page| Projection { older_history: page.older_cursor.is_some(), entries: page.entries })
}

/// Reconstructs image references from bounded persisted records before retention.
/// One record may be up to 8 MiB, with 16,384 allocation nodes enforced during
/// decoding; projected records still obey the existing 64 KiB preview limit.
pub fn project_images<R: Read + Seek>(reader: R, leaf: &str, project: impl FnMut(&mut serde_json::Value)) -> Result<Projection> {
    project_inner(reader, leaf, 8 * 1024 * 1024, true, None, None, project).map(|page| Projection { older_history: page.older_cursor.is_some(), entries: page.entries })
}

fn project_inner<R: Read + Seek>(mut reader: R, leaf: &str, record_limit: u64, images: bool, page_skip: Option<usize>, end: Option<u64>, mut project: impl FnMut(&mut serde_json::Value)) -> Result<Page> {
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
    if let Some(end) = end {
        if end == 0 || end > lines.size { return Err("history cursor is outside the file".into()); }
        lines.size = end; lines.cursor = end; lines.line_end = end; lines.block_start = end;
    }
    let mut last_offset = 0;
    let mut wanted = Some(leaf.to_owned());
    let mut entries = Vec::new();
    let mut retained = 0;
    let mut retained_nodes = 0;
    let mut skipped = 0;
    let mut exchanges = 0;
    let mut cursor = None;
    let mut stopped = false;
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
        last_offset = offset;
        let user = metadata.kind == "message" && metadata.message.as_ref().is_some_and(|message| message.role == "user");
        if page_skip.is_some_and(|skip| skipped < skip) {
            if user { skipped += 1; }
            continue;
        }
        if cursor.is_none() { cursor = metadata.id.as_deref().map(|id| page_cursor(offset + length, id)); }
        let visible = match metadata.kind.as_str() {
            "message" => metadata
                .message
                .as_ref()
                .is_some_and(|m| m.role != "system" && (images || m.role != "toolResult")),
            "custom_message" => metadata.display != Some(false) && !metadata.internal_notification,
            "compaction" | "branch_summary" => true,
            _ => false,
        };
        if !visible {
            continue;
        }
        let mut value = if length > record_limit {
            truncated_entry(&metadata)
        } else {
            lines.reader.seek(SeekFrom::Start(offset))?;
            let mut budget = MAX_RETAINED_NODES;
            let mut decoder = serde_json::Deserializer::from_reader(BufReader::new(lines.reader.by_ref().take(length)));
            let mut value = bounded_value::BoundedValue(&mut budget).deserialize(&mut decoder).unwrap_or_else(|_| truncated_entry(&metadata));
            if value["message"]["role"] == "custom" && (value["message"]["display"] == false || value["message"]["customType"] == "subagent-notification") { continue; }
            project(&mut value);
            // Only bounded presentation fields survive; omit signatures, images and details.
            if let Some(message) = value.get_mut("message").and_then(|m| m.as_object_mut()) {
                // The SDK timestamp keeps restored replies linked to their saved presentations.
                message.retain(|k, _| matches!(k.as_str(), "role" | "content" | "errorMessage" | "timestamp"));
                if let Some(blocks) = message.get_mut("content").and_then(|c| c.as_array_mut()) {
                    blocks.retain(|block| {
                        matches!(block["type"].as_str(), Some("text" | "thinking" | "image_ref" | "image_unavailable"))
                    });
                    for block in blocks {
                        if let Some(block) = block.as_object_mut() {
                            block.retain(|k, _| matches!(k.as_str(), "type" | "text" | "thinking" | "ref"));
                        }
                    }
                }
            }
            if value["message"]["role"] == "toolResult" {
                if let Some(blocks) = value["message"]["content"].as_array_mut() {
                    blocks.retain(|block| matches!(block["type"].as_str(), Some("image_ref" | "image_unavailable")));
                }
                if value["message"]["content"].as_array().is_none_or(Vec::is_empty) { continue; }
                if let Some(message) = value["message"].as_object_mut() { message.remove("errorMessage"); }
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
                        "id" | "type" | "message" | "summary" | "content" | "display" | "truncated" | "notice"
                    )
                });
            }
            value
        };
        if images && metadata.message.as_ref().is_some_and(|m| m.role == "toolResult") && value["truncated"] == true { continue; }
        let mut nodes = preview_nodes(&value);
        if nodes > MAX_RETAINED_NODES || serde_json::to_vec(&value)?.len() > MAX_RECORD_BYTES as usize {
            value = truncated_entry(&metadata);
            nodes = preview_nodes(&value);
        }
        let bytes = serde_json::to_vec(&value)?.len();
        if retained + bytes > MAX_RETAINED_BYTES || retained_nodes + nodes > MAX_RETAINED_NODES {
            entries.reverse();
            return Ok(Page { entries, cursor, older_cursor: metadata.id.as_deref().map(|id| page_cursor(offset + length, id)) });
        }
        retained += bytes;
        retained_nodes += nodes;
        entries.push(value);
        if user { exchanges += 1; }
        if entries.len() == MAX_ENTRIES || page_skip.is_some() && exchanges == 10 {
            stopped = true;
            break;
        }
    }
    if wanted.is_some() && !stopped {
        return Err("active ancestor missing from session file".into());
    }
    entries.reverse();
    Ok(Page { entries, cursor, older_cursor: wanted.as_deref().map(|id| page_cursor(last_offset, id)) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn history_pages_replace_ten_exchanges_and_resume_without_gaps() {
        let mut file = String::from("{\"type\":\"session\",\"version\":3}\n");
        let mut parent: Option<String> = None;
        for index in 0..45 {
            for role in ["user", "assistant", "assistant"] {
                let id = format!("{index}-{role}-{}", parent.as_deref().unwrap_or("root").len());
                file.push_str(&serde_json::json!({"type":"message","id":id,"parentId":parent,"message":{"role":role,"content":format!("{index}: {role}")}}).to_string());
                file.push('\n'); parent = Some(id);
            }
        }
        let latest = project_page_images(Cursor::new(&file), parent.as_deref().unwrap(), 0, |_| {}).unwrap();
        assert_eq!(latest.entries.iter().filter(|entry| entry["message"]["role"] == "user").count(), 10);
        assert_eq!(latest.entries[0]["message"]["content"], "35: user");
        let older = resume_page_images(Cursor::new(&file), latest.older_cursor.as_deref().unwrap(), |_| {}).unwrap();
        assert_eq!(older.entries[0]["message"]["content"], "25: user");
        let middle = resume_page_images(Cursor::new(&file), older.older_cursor.as_deref().unwrap(), |_| {}).unwrap();
        assert_eq!(middle.entries[0]["message"]["content"], "15: user");
        let earlier = resume_page_images(Cursor::new(&file), middle.older_cursor.as_deref().unwrap(), |_| {}).unwrap();
        assert_eq!(earlier.entries[0]["message"]["content"], "5: user");
        let first = resume_page_images(Cursor::new(&file), earlier.older_cursor.as_deref().unwrap(), |_| {}).unwrap();
        assert_eq!(first.entries.len(), 15);
        assert!(first.older_cursor.is_none());
        let skipped = project_page_images(Cursor::new(&file), parent.as_deref().unwrap(), 10, |_| {}).unwrap();
        assert_eq!(skipped.entries, older.entries);
        struct PrefixReader { data: Cursor<Vec<u8>>, prefix: u64 }
        impl Read for PrefixReader {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                let remaining = self.prefix.saturating_sub(self.data.position()) as usize;
                if remaining == 0 { return Err(std::io::Error::other("cursor rescanned the unrelated tail")); }
                let size = output.len().min(remaining);
                self.data.read(&mut output[..size])
            }
        }
        impl Seek for PrefixReader {
            fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> { self.data.seek(position) }
        }
        let mut extended = file.as_bytes().to_vec(); extended.extend(vec![b'x'; 128 * 1024]);
        let reader = PrefixReader { data: Cursor::new(extended), prefix: file.len() as u64 };
        assert_eq!(resume_page_images(reader, older.cursor.as_deref().unwrap(), |_| {}).unwrap().entries, older.entries);
    }

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
