//! Bounded Git-only expansion of unchanged text in a verified review snapshot.
use crate::local_review::{Git, Scope, fingerprint, prepare, validate_path};
use serde::{Deserialize, Serialize};
use std::{collections::VecDeque, path::Path, sync::Mutex, time::Duration};
use tokio::{sync::oneshot, time::Instant};

const UNAVAILABLE: &str = "Text context unavailable";
const STALE: &str = "File snapshot changed; refresh review";
const RANGE: &str = "Invalid text context range";

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Request {
    scope: Scope,
    base: Option<String>,
    commit: Option<String>,
    path: String,
    fingerprint: String,
    old_start: i64,
    new_start: i64,
    count: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Review {
    old_start: i64,
    new_start: i64,
    lines: Vec<String>,
    has_more: bool,
    /// The final returned context line is the file's unterminated final line.
    no_newline: bool,
}

/// Server-owned expanded patches, isolated by root, resolved scope, path and verified patch.
/// Accounts for allocated key/content capacity and entry storage within 4 MiB.
#[derive(Default)]
pub(crate) struct Cache {
    entries: VecDeque<(String, String)>,
    bytes: usize,
}
impl Cache {
    fn get(&self, key: &str) -> Option<String> {
        self.entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    }
    fn insert(&mut self, key: String, patch: String) {
        let size = key.capacity() + patch.capacity();
        while self.entries.len() >= 4
            || self.bytes + size + 4 * std::mem::size_of::<(String, String)>() > 4 * 1024 * 1024
        {
            let Some((k, v)) = self.entries.pop_front() else {
                return;
            };
            self.bytes -= k.capacity() + v.capacity();
        }
        self.bytes += size;
        self.entries.push_back((key, patch));
    }
}

/// Verifies tracked membership and content identity around a bounded expanded Git diff.
/// Like local review, this is a best-effort, non-atomic snapshot: concurrent edits can
/// occur between Git commands. Identity comparison and a final fingerprint check reject
/// observed changes; cancellation retains admission until Git has been killed and reaped.
pub(crate) async fn review(
    root: &Path,
    request: Request,
    mut cancelled: oneshot::Receiver<()>,
    cache: &Mutex<Cache>,
) -> Result<Review, &'static str> {
    validate_path(&request.path)?;
    if !(1..=1_000_000).contains(&request.old_start)
        || !(1..=1_000_000).contains(&request.new_start)
        || !(1..=20).contains(&request.count)
    {
        return Err(RANGE);
    }
    let mut git = Git {
        root,
        deadline: Instant::now() + Duration::from_secs(5),
        cancelled: &mut cancelled,
    };
    let args = prepare(
        &mut git,
        &crate::local_review::Request {
            scope: request.scope,
            path: None,
            base: request.base.clone(),
            commit: request.commit.clone(),
        },
    )
    .await?;
    let mut listing = args.clone();
    listing.extend(["--name-status".into(), "-z".into(), "--".into()]);
    let bytes = git.strings(&listing, 256 * 1024).await?;
    let mut fields = bytes.split(|b| *b == 0);
    let mut selected = None;
    while let Some(status) = fields.next() {
        if status.is_empty() {
            if fields.next().is_some() {
                return Err(UNAVAILABLE);
            }
            break;
        }
        let first = fields.next().ok_or(UNAVAILABLE)?;
        let (previous, path) = if matches!(status.first(), Some(b'R' | b'C')) {
            (Some(first), fields.next().ok_or(UNAVAILABLE)?)
        } else {
            (None, first)
        };
        if path == request.path.as_bytes() {
            let kind = match status.first() {
                Some(b'M') => "modified",
                Some(b'R') => "renamed",
                Some(b'C') => "copied",
                _ => return Err(UNAVAILABLE),
            };
            if selected.is_some() {
                return Err(UNAVAILABLE);
            }
            selected = Some((kind, previous));
        }
    }
    let (status, previous) = selected.ok_or(UNAVAILABLE)?;
    let previous = previous
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|_| UNAVAILABLE)?;
    if let Some(path) = previous {
        validate_path(path)?;
    }
    let mut patch_args = args.clone();
    patch_args.extend(["--patch".into(), "--".into()]);
    if let Some(path) = previous {
        patch_args.push(path.into());
    }
    patch_args.push(request.path.clone());
    let original = git.strings(&patch_args, 64 * 1024).await?;
    let original = std::str::from_utf8(&original).map_err(|_| UNAVAILABLE)?;
    if fingerprint(&request.path, previous, status, original) != request.fingerprint {
        return Err(STALE);
    }
    let metadata = metadata(original)?;
    let key = serde_json::to_string(&(root, &args, &request.path, status, previous, original))
        .map_err(|_| UNAVAILABLE)?;
    let cached = cache.lock().map_err(|_| UNAVAILABLE)?.get(&key);
    let hit = cached.is_some();
    let expanded = if let Some(patch) = cached {
        patch
    } else {
        let mut expanded_args = args;
        expanded_args.extend(["--unified=1000000".into(), "--patch".into(), "--".into()]);
        if let Some(path) = previous {
            expanded_args.push(path.into());
        }
        expanded_args.push(request.path.clone());
        let expanded = git.strings(&expanded_args, 1024 * 1024).await?;
        String::from_utf8(expanded).map_err(|_| UNAVAILABLE)?
    };
    if metadata != self::metadata(&expanded)? {
        return Err(STALE);
    }
    let result = extract(&expanded, &request)?;
    let checked = git.strings(&patch_args, 64 * 1024).await?;
    let checked = std::str::from_utf8(&checked).map_err(|_| UNAVAILABLE)?;
    if fingerprint(&request.path, previous, status, checked) != request.fingerprint {
        return Err(STALE);
    }
    if serde_json::to_vec(&result).map_err(|_| UNAVAILABLE)?.len() > 64 * 1024 {
        return Err("Text context exceeds response limit");
    }
    if !hit {
        cache.lock().map_err(|_| UNAVAILABLE)?.insert(key, expanded);
    }
    Ok(result)
}

/// Returns only pre-hunk metadata, requiring a single full-index regular-file identity.
fn metadata(patch: &str) -> Result<&str, &'static str> {
    if patch.contains('\0') || !patch.ends_with('\n') {
        return Err(UNAVAILABLE);
    }
    let boundary = patch.find("\n@@ ").ok_or(UNAVAILABLE)? + 1;
    let metadata = &patch[..boundary];
    if !metadata.starts_with("diff --git ") || metadata.matches("\ndiff ").count() != 0 {
        return Err(UNAVAILABLE);
    }
    let mut identities = metadata
        .split('\n')
        .filter_map(|l| l.strip_prefix("index "));
    let identity = identities.next().ok_or(UNAVAILABLE)?;
    if identities.next().is_some() {
        return Err(UNAVAILABLE);
    }
    let (ids, mode) = identity.split_once(' ').ok_or(UNAVAILABLE)?;
    let (old, new) = ids.split_once("..").ok_or(UNAVAILABLE)?;
    if !matches!(mode, "100644" | "100755")
        || old.len() != new.len()
        || !matches!(old.len(), 40 | 64)
        || !old
            .bytes()
            .chain(new.bytes())
            .all(|b| b.is_ascii_hexdigit())
        || old.bytes().all(|b| b == b'0')
        || new.bytes().all(|b| b == b'0')
    {
        return Err(UNAVAILABLE);
    }
    Ok(metadata)
}

fn range(value: &str) -> Result<(i64, i64), &'static str> {
    let (start, count) = value.split_once(',').unwrap_or((value, "1"));
    let number = |s: &str| -> Result<i64, &'static str> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return Err(UNAVAILABLE);
        }
        s.parse::<i64>()
            .ok()
            .filter(|n| *n <= 1_000_000)
            .ok_or(UNAVAILABLE)
    };
    let (start, count) = (number(start)?, number(count)?);
    // Zero-count ranges point before the first line rather than at it.
    Ok((start + i64::from(count == 0), count))
}

/// Parses the complete expanded hunk, preserving CR and tabs and validating both counts.
/// A 1 MiB patch cannot hide a gap behind one million lines of requested context.
fn extract(patch: &str, request: &Request) -> Result<Review, &'static str> {
    let metadata = metadata(patch)?;
    let mut rows = patch[metadata.len()..].split_terminator('\n');
    let header = rows.next().ok_or(UNAVAILABLE)?;
    let ranges = header
        .strip_prefix("@@ -")
        .and_then(|s| s.split_once(" @@"))
        .ok_or(UNAVAILABLE)?
        .0;
    let (old, new) = ranges.split_once(" +").ok_or(UNAVAILABLE)?;
    let (mut old, old_count) = range(old)?;
    let (mut new, new_count) = range(new)?;
    if old != 1 || new != 1 {
        return Err(UNAVAILABLE);
    }
    let (old_end, new_end) = (old + old_count, new + new_count);
    let mut result = Review {
        old_start: request.old_start,
        new_start: request.new_start,
        lines: Vec::new(),
        has_more: false,
        no_newline: false,
    };
    let mut found = false;
    let mut collecting = false;
    let mut previous_kind = None;
    let mut ended = [false, false];
    for row in rows {
        if row == "\\ No newline at end of file" {
            let kind = previous_kind.take().ok_or(UNAVAILABLE)?;
            if collecting && kind == b' ' && !result.lines.is_empty() {
                result.no_newline = true;
            }
            ended[0] |= kind != b'+';
            ended[1] |= kind != b'-';
            continue;
        }
        let kind = row.as_bytes().first().copied().ok_or(UNAVAILABLE)?;
        if !matches!(kind, b' ' | b'+' | b'-') {
            return Err(UNAVAILABLE);
        }
        if (kind != b'+' && ended[0]) || (kind != b'-' && ended[1]) {
            return Err(UNAVAILABLE);
        }
        previous_kind = Some(kind);
        if old == request.old_start && new == request.new_start && !found {
            if kind != b' ' {
                return Err(RANGE);
            }
            found = true;
            collecting = true;
        }
        if collecting {
            if kind != b' ' {
                collecting = false;
            } else if result.lines.len() < request.count as usize {
                result.lines.push(row[1..].into());
            } else {
                result.has_more = true;
                collecting = false;
            }
        }
        old += i64::from(kind != b'+');
        new += i64::from(kind != b'-');
        if old > old_end || new > new_end {
            return Err(UNAVAILABLE);
        }
    }
    if old != old_end || new != new_end {
        return Err(UNAVAILABLE);
    }
    if !found && (old != request.old_start || new != request.new_start) {
        return Err(RANGE);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(body: &str) -> String {
        format!(
            "diff --git a/file b/file\nindex {}..{} 100644\n--- a/file\n+++ b/file\n{body}",
            "1".repeat(40),
            "2".repeat(40)
        )
    }
    fn request() -> Request {
        Request {
            scope: Scope::Unstaged,
            base: None,
            commit: None,
            path: "file".into(),
            fingerprint: String::new(),
            old_start: 1,
            new_start: 1,
            count: 20,
        }
    }

    #[test]
    fn expanded_cache_is_exact_and_bounded() {
        let mut cache = Cache::default();
        for i in 0..8 {
            cache.insert(
                format!("root/scope/path/metadata/{i}"),
                "x".repeat(1024 * 1024),
            );
        }
        assert!(cache.entries.len() <= 4);
        assert!(
            cache.bytes + cache.entries.capacity() * std::mem::size_of::<(String, String)>()
                <= 4 * 1024 * 1024
        );
        assert!(cache.get("root/scope/path/metadata/7").is_some());
        for key in [
            "other/scope/path/metadata/7",
            "root/other/path/metadata/7",
            "root/scope/other/metadata/7",
            "root/scope/path/changed/7",
            "root/scope/path/metadata/0",
        ] {
            assert!(cache.get(key).is_none());
        }
        cache.insert("oversized".into(), "x".repeat(4 * 1024 * 1024));
        assert!(cache.get("oversized").is_none());
    }

    #[test]
    fn parser_rejects_inconsistent_combined_truncated_and_nonregular_patches() {
        for body in [
            "@@ -1,2 +1,2 @@\n context\n",
            "@@ -1 +1 @@\n context\n excess\n",
            "@@ -2 +2 @@\n context\n",
            "@@@ -1 +1 @@@\n context\n",
            "@@ -1 +1 @@\n\\ No newline at end of file\n context\n",
            "@@ -1,2 +1,2 @@\n context\n\\ No newline at end of file\n invalid\n",
            "@@ -1 +1 @@\n context\n@@ -3 +3 @@\n extra\n",
        ] {
            assert!(extract(&patch(body), &request()).is_err(), "{body}");
        }
        let valid = patch("@@ -1 +1 @@\n context\n");
        assert!(extract(&valid, &request()).is_ok());
        assert!(metadata(&valid.replace("100644", "120000")).is_err());
        assert!(metadata(&valid.replace("diff --git", "diff --cc")).is_err());
        assert!(metadata(&valid.replace(" context", " con\0text")).is_err());
        assert!(metadata("Binary files a/file and b/file differ\n").is_err());
    }

    #[test]
    fn parser_treats_header_like_content_as_rows_and_preserves_carriage_returns() {
        let text = patch(
            "@@ -1,4 +1,4 @@\n index fake\r\n --- fake\n-old\n+new\n \\ No newline at end of file\n\\ No newline at end of file\n",
        );
        let review = extract(&text, &request()).unwrap();
        assert_eq!(review.lines, ["index fake\r", "--- fake"]);
        assert!(!review.has_more);
        let mut request = request();
        request.old_start = 4;
        request.new_start = 4;
        assert_eq!(
            extract(&text, &request).unwrap().lines,
            ["\\ No newline at end of file"]
        );
    }
}
