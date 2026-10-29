use super::*;
use std::io::Cursor;

#[test]
fn partial_appends_fail_without_returning_an_incomplete_projection() {
    let stable = concat!(
        "{\"type\":\"session\",\"version\":3}\n",
        "{\"type\":\"compaction\",\"id\":\"a\",\"parentId\":null}\n"
    );
    let incomplete = format!("{stable}{{\"type\":\"compaction\",\"id\":\"b\",\"parentId\":");
    assert!(project(Cursor::new(&incomplete), "a").is_err());
    assert!(project(Cursor::new(&incomplete), "b").is_err());
    let complete = format!("{incomplete}\"a\"}}\n");
    let projection = project(Cursor::new(complete), "b").unwrap();
    assert_eq!(projection.entries.len(), 2);
    assert_eq!(projection.entries[1]["id"], "b");
}

#[test]
fn a_not_yet_persisted_leaf_fails_instead_of_guessing_the_file_tail() {
    let file = concat!(
        "{\"type\":\"session\",\"version\":3}\n",
        "{\"type\":\"compaction\",\"id\":\"old\",\"parentId\":null}\n"
    );
    let error = project(Cursor::new(file), "new").unwrap_err();
    assert_eq!(
        error.to_string(),
        "active ancestor missing from session file"
    );
}

#[test]
fn scan_exhaustion_uses_fixed_memory_and_stops_at_the_byte_budget() {
    struct SparseHistory {
        position: u64,
        bytes_read: u64,
    }
    impl Read for SparseHistory {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            buffer.fill(b' ');
            self.position += buffer.len() as u64;
            self.bytes_read += buffer.len() as u64;
            Ok(buffer.len())
        }
    }
    impl Seek for SparseHistory {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.position = match position {
                SeekFrom::Start(offset) => offset,
                SeekFrom::End(offset) => (MAX_SCAN_BYTES + BLOCK_BYTES as u64)
                    .checked_add_signed(offset)
                    .unwrap(),
                SeekFrom::Current(offset) => self.position.checked_add_signed(offset).unwrap(),
            };
            Ok(self.position)
        }
    }
    let mut lines = ReverseLines::new(SparseHistory {
        position: 0,
        bytes_read: 0,
    })
    .unwrap();
    assert_eq!(
        lines.next_range().unwrap_err().to_string(),
        "history scan budget exceeded"
    );
    assert_eq!(lines.reader.bytes_read, MAX_SCAN_BYTES);
    assert_eq!(lines.block.len(), BLOCK_BYTES);
}

#[test]
fn dense_previews_cannot_exhaust_retention_with_decoded_objects() {
    let entries: Vec<_> = (0..12)
        .map(|i| {
            serde_json::json!({"type":"message","id":i.to_string(),
                "parentId":(i > 0).then(|| (i - 1).to_string()),
                "message":{"role":"user","content":vec![serde_json::json!({"type":"text","text":"x"}); 2000]}})
        })
        .collect();
    let mut file = b"{\"type\":\"session\",\"version\":3}\n".to_vec();
    for entry in &entries {
        serde_json::to_writer(&mut file, entry).unwrap();
        file.push(b'\n');
    }
    let result = project(Cursor::new(file), "11").unwrap();
    assert!(!result.entries.is_empty());
    assert!(result.entries.len() < entries.len());
    assert_eq!(result.entries.last().unwrap()["id"], "11");
    assert!(result.older_history);
    assert!(result.entries.iter().map(preview_nodes).sum::<usize>() <= MAX_RETAINED_NODES);
}

#[test]
fn single_overcomplex_preview_is_visible_as_a_placeholder() {
    // Adversarial presentation data remains bounded even before a typed DTO exists.
    let entry = serde_json::json!({"type":"custom_message","id":"leaf","parentId":null,
        "content":vec![serde_json::json!([]); MAX_RETAINED_NODES]});
    let mut file = b"{\"type\":\"session\",\"version\":3}\n".to_vec();
    let encoded = serde_json::to_vec(&entry).unwrap();
    assert!(encoded.len() < MAX_RECORD_BYTES as usize);
    file.extend(encoded);
    file.push(b'\n');
    let result = project(Cursor::new(file), "leaf").unwrap();
    assert_eq!(result.entries.len(), 1);
    assert_eq!(result.entries[0]["truncated"], true);
    assert_eq!(result.entries[0]["id"], "leaf");
    assert!(!result.older_history);
    assert!(preview_nodes(&result.entries[0]) <= MAX_RETAINED_NODES);
}

#[test]
fn stops_reading_older_records_when_selected_ancestry_is_complete() {
    struct GuardedHistory(Cursor<Vec<u8>>);
    impl Read for GuardedHistory {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let position = self.0.position();
            if position > BLOCK_BYTES as u64
                && position < (self.0.get_ref().len() - BLOCK_BYTES) as u64
            {
                return Err(std::io::Error::other("unnecessary older-history read"));
            }
            self.0.read(buffer)
        }
    }
    impl Seek for GuardedHistory {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.0.seek(position)
        }
    }
    let file = format!(
        "{{\"type\":\"session\",\"version\":3}}\n{{\"type\":\"custom\",\"data\":\"{}\"}}\n{{\"type\":\"compaction\",\"id\":\"root\",\"parentId\":null}}\n",
        "x".repeat(4 * BLOCK_BYTES)
    );
    let result = project(GuardedHistory(Cursor::new(file.into_bytes())), "root").unwrap();
    assert_eq!(result.entries.len(), 1);
    assert!(!result.older_history);
}

#[test]
fn rejects_oversized_initial_leaf() {
    let leaf = "x".repeat(1025);
    let file = format!(
        "{{\"type\":\"session\",\"version\":3}}\n{{\"type\":\"compaction\",\"id\":\"{leaf}\",\"parentId\":null}}\n"
    );
    assert!(project(Cursor::new(file), &leaf).is_err());
}

#[test]
fn skips_abandoned_oversized_id_and_preserves_selected_ancestry() {
    let abandoned = "x".repeat(256 * 1024);
    let file = format!(
        concat!(
            "{{\"type\":\"session\",\"version\":3}}\n",
            "{{\"type\":\"compaction\",\"id\":\"root\",\"parentId\":null}}\n",
            "{{\"type\":\"message\",\"id\":\"{}\",\"parentId\":\"root\",\"message\":{{\"role\":\"user\"}}}}\n",
            "{{\"type\":\"compaction\",\"id\":\"leaf\",\"parentId\":\"root\"}}\n"
        ),
        abandoned
    );
    let result = project(Cursor::new(file), "leaf").unwrap();
    assert_eq!(result.entries.len(), 2);
    assert_eq!(result.entries[0]["id"], "root");
    assert_eq!(result.entries[1]["id"], "leaf");
}
