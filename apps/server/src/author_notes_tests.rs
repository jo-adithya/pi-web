//! Real local VCS fixtures exercise note operations and provenance without a model.
use super::*;
use std::{fs, path::PathBuf, process::Command};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pi-note-binding-{}", crate::config::identity().unwrap()));
        fs::create_dir(&root).unwrap(); let fixture = Self(root);
        fixture.git(&["init", "-b", "main"]);
        fs::write(fixture.0.join("a.ts"), "context\nold\n").unwrap(); fixture.git(&["add", "a.ts"]);
        fixture.git(&["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
        fixture
    }
    fn git(&self, args: &[&str]) {
        let output = Command::new("git").current_dir(&self.0).args(args).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
    fn store(&self) -> Arc<MetadataStore> { Arc::new(MetadataStore::open(&self.0.join("private")).unwrap()) }
    fn change(&self) { fs::write(self.0.join("a.ts"), "context\nnew\n").unwrap(); }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn note() -> Value { json!({"path":"a.ts","side":"new","line":2,"quote":"new","text":"Keep retries."}) }
fn request(turn: &str, operation: Value) -> Request { serde_json::from_value(json!({"turn":turn,"operation":operation})).unwrap() }
fn record(turn: &str, id: &str, version: Option<u64>) -> Request { request(turn, json!({"action":"record","id":id,"version":version,"note":note()})) }

#[tokio::test]
async fn raw_agent_files_cannot_claim_tool_time_evidence() {
    let f = Fixture::new(); let store = f.store(); let notes = AuthorCapture::new(&store);
    notes.begin(&f.0, "epoch:1".into()).await; f.change();
    fs::create_dir_all(f.0.join(".pi/review-notes")).unwrap();
    fs::write(f.0.join(".pi/review-notes/session.json"), json!({"turn":"epoch:1","notes":[note()]}).to_string()).unwrap();
    notes.finish(&f.0, "epoch:1").await;
    assert!(notes.read(&f.0).await.unwrap()["notes"].as_array().unwrap().is_empty(), "Only tool-recorded notes may receive automatic provenance");
}

#[tokio::test]
async fn captures_server_evidence_restores_it_and_rejects_same_head_branch_switch() {
    let f = Fixture::new(); let store = f.store(); let notes = AuthorCapture::new(&store);
    notes.begin(&f.0, "epoch:1".into()).await; f.change();
    notes.tool(&f.0, record("epoch:1", "retry", None)).await.unwrap();
    notes.finish(&f.0, "epoch:1").await;
    let first = notes.read(&f.0).await.unwrap();
    assert!(first["notes"][0]["binding"]["patch"].as_str().unwrap().contains("+new"));
    assert_eq!(first["notes"][0]["binding"]["checkoutKey"], checkout(&f.0).await.unwrap().key);
    assert_eq!(first["notes"][0]["binding"]["base"], first["notes"][0]["binding"]["head"]);
    assert_eq!(first["notes"][0]["binding"]["recordedBy"], "tool-v1");
    assert_eq!(first["notes"][0]["binding"]["outdated"], false);
    fs::write(f.0.join("a.ts"), "changed context\nnew\n").unwrap();
    assert_eq!(notes.read(&f.0).await.unwrap(), first, "Later disk edits must not rewrite evidence");
    assert_eq!(AuthorCapture::new(&store).read(&f.0).await.unwrap(), first);
    f.git(&["checkout", "-b", "other"]); assert!(notes.read(&f.0).await.unwrap_err().contains("outdated"));
    f.git(&["checkout", "main"]); assert_eq!(notes.read(&f.0).await.unwrap(), first);
    f.git(&["add", "a.ts"]); f.git(&["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "advance"]);
    assert!(notes.read(&f.0).await.unwrap_err().contains("outdated"));
}

#[tokio::test]
async fn later_edits_are_flagged_without_rebinding_the_recorded_note() {
    let f = Fixture::new(); let store = f.store(); let notes = AuthorCapture::new(&store);
    notes.begin(&f.0, "epoch:1".into()).await; f.change();
    notes.tool(&f.0, record("epoch:1", "retry", None)).await.unwrap();
    fs::write(f.0.join("a.ts"), "changed context\nnew\n").unwrap();
    notes.finish(&f.0, "epoch:1").await;
    let result = notes.read(&f.0).await.unwrap();
    assert_eq!(result["notes"][0]["binding"]["outdated"], true);
    assert!(!result["notes"][0]["binding"]["patch"].as_str().unwrap().contains("changed context"));
    f.change();
    assert_eq!(notes.read(&f.0).await.unwrap()["notes"][0]["binding"]["outdated"], true);
}

#[tokio::test]
async fn replacement_delete_and_id_reuse_require_current_versions_and_never_edit_saved_evidence() {
    let f = Fixture::new(); let store = f.store(); let notes = AuthorCapture::new(&store);
    notes.begin(&f.0, "epoch:1".into()).await; f.change();
    let first = notes.tool(&f.0, record("epoch:1", "retry", None)).await.unwrap(); assert_eq!(first["version"], 1);
    let listed = notes.tool(&f.0, request("epoch:1", json!({"action":"list"}))).await.unwrap();
    assert_eq!(listed["notes"][0]["note"], note()); assert!(!listed.to_string().contains("binding"));
    assert!(notes.tool(&f.0, record("epoch:1", "retry", None)).await.unwrap_err().contains("version"));
    assert!(notes.tool(&f.0, request("epoch:1", json!({"action":"delete","id":"retry","version":2}))).await.is_err());
    let mut updated = record("epoch:1", "retry", Some(1));
    if let tool::Operation::Record { ref mut note, .. } = updated.operation { *note = serde_json::from_value(json!({"path":"a.ts","side":"new","line":2,"quote":"new","text":"Updated rationale."})).unwrap(); }
    assert_eq!(notes.tool(&f.0, updated).await.unwrap()["version"], 2);
    notes.tool(&f.0, request("epoch:1", json!({"action":"delete","id":"retry","version":2}))).await.unwrap();
    assert_eq!(notes.tool(&f.0, record("epoch:1", "retry", None)).await.unwrap()["version"], 4);
    assert!(notes.tool(&f.0, request("epoch:1", json!({"action":"delete","id":"retry","version":1}))).await.is_err());
    notes.finish(&f.0, "epoch:1").await;
    let saved = notes.read(&f.0).await.unwrap();
    assert!(notes.tool(&f.0, request("epoch:1", json!({"action":"delete","id":"retry","version":4}))).await.unwrap_err().contains("closed"));
    assert_eq!(notes.read(&f.0).await.unwrap(), saved);
}

#[tokio::test]
async fn rejects_wrong_quotes_old_turns_over_budget_notes_and_moving_checkouts() {
    let f = Fixture::new(); let store = f.store(); let notes = AuthorCapture::new(&store);
    notes.begin(&f.0, "epoch:1".into()).await; f.change();
    assert!(notes.tool(&f.0, record("old:1", "retry", None)).await.is_err());
    let mut wrong = note(); wrong["quote"] = json!("not source");
    assert!(notes.tool(&f.0, request("epoch:1", json!({"action":"record","id":"wrong","note":wrong}))).await.unwrap_err().contains("quote"));
    let mut huge = note(); huge["text"] = json!("x".repeat(601));
    assert!(notes.tool(&f.0, request("epoch:1", json!({"action":"record","id":"huge","note":huge}))).await.is_err());
    for i in 0..8 { notes.tool(&f.0, record("epoch:1", &format!("note-{i}"), None)).await.unwrap(); }
    assert!(notes.tool(&f.0, record("epoch:1", "ninth", None)).await.unwrap_err().contains("eight"));
    f.git(&["checkout", "-b", "other"]);
    assert!(notes.tool(&f.0, record("epoch:1", "note-0", Some(1))).await.unwrap_err().contains("Checkout changed"));
    notes.finish(&f.0, "epoch:1").await;
    assert!(notes.read(&f.0).await.unwrap_err().contains("Checkout changed"));
}

#[tokio::test]
async fn worktrees_are_distinct_and_new_turns_invalidate_durable_old_evidence() {
    let f = Fixture::new(); let store = f.store(); let notes = AuthorCapture::new(&store);
    let other = f.0.join("worktree"); f.git(&["worktree", "add", "--detach", other.to_str().unwrap(), "HEAD"]);
    let first = checkout(&f.0).await.unwrap(); let second = checkout(&other).await.unwrap();
    assert_eq!(first.head, second.head); assert_ne!(first.key, second.key);
    notes.begin(&f.0, "epoch:1".into()).await; f.change();
    notes.tool(&f.0, record("epoch:1", "retry", None)).await.unwrap();
    notes.finish(&f.0, "epoch:1").await; assert!(notes.read(&f.0).await.is_ok());
    notes.begin(&f.0, "epoch:2".into()).await; notes.finish(&f.0, "epoch:1").await;
    assert!(AuthorCapture::new(&store).read(&f.0).await.unwrap_err().contains("No bound"));
    assert!(notes.tool(&f.0, request("epoch:1", json!({"action":"delete","id":"retry","version":1}))).await.is_err());
}

#[tokio::test]
async fn a_directory_cannot_masquerade_as_a_note_file() {
    let f = Fixture::new(); let store = f.store(); let notes = AuthorCapture::new(&store);
    fs::create_dir(f.0.join("folder")).unwrap(); fs::write(f.0.join("folder/a.ts"), "context\nold\n").unwrap();
    f.git(&["add", "folder/a.ts"]); f.git(&["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "nested"]);
    notes.begin(&f.0, "epoch:1".into()).await;
    fs::write(f.0.join("folder/a.ts"), "context\nnew\n").unwrap();
    let mut value = note(); value["path"] = json!("folder");
    assert!(notes.tool(&f.0, request("epoch:1", json!({"action":"record","id":"bad-path","note":value}))).await.is_err());
}

#[tokio::test]
async fn concurrent_replacements_cannot_overwrite_each_other() {
    let f = Fixture::new(); let store = f.store(); let notes = AuthorCapture::new(&store);
    notes.begin(&f.0, "epoch:1".into()).await; f.change();
    notes.tool(&f.0, record("epoch:1", "retry", None)).await.unwrap();
    let (first, second) = tokio::join!(
        notes.tool(&f.0, record("epoch:1", "retry", Some(1))),
        notes.tool(&f.0, record("epoch:1", "retry", Some(1))),
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert!(first.err().or(second.err()).unwrap().contains("version"));
}

#[tokio::test]
async fn unchanged_hunks_can_move_between_recording_and_settlement() {
    let f = Fixture::new(); let store = f.store(); let notes = AuthorCapture::new(&store);
    let original = (0..30).map(|n| format!("line{n}\n")).collect::<String>();
    fs::write(f.0.join("a.ts"), &original).unwrap(); f.git(&["add", "a.ts"]);
    f.git(&["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "context"]);
    notes.begin(&f.0, "epoch:1".into()).await;
    let changed = original.replace("line20\n", "replacement\n");
    fs::write(f.0.join("a.ts"), &changed).unwrap();
    let mut value = note(); value["line"] = json!(21); value["quote"] = json!("replacement");
    notes.tool(&f.0, request("epoch:1", json!({"action":"record","id":"moved","note":value}))).await.unwrap();
    fs::write(f.0.join("a.ts"), format!("prefix\n{changed}")).unwrap();
    notes.finish(&f.0, "epoch:1").await;
    let result = notes.read(&f.0).await.unwrap();
    assert_eq!(result["notes"][0]["line"], 21, "Original coordinates must remain immutable");
    assert_eq!(result["notes"][0]["binding"]["outdated"], false, "A unique unchanged whole hunk can relocate");
}

#[test]
fn hunk_identity_preserves_function_context_and_uniqueness_but_not_offsets() {
    let a = "@@ -1,2 +1,2 @@ function first()\n context\n-old\n+new\n";
    let b = "@@ -20,2 +30,2 @@ function first()\n context\n-old\n+new\n";
    assert_eq!(tool::hunks(a, None), tool::hunks(b, None));
    assert_ne!(tool::hunks(a, None), tool::hunks(&b.replace("first", "other"), None));
    assert_eq!(tool::hunks(&(a.to_owned() + b), None).len(), 2);
}

#[tokio::test]
#[ignore = "requires jj executable"]
async fn jj_recorded_revision_and_logical_change_are_bound_without_snapshotting() {
    let f = Fixture::new();
    let jj = |args: &[&str]| {
        let output = Command::new("jj").env("JJ_CONFIG", "").current_dir(&f.0).args(args).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    };
    jj(&["git", "init", "--colocate"]); let before = checkout(&f.0).await.unwrap(); assert!(!before.logical.is_empty());
    f.change(); assert_eq!(checkout(&f.0).await.unwrap().key, before.key, "Identity reads must not snapshot unrecorded edits");
    jj(&["status"]); let recorded = checkout(&f.0).await.unwrap(); assert_ne!(recorded.key, before.key); assert_eq!(recorded.logical, before.logical);
    jj(&["new"]); assert_ne!(checkout(&f.0).await.unwrap().logical, before.logical);
}
