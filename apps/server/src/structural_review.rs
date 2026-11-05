//! Optional, bounded Difftastic enrichment of a freshly verified selected-file snapshot.
use crate::local_review::{Git, Scope, fingerprint, prepare};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command, sync::oneshot, time::Instant};

const INPUT: usize = 128 * 1024;
const OUTPUT: usize = 1024 * 1024;
const ENGINE: &str = "Difftastic 0.72.0";
const OPTIONS: [&str; 6] = [
    "--display=json",
    "--color=never",
    "--strip-cr=off",
    "--tab-width=1",
    "--graph-limit=500000",
    "--parse-error-limit=0",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    scope: Scope,
    base: Option<String>,
    commit: Option<String>,
    path: String,
    fingerprint: String,
}
#[derive(Clone, Serialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub(crate) enum Review {
    Text {
        reason: String,
    },
    Structural {
        engine: &'static str,
        language: String,
        lines: Vec<Line>,
    },
}
#[derive(Clone, Serialize)]
pub(crate) struct Line {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    old: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    next: Option<usize>,
    segments: Vec<Segment>,
}
#[derive(Clone, Serialize)]
struct Segment {
    text: String,
    changed: bool,
}

struct Entry {
    path: String,
    before: Vec<u8>,
    after: Vec<u8>,
    review: Review,
    size: usize,
}
/// Server-owned FIFO cache; exact captured bytes and path are compared, with fixed engine/options.
#[derive(Default)]
pub(crate) struct Cache {
    entries: VecDeque<Entry>,
    bytes: usize,
}
impl Cache {
    fn get(&self, path: &str, before: &[u8], after: &[u8]) -> Option<Review> {
        self.entries
            .iter()
            .find(|e| e.path == path && e.before == before && e.after == after)
            .map(|e| e.review.clone())
    }
    fn insert(&mut self, path: String, before: Vec<u8>, after: Vec<u8>, review: Review) {
        let size = std::mem::size_of::<Entry>()
            + path.capacity()
            + before.capacity()
            + after.capacity()
            + match &review {
                Review::Text { reason } => reason.capacity(),
                Review::Structural {
                    language, lines, ..
                } => {
                    language.capacity()
                        + lines.capacity() * std::mem::size_of::<Line>()
                        + lines
                            .iter()
                            .map(|line| {
                                line.segments.capacity() * std::mem::size_of::<Segment>()
                                    + line
                                        .segments
                                        .iter()
                                        .map(|s| s.text.capacity())
                                        .sum::<usize>()
                            })
                            .sum::<usize>()
                }
            };
        while self.entries.len() >= 16 || self.bytes + size > 4 * OUTPUT {
            let Some(entry) = self.entries.pop_front() else {
                return;
            };
            self.bytes -= entry.size;
        }
        self.bytes += size;
        self.entries.push_back(Entry {
            path,
            before,
            after,
            review,
            size,
        });
    }
}
fn fallback(reason: &str) -> Review {
    Review::Text {
        reason: reason.into(),
    }
}

/// Verifies membership and the selected patch before reading bounded immutable blobs or a
/// descriptor-relative worktree file. All children are killed and reaped before returning.
pub(crate) async fn review(
    root: &Path,
    request: Request,
    mut cancelled: oneshot::Receiver<()>,
    cache: &Mutex<Cache>,
) -> Result<Review, &'static str> {
    validate_path(&request.path)?;
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
            base: request.base,
            commit: request.commit,
        },
    )
    .await?;
    let mut listing = args.clone();
    listing.extend(["--name-status".into(), "-z".into(), "--".into()]);
    let bytes = git.strings(&listing, 256 * 1024).await?;
    let mut fields = bytes.split(|b| *b == 0).filter(|b| !b.is_empty());
    let mut selected = None;
    while let Some(status) = fields.next() {
        let first = fields.next().ok_or("Invalid Git file listing")?;
        let (previous, path) = if matches!(status.first(), Some(b'R' | b'C')) {
            (
                Some(first),
                fields.next().ok_or("Invalid Git file listing")?,
            )
        } else {
            (None, first)
        };
        if path == request.path.as_bytes() {
            selected = Some((status[0], previous));
            break;
        }
    }
    let Some((status, previous)) = selected else {
        if matches!(request.scope, Scope::Commit) {
            return Err("File snapshot changed; refresh review");
        }
        // Untracked files are deliberately never opened.
        let untracked = git
            .run(
                &[
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                    "-z",
                    "--",
                    &request.path,
                ],
                8192,
            )
            .await?;
        if untracked
            .split(|b| *b == 0)
            .any(|p| p == request.path.as_bytes())
        {
            return Ok(fallback(
                "Untracked files use text review; stage the file first",
            ));
        }
        return Err("File snapshot changed; refresh review");
    };
    let previous = previous
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|_| "Invalid Git path")?;
    if let Some(path) = previous {
        validate_path(path)?;
    }
    let status = match status {
        b'A' => "added",
        b'D' => "deleted",
        b'R' => "renamed",
        b'C' => "copied",
        b'T' => "typechanged",
        b'U' => "unmerged",
        _ => "modified",
    };
    let mut patch_args = args;
    patch_args.extend(["--patch".into(), "--".into()]);
    if let Some(previous) = previous {
        patch_args.push(previous.into());
    }
    patch_args.push(request.path.clone());
    let patch = match git.strings(&patch_args, 64 * 1024).await {
        Ok(bytes) => String::from_utf8(bytes).map_err(|_| "File is not UTF-8; use text review")?,
        Err("Git output exceeds review limit") => {
            return Ok(fallback("Patch exceeds structural review limits"));
        }
        Err(e) => return Err(e),
    };
    if fingerprint(&request.path, previous, status, &patch) != request.fingerprint {
        return Err("File snapshot changed; refresh review");
    }
    if !matches!(status, "modified" | "renamed" | "copied") {
        return Ok(fallback("Added, deleted, or special files use text review"));
    }
    let Some((before_oid, after_oid)) = identities(&patch) else {
        return Ok(fallback(
            "Regular-file content identities unavailable; use text review",
        ));
    };
    let before = match git.run(&["cat-file", "blob", before_oid], INPUT).await {
        Ok(bytes) => bytes,
        Err("Git output exceeds review limit") => {
            return Ok(fallback("File exceeds 128 KiB structural limit"));
        }
        Err(e) => return Err(e),
    };
    let after = if matches!(request.scope, Scope::Unstaged) {
        match read_worktree(root, &request.path) {
            Ok(bytes) => bytes,
            Err(_) => {
                return Ok(fallback(
                    "Worktree file is unsafe or exceeds 128 KiB; use text review",
                ));
            }
        }
    } else {
        match git.run(&["cat-file", "blob", after_oid], INPUT).await {
            Ok(bytes) => bytes,
            Err("Git output exceeds review limit") => {
                return Ok(fallback("File exceeds 128 KiB structural limit"));
            }
            Err(e) => return Err(e),
        }
    };
    let extension = Path::new(&request.path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("txt");
    // Unstaged identity verification needs only the captured new file before lookup.
    let mut temp = None;
    if matches!(request.scope, Scope::Unstaged) {
        let captured = Temp::new()?;
        let new = captured.0.join(format!("new.{extension}"));
        fs::write(&new, &after).map_err(|_| "Cannot capture structural input")?;
        temp = Some(captured);
        let oid = git
            .run(
                &[
                    "hash-object",
                    "--no-filters",
                    "--",
                    new.to_str().ok_or("Invalid temporary path")?,
                ],
                128,
            )
            .await?;
        if std::str::from_utf8(&oid).ok().map(str::trim) != Some(after_oid) {
            return Err("File contents changed or use Git conversion; refresh or use text review");
        }
    }
    let (Ok(old_text), Ok(new_text)) = (std::str::from_utf8(&before), std::str::from_utf8(&after))
    else {
        return Ok(fallback("Non-UTF-8 content uses text review"));
    };
    if before.contains(&0) || after.contains(&0) {
        return Ok(fallback("Binary content uses text review"));
    }
    // Gate even cache hits: a removed or replaced engine must not silently bypass the version contract.
    let version = match engine(&["--version"], 4096, &mut git).await {
        Ok(bytes) => bytes,
        Err(reason) => return Ok(fallback(reason)),
    };
    if version.split(|b| *b == b'\n').next() != Some(ENGINE.as_bytes()) {
        return Ok(fallback("Install Difftastic 0.72.0 for structural review"));
    }
    if let Some(review) = cache
        .lock()
        .map_err(|_| "Structural cache unavailable")?
        .get(&request.path, &before, &after)
    {
        return Ok(review);
    }
    let temp = match temp {
        Some(temp) => temp,
        None => Temp::new()?,
    };
    let old = temp.0.join(format!("old.{extension}"));
    let new = temp.0.join(format!("new.{extension}"));
    fs::write(&old, &before).map_err(|_| "Cannot capture structural input")?;
    if !matches!(request.scope, Scope::Unstaged) {
        fs::write(&new, &after).map_err(|_| "Cannot capture structural input")?;
    }
    let mut command = OPTIONS.to_vec();
    command.extend([
        old.to_str().ok_or("Invalid temporary path")?,
        new.to_str().ok_or("Invalid temporary path")?,
    ]);
    let output = match engine(&command, OUTPUT, &mut git).await {
        Ok(bytes) => bytes,
        Err(reason) => return Ok(fallback(reason)),
    };
    let review = match adapt(&output, old_text, new_text) {
        Ok(review) => review,
        Err("Language or parser unsupported; use text review") => {
            fallback("Language or parser unsupported; use text review")
        }
        Err(reason) => return Ok(fallback(reason)),
    };
    if serde_json::to_vec(&review)
        .map_err(|_| "Cannot encode structural review")?
        .len()
        > OUTPUT
    {
        return Ok(fallback("Structural output exceeds 1 MiB; use text review"));
    }
    cache
        .lock()
        .map_err(|_| "Structural cache unavailable")?
        .insert(request.path, before, after, review.clone());
    Ok(review)
}

fn validate_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty()
        || path.len() > 1024
        || path.contains('\0')
        || path.starts_with('/')
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.eq_ignore_ascii_case(".git"))
    {
        return Err("Invalid root-relative review path");
    }
    Ok(())
}
/// Accepts only full object IDs and regular-file mode from Git's full-index patch.
fn identities(patch: &str) -> Option<(&str, &str)> {
    let mut headers = patch.lines().filter_map(|l| l.strip_prefix("index "));
    let header = headers.next()?;
    if headers.next().is_some() {
        return None;
    }
    let (ids, mode) = header.split_once(' ')?;
    if !matches!(mode, "100644" | "100755") {
        return None;
    }
    let (old, new) = ids.split_once("..")?;
    if old.len() != new.len()
        || !matches!(old.len(), 40 | 64)
        || !old
            .bytes()
            .chain(new.bytes())
            .all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    Some((old, new))
}

/// Traverses every component with O_NOFOLLOW, retaining parent descriptors against rename races.
fn read_worktree(root: &Path, path: &str) -> std::io::Result<Vec<u8>> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
    };
    let mut parent = fs::File::open("/")?;
    let full = root.canonicalize()?.join(path);
    let components = full
        .components()
        .filter_map(|c| {
            if let std::path::Component::Normal(s) = c {
                Some(s)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let name = CString::new(component.as_bytes())?;
        let directory = index + 1 < components.len();
        // SAFETY: the parent descriptor and NUL-terminated name are live for openat.
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY
                    | libc::O_NOFOLLOW
                    | libc::O_CLOEXEC
                    | libc::O_NONBLOCK
                    | if directory { libc::O_DIRECTORY } else { 0 },
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: openat returned a newly owned descriptor.
        parent = unsafe { fs::File::from_raw_fd(fd) };
    }
    if !parent.metadata()?.is_file() || parent.metadata()?.len() > INPUT as u64 {
        return Err(std::io::Error::other("unsupported file"));
    }
    let mut bytes = Vec::new();
    parent.take(INPUT as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > INPUT {
        return Err(std::io::Error::other("file too large"));
    }
    Ok(bytes)
}

/// Private input directory whose ownership lasts through child reap and all return paths.
struct Temp(PathBuf);
impl Temp {
    fn new() -> Result<Self, &'static str> {
        use std::os::unix::fs::DirBuilderExt;
        let path = std::env::temp_dir().join(format!(
            "pi-structural-{}",
            crate::config::identity().map_err(|_| "Cannot allocate structural input")?
        ));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|_| "Cannot allocate structural input")?;
        Ok(Self(path))
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        if fs::remove_dir_all(&self.0).is_err() {
            eprintln!("pi-web: could not remove private structural-review temporary files");
        }
    }
}

async fn engine(args: &[&str], limit: usize, git: &mut Git<'_>) -> Result<Vec<u8>, &'static str> {
    if Instant::now() >= git.deadline {
        return Err("Structural review timed out; use text review");
    }
    if !matches!(
        git.cancelled.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ) {
        return Err("Structural review cancelled");
    }
    run_engine(Command::new("difft"), args, limit, git).await
}

/// Runs one bounded engine process; accepting the owned command keeps fixtures process-local.
async fn run_engine(
    mut command: Command,
    args: &[&str],
    limit: usize,
    git: &mut Git<'_>,
) -> Result<Vec<u8>, &'static str> {
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("DFT_UNSTABLE", "yes")
        .env("LC_ALL", "C.UTF-8")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| "Install Difftastic 0.72.0 for structural review")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Structural engine output unavailable")?;
    let operation = async {
        let mut bytes = Vec::new();
        stdout
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Cannot read structural output")?;
        if bytes.len() > limit {
            return Err("Structural output exceeds limit; use text review");
        }
        if !child
            .wait()
            .await
            .map_err(|_| "Cannot wait for structural engine")?
            .success()
        {
            return Err("Structural engine failed; use text review");
        }
        Ok(bytes)
    };
    let result = tokio::select! {
        value = tokio::time::timeout_at(git.deadline, operation) => value.unwrap_or(Err("Structural review timed out; use text review")),
        _ = &mut *git.cancelled => Err("Structural review cancelled"),
    };
    if result.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    result
}

#[derive(Deserialize)]
struct Output {
    status: String,
    language: String,
    aligned_lines: Option<Vec<(Option<usize>, Option<usize>)>>,
    chunks: Option<Vec<Vec<Pair>>>,
}
#[derive(Deserialize)]
struct Pair {
    lhs: Option<Side>,
    rhs: Option<Side>,
}
#[derive(Deserialize)]
struct Side {
    line_number: usize,
    changes: Vec<Change>,
}
#[derive(Deserialize)]
struct Change {
    start: usize,
    end: usize,
    content: String,
}
const INVALID: &str = "Unsupported structural output; use text review";

/// Validates byte ranges against captured UTF-8 text and renders three lines of aligned context.
fn adapt(bytes: &[u8], old: &str, new: &str) -> Result<Review, &'static str> {
    let output: Output = serde_json::from_slice(bytes).map_err(|_| INVALID)?;
    if output.language == "Text" || output.language.starts_with("Text (") {
        return Err("Language or parser unsupported; use text review");
    }
    if output.language.is_empty() || output.language.len() > 256 {
        return Err(INVALID);
    }
    if output.status == "unchanged" {
        if output.aligned_lines.is_some() || output.chunks.is_some() {
            return Err(INVALID);
        }
        return Ok(Review::Structural {
            engine: ENGINE,
            language: output.language,
            lines: vec![],
        });
    }
    if output.status != "changed" {
        return Err(INVALID);
    }
    let aligned = output.aligned_lines.ok_or(INVALID)?;
    if aligned.len() > 32768 {
        return Err(INVALID);
    }
    let texts = [
        old.split('\n').collect::<Vec<_>>(),
        new.split('\n').collect::<Vec<_>>(),
    ];
    let mut changes = [
        BTreeMap::<usize, Vec<Change>>::new(),
        BTreeMap::<usize, Vec<Change>>::new(),
    ];
    let mut count = 0;
    for chunk in output.chunks.ok_or(INVALID)? {
        for pair in chunk {
            for (side, entry) in [pair.lhs, pair.rhs].into_iter().enumerate() {
                let Some(entry) = entry else { continue };
                let text = texts[side].get(entry.line_number).ok_or(INVALID)?;
                let ranges = changes[side].entry(entry.line_number).or_default();
                for change in entry.changes {
                    count += 1;
                    if count > 32768
                        || change.start >= change.end
                        || text.get(change.start..change.end) != Some(change.content.as_str())
                    {
                        return Err(INVALID);
                    }
                    ranges.push(change);
                }
            }
        }
    }
    for side in &mut changes {
        for ranges in side.values_mut() {
            ranges.sort_by_key(|c| c.start);
            if ranges.windows(2).any(|w| w[0].end > w[1].start) {
                return Err(INVALID);
            }
        }
    }
    let mut seen = [0, 0];
    let mut novel = Vec::new();
    for (index, &(left, right)) in aligned.iter().enumerate() {
        if left.is_none() && right.is_none() {
            return Err(INVALID);
        }
        let mut changed = false;
        for (side, line) in [left, right].into_iter().enumerate() {
            if let Some(line) = line {
                if line != seen[side] || line >= texts[side].len() {
                    return Err(INVALID);
                }
                seen[side] += 1;
                changed |= changes[side].get(&line).is_some_and(|c| !c.is_empty());
            }
        }
        if changed {
            novel.push(index);
        }
    }
    if seen != [texts[0].len(), texts[1].len()] {
        return Err(INVALID);
    }
    let mut visible = vec![false; aligned.len()];
    for i in novel {
        for flag in visible
            .iter_mut()
            .take((i + 4).min(aligned.len()))
            .skip(i.saturating_sub(3))
        {
            *flag = true;
        }
    }
    let mut lines = Vec::new();
    let mut previous = None;
    for (i, &(left, right)) in aligned.iter().enumerate() {
        if !visible[i] {
            continue;
        }
        if previous.is_some_and(|p| p + 1 != i) {
            lines.push(Line {
                kind: "header",
                old: None,
                next: None,
                segments: vec![Segment {
                    text: "…".into(),
                    changed: false,
                }],
            });
        }
        previous = Some(i);
        let changed = left.is_some_and(|l| changes[0].get(&l).is_some_and(|c| !c.is_empty()))
            || right.is_some_and(|l| changes[1].get(&l).is_some_and(|c| !c.is_empty()));
        if changed {
            if let Some(l) = left {
                lines.push(row(
                    "remove",
                    Some(l + 1),
                    None,
                    texts[0][l],
                    changes[0].get(&l),
                ));
            }
            if let Some(l) = right {
                lines.push(row(
                    "add",
                    None,
                    Some(l + 1),
                    texts[1][l],
                    changes[1].get(&l),
                ));
            }
        } else if let Some(l) = right {
            lines.push(row(
                "context",
                left.map(|l| l + 1),
                Some(l + 1),
                texts[1][l],
                None,
            ));
        } else if let Some(l) = left {
            lines.push(row("context", Some(l + 1), None, texts[0][l], None));
        }
        if lines.len() > 10000 {
            return Err(INVALID);
        }
    }
    if lines.iter().map(|line| line.segments.len()).sum::<usize>() > 60000 {
        return Err(INVALID);
    }
    Ok(Review::Structural {
        engine: ENGINE,
        language: output.language,
        lines,
    })
}
fn row(
    kind: &'static str,
    old: Option<usize>,
    next: Option<usize>,
    text: &str,
    changes: Option<&Vec<Change>>,
) -> Line {
    let mut segments = Vec::new();
    let mut offset = 0;
    for change in changes.into_iter().flatten() {
        if offset < change.start {
            segments.push(Segment {
                text: text[offset..change.start].into(),
                changed: false,
            });
        }
        segments.push(Segment {
            text: text[change.start..change.end].into(),
            changed: true,
        });
        offset = change.end;
    }
    if offset < text.len() || segments.is_empty() {
        segments.push(Segment {
            text: text[offset..].into(),
            changed: false,
        });
    }
    Line {
        kind,
        old,
        next,
        segments,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_preserves_bytes_and_rejects_invalid_ranges_and_alignment() {
        let old = "\tlet café = \"old\";\r\n";
        let new = "\tlet café = \"new\";\r\n";
        let valid = serde_json::json!({"status":"changed","language":"Rust", "aligned_lines":[[0,0],[1,1]],"chunks":[[{"lhs":{"line_number":0,"changes":[{"start":13,"end":18,"content":"\"old\""}]},"rhs":{"line_number":0,"changes":[{"start":13,"end":18,"content":"\"new\""}]}}]]});
        let review = adapt(&serde_json::to_vec(&valid).unwrap(), old, new).unwrap();
        let Review::Structural { lines, .. } = review else {
            panic!("expected structural")
        };
        assert_eq!(
            lines[0]
                .segments
                .iter()
                .map(|s| s.text.as_str())
                .collect::<String>(),
            old.trim_end_matches('\n')
        );
        assert_eq!(
            lines[1]
                .segments
                .iter()
                .filter(|s| s.changed)
                .map(|s| s.text.as_str())
                .collect::<String>(),
            "\"new\""
        );
        for (start, end, content) in [
            (9, 10, "é"),
            (13, 999, "x"),
            (13, 18, "wrong"),
            (13, 13, ""),
        ] {
            let mut bad = valid.clone();
            bad["chunks"][0][0]["lhs"]["changes"][0] =
                serde_json::json!({"start":start,"end":end,"content":content});
            assert!(adapt(&serde_json::to_vec(&bad).unwrap(), old, new).is_err());
        }
        let mut bad = valid.clone();
        bad["aligned_lines"] = serde_json::json!([[0, 0], [0, 1]]);
        assert!(adapt(&serde_json::to_vec(&bad).unwrap(), old, new).is_err());
        bad["aligned_lines"] = serde_json::json!([[0, 0]]);
        assert!(adapt(&serde_json::to_vec(&bad).unwrap(), old, new).is_err());
        for language in ["", "Text", "Text (exceeded DFT_GRAPH_LIMIT)"] {
            let output = serde_json::json!({"status":"changed","language":language});
            assert!(adapt(&serde_json::to_vec(&output).unwrap(), old, new).is_err());
        }
        assert!(adapt(b"[]", old, new).is_err());
        assert!(adapt(br#"{"status":"created","language":"Rust"}"#, old, new).is_err());
    }

    #[test]
    fn cache_requires_exact_content_and_obeys_entry_and_byte_limits() {
        let mut cache = Cache::default();
        for i in 0..20 {
            cache.insert(
                format!("{i}.rs"),
                vec![0; INPUT],
                vec![1; INPUT],
                fallback("test"),
            );
        }
        assert!(cache.entries.len() <= 16);
        assert!(cache.bytes <= 4 * OUTPUT);
        assert!(
            cache
                .get("0.rs", &vec![0; INPUT], &vec![1; INPUT])
                .is_none()
        );
        assert!(
            cache
                .get("19.rs", &vec![0; INPUT], &vec![1; INPUT])
                .is_some()
        );
        assert!(
            cache
                .get("19.rs", &vec![0; INPUT], &vec![2; INPUT])
                .is_none()
        );
    }

    #[test]
    fn descriptor_reads_reject_symlinks_special_files_and_oversize_and_temp_cleans_up() {
        let temp = Temp::new().unwrap();
        let root = temp.0.clone();
        fs::write(root.join("normal"), "hello").unwrap();
        assert_eq!(read_worktree(&root, "normal").unwrap(), b"hello");
        std::os::unix::fs::symlink("normal", root.join("link")).unwrap();
        assert!(read_worktree(&root, "link").is_err());
        std::os::unix::fs::symlink(&root, root.join("directory")).unwrap();
        assert!(read_worktree(&root, "directory/normal").is_err());
        fs::write(root.join("large"), vec![0; INPUT + 1]).unwrap();
        assert!(read_worktree(&root, "large").is_err());
        let fifo = std::ffi::CString::new(root.join("fifo").to_str().unwrap()).unwrap();
        // SAFETY: fifo is a valid NUL-terminated path inside the owned test directory.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(read_worktree(&root, "fifo").is_err());
        drop(temp);
        assert!(!root.exists());
    }

    #[tokio::test]
    async fn engine_bounds_output_deadline_and_cancellation_and_reaps() {
        let (sender, mut cancelled) = oneshot::channel();
        let mut git = Git {
            root: Path::new("."),
            deadline: Instant::now() + Duration::from_secs(2),
            cancelled: &mut cancelled,
        };
        assert_eq!(
            run_engine(
                Command::new("/bin/sh"),
                &["-c", "printf 12345"],
                4,
                &mut git
            )
            .await
            .unwrap_err(),
            "Structural output exceeds limit; use text review"
        );
        let temp = Temp::new().unwrap();
        let pid_file = temp.0.join("pid");
        let script = format!("echo $$ > '{}'; while :; do :; done", pid_file.display());
        git.deadline = Instant::now() + Duration::from_millis(100);
        assert_eq!(
            run_engine(Command::new("/bin/sh"), &["-c", &script], OUTPUT, &mut git)
                .await
                .unwrap_err(),
            "Structural review timed out; use text review"
        );
        let pid: i32 = fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // SAFETY: signal zero only tests whether the known child still exists.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        git.deadline = Instant::now() + Duration::from_secs(2);
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            drop(sender);
        };
        let args = ["-c", &script];
        let (result, _) = tokio::join!(
            run_engine(Command::new("/bin/sh"), &args, OUTPUT, &mut git),
            cancel
        );
        assert_eq!(result.unwrap_err(), "Structural review cancelled");
        let pid: i32 = fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // SAFETY: signal zero only tests whether the known child still exists.
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    }
}
