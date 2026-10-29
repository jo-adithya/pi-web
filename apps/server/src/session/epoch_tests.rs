use super::*;
use std::{fs, os::unix::fs::PermissionsExt};

async fn message(connection: &mut Connection) -> ServerMessage {
    let frame = tokio::time::timeout(Duration::from_secs(5), connection.frames.recv())
        .await
        .unwrap()
        .unwrap();
    serde_json::from_str(&frame.text).unwrap()
}
async fn wait_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

/// Forces both the old controller request and post-response events to be ready
/// before the actor resumes; transport pipe tasks continue while it is paused.
#[tokio::test]
async fn pending_old_prompt_cannot_consume_new_epoch_activity() {
    let root = std::env::temp_dir().join(format!("pi-web-epoch-{}", config::identity().unwrap()));
    fs::create_dir(&root).unwrap();
    let executable = root.join("mock-pi");
    fs::write(
        &executable,
        include_str!("../../tests/fixtures/runtime_mock.py"),
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(root.join("pause-state"), "").unwrap();
    let config = Config::parse([
        "--cwd".into(),
        root.to_string_lossy().into_owned(),
        "--state-dir".into(),
        root.join("state").to_string_lossy().into_owned(),
        "--pi".into(),
        executable.to_string_lossy().into_owned(),
        "--isolated".into(),
    ])
    .unwrap()
    .unwrap();
    let handle = start(config).unwrap();
    let child = handle.clone();
    let test_root = root.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = child.connect("client".into()).await.unwrap();
        let identity = loop {
            let message = message(&mut connection).await;
            if matches!(&message.body, ServerBody::Snapshot { status, .. } | ServerBody::Event { status, .. } if status.process == ProcessStatus::Ready && status.history_warning.is_none()) { break message; }
        };
        let request = |id: &str, text: &str| BrowserMessage { v: 1, session_id: identity.session_id.clone(), epoch: identity.epoch.clone(), request_id: id.into(), action: BrowserAction::Prompt { text: text.into(), images: vec![] } };
        child.dispatch("client".into(), request("switch", "/switch-start")).unwrap();
        wait_file(&test_root.join("state-waiting")).await;
        let (entered, waiting) = oneshot::channel();
        let (resume, resuming) = oneshot::channel();
        child.tx.send(Control::Pause(entered, resuming, 2)).await.unwrap();
        waiting.await.unwrap();
        fs::write(test_root.join("allow-state"), "").unwrap();
        wait_file(&test_root.join("state-sent")).await;
        child.dispatch("client".into(), request("old-prompt", "must not run")).unwrap();
        resume.send(()).unwrap();
        let new_identity = loop {
            let m = message(&mut connection).await;
            if matches!(m.body, ServerBody::Hello { .. }) { break m; }
        };
        let mut live = false;
        for _ in 0..10 {
            let m = message(&mut connection).await;
            if let ServerBody::Event { status, patches, .. } = m.body {
                live |= patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if message.blocks.iter().any(|block| block.text == "NEW_SESSION_LIVE")));
                if status.activity == Activity::Running && live { break; }
            }
        }
        assert!(live, "new-session output was erased by the old prompt");
        child.dispatch("client".into(), BrowserMessage { v: 1, session_id: new_identity.session_id, epoch: new_identity.epoch, request_id: "new-prompt".into(), action: BrowserAction::Prompt { text: "must remain busy".into(), images: vec![] } }).unwrap();
        loop {
            if let ServerBody::Result { result } = message(&mut connection).await.body
                && result.request_id == "new-prompt" {
                assert_eq!(result.code, "busy"); break;
            }
        }
    }).await;
    handle.shutdown().await;
    fs::remove_dir_all(root).unwrap();
    outcome.unwrap();
}

#[tokio::test]
async fn replacement_discards_completed_old_jobs() {
    let mut jobs = JoinSet::new();
    let old = jobs.spawn(async { Done::History(Err("obsolete result".into())) });
    tokio::time::timeout(Duration::from_secs(1), async {
        while !old.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    invalidate_jobs(&mut jobs);
    assert!(
        jobs.join_next().await.is_none(),
        "old completed job crossed the epoch boundary"
    );
}
