//! Bounded, runtime-only before/after content comparisons. No Git index or history writes.
use super::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex},
};

const CAPTURE_BYTES: usize = 4 * 1024 * 1024;
const CAPTURE_FILES: usize = 1000;
const FILE_BYTES: usize = 256 * 1024;

#[derive(Clone)]
enum Content {
    Missing,
    Text(Vec<u8>),
    Omitted,
}
struct Baseline {
    head: String,
    dirty: BTreeMap<String, Content>,
}
#[derive(Default)]
struct State {
    generation: u64,
    before: Option<Arc<Baseline>>,
    result: Option<Result<Arc<Review>, &'static str>>,
}
/// One latest turn per runtime; late workers cannot replace a newer turn.
#[derive(Clone, Default)]
pub(crate) struct TurnChanges(Arc<Mutex<State>>);
impl TurnChanges {
    pub(crate) fn reset(&self) {
        let mut state = self.0.lock().unwrap();
        state.generation += 1;
        state.before = None;
        state.result = None;
    }
    /// Runs before forwarding the prompt. Failure disables comparison, not the agent.
    pub(crate) async fn begin(&self, root: &Path) {
        self.reset();
        let generation = self.0.lock().unwrap().generation;
        let captured = baseline(root).await;
        let mut state = self.0.lock().unwrap();
        if state.generation != generation {
            return;
        }
        match captured {
            Ok(before) => state.before = Some(Arc::new(before)),
            Err(error) => state.result = Some(Err(error)),
        }
    }
    pub(crate) fn generation(&self) -> u64 {
        self.0.lock().unwrap().generation
    }
    /// Captures the settled filesystem; manual/concurrent edits during the run are included.
    pub(crate) async fn finish(&self, root: &Path, expected: u64) {
        let (generation, before) = {
            let state = self.0.lock().unwrap();
            (state.generation, state.before.clone())
        };
        if generation != expected {
            return;
        }
        let Some(before) = before else {
            return;
        };
        let result = comparison(root, &before).await.map(Arc::new);
        let mut state = self.0.lock().unwrap();
        if state.generation == generation {
            state.result = Some(result);
            state.before = None;
        }
    }
    /// Copies bounded file metadata for the expected settled turn. Concurrent edits are
    /// included; stale or unavailable captures stay explicitly unavailable.
    pub(crate) fn response_files(&self, expected: u64, recorded: &mut crate::response_format::RecordedEvidence) {
        use crate::response_format::{FileCaptureState, FileChangeKind, RecordedFile};
        let state = self.0.lock().unwrap();
        if state.generation != expected { return; }
        let Some(Ok(review)) = &state.result else { return; };
        recorded.files_state = FileCaptureState::Captured;
        recorded.omitted_files = review.truncated;
        for file in &review.files {
            if recorded.files.len() == 8 || file.path.len() > 512 || file.path.chars().any(char::is_control) {
                recorded.omitted_files = true; continue;
            }
            let change = match file.status { "added" => FileChangeKind::Added, "deleted" => FileChangeKind::Deleted, _ => FileChangeKind::Modified };
            let counts = file.patch.as_ref().filter(|patch| patch.starts_with("--- a/")).map(|patch| {
                let hunks = patch.find("\n@@").map_or("", |index| &patch[index + 1..]);
                (hunks.lines().filter(|line| line.starts_with('+')).count() as u32, hunks.lines().filter(|line| line.starts_with('-')).count() as u32)
            });
            recorded.files.push(RecordedFile { id: format!("file:{}", recorded.files.len()), path: file.path.clone(), change,
                added: counts.map(|value| value.0), removed: counts.map(|value| value.1) });
        }
    }

    pub(crate) fn review(&self, request: &Request) -> Result<Review, &'static str> {
        if request.base.is_some()
            || request.commit.is_some()
            || request.path.is_some() && request.cursor.is_some()
        {
            return Err("Invalid last-turn request");
        }
        let state = self.0.lock().unwrap();
        let result = state
            .result
            .as_ref()
            .ok_or("No completed turn snapshot. Finish a new turn, then refresh Last turn")?
            .as_ref()
            .map_err(|error| *error)?;
        let mut review = (**result).clone();
        if let Some(path) = &request.path {
            validate_path(path)?;
            review.files.retain(|file| file.path == *path);
            if review.files.is_empty() {
                return Err("This file is not in the captured turn");
            }
            review.line_stats = None;
        } else {
            let offset = match request.cursor.as_deref() {
                None => 0,
                Some(cursor) => {
                    let offset = cursor
                        .split_once(':')
                        .and_then(|(n, _)| n.parse::<usize>().ok())
                        .ok_or("Invalid turn cursor")?;
                    if cursor != page_cursor(state.generation, offset) {
                        return Err("Turn changed; refresh review");
                    }
                    offset
                }
            };
            paginate(&mut review, offset, state.generation)?;
        }
        Ok(review)
    }
}

async fn changed(git: &mut Git<'_>, head: &str) -> Result<BTreeSet<String>, &'static str> {
    let tracked = git
        .run(
            &[
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--ignore-submodules=all",
                "--no-renames",
                "--name-only",
                "-z",
                head,
                "--",
            ],
            MAX_LIST,
        )
        .await?;
    let untracked = git
        .run(
            &["ls-files", "--others", "--exclude-standard", "-z"],
            MAX_LIST,
        )
        .await?;
    let mut paths = BTreeSet::new();
    for path in tracked
        .split(|b| *b == 0)
        .chain(untracked.split(|b| *b == 0))
        .filter(|p| !p.is_empty())
    {
        let path =
            std::str::from_utf8(path).map_err(|_| "Turn snapshot contains non-UTF-8 filenames")?;
        validate_path(path)?;
        paths.insert(path.to_owned());
        if paths.len() > CAPTURE_FILES {
            return Err("Turn snapshot exceeds 1,000 changed files");
        }
    }
    Ok(paths)
}
async fn current(root: &Path, path: &str) -> Content {
    let root = root.to_owned();
    let path = path.to_owned();
    match tokio::task::spawn_blocking(move || {
        crate::workspace_files::read(&root, &path, FILE_BYTES)
    })
    .await
    {
        Ok(Ok(bytes)) if !bytes.contains(&0) && std::str::from_utf8(&bytes).is_ok() => {
            Content::Text(bytes)
        }
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => Content::Missing,
        _ => Content::Omitted,
    }
}
async fn baseline(root: &Path) -> Result<Baseline, &'static str> {
    let (_cancel, mut cancelled) = oneshot::channel();
    let mut git = Git {
        root,
        deadline: Instant::now() + Duration::from_secs(3),
        cancelled: &mut cancelled,
    };
    validate_repository(&mut git).await?;
    let head = String::from_utf8(git.run(&["rev-parse", "--verify", "HEAD"], 128).await?)
        .map_err(|_| "Invalid turn base")?
        .trim()
        .to_owned();
    validate_commit(&head)?;
    let mut dirty = BTreeMap::new();
    let mut size = 0;
    for path in changed(&mut git, &head).await? {
        if Instant::now() >= git.deadline {
            return Err("Turn capture timed out");
        }
        let content = current(root, &path).await;
        if let Content::Text(bytes) = &content {
            size += bytes.len();
        }
        if size > CAPTURE_BYTES {
            return Err("Turn baseline exceeds 4 MiB");
        }
        dirty.insert(path, content);
    }
    Ok(Baseline { head, dirty })
}
async fn original(git: &mut Git<'_>, head: &str, path: &str) -> Content {
    let Ok(tree) = git.run(&["ls-tree", head, "--", path], 2048).await else {
        return Content::Omitted;
    };
    if tree.is_empty() {
        return Content::Missing;
    }
    if !tree.starts_with(b"100644 blob ") && !tree.starts_with(b"100755 blob ") {
        return Content::Omitted;
    }
    match git
        .run(&["cat-file", "blob", &format!("{head}:{path}")], FILE_BYTES)
        .await
    {
        Ok(bytes) if !bytes.contains(&0) && std::str::from_utf8(&bytes).is_ok() => {
            Content::Text(bytes)
        }
        _ => Content::Omitted,
    }
}
struct Scratch(std::path::PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
async fn comparison(root: &Path, before: &Baseline) -> Result<Review, &'static str> {
    use std::os::unix::fs::DirBuilderExt;
    let (_cancel, mut cancelled) = oneshot::channel();
    let mut git = Git {
        root,
        deadline: Instant::now() + Duration::from_secs(5),
        cancelled: &mut cancelled,
    };
    validate_repository(&mut git).await?;
    let mut paths = changed(&mut git, &before.head).await?;
    paths.extend(before.dirty.keys().cloned());
    let directory = std::env::temp_dir().join(format!(
        "pi-web-turn-{}",
        crate::config::identity().map_err(|_| "Cannot create turn snapshot")?
    ));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&directory)
        .map_err(|_| "Cannot create turn snapshot")?;
    let scratch = Scratch(directory);
    let old_path = scratch.0.join("before");
    let new_path = scratch.0.join("after");
    let (current_branch, jj_context) = git.checkout_context().await?;
    let mut review = Review { files: Vec::new(), truncated: false, note: Some("Captured from turn start to settlement, including any concurrent edits. Content only; not an attribution or filesystem transaction. Snapshots are runtime-only. Binary, symlink and oversized content is omitted.".into()), line_stats: None, next_cursor: None, snapshot_key: None, current_branch, jj_context };
    let mut total = 1024 + serde_json::to_vec(&review).map_err(|_| "Cannot encode review metadata")?.len();
    for path in paths {
        if Instant::now() >= git.deadline {
            return Err("Turn comparison timed out");
        }
        let old = match before.dirty.get(&path) {
            Some(content) => content.clone(),
            None => original(&mut git, &before.head, &path).await,
        };
        let new = current(root, &path).await;
        let (old_bytes, new_bytes, status) = match (&old, &new) {
            (Content::Missing, Content::Missing) => continue,
            (Content::Text(a), Content::Text(b)) if a == b => continue,
            (Content::Text(a), Content::Text(b)) => (a.as_slice(), b.as_slice(), "modified"),
            (Content::Missing, Content::Text(b)) => (&[][..], b.as_slice(), "added"),
            (Content::Text(a), Content::Missing) => (a.as_slice(), &[][..], "deleted"),
            _ => {
                review.truncated = true;
                continue;
            }
        };
        std::fs::write(&old_path, old_bytes).map_err(|_| "Cannot capture old turn content")?;
        std::fs::write(&new_path, new_bytes).map_err(|_| "Cannot capture new turn content")?;
        let output = git
            .run(
                &[
                    "diff",
                    "--no-index",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-color",
                    "--",
                    old_path.to_str().unwrap(),
                    new_path.to_str().unwrap(),
                ],
                MAX_PATCH,
            )
            .await;
        let patch = match output {
            Ok(bytes) => {
                let patch = String::from_utf8(bytes).map_err(|_| "Invalid turn diff")?;
                let hunk = patch.find("@@").map(|index| &patch[index..]).unwrap_or("");
                format!("--- a/{path}\n+++ b/{path}\n{hunk}")
            }
            Err("Git output exceeds review limit") => {
                review.truncated = true;
                "Patch exceeds 64 KiB; content omitted.\n".into()
            }
            Err(error) => return Err(error),
        };
        let fingerprint = fingerprint(&path, None, status, &patch);
        if !append_file(
            &mut review,
            &mut total,
            File {
                path,
                previous_path: None,
                status,
                fingerprint: Some(fingerprint),
                patch: Some(patch),
                line_stats: None,
            },
        )? {
            break;
        }
    }
    Ok(review)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn git(root: &Path, args: &[&str]) {
        assert!(
            std::process::Command::new("git")
                .current_dir(root)
                .args(args)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    fn fixture() -> Scratch {
        let root = std::env::temp_dir().join(format!(
            "pi-web-turn-test-{}",
            crate::config::identity().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        git(&root, &["init", "-q"]);
        std::fs::write(root.join("main.ts"), "initial\n").unwrap();
        std::fs::write(root.join("other.ts"), "untouched\n").unwrap();
        git(&root, &["add", "."]);
        git(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "initial",
            ],
        );
        Scratch(root)
    }
    fn request() -> Request {
        Request {
            scope: Scope::Turn,
            base: None,
            commit: None,
            path: None,
            cursor: None,
        }
    }
    #[tokio::test]
    async fn comparison_excludes_preexisting_edits_and_is_frozen_after_settlement() {
        let root = fixture();
        git(&root.0, &["checkout", "-qb", "captured-branch"]);
        std::fs::write(root.0.join("main.ts"), "already dirty\n").unwrap();
        std::fs::write(root.0.join("existing.ts"), "already untracked\n").unwrap();
        let turns = TurnChanges::default();
        turns.begin(&root.0).await;
        std::fs::write(root.0.join("main.ts"), "this turn\n").unwrap();
        std::fs::write(root.0.join("new.ts"), "created this turn\n").unwrap();
        std::fs::remove_file(root.0.join("other.ts")).unwrap();
        turns.finish(&root.0, turns.generation()).await;
        let review = turns.review(&request()).unwrap();
        assert_eq!(review.files.len(), 3);
        assert_eq!(review.current_branch.as_deref(), Some("captured-branch"));
        let mut recorded = crate::response_format::RecordedEvidence::default();
        turns.response_files(turns.generation(), &mut recorded);
        assert_eq!(recorded.files.len(), 3);
        let file = recorded.files.iter().find(|file| file.path == "main.ts").unwrap();
        assert_eq!((file.added, file.removed), (Some(1), Some(1)));
        assert!(!serde_json::to_string(&recorded).unwrap().contains("already dirty"));
        let main = review
            .files
            .iter()
            .find(|file| file.path == "main.ts")
            .unwrap()
            .patch
            .as_ref()
            .unwrap();
        assert!(main.contains("-already dirty\n+this turn"));
        assert!(!main.contains("-initial"));
        assert!(
            review
                .files
                .iter()
                .any(|file| file.path == "new.ts" && file.status == "added")
        );
        assert!(
            review
                .files
                .iter()
                .any(|file| file.path == "other.ts" && file.status == "deleted")
        );
        std::fs::write(root.0.join("main.ts"), "after settlement\n").unwrap();
        git(&root.0, &["checkout", "-qb", "later-branch"]);
        turns.finish(&root.0, turns.generation()).await;
        let frozen = turns.review(&request()).unwrap();
        assert_eq!(frozen.current_branch.as_deref(), Some("captured-branch"), "branch metadata stays with the captured turn");
        assert_eq!(
            frozen
                .files
                .iter()
                .find(|file| file.path == "main.ts")
                .unwrap()
                .patch
                .as_ref()
                .unwrap(),
            main
        );
        let old = turns.generation();
        turns.reset();
        assert!(turns.review(&request()).is_err());
        let mut unavailable = crate::response_format::RecordedEvidence::default();
        turns.response_files(old, &mut unavailable);
        assert_eq!(unavailable.files_state, crate::response_format::FileCaptureState::Unavailable);
        assert!(unavailable.files.is_empty());
    }
    #[tokio::test]
    async fn stale_capture_cannot_replace_a_new_turn_and_symlinks_are_not_read() {
        let root = fixture();
        let turns = TurnChanges::default();
        turns.begin(&root.0).await;
        let previous = turns.generation();
        turns.begin(&root.0).await;
        std::os::unix::fs::symlink("main.ts", root.0.join("link.ts")).unwrap();
        std::fs::write(root.0.join("main.ts"), "new turn\n").unwrap();
        turns.finish(&root.0, previous).await;
        assert!(turns.review(&request()).is_err());
        turns.finish(&root.0, turns.generation()).await;
        let review = turns.review(&request()).unwrap();
        assert!(review.truncated);
        assert_eq!(review.files.len(), 1);
        assert!(
            review.files[0]
                .patch
                .as_ref()
                .unwrap()
                .contains("+new turn")
        );
    }
}
