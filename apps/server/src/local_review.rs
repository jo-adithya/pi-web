//! Bounded, read-only Git snapshots rooted at a registered workspace.
mod turn;
pub(crate) use turn::TurnChanges;
use p256::ecdsa::{
    Signature,
    signature::{PrehashSignature, digest::Digest},
};
use serde::{Deserialize, Serialize};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, sync::oneshot, time::Instant};

// P-256's existing dependency exposes SHA-256 through its signature digest contract.
type Sha256 = <Signature as PrehashSignature>::Digest;

const MAX_FILES: usize = 100;
const MAX_PATCH: usize = 64 * 1024;
const MAX_TOTAL: usize = 1024 * 1024;
const MAX_LIST: usize = 4 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize, std::hash::Hash)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Scope {
    Unstaged,
    Staged,
    Branch,
    Commit,
    Turn,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub scope: Scope,
    pub base: Option<String>,
    pub commit: Option<String>,
    pub path: Option<String>,
    /// Continuation token from a metadata page; mutually exclusive with path.
    pub cursor: Option<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct File {
    path: String,
    previous_path: Option<String>,
    status: &'static str,
    patch: Option<String>,
    fingerprint: Option<String>,
    /// Text counts from metadata; absent for binary, untracked, or unavailable statistics.
    #[serde(skip_serializing_if = "Option::is_none")]
    line_stats: Option<FileLineStats>,
}
#[derive(Clone, Copy, Serialize)]
pub(crate) struct FileLineStats {
    added: u64,
    removed: u64,
}
#[derive(Default)]
struct ParsedLineStats {
    totals: LineStats,
    files: std::collections::HashMap<Vec<u8>, FileLineStats>,
}
/// Scope-wide Git line counts, independent of the bounded file list and lazy patches.
/// Added and removed totals exclude conventional test/generated paths, lockfiles, and .md files.
/// Binary and untracked files contribute to unavailable_files instead of line counts.
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LineStats {
    added: u64,
    /// Unfiltered additions across all paths.
    total_added: u64,
    removed: u64,
    /// Unfiltered deletions across all paths.
    total_removed: u64,
    unavailable_files: usize,
}
#[derive(Clone, Serialize)]
pub(crate) struct Review {
    files: Vec<File>,
    truncated: bool,
    note: Option<String>,
    /// Absent for selected-file requests, continuation pages, or over-budget statistics.
    #[serde(rename = "lineStats", skip_serializing_if = "Option::is_none")]
    line_stats: Option<LineStats>,
    #[serde(rename = "nextCursor", skip_serializing_if = "Option::is_none")]
    next_cursor: Option<String>,
    /// SHA-256 identity of captured tracked diff bytes and scope/listing metadata.
    /// Absent outside the first metadata page or when the full diff exceeds 4 MiB.
    #[serde(rename = "snapshotKey", skip_serializing_if = "Option::is_none")]
    snapshot_key: Option<String>,
}

/// Lists up to 100 metadata entries per page, or loads one fresh member, within ten seconds.
/// Cursors bind the listing and resolved scope identity; changed listings require a restart.
/// Scope totals appear only on the first page; file counts accompany every metadata page.
/// More pages do not imply omitted content.
/// Snapshot keys identify the captured diff, including binary changes, not an atomic workspace state.
/// Untracked names participate in the identity; their content remains unread and omitted.
/// Concurrent edits may change files between listing, identity, and selected patch reads;
/// consumers must revalidate around grouping and cannot treat the key as a filesystem lock.
/// Cancellation kills and reaps Git.
/// Errors are fixed actionable messages suitable for the HTTP boundary.
pub(crate) async fn review(
    root: &Path,
    request: Request,
    mut cancelled: oneshot::Receiver<()>,
) -> Result<Review, &'static str> {
    if request.cursor.is_some() && request.path.is_some() {
        return Err("Cursor and path are mutually exclusive");
    }
    if let Some(path) = &request.path {
        validate_path(path)?;
    }
    let mut git = Git {
        root,
        deadline: Instant::now() + Duration::from_secs(10),
        cancelled: &mut cancelled,
    };
    let (args, identity) = prepare_snapshot(&mut git, &request).await?;
    let mut listing = args.clone();
    listing.extend(["--name-status".into(), "-z".into(), "--".into()]);
    let bytes = git.strings(&listing, MAX_LIST).await?;
    let untracked = if matches!(request.scope, Scope::Unstaged) {
        git.run(
            &["ls-files", "--others", "--exclude-standard", "-z"],
            MAX_LIST,
        )
        .await?
    } else {
        Vec::new()
    };
    use std::hash::{Hash, Hasher};
    let mut snapshot = std::collections::hash_map::DefaultHasher::new();
    (root, request.scope, &args, &identity, &bytes, &untracked).hash(&mut snapshot);
    let snapshot = snapshot.finish();
    let offset = match request.cursor.as_deref() {
        Some(cursor) => {
            let offset = cursor
                .split_once(':')
                .and_then(|(offset, _)| offset.parse::<usize>().ok())
                .filter(|offset| *offset > 0)
                .ok_or("Invalid review cursor; refresh review")?;
            if cursor != page_cursor(snapshot, offset) {
                return Err("Invalid or stale review cursor; refresh review");
            }
            offset
        }
        None => 0,
    };
    let stats = if request.path.is_none() {
        let mut stats_args = args.clone();
        stats_args.extend(["--numstat".into(), "-z".into(), "--".into()]);
        match git.strings(&stats_args, MAX_LIST).await {
            Ok(bytes) => Some(parse_line_stats(&bytes)?),
            Err("Git output exceeds review limit") => None,
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    let stats_available = stats.is_some();
    let ParsedLineStats { totals, files: file_stats } = stats.unwrap_or_default();
    let line_stats = if request.path.is_none() && request.cursor.is_none() && stats_available {
        Some(totals)
    } else {
        None
    };
    let snapshot_key = if request.path.is_none() && request.cursor.is_none() {
        let mut patch_args = args.clone();
        patch_args.extend([
            "--patch".into(),
            "--binary".into(),
            "--full-index".into(),
            "--".into(),
        ]);
        match git.strings(&patch_args, MAX_LIST).await {
            Ok(patch) => {
                let mut hash = Sha256::new();
                // Length framing preserves field boundaries, including opaque path bytes.
                let mut field = |value: &[u8]| {
                    hash.update((value.len() as u64).to_be_bytes());
                    hash.update(value);
                };
                field(b"pi-review-snapshot-v1");
                field(root.as_os_str().as_encoded_bytes());
                field(match request.scope {
                    Scope::Unstaged => b"unstaged",
                    Scope::Staged => b"staged",
                    Scope::Branch => b"branch",
                    Scope::Commit => b"commit",
                    Scope::Turn => b"turn",
                });
                field(&(patch_args.len() as u64).to_be_bytes());
                for arg in &patch_args {
                    field(arg.as_bytes());
                }
                field(identity.as_deref().unwrap_or("").as_bytes());
                field(&bytes);
                field(&untracked);
                field(&patch);
                Some(format!("{:x}", hash.finalize()))
            }
            // Partial output is never content identity. Metadata remains usable without reuse.
            Err("Git output exceeds review limit") => None,
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    let mut fields = bytes.split(|b| *b == 0).filter(|b| !b.is_empty());
    let mut result = Review {
        files: Vec::new(),
        truncated: false,
        note: None,
        line_stats,
        next_cursor: None,
        snapshot_key,
    };
    let mut seen = std::collections::HashSet::new();
    while let Some(status) = fields.next() {
        let first = fields.next().ok_or("Invalid Git file listing")?;
        let (previous, path) = if matches!(status.first(), Some(b'R' | b'C')) {
            (
                Some(first),
                fields.next().ok_or("Invalid Git rename listing")?,
            )
        } else {
            (None, first)
        };
        if request
            .path
            .as_ref()
            .is_some_and(|selected| selected.as_bytes() != path)
        {
            continue;
        }
        let Ok(path) = std::str::from_utf8(path) else {
            result.truncated = true;
            continue;
        };
        if !seen.insert(path.to_owned()) {
            continue;
        }
        let previous = match previous.map(std::str::from_utf8).transpose() {
            Ok(p) => p,
            Err(_) => {
                result.truncated = true;
                continue;
            }
        };
        let status = match status[0] {
            b'A' => "added",
            b'D' => "deleted",
            b'R' => "renamed",
            b'C' => "copied",
            b'T' => "typechanged",
            b'U' => "unmerged",
            _ => "modified",
        };
        let file = File {
            path: path.into(),
            previous_path: previous.map(str::to_owned),
            status,
            patch: None,
            fingerprint: None,
            line_stats: file_stats.get(path.as_bytes()).copied(),
        };
        result.files.push(file);
    }
    if matches!(request.scope, Scope::Unstaged) {
        let bytes = untracked;
        if let Some(stats) = &mut result.line_stats {
            stats.unavailable_files += bytes
                .split(|b| *b == 0)
                .filter(|b| !b.is_empty())
                .count();
        }
        for path in bytes.split(|b| *b == 0).filter(|b| !b.is_empty()) {
            if request
                .path
                .as_ref()
                .is_some_and(|selected| selected.as_bytes() != path)
            {
                continue;
            }
            result.truncated = true;
            if let Ok(path) = std::str::from_utf8(path) {
                let file = File {
                    path: path.into(),
                    previous_path: None,
                    status: "untracked",
                    patch: None,
                    fingerprint: None,
                    line_stats: None,
                };
                result.files.push(file);
            }
        }
    }
    if request.path.is_none() {
        paginate(&mut result, offset, snapshot)?;
    }
    if let Some(path) = request.path {
        let index = result
            .files
            .iter()
            .position(|file| file.path == path)
            .ok_or("File snapshot changed; refresh review")?;
        let mut file = result.files.remove(index);
        let patch = if file.status == "untracked" {
            "Untracked content omitted; file has not been read.\n".into()
        } else {
            let mut patch_args = args;
            patch_args.extend(["--patch".into(), "--".into()]);
            if let Some(previous) = &file.previous_path {
                validate_path(previous)?;
                patch_args.push(previous.clone());
            }
            patch_args.push(file.path.clone());
            let patch = match git.strings(&patch_args, MAX_PATCH).await {
                Ok(bytes) if bytes.contains(&0) => {
                    result.truncated = true;
                    "Binary content omitted.\n".into()
                }
                Ok(bytes) => match String::from_utf8(bytes) {
                    Ok(patch) => patch,
                    Err(_) => {
                        result.truncated = true;
                        "Non-UTF-8 patch omitted.\n".into()
                    }
                },
                Err("Git output exceeds review limit") => {
                    result.truncated = true;
                    "Patch exceeds 64 KiB; content omitted.\n".into()
                }
                Err(error) => return Err(error),
            };
            patch
        };
        file.fingerprint = Some(fingerprint(
            &file.path,
            file.previous_path.as_deref(),
            file.status,
            &patch,
        ));
        file.patch = Some(patch);
        result.files.clear();
        let mut total = 1024;
        append_file(&mut result, &mut total, file)?;
    }
    if result.truncated {
        result.note = Some("Some content was omitted: review limits, non-UTF-8 paths/content, or untracked files. Limits: 100 files per page, 64 KiB per patch, 1 MiB JSON response.".into());
    }
    Ok(result)
}

/// Encodes an offset bound to a listing snapshot; this is a staleness check, not authorization.
fn page_cursor(snapshot: u64, offset: usize) -> String {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (snapshot, offset).hash(&mut hash);
    format!("{offset}:{:016x}", hash.finish())
}

/// Selects a byte-bounded metadata page without treating deferred entries as omissions.
fn paginate(review: &mut Review, offset: usize, snapshot: u64) -> Result<(), &'static str> {
    let files = std::mem::take(&mut review.files);
    if offset > 0 && offset >= files.len() {
        return Err("Invalid review cursor; refresh review");
    }
    // Reserve room for statistics, the cursor, and an omission note.
    let mut total = 1024;
    for (index, file) in files.into_iter().enumerate().skip(offset) {
        let size = serde_json::to_vec(&file)
            .map_err(|_| "Cannot encode review file")?
            .len()
            + 1;
        if review.files.len() == MAX_FILES || total + size > MAX_TOTAL {
            if review.files.is_empty() {
                return Err("Review file metadata exceeds response limit");
            }
            review.next_cursor = Some(page_cursor(snapshot, index));
            break;
        }
        total += size;
        review.files.push(file);
    }
    Ok(())
}

/// Recognizes test/generated paths, lockfiles, and .md files without reading contents.
fn excluded_from_line_totals(path: &[u8]) -> bool {
    let path = path.to_ascii_lowercase();
    let components: Vec<_> = path.split(|b| *b == b'/').collect();
    if components.iter().any(|part| matches!(*part,
        b"test" | b"tests" | b"__tests__" | b"spec" | b"specs" | b"e2e" |
        b"generated" | b"__generated__"
    )) {
        return true;
    }
    let name = components.last().copied().unwrap_or_default();
    let parts: Vec<_> = name.split(|b| matches!(b, b'.' | b'_' | b'-')).collect();
    let test_name = parts.iter().enumerate().any(|(index, part)| {
        index > 0 && index + 1 < parts.len()
            && matches!(*part, b"test" | b"tests" | b"spec" | b"specs")
    });
    name.ends_with(b".md") || name.starts_with(b"test_") || test_name
        || name.windows(b".generated.".len()).any(|part| part == b".generated.")
        || name.ends_with(b".lock") || name.ends_with(b".lockb")
        || matches!(name, b"package-lock.json" | b"npm-shrinkwrap.json" | b"pnpm-lock.yaml")
        || [b".g.ts".as_slice(), b".g.dart", b".pb.go", b".min.js", b".min.css", b".map"]
            .iter().any(|suffix| name.ends_with(suffix))
}

/// Totals NUL-delimited numstat records and indexes unfiltered text counts by destination path.
/// Paths stay opaque bytes so tabs, newlines and non-UTF-8 names cannot alter counts.
fn parse_line_stats(bytes: &[u8]) -> Result<ParsedLineStats, &'static str> {
    let mut result = ParsedLineStats::default();
    let mut records = bytes.split(|b| *b == 0);
    while let Some(record) = records.next().filter(|record| !record.is_empty()) {
        let mut fields = record.splitn(3, |b| *b == b'\t');
        let added = fields.next().ok_or("Invalid Git line statistics")?;
        let removed = fields.next().ok_or("Invalid Git line statistics")?;
        let path = fields.next().ok_or("Invalid Git line statistics")?;
        let path = if path.is_empty() {
            records.next().filter(|path| !path.is_empty())
                .ok_or("Invalid Git rename statistics")?;
            records.next().filter(|path| !path.is_empty())
                .ok_or("Invalid Git rename statistics")?
        } else {
            path
        };
        if added == b"-" && removed == b"-" {
            result.totals.unavailable_files += 1;
        } else {
            let count = |bytes| {
                std::str::from_utf8(bytes)
                    .ok()
                    .and_then(|s| s.parse::<u64>().ok())
                    .ok_or("Invalid Git line count")
            };
            let added = count(added)?;
            let removed = count(removed)?;
            result.files.insert(path.to_vec(), FileLineStats { added, removed });
            result.totals.total_added = result.totals.total_added
                .checked_add(added)
                .ok_or("Git line counts exceed limit")?;
            result.totals.total_removed = result.totals.total_removed
                .checked_add(removed)
                .ok_or("Git line counts exceed limit")?;
            if !excluded_from_line_totals(path) {
                result.totals.added = result.totals.added
                    .checked_add(added)
                    .ok_or("Git line counts exceed limit")?;
                result.totals.removed = result.totals.removed
                    .checked_add(removed)
                    .ok_or("Git line counts exceed limit")?;
            }
        }
    }
    Ok(result)
}

/// Requires a literal root-relative path outside Git metadata.
pub(crate) fn validate_path(path: &str) -> Result<(), &'static str> {
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

/// Validates the repository and resolves local scope refs before any content operation.
/// Commit scope compares immutable first-parent and selected commit IDs; true roots use
/// Git's read-only empty-tree comparison. Missing parent objects fail even at shallow boundaries.
pub(crate) async fn prepare(
    git: &mut Git<'_>,
    request: &Request,
) -> Result<Vec<String>, &'static str> {
    Ok(prepare_snapshot(git, request).await?.0)
}

/// Resolves comparison arguments and branch tip identities for pagination and content identity.
async fn prepare_snapshot(
    git: &mut Git<'_>,
    request: &Request,
) -> Result<(Vec<String>, Option<String>), &'static str> {
    if matches!(request.scope, Scope::Turn) { return Err("Last-turn snapshots are read from their runtime"); }
    let mut identity = None;
    if !matches!(request.scope, Scope::Branch) && request.base.is_some() {
        return Err("Base is only valid for branch review");
    }
    if !matches!(request.scope, Scope::Commit) && request.commit.is_some() {
        return Err("Commit is only valid for commit review");
    }
    if matches!(request.scope, Scope::Commit) {
        validate_commit(
            request
                .commit
                .as_deref()
                .ok_or("Commit review requires a full commit ID")?,
        )?;
    }
    validate_repository(git).await?;
    let mut args = vec![
        "diff".to_owned(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--ignore-submodules=all".into(),
        "--no-color".into(),
        "--find-renames".into(),
        "--full-index".into(),
    ];
    match request.scope {
        Scope::Turn => unreachable!(),
        Scope::Unstaged => {}
        Scope::Staged => args.push("--cached".into()),
        Scope::Commit => {
            let commit = request
                .commit
                .as_deref()
                .ok_or("Commit review requires a full commit ID")?;
            require_commit(git, commit).await?;
            let object = git.run(&["cat-file", "commit", commit], MAX_TOTAL).await?;
            let headers = object
                .split(|b| *b == b'\n')
                .take_while(|line| !line.is_empty());
            let parent = headers
                .filter_map(|line| line.strip_prefix(b"parent "))
                .next();
            if let Some(parent) = parent {
                let parent = std::str::from_utf8(parent).map_err(|_| "Invalid commit parent")?;
                validate_commit(parent)?;
                require_commit(git, parent)
                    .await
                    .map_err(|_| "Commit first parent is unavailable locally")?;
                args.push(parent.into());
            } else {
                args[0] = "diff-tree".into();
                args.extend(["--root".into(), "-r".into(), "--no-commit-id".into()]);
            }
            args.push(commit.into());
        }
        Scope::Branch => {
            let base = request
                .base
                .as_deref()
                .ok_or("Branch review requires a local base ref")?;
            if base.len() > 256
                || base.is_empty()
                || base.starts_with('-')
                || base.contains(':')
                || base.contains('@')
                || base.chars().any(char::is_whitespace)
            {
                return Err("Invalid local base ref");
            }
            if base != "HEAD" {
                git.run(&["check-ref-format", "--allow-onelevel", base], 1024)
                    .await
                    .map_err(|_| "Invalid local base ref")?;
            }
            // Only named local branches/tags (or full refs), never revision expressions or URLs.
            let candidates = if base == "HEAD" || base.starts_with("refs/") {
                vec![base.to_owned()]
            } else {
                vec![format!("refs/heads/{base}"), format!("refs/tags/{base}")]
            };
            let mut resolved = None;
            for candidate in candidates {
                if let Ok(value) = git
                    .run(
                        &[
                            "rev-parse",
                            "--verify",
                            "--end-of-options",
                            &format!("{candidate}^{{commit}}"),
                        ],
                        1024,
                    )
                    .await
                {
                    resolved = Some(value);
                    break;
                }
            }
            let resolved = resolved.ok_or("Local base ref does not resolve to a commit")?;
            let commit = std::str::from_utf8(&resolved)
                .map_err(|_| "Invalid Git commit")?
                .trim();
            let head = git
                .run(&["rev-parse", "--verify", "HEAD^{commit}"], 1024)
                .await?;
            let head = std::str::from_utf8(&head)
                .map_err(|_| "Invalid Git commit")?
                .trim();
            identity = Some(commit.to_owned());
            let merge = git
                .run(&["merge-base", commit, head], 1024)
                .await
                .map_err(|_| "Base and HEAD have no available merge base")?;
            args.push(
                String::from_utf8(merge)
                    .map_err(|_| "Invalid Git commit")?
                    .trim()
                    .into(),
            );
            args.push(head.into());
        }
    }
    Ok((args, identity))
}

/// Validates a registered working-tree root and rejects configured conversion filters.
/// All Git operations retain the caller's deadline and cancellation receiver.
pub(crate) async fn validate_repository(git: &mut Git<'_>) -> Result<(), &'static str> {
    if !git.root.join(".git").exists() {
        return Err(
            "Workspace is not a Git working-tree root (jj-only workspaces are unsupported)",
        );
    }
    // The CLI option is deliberately required: older Git must fail rather than
    // silently ignore GIT_NO_LAZY_FETCH and fetch missing promisor objects.
    git.run(&["--version"], 1024).await.map_err(
        |_| "Local review requires Git with --no-lazy-fetch support; install or upgrade Git",
    )?;
    let top = git.run(&["rev-parse", "--show-toplevel"], 8192).await?;
    let top = std::str::from_utf8(&top)
        .map_err(|_| "Repository path is not UTF-8")?
        .trim_end_matches('\n');
    let root_path = git
        .root
        .canonicalize()
        .map_err(|_| "Workspace is unavailable")?;
    let git_path = Path::new(top)
        .canonicalize()
        .map_err(|_| "Git working tree is unavailable")?;
    if root_path != git_path || top.is_empty() {
        return Err("Workspace must be the root of a Git working tree");
    }
    // --no-textconv does not disable clean/process filters. Reject configured
    // drivers before any worktree conversion instead of changing their semantics.
    let keys = git
        .run(&["config", "--null", "--name-only", "--list"], MAX_LIST)
        .await?;
    if keys
        .split(|byte| *byte == 0)
        .any(|key| key.starts_with(b"filter."))
    {
        return Err("Repositories with configured Git filters are unsupported for local review");
    }
    Ok(())
}

/// Accepts only full lowercase SHA-1 or SHA-256 object IDs, never revision expressions.
fn validate_commit(commit: &str) -> Result<(), &'static str> {
    if !matches!(commit.len(), 40 | 64)
        || !commit
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid full commit ID");
    }
    Ok(())
}

/// Requires an actual local commit object rather than a tag that peels to one.
async fn require_commit(git: &mut Git<'_>, commit: &str) -> Result<(), &'static str> {
    let resolved = git
        .run(&["rev-parse", "--verify", "--end-of-options", commit], 1024)
        .await?;
    if resolved.strip_suffix(b"\n") != Some(commit.as_bytes()) {
        return Err("Commit ID must be full length for this repository");
    }
    let kind = git.run(&["cat-file", "-t", commit], 1024).await?;
    if kind != b"commit\n" {
        return Err("Selected object is not a commit");
    }
    Ok(())
}

/// Accounts for JSON escaping, both rename paths, notices, and array separators.
fn append_file(review: &mut Review, total: &mut usize, file: File) -> Result<bool, &'static str> {
    let size = serde_json::to_vec(&file)
        .map_err(|_| "Cannot encode review file")?
        .len()
        + 1;
    if *total + size > MAX_TOTAL {
        review.truncated = true;
        return Ok(false);
    }
    *total += size;
    review.files.push(file);
    Ok(true)
}

pub(crate) struct Git<'a> {
    pub(crate) root: &'a Path,
    pub(crate) deadline: Instant,
    pub(crate) cancelled: &'a mut oneshot::Receiver<()>,
}
impl Git<'_> {
    pub(crate) async fn strings(
        &mut self,
        args: &[String],
        limit: usize,
    ) -> Result<Vec<u8>, &'static str> {
        self.run(&args.iter().map(String::as_str).collect::<Vec<_>>(), limit)
            .await
    }
    /// Caps stdout while reading. Every exit path waits for the child before releasing admission.
    pub(crate) async fn run(
        &mut self,
        args: &[&str],
        limit: usize,
    ) -> Result<Vec<u8>, &'static str> {
        if Instant::now() >= self.deadline {
            return Err("Git review timed out");
        }
        if !matches!(
            self.cancelled.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ) {
            return Err("Git review cancelled");
        }
        let mut command = Command::new("git");
        command.current_dir(self.root).env_clear();
        // Keep only executable lookup, not Git overrides or credentials.
        if let Some(path) = std::env::var_os("PATH") {
            command.env("PATH", path);
        }
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_ALLOW_PROTOCOL", "")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_LITERAL_PATHSPECS", "1")
            .env("LC_ALL", "C")
            .args([
                "--no-pager",
                "--no-lazy-fetch",
                "-c",
                "protocol.allow=never",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.pager=cat",
                "-c",
                "diff.external=",
                "-c",
                "diff.renames=true",
            ])
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| "Git is unavailable")?;
        let stdout = child.stdout.take().ok_or("Git output unavailable")?;
        let operation = async {
            let mut bytes = Vec::new();
            stdout
                .take(limit as u64 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "Cannot read Git output")?;
            if bytes.len() > limit {
                return Err("Git output exceeds review limit");
            }
            let status = child.wait().await.map_err(|_| "Cannot wait for Git")?;
            if !status.success() && !(args.get(1) == Some(&"--no-index") && status.code() == Some(1)) {
                return Err("Git review failed; check repository and local refs");
            }
            Ok(bytes)
        };
        let result = tokio::select! {
            result = tokio::time::timeout_at(self.deadline, operation) => result.unwrap_or(Err("Git review timed out")),
            _ = &mut *self.cancelled => Err("Git review cancelled"),
        };
        if result.is_err() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numstat_retains_destination_counts_and_omits_binary_counts() {
        let parsed = parse_line_stats(
            b"12\t3\tplain\0\
              0\t0\t\0old\tname\0new\nname\0\
              -\t-\t\0old-bin\0new-bin\0\
              2\t1\t\xff\0",
        ).unwrap();
        assert_eq!(parsed.totals.added, 14);
        assert_eq!(parsed.totals.removed, 4);
        assert_eq!(parsed.totals.unavailable_files, 1);
        assert_eq!(parsed.files.len(), 3);
        assert_eq!(parsed.files[b"plain".as_slice()].added, 12);
        assert_eq!(parsed.files[b"plain".as_slice()].removed, 3);
        assert_eq!(parsed.files[b"new\nname".as_slice()].added, 0);
        assert!(!parsed.files.contains_key(b"old\tname".as_slice()));
        assert!(!parsed.files.contains_key(b"new-bin".as_slice()));
        assert_eq!(parsed.files[b"\xff".as_slice()].removed, 1);
        assert!(parse_line_stats(b"1\t2\t\0old\0").is_err());
        assert!(parse_line_stats(b"-\t2\tfile\0").is_err());
        assert!(parse_line_stats(b"18446744073709551615\t0\ta\x001\t0\tb\0").is_err());
    }

    #[test]
    fn line_totals_exclude_test_and_generated_paths_but_keep_file_counts() {
        let excluded = [
            "apps/web/test/view.tsx", "src/__tests__/view.ts", "tests/fixture.json",
            "spec/api.rb", "e2e/login.ts", "src/view.test.tsx", "src/view.spec.ts",
            "src/test_parser.py", "src/parser_test.go", "src/metadata_tests.rs",
            "src/generated/protocol.ts", "src/__generated__/api.ts", "api.generated.ts",
            "api.g.ts", "api.pb.go", "bundle.min.js", "bundle.js.map",
            "Cargo.lock", "bun.lock", "package-lock.json", "pnpm-lock.yaml",
        ];
        let mut records = b"3\t2\tsrc/main.rs\0".to_vec();
        for path in excluded {
            records.extend_from_slice(format!("10\t1\t{path}\0").as_bytes());
        }
        // Renames use their destination, and opaque bytes still count as source.
        records.extend_from_slice(b"7\t0\t\0old.ts\0src/generated/new.ts\0");
        records.extend_from_slice(b"2\t0\t\xff\0");
        let parsed = parse_line_stats(&records).unwrap();
        assert_eq!(parsed.totals.added, 5);
        assert_eq!(serde_json::to_value(&parsed.totals).unwrap()["totalAdded"], 222);
        assert_eq!(parsed.totals.removed, 2);
        assert_eq!(serde_json::to_value(&parsed.totals).unwrap()["totalRemoved"], 2 + excluded.len() as u64);
        for path in excluded {
            assert_eq!(parsed.files[path.as_bytes()].added, 10);
            assert_eq!(parsed.files[path.as_bytes()].removed, 1);
        }
        assert_eq!(parsed.files[b"src/generated/new.ts".as_slice()].added, 7);
        let source = parse_line_stats(b"4\t0\tsrc/testimonial.ts\x005\t0\tsrc/generated-helper.ts\0").unwrap();
        assert_eq!(source.totals.added, 9);
    }

    #[test]
    fn markdown_is_excluded_from_shown_totals_only() {
        let parsed = parse_line_stats(b"10\t4\tREADME.md\x002\t3\tdocs/Guide.MD\x005\t1\tsrc/md/parser.ts\x007\t2\tdocs/page.mdx\0").unwrap();
        assert_eq!((parsed.totals.added, parsed.totals.removed), (12, 3));
        assert_eq!((parsed.totals.total_added, parsed.totals.total_removed), (24, 10));
        assert_eq!((parsed.files[b"README.md".as_slice()].added, parsed.files[b"README.md".as_slice()].removed), (10, 4));
        assert_eq!((parsed.files[b"docs/Guide.MD".as_slice()].added, parsed.files[b"docs/Guide.MD".as_slice()].removed), (2, 3));
    }

    #[test]
    fn snapshot_digest_is_sha256() {
        assert_eq!(
            format!("{:x}", Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn response_budget_includes_escaped_metadata_and_untracked_notices() {
        let mut review = Review {
            files: Vec::new(),
            truncated: false,
            note: None,
            line_stats: None,
            next_cursor: None,
            snapshot_key: None,
        };
        let mut total = 1024;
        for _ in 0..100 {
            let file = File {
                path: "\t".repeat(4096),
                previous_path: Some("\n".repeat(4096)),
                status: "untracked",
                patch: Some("notice".into()),
                fingerprint: Some("token".into()),
                line_stats: None,
            };
            if !append_file(&mut review, &mut total, file).unwrap() {
                break;
            }
        }
        assert!(review.truncated);
        assert!(serde_json::to_vec(&review).unwrap().len() <= MAX_TOTAL);
        assert!(review.files.len() < 100);
    }

    #[test]
    fn metadata_pages_respect_escaped_json_budget_without_omitting_files() {
        let make_review = || Review {
            files: (0..100).map(|index| File {
                path: format!("{index}{}", "\u{0001}".repeat(1020)),
                previous_path: Some("\u{0002}".repeat(1024)),
                status: "renamed",
                patch: None,
                fingerprint: None,
                line_stats: None,
            }).collect(),
            truncated: false,
            note: None,
            line_stats: None,
            next_cursor: None,
            snapshot_key: None,
        };
        let mut first = make_review();
        paginate(&mut first, 0, 42).unwrap();
        let count = first.files.len();
        assert!((1..100).contains(&count));
        assert!(!first.truncated);
        assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_TOTAL);
        assert_eq!(first.next_cursor, Some(page_cursor(42, count)));
        let mut second = make_review();
        paginate(&mut second, count, 42).unwrap();
        assert_eq!(second.files.len() + count, 100);
        assert!(second.files[0].path.starts_with(&count.to_string()));
        assert!(!second.truncated);
        assert!(second.next_cursor.is_none());
        assert!(serde_json::to_vec(&second).unwrap().len() <= MAX_TOTAL);
        assert!(paginate(&mut make_review(), 100, 42).is_err());
    }

    #[tokio::test]
    async fn git_runner_bounds_output_deadlines_and_cancellation() {
        let (sender, mut cancelled) = oneshot::channel();
        let mut git = Git {
            root: Path::new("."),
            deadline: Instant::now() + Duration::from_secs(10),
            cancelled: &mut cancelled,
        };
        assert_eq!(
            git.run(&["--version"], 1).await.unwrap_err(),
            "Git output exceeds review limit"
        );
        git.deadline = Instant::now();
        assert_eq!(
            git.run(&["--version"], 1024).await.unwrap_err(),
            "Git review timed out"
        );
        git.deadline = Instant::now() + Duration::from_secs(10);
        drop(sender);
        assert_eq!(
            git.run(&["--version"], 1024).await.unwrap_err(),
            "Git review cancelled"
        );
    }
}

/// Opaque best-effort staleness token, never an authorization or cache identity.
pub(crate) fn fingerprint(path: &str, previous: Option<&str>, status: &str, patch: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    (path, previous, status, patch).hash(&mut hash);
    format!("{:016x}", hash.finish())
}
