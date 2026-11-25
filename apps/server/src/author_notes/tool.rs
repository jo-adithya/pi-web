//! Current-turn note operations. Mutations serialize with settlement and use optimistic versions.
use super::*;

pub(crate) const PREFIX: &str = "pi-web:review-note:v1:";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request { pub turn: String, pub operation: Operation }
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Operation {
    Record { id: String, version: Option<u64>, note: Note },
    List,
    Delete { id: String, version: u64 },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Note {
    path: String, side: Side, line: u32, quote: String, text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    chapter: Option<String>,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Side { New, Old }
#[derive(Clone)]
pub(super) struct Draft { pub version: u64, pub note: Value, pub hunk: String }

impl AuthorCapture {
    /// Records or manages only the active turn. Replacement captures fresh evidence atomically;
    /// versions reject stale updates/deletes, including reuse of a deleted ID. No saved history is edited.
    pub(crate) async fn tool(&self, root: &Path, request: Request) -> Result<Value, &'static str> {
        let mut state = self.0.state.lock().await;
        if state.turn != request.turn || state.closed { return Err("Review-note turn is closed or outdated"); }
        let before = state.before.as_ref().ok_or("No checkout evidence for this turn")?.clone();
        match request.operation {
            Operation::List => Ok(json!({"notes":state.drafts.iter().map(|(id, draft)| {
                let mut note = draft.note.clone(); note.as_object_mut().unwrap().remove("binding");
                json!({"id":id,"version":draft.version,"note":note})
            }).collect::<Vec<_>>()})),
            Operation::Delete { id, version } => {
                let draft = state.drafts.get(&id).ok_or("Note not found in this turn")?;
                if draft.version != version { return Err("Note version changed; list notes before retrying"); }
                state.version = state.version.checked_add(1).ok_or("Note version limit reached")?;
                state.drafts.remove(&id);
                Ok(json!({"deleted":id}))
            },
            Operation::Record { id, version, note } => {
                if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { return Err("Note ID must be 1–64 letters, digits, underscores or hyphens"); }
                if version != state.drafts.get(&id).map(|draft| draft.version) { return Err("Note version changed; list notes before retrying"); }
                if !state.drafts.contains_key(&id) && state.drafts.len() >= 8 { return Err("Automatic notes are limited to eight short notes"); }
                validate(&note)?;
                let mut draft = record(root, &before, note).await?;
                state.version = state.version.checked_add(1).ok_or("Note version limit reached")?;
                draft.version = state.version;
                state.drafts.insert(id.clone(), draft);
                Ok(json!({"id":id,"version":state.version,"status":"source captured; rationale unverified"}))
            },
        }
    }
}
fn validate(note: &Note) -> Result<(), &'static str> {
    validate_path(&note.path)?;
    if note.line == 0 || note.line > 1_000_000_000 || note.quote.is_empty() || note.quote.contains(['\n', '\0']) || note.quote.chars().count() > 240 { return Err("Choose an exact source line (1-based), quoted within 240 characters"); }
    if note.text.trim().is_empty() || note.text.contains('\0') || note.text.chars().count() > 600 || note.chapter.as_ref().is_some_and(|v| v.contains('\0') || v.len() > 80) { return Err("Use 1–600 characters of rationale and at most 80 UTF-8 bytes for a chapter"); }
    Ok(())
}
async fn record(root: &Path, before: &Checkout, note: Note) -> Result<Draft, &'static str> {
    let after = checkout(root).await?;
    if before.root != after.root || before.branch != after.branch || before.logical != after.logical { return Err("Checkout changed during implementation; start a new turn"); }
    let (_keep, mut cancelled) = oneshot::channel();
    let mut git = Git { root, deadline: Instant::now() + Duration::from_secs(5), cancelled: &mut cancelled };
    crate::local_review::validate_repository(&mut git).await?;
    let patch = patch(&mut git, &before.head, &note.path).await?;
    if patch.is_empty() { return Err("No tracked diff for this file; leave it unannotated rather than staging or committing just for a note"); }
    let hunks = hunks(&patch, Some(&note));
    let selected: Vec<_> = hunks.iter().filter(|(_, selected)| *selected).collect();
    if selected.len() != 1 || hunks.iter().filter(|(body, _)| body == &selected[0].0).count() != 1 { return Err("The quote and line must identify one unique changed hunk; inspect the diff and retry"); }
    let hunk = selected[0].0.clone();
    if checkout(root).await? != after { return Err("Checkout moved while recording the note; retry after edits settle"); }
    let fingerprint = format!("{:x}", Sha256::digest(patch.as_bytes()));
    let mut note = serde_json::to_value(note).unwrap();
    note["binding"] = json!({"checkoutKey":after.key,"base":before.head,"head":after.head,"fingerprint":fingerprint,"patch":patch,"recordedBy":"tool-v1"});
    Ok(Draft { version: 0, note, hunk })
}
/// Reads the full-index diff twice within the caller's deadline. Repository validation precedes this read.
pub(super) async fn patch(git: &mut Git<'_>, base: &str, path: &str) -> Result<String, &'static str> {
    let args = ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-color", "--no-renames", "--full-index", base, "--", path];
    let listing = ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-renames", "--name-only", "-z", base, "--", path];
    let names = git.run(&listing, 2048).await?;
    if !names.is_empty() && names != format!("{path}\0").as_bytes() { return Err("Choose one changed file, not a directory or path prefix"); }
    let bytes = git.run(&args, 65536).await?;
    if git.run(&args, 65536).await? != bytes || git.run(&listing, 2048).await? != names { return Err("Code moved during note capture; retry after edits settle"); }
    String::from_utf8(bytes).map_err(|_| "Author-note source is not text")
}
/// Whole-hunk identities preserve function context and every body line, excluding numeric header offsets.
pub(super) fn hunks(patch: &str, note: Option<&Note>) -> Vec<(String, bool)> {
    let mut result: Vec<(String, bool)> = Vec::new();
    let (mut old, mut new) = (0_u32, 0_u32);
    for line in patch.split_terminator('\n') {
        if let Some(header) = line.strip_prefix("@@ ") {
            let Some((coordinates, context)) = header.split_once(" @@") else { continue; };
            let mut numbers = coordinates.split_whitespace().map(|part| part.get(1..).and_then(|n| n.split(',').next()).and_then(|n| n.parse::<u32>().ok()));
            let (Some(Some(a)), Some(Some(b))) = (numbers.next(), numbers.next()) else { continue; };
            old = a; new = b;
            result.push((format!("@@{context}\n"), false));
        } else if let Some((body, selected)) = result.last_mut() {
            let side_line = match line.as_bytes().first() {
                Some(b'+') => { let value = Some((None, Some(new))); new = new.saturating_add(1); value },
                Some(b'-') => { let value = Some((Some(old), None)); old = old.saturating_add(1); value },
                Some(b' ') => { let value = Some((None, Some(new))); old = old.saturating_add(1); new = new.saturating_add(1); value },
                _ => None,
            };
            if let (Some(note), Some((a, b))) = (note, side_line) {
                let coordinate = match note.side { Side::Old => a, Side::New => b };
                *selected |= coordinate == Some(note.line) && line.get(1..) == Some(note.quote.as_str());
            }
            body.push_str(line); body.push('\n');
        }
    }
    result
}
