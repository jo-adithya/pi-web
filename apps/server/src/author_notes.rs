//! Server-owned provenance for optional author commentary. No model calls or repository writes.
use crate::{local_review::{Git, validate_path}, metadata::MetadataStore};
use p256::ecdsa::signature::{PrehashSignature, digest::Digest};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::{sync::{Mutex, watch, oneshot}, time::Instant};
type Sha256 = <p256::ecdsa::Signature as PrehashSignature>::Digest;
#[cfg(test)]
#[path = "author_notes_tests.rs"]
mod tests;

mod tool;
pub(crate) use tool::{Request, PREFIX};
use tool::Draft;

const RECORD: &str = "author-evidence.json";
const LIMIT: usize = 1024 * 1024;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct Checkout { root: String, branch: Option<String>, logical: String, head: String, pub key: String }
impl Checkout {
    /// Binds a physical worktree, Git branch/HEAD, and (when present) recorded jj change/commit.
    pub(crate) async fn read(git: &mut Git<'_>) -> Result<Self, &'static str> {
        let directory = git.run(&["rev-parse", "--absolute-git-dir"], 8192).await?;
        let head = String::from_utf8(git.run(&["rev-parse", "--verify", "HEAD"], 128).await?).map_err(|_| "Invalid checkout revision")?.trim().to_owned();
        if !matches!(head.len(), 40 | 64) || !head.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Checkout has no recorded HEAD"); }
        let branch = git.current_branch().await?;
        let mut logical = String::new();
        let mut revision = String::new();
        if git.root.join(".jj").is_dir() {
            let bytes = git.run_program("jj", &["--ignore-working-copy", "--at-op=@", "--no-pager", "--color=never", "log", "--no-graph", "-r", "@", "-T", "commit_id ++ \"\\n\" ++ change_id"], 1024).await?;
            let text = String::from_utf8(bytes).map_err(|_| "Invalid jj checkout identity")?;
            let (commit, change) = text.trim().split_once('\n').ok_or("Invalid jj checkout identity")?;
            revision = commit.into(); logical = change.into();
        }
        let canonical = std::fs::canonicalize(git.root).map_err(|_| "Checkout unavailable")?;
        let root = format!("{:x}", Sha256::digest(serde_json::to_vec(&(canonical, directory)).map_err(|_| "Cannot encode checkout")?));
        let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&(&root, &branch, &head, &logical, revision)).unwrap()));
        Ok(Self { root, branch, logical, head, key })
    }
}
async fn checkout(root: &Path) -> Result<Checkout, &'static str> {
    let (_keep, mut cancelled) = oneshot::channel();
    Checkout::read(&mut Git { root, deadline: Instant::now() + Duration::from_secs(3), cancelled: &mut cancelled }).await
}
#[derive(Clone, Serialize, Deserialize)]
struct Evidence { #[serde(default)] version: u8, turn: String, checkout: Checkout, notes: Value }
struct State {
    turn: String, before: Option<Checkout>, result: Option<Result<Arc<Evidence>, &'static str>>,
    drafts: std::collections::BTreeMap<String, Draft>, version: u64, closed: bool,
}
struct Inner { state: Mutex<State>, changed: watch::Sender<()>, store: std::sync::Weak<MetadataStore> }
/// One durable author-note capture per conversation. Begin before forwarding an opted-in prompt;
/// finish at settlement. Surviving handles retain evidence without owning the workspace writer lock.
#[derive(Clone)]
pub(crate) struct AuthorCapture(Arc<Inner>);
impl AuthorCapture {
    pub(crate) fn new(store: &Arc<MetadataStore>) -> Self {
        let restored = store.load_bounded_document::<Evidence>(RECORD, LIMIT);
        let (turn, result) = match restored {
            Ok(Some(value)) if value.version == 2 => (value.turn.clone(), Some(Ok(Arc::new(value)))),
            Ok(Some(_)) => (String::new(), Some(Err("Older note evidence has no tool-time capture; complete a new implementation turn"))),
            Ok(None) => (String::new(), Some(Err("No bound author notes. Complete a new implementation turn"))),
            Err(_) => (String::new(), Some(Err("Saved author-note evidence is unreadable"))),
        };
        let (changed, _) = watch::channel(());
        Self(Arc::new(Inner { state: Mutex::new(State { turn, before: None, result, drafts: Default::default(), version: 0, closed: true }), changed, store: Arc::downgrade(store) }))
    }
    /// Establishes provenance before forwarding a prompt; failures affect notes, never the prompt.
    pub(crate) async fn begin(&self, root: &Path, turn: String) {
        let mut state = self.0.state.lock().await;
        state.turn = turn; state.before = None; state.result = None;
        state.drafts.clear(); state.version = 0; state.closed = false;
        match checkout(root).await { Ok(value) => state.before = Some(value), Err(_) => state.result = Some(Err("Author notes require an identifiable Git checkout")) }
        // Invalidate the previous durable envelope before a new turn, even if this process later stops.
        let invalidated = if let Some(store) = self.0.store.upgrade() {
            matches!(tokio::task::spawn_blocking(move || store.remove_record(RECORD)).await, Ok(Ok(())))
        } else { false };
        if !invalidated { state.result = Some(Err("Could not invalidate previous author-note evidence")); state.before = None; }
        self.0.changed.send_replace(());
    }
    /// Freezes bounded source evidence at settlement; late runs cannot replace a newer turn.
    pub(crate) async fn finish(&self, root: &Path, turn: &str) {
        let (before, drafts) = {
            let mut state = self.0.state.lock().await;
            if state.turn != turn || state.closed { return; }
            state.closed = true;
            if state.result.is_some() { return; }
            (state.before.clone(), state.drafts.clone())
        };
        let result = match &before { Some(before) => capture(root, turn, before, &drafts).await.map(Arc::new), None => Err("Author-note provenance was not captured for this turn") };
        let mut state = self.0.state.lock().await;
        if state.turn != turn || !state.closed || state.result.is_some() { return; }
        state.result = Some(match result {
            Ok(value) => match self.0.store.upgrade() {
                Some(store) => { let saved = value.clone();
                    match tokio::task::spawn_blocking(move || store.save_document(RECORD, &*saved)).await {
                        Ok(Ok(())) => Ok(value), _ => Err("Could not persist author-note evidence"),
                    }
                },
                None => Err("Conversation closed before author-note evidence was saved"),
            },
            Err(error) => Err(error),
        });
        state.drafts.clear();
        self.0.changed.send_replace(());
    }
    /// Waits for settlement capture and rechecks the current checkout before serving server-owned evidence.
    pub(crate) async fn read(&self, root: &Path) -> Result<Value, &'static str> {
        let mut changed = self.0.changed.subscribe();
        let evidence = tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                if let Some(result) = &self.0.state.lock().await.result { return result.clone(); }
                changed.changed().await.map_err(|_| "Author-note capture unavailable")?;
            }
        }).await.map_err(|_| "Author-note capture is still pending; reopen Changes to retry")??;
        if checkout(root).await? != evidence.checkout { return Err("Author notes are outdated: the checkout, branch, or revision changed. Generate fresh notes"); }
        if self.0.state.lock().await.turn != evidence.turn { return Err("A newer turn started; previous author notes were not attached"); }
        Ok(json!({"turn": evidence.turn, "notes": evidence.notes}))
    }
}
async fn capture(root: &Path, turn: &str, before: &Checkout, drafts: &std::collections::BTreeMap<String, Draft>) -> Result<Evidence, &'static str> {
    let after = checkout(root).await?;
    if before.root != after.root || before.branch != after.branch || before.logical != after.logical { return Err("Checkout changed during implementation; author notes were not attached"); }
    let (_keep, mut cancelled) = oneshot::channel();
    let mut git = Git { root, deadline: Instant::now() + Duration::from_secs(5), cancelled: &mut cancelled };
    crate::local_review::validate_repository(&mut git).await?;
    let mut notes = Vec::new();
    let mut patches = std::collections::BTreeMap::new();
    for draft in drafts.values() {
        let mut note = draft.note.clone();
        let path = draft.note["path"].as_str().unwrap();
        if !patches.contains_key(path) { patches.insert(path, tool::patch(&mut git, &before.head, path).await?); }
        let matches = tool::hunks(&patches[path], None).iter().filter(|(body, _)| body == &draft.hunk).count();
        // Preserve the original tool-time binding even when final edits invalidate it.
        note["binding"]["outdated"] = json!(matches != 1 || note["binding"]["checkoutKey"] != after.key);
        notes.push(note);
    }
    if checkout(root).await? != after { return Err("Checkout moved during author-note capture"); }
    let evidence = Evidence { version: 2, turn: turn.into(), checkout: after, notes: Value::Array(notes) };
    if serde_json::to_vec(&evidence).map_err(|_| "Cannot encode author evidence")?.len() > LIMIT { return Err("Author-note evidence exceeds 1 MiB"); }
    Ok(evidence)
}
