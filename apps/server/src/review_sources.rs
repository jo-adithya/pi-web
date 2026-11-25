//! Explicit read-only imports. GitHub uses the operator's gh credentials; jj reads recorded revisions.
use crate::{local_review::{Git, validate_path}, review_notebook::File};
use p256::ecdsa::signature::{PrehashSignature, digest::Digest};
use serde::{Deserialize, Serialize};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, sync::oneshot, time::Instant};
type Sha256 = <p256::ecdsa::Signature as PrehashSignature>::Digest;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Request { Pr { url: String }, Jj { revision: String }, Author { #[serde(default)] automatic: bool }, Preferences { enabled: Option<bool> } }
#[derive(Serialize)]
pub(crate) struct Imported { pub label: String, pub source: String, pub files: Vec<File> }

/// Admits github.com PR identities only; URLs never become process flags, paths or arbitrary hosts.
fn pr_identity(url: &str) -> Result<String, &'static str> {
    let path = url.strip_prefix("https://github.com/").ok_or("Use a https://github.com/owner/repo/pull/number URL")?;
    let parts: Vec<_> = path.trim_end_matches('/').split('/').collect();
    if parts.len() != 4 || parts[2] != "pull" || parts[..2].iter().any(|part| part.is_empty() || part.starts_with('.') || part.len() > 100 || !part.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c)))
        || parts[3].parse::<u32>().ok().is_none_or(|n| n == 0) { return Err("Invalid GitHub pull request URL"); }
    Ok(format!("repos/{}/{}/pulls/{}", parts[0], parts[1], parts[3]))
}

/// Parses complete Git-style patches. Unsupported/ambiguous path encodings fail rather than misanchor comments.
pub(crate) fn parse_patch(patch: &str) -> Result<Vec<File>, &'static str> {
    if patch.len() > 4 * 1024 * 1024 || patch.contains('\0') { return Err("Imported diff exceeds 4 MiB or contains binary bytes"); }
    let mut sections: Vec<String> = vec![];
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") { sections.push(String::new()); }
        if let Some(section) = sections.last_mut() { section.push_str(line); }
        else if !line.trim().is_empty() { return Err("Expected a Git-style unified diff"); }
    }
    let mut paths = std::collections::HashSet::new();
    let mut files = vec![];
    for section in sections {
        if section.len() > 64 * 1024 || files.len() >= 1000 { return Err("Imported diff exceeds 1,000 files or 64 KiB per file; narrow the review"); }
        let mut old = None; let mut new = None;
        for line in section.lines().take_while(|line| !line.starts_with("@@ ")) {
            if let Some(value) = line.strip_prefix("--- a/") { old = Some(value.to_owned()); }
            if let Some(value) = line.strip_prefix("+++ b/") { new = Some(value.to_owned()); }
            if let Some(value) = line.strip_prefix("rename from ") { old = Some(value.to_owned()); }
            if let Some(value) = line.strip_prefix("rename to ") { new = Some(value.to_owned()); }
        }
        if old.is_none() && new.is_none() {
            let header = section.lines().next().unwrap_or("");
            let Some((left, right)) = header.strip_prefix("diff --git a/").and_then(|header| header.split_once(" b/")) else { return Err("This patch uses unsupported quoted paths. Review it through the local file view"); };
            if left != right { return Err("Ambiguous imported path; use the local file view"); }
            old = Some(left.to_owned()); new = Some(right.to_owned());
        }
        let path = new.as_ref().or(old.as_ref()).ok_or("Missing patch path")?.clone();
        if path.contains('"') || validate_path(&path).is_err() || old.as_ref().is_some_and(|path| validate_path(path).is_err()) || !paths.insert(path.clone()) { return Err("Invalid or duplicate imported path"); }
        let status = if section.lines().any(|line| line == "+++ /dev/null") { "deleted" } else if section.lines().any(|line| line == "--- /dev/null") { "added" } else if old != new { "renamed" } else { "modified" };
        let fingerprint = format!("{:x}", Sha256::digest(section.as_bytes()));
        files.push(File { path, previous_path: old.filter(|previous| new.as_ref().is_some_and(|next| next != previous)), status: status.into(), patch: section, fingerprint, reviewed: false, checkout_key: None });
    }
    Ok(files)
}

async fn gh(root: &Path, args: &[&str], deadline: Instant, cancelled: &mut oneshot::Receiver<()>) -> Result<Vec<u8>, &'static str> {
    let mut child = Command::new("gh").current_dir(root).args(args)
        .env("GH_PROMPT_DISABLED", "1").env("GH_PAGER", "cat").env("GH_HOST", "github.com")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true)
        .spawn().map_err(|_| "GitHub import requires an installed, authenticated gh CLI")?;
    let stdout = child.stdout.take().ok_or("GitHub output unavailable")?;
    let work = async {
        let mut bytes = vec![];
        stdout.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes).await.map_err(|_| "Cannot read GitHub response")?;
        if bytes.len() > 4 * 1024 * 1024 { return Err("GitHub response exceeds 4 MiB; review locally"); }
        if !child.wait().await.map_err(|_| "Cannot wait for GitHub")?.success() { return Err("GitHub request failed; check gh authentication and repository access"); }
        Ok(bytes)
    };
    let result = tokio::select! { result = tokio::time::timeout_at(deadline, work) => result.unwrap_or(Err("GitHub import timed out")), _ = cancelled => Err("GitHub import cancelled") };
    if result.is_err() { let _ = child.kill().await; let _ = child.wait().await; }
    result
}

/// Imports a pinned PR diff or a jj revision without checkout, fetch, staging or repository writes.
/// jj's ignore-working-copy mode reads its recorded tree; unrecorded disk edits are excluded.
pub(crate) async fn import(root: &Path, session: &str, input: Request, mut cancelled: oneshot::Receiver<()>) -> Result<serde_json::Value, &'static str> {
    let deadline = Instant::now() + Duration::from_secs(30);
    match input {
        Request::Preferences { .. } => Err("Preferences require the workspace manager"),
        Request::Author { automatic: true } => Err("Automatic author notes require server-captured provenance"),
        Request::Author { automatic: false } => {
            let root = root.to_owned();
            if !crate::catalog::valid_id(session) { return Err("Invalid session"); }
            let path = ".pi/review-notes.json";
            let bytes = tokio::task::spawn_blocking(move || crate::workspace_files::read(&root, path, 64 * 1024)).await
                .map_err(|_| "Author note reader failed")?.map_err(|_| "No readable author-note file yet (must be a regular file, at most 64 KiB)")?;
            serde_json::from_slice(&bytes).map_err(|_| "Author notes must be valid JSON")
        }
        Request::Jj { revision } => {
            if revision.is_empty() || revision.len() > 256 || revision.starts_with('-') || revision.chars().any(char::is_control) { return Err("Choose a jj revision of at most 256 characters"); }
            let mut vcs = Git { root, deadline, cancelled: &mut cancelled };
            let patch = vcs.run_program("jj", &["--ignore-working-copy", "--no-pager", "--color=never", "diff", "--git", "--revision", &revision], 4 * 1024 * 1024).await?;
            let patch = std::str::from_utf8(&patch).map_err(|_| "Revision diff is not UTF-8")?;
            serde_json::to_value(Imported { label: format!("jj {revision}"), source: format!("jj recorded revision {revision}; unrecorded working-copy edits excluded"), files: parse_patch(patch)? }).map_err(|_| "Cannot encode imported review")
        }
        Request::Pr { url } => {
            let endpoint = pr_identity(&url)?;
            let args = ["api", "--hostname", "github.com", &endpoint];
            let before: serde_json::Value = serde_json::from_slice(&gh(root, &args, deadline, &mut cancelled).await?).map_err(|_| "Invalid PR metadata")?;

            let sha = |value: &serde_json::Value, side: &str| value[side]["sha"].as_str().filter(|sha| sha.len() == 40 && sha.bytes().all(|c| c.is_ascii_hexdigit())).map(str::to_owned);
            let (base, head) = (sha(&before, "base"), sha(&before, "head"));
            let (Some(base), Some(head)) = (base, head) else { return Err("Invalid PR commit identities"); };
            let repository = endpoint.split_once("/pulls/").ok_or("Invalid PR identity")?.0;
            let comparison = format!("{repository}/compare/{base}...{head}");
            let patch = gh(root, &["api", "--hostname", "github.com", &comparison, "-H", "Accept: application/vnd.github.diff"], deadline, &mut cancelled).await?;
            let files = parse_patch(std::str::from_utf8(&patch).map_err(|_| "PR diff is not UTF-8")?)?;
            if before["changed_files"].as_u64() != Some(files.len() as u64) { return Err("GitHub omitted files from this diff. Review the complete checkout locally"); }
            serde_json::to_value(Imported { label: format!("PR {}", url.rsplit('/').next().unwrap_or("")), source: format!("{url} · {}...{}; imported snapshot, checkout not verified", base, head), files }).map_err(|_| "Cannot encode imported review")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_additions_deletions_renames_and_rejects_unsafe_paths() {
        let files = parse_patch("diff --git a/a b/a\n--- /dev/null\n+++ b/a\n@@ -0,0 +1 @@\n+new\ndiff --git a/b b/b\n--- a/b\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n").unwrap();
        assert_eq!(files.len(), 2); assert_eq!(files[0].status, "added"); assert_eq!(files[1].status, "deleted");
        let renamed = parse_patch("diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n").unwrap();
        assert_eq!(renamed[0].previous_path.as_deref(), Some("old"));
        assert!(parse_patch("diff --git a/../secret b/../secret\n").is_err());
        assert!(parse_patch("diff --git a/a b/a\n\ndiff --git a/a b/a\n").is_err());
    }
    #[test]
    fn restricts_pr_destinations() {
        assert_eq!(pr_identity("https://github.com/team/repo/pull/12").unwrap(), "repos/team/repo/pulls/12");
        for url in ["http://github.com/a/b/pull/1", "https://evil.test/a/b/pull/1", "https://github.com/a/b/pull/1?x", "https://github.com/../b/pull/1"] { assert!(pr_identity(url).is_err()); }
    }
}
