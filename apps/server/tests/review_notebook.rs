//! Durable review state uses authenticated, revision-checked writes without a Pi runtime.
use axum::{body::{Body, to_bytes}, http::{Request, StatusCode}};
use pi_web::{config::Config, http::{self, WebState}, protocol::{WorkspaceAction, WorkspaceCommand}, session_manager::SessionManager};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn request(router: &axum::Router, session: &str, body: Value, proof: bool) -> (StatusCode, Value) {
    let endpoint = if body.get("scope").is_some() { "" } else if body.get("kind").is_some() { "/source" } else { "/notebook" };
    let mut request = Request::post(format!("/review/{session}{endpoint}"))
        .header("host", "127.0.0.1:9876").header("origin", "http://127.0.0.1:9876")
        .header("content-type", "application/json");
    if proof { request = request.header("x-pi-capability", "a".repeat(64)); }
    let response = router.clone().oneshot(request.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 17 * 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn notebook_persists_rounds_rejects_stale_writes_and_requires_proof() {
    let root = std::env::temp_dir().join(format!("pi-notebook-{}", pi_web::config::identity().unwrap()));
    std::fs::create_dir(&root).unwrap();
    let config = Config::parse(["--cwd".into(), root.to_string_lossy().into_owned(), "--state-dir".into(), root.join("state").to_string_lossy().into_owned(), "--pi".into(), "/missing/pi".into()]).unwrap().unwrap();
    let manager = SessionManager::start(config.clone()).unwrap();
    let session = manager.snapshot().await.selected;
    let (_, stopping) = tokio::sync::watch::channel(false);
    let router = http::router(WebState::new(manager.clone(), 9876, None, "a".repeat(64), root.clone(), stopping.clone()));
    assert_eq!(request(&router, &session, json!({}), false).await.0, StatusCode::UNAUTHORIZED);
    let (status, mut document) = request(&router, &session, json!({}), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(document["revision"], 0);
    assert_eq!(request(&router, &session, json!({"kind":"preferences", "enabled":true}), false).await.0, StatusCode::UNAUTHORIZED);
    let (status, preferences) = request(&router, &session, json!({"kind":"preferences", "enabled":true}), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(preferences["enabled"], true);
    assert_eq!(request(&router, &session, json!({"kind":"preferences", "enabled":"yes"}), true).await.0, StatusCode::BAD_REQUEST);
    let notes_dir = root.join(".pi/review-notes");
    std::fs::create_dir_all(&notes_dir).unwrap();
    let notes_path = notes_dir.join(format!("{session}.json"));
    let notes = json!({"turn":"epoch:1", "notes":[{"path":"src/a.ts","side":"new","line":1,"quote":"new","text":"Keep recovery."}]});
    std::fs::write(&notes_path, notes.to_string()).unwrap();
    std::fs::write(root.join(".pi/review-notes.json"), r#"{"notes":[]}"#).unwrap();
    // A raw agent file is not server-owned provenance, even with a matching turn marker.
    assert_eq!(request(&router, &session, json!({"kind":"author", "automatic":true}), true).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    std::fs::write(root.join(".pi/review-notes.json"), notes.to_string()).unwrap();
    assert_eq!(request(&router, &session, json!({"kind":"author"}), true).await, (StatusCode::OK, notes));
    std::fs::remove_file(&notes_path).unwrap();
    std::os::unix::fs::symlink(root.join(".pi/review-notes.json"), &notes_path).unwrap();
    assert_eq!(request(&router, &session, json!({"kind":"author", "automatic":true}), true).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    document["rounds"] = json!([{"id":"round-1", "label":"First review", "source":"unstaged", "files":[{"path":"src/a.ts", "previousPath":null, "status":"modified", "patch":"@@ -1 +1 @@\n-old\n+new\n", "fingerprint":"one", "reviewed":true}]}]);
    let save = json!({"revision":0,"document":document});
    let (status, saved) = request(&router, &session, save.clone(), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["revision"], 1);
    assert_eq!(request(&router, &session, save, true).await.0, StatusCode::CONFLICT);
    let mut invalid = saved.clone();
    invalid["rounds"][0]["files"][0]["path"] = json!("../secret");
    assert_eq!(request(&router, &session, json!({"revision":1,"document":invalid}), true).await.0, StatusCode::BAD_REQUEST);
    let mut rewritten = saved.clone();
    rewritten["rounds"][0]["files"][0]["patch"] = json!("@@ -1 +1 @@\n-forged\n+replacement\n");
    assert_eq!(request(&router, &session, json!({"revision":1,"document":rewritten}), true).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(request(&router, "unknown", json!({}), true).await.0, StatusCode::NOT_FOUND);
    manager.shutdown().await; drop(router); drop(manager);
    let manager = SessionManager::start(config).unwrap();
    let router = http::router(WebState::new(manager.clone(), 9876, None, "a".repeat(64), root.clone(), stopping));
    let (status, loaded) = request(&router, &session, json!({}), true).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(loaded, saved);
    assert_eq!(request(&router, &session, json!({"kind":"preferences"}), true).await.1["enabled"], true);
    let sibling = manager.command(WorkspaceCommand { v: 2, request_id: "sibling".into(), action: WorkspaceAction::Create }).await;
    assert!(sibling.ok, "{}", sibling.code);
    assert_eq!(request(&router, &sibling.selected, json!({"kind":"preferences"}), true).await.1["enabled"], true);
    let other = root.join("other-project"); std::fs::create_dir(&other).unwrap();
    let other = manager.command(WorkspaceCommand { v: 2, request_id: "other-project".into(), action: WorkspaceAction::AddWorkspace { path: other.to_string_lossy().into(), confirmed: true } }).await;
    assert!(other.ok, "{}", other.code);
    assert_eq!(request(&router, &other.selected, json!({"kind":"preferences"}), true).await.1["enabled"], false);
    assert_eq!(request(&router, &sibling.selected, json!({"kind":"preferences", "enabled":false}), true).await.1["enabled"], false);
    assert_eq!(request(&router, &session, json!({"kind":"preferences"}), true).await.1["enabled"], false);
    let epoch = manager.lookup(&session).await.map(|handle| handle.summary().epoch);
    let deleted = manager.command(WorkspaceCommand { v: 2, request_id: "delete-review".into(), action: WorkspaceAction::Delete { session_id: session.clone(), epoch, confirmed: true } }).await;
    assert!(deleted.ok, "{}", deleted.code);
    assert_eq!(request(&router, &session, json!({}), true).await.0, StatusCode::NOT_FOUND);
    fn contains_review(path: &std::path::Path, name: &str) -> bool {
        std::fs::read_dir(path).unwrap().any(|entry| {
            let path = entry.unwrap().path();
            if path.is_dir() { contains_review(&path, name) } else { path.file_name().unwrap() == name && path.parent().unwrap().ends_with("reviews") }
        })
    }
    assert!(!contains_review(&root, &format!("{session}.json")));
    manager.shutdown().await; drop(router); drop(manager);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn completion_captures_author_provenance_and_restores_it_without_inference() {
    use pi_web::protocol::{BrowserAction, BrowserMessage, ProcessStatus, ServerBody, ServerMessage};
    use std::{fs, os::unix::fs::PermissionsExt, process::Command, time::Duration};
    let root = std::env::temp_dir().join(format!("pi-note-flow-{}", pi_web::config::identity().unwrap()));
    fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| { assert!(Command::new("git").current_dir(&root).args(args).output().unwrap().status.success()); };
    git(&["init", "-b", "main"]); fs::write(root.join("a.ts"), "context\nold\n").unwrap(); git(&["add", "a.ts"]);
    git(&["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
    let executable = root.join("pi-fixture");
    fs::write(&executable, include_str!("fixtures/runtime_mock.py")).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let config = Config::parse(["--cwd".into(), root.to_string_lossy().into_owned(), "--state-dir".into(), root.join("state").to_string_lossy().into_owned(), "--pi".into(), executable.to_string_lossy().into_owned()]).unwrap().unwrap();
    let manager = SessionManager::start(config.clone()).unwrap();
    let session = manager.snapshot().await.selected;
    let (_, stopping) = tokio::sync::watch::channel(false);
    let router = http::router(WebState::new(manager.clone(), 9876, None, "a".repeat(64), root.clone(), stopping.clone()));
    let owned_manager = manager.clone(); let owned_session = session.clone(); let owned_router = router.clone();
    let outcome = tokio::spawn(async move {
        assert_eq!(request(&owned_router, &owned_session, json!({"kind":"preferences","enabled":true}), true).await.0, StatusCode::OK);
        let handle = owned_manager.lookup(&owned_session).await.unwrap();
        let mut connection = handle.connect("client".into()).await.unwrap();
        let identity = tokio::time::timeout(Duration::from_secs(20), async {
            loop { let frame: ServerMessage = serde_json::from_str(&connection.frames.recv().await.unwrap().text).unwrap();
                if matches!(&frame.body, ServerBody::Snapshot { status, .. } | ServerBody::Event { status, .. } if status.process == ProcessStatus::Ready && status.history_warning.is_none()) { break frame; }
            }
        }).await.unwrap();
        handle.dispatch("client".into(), BrowserMessage { v:1, session_id:owned_session.clone(), epoch:identity.epoch.clone(), request_id:"notes".into(), action:BrowserAction::Prompt { text:"author-note-fixture".into(), images:vec![] } }).unwrap();
        tokio::time::timeout(Duration::from_secs(20), async {
            loop { let frame: ServerMessage = serde_json::from_str(&connection.frames.recv().await.unwrap().text).unwrap();
                if let ServerBody::Snapshot { dialogs, .. } | ServerBody::Event { dialogs, .. } = &frame.body { assert!(dialogs.is_empty(), "Private note tools must never become browser dialogs"); }
                if matches!(frame.body, ServerBody::RunCompleted { .. }) { break; }
            }
        }).await.unwrap();
        let (status, notes) = request(&owned_router, &owned_session, json!({"kind":"author","automatic":true}), true).await;
        assert_eq!(status, StatusCode::OK, "{notes}");
        assert_eq!(notes["turn"], format!("{}:1", identity.epoch));
        assert_eq!(notes["notes"][0]["binding"]["checkoutKey"].as_str().unwrap().len(), 64);
        assert_eq!(notes["notes"][0]["binding"]["recordedBy"], "tool-v1");
        assert_eq!(notes["notes"][0]["binding"]["outdated"], false);
        assert!(notes["notes"][0]["binding"]["patch"].as_str().unwrap().contains("+new"));
        let (status, live) = request(&owned_router, &owned_session, json!({"scope":"unstaged","path":"a.ts"}), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(live["checkoutKey"], notes["notes"][0]["binding"]["checkoutKey"]);
        let (status, historical) = request(&owned_router, &owned_session, json!({"scope":"commit","commit":notes["notes"][0]["binding"]["head"]}), true).await;
        assert_eq!(status, StatusCode::OK);
        assert!(historical.get("checkoutKey").is_none(), "A historical commit must not inherit working-copy note identity");
        notes
    }).await;
    manager.shutdown().await; drop(router); drop(manager);
    let notes = outcome.unwrap();
    assert!(!root.join("formatter-calls.jsonl").exists(), "Collection must not start a model process");
    let manager = SessionManager::start(config).unwrap();
    let router = http::router(WebState::new(manager.clone(), 9876, None, "a".repeat(64), root.clone(), stopping));
    assert_eq!(request(&router, &session, json!({"kind":"author","automatic":true}), true).await, (StatusCode::OK, notes));
    git(&["checkout", "-b", "other"]);
    assert_eq!(request(&router, &session, json!({"kind":"author","automatic":true}), true).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    manager.shutdown().await; drop(router); drop(manager); fs::remove_dir_all(&root).unwrap();
}
