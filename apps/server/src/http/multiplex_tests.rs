use super::*;
use std::{fs, os::unix::fs::PermissionsExt};
fn fixture() -> (PathBuf, SessionManager) {
    let root = std::env::temp_dir().join(format!("pi-web-mux-{}", config::identity().unwrap()));
    fs::create_dir(&root).unwrap();
    let pi = root.join("pi");
    fs::write(&pi, include_str!("../../tests/fixtures/runtime_mock.py")).unwrap();
    fs::set_permissions(&pi, fs::Permissions::from_mode(0o700)).unwrap();
    let config = config::Config::parse([
        "--cwd".into(),
        root.to_string_lossy().into(),
        "--state-dir".into(),
        root.join("state").to_string_lossy().into(),
        "--pi".into(),
        pi.to_string_lossy().into(),
        "--isolated".into(),
    ])
    .unwrap()
    .unwrap();
    (root, SessionManager::start(config).unwrap())
}
fn command(id: &str, action: WorkspaceAction) -> WorkspaceCommand {
    WorkspaceCommand {
        v: 2,
        request_id: id.into(),
        action,
    }
}
#[tokio::test]
async fn delayed_command_receipt_uses_the_current_catalog() {
    let (root, manager) = fixture();
    let task = manager.clone();
    let outcome = tokio::spawn(async move {
        let captured = task.command(command("old", WorkspaceAction::List)).await;
        let newer = task
            .command(command("create", WorkspaceAction::Create))
            .await;
        assert!(newer.ok);
        let receipt = refreshed_reply(&task, captured.clone()).await;
        assert_eq!(
            receipt.sessions.len(),
            2,
            "old receipt must not regress a newer periodic catalog"
        );
        assert_eq!(receipt.request_id, captured.request_id);
        assert_eq!(receipt.code, captured.code);
        assert_eq!(receipt.selected, newer.selected);
    })
    .await;
    assert!(manager.shutdown().await);
    fs::remove_dir_all(root).unwrap();
    outcome.unwrap();
}
#[tokio::test]
async fn delayed_create_receipt_preserves_its_target_while_refreshing_selection() {
    let (root, manager) = fixture();
    let task = manager.clone();
    let outcome = tokio::spawn(async move {
        let original = task.snapshot().await.selected;
        let created = task
            .command(command("create", WorkspaceAction::Create))
            .await;
        assert!(created.ok);
        let target = created.selected.clone();
        assert_ne!(target, original);
        let opened = task
            .command(command(
                "open",
                WorkspaceAction::Open {
                    session_id: original.clone(),
                },
            ))
            .await;
        assert!(opened.ok);
        let receipt = refreshed_reply(&task, created.clone()).await;
        assert_eq!(receipt.selected, original);
        assert_eq!(receipt.sessions.len(), 2);
        assert_eq!(
            serde_json::to_value(&receipt).unwrap()["target"],
            target,
            "refresh lost the created session identity"
        );
        assert_eq!(serde_json::to_value(&opened).unwrap()["target"], original);
        let duplicate = task
            .command(command("create", WorkspaceAction::Create))
            .await;
        assert_eq!(duplicate, created);
    })
    .await;
    assert!(manager.shutdown().await);
    fs::remove_dir_all(root).unwrap();
    outcome.unwrap();
}
#[tokio::test]
async fn reopened_runtime_replaces_undrained_old_subscription() {
    let (root, manager) = fixture();
    let task = manager.clone();
    let outcome = tokio::spawn(async move {
        let id = task.snapshot().await.selected;
        let old = task.lookup(&id).await.unwrap();
        let mut slots = Vec::new();
        subscribe(&mut slots, &task, "client", &id).await.unwrap();
        assert!(
            !slots[0].connection.frames.is_empty(),
            "retain old hello/snapshot"
        );
        assert!(
            task.command(command(
                "stop",
                WorkspaceAction::Stop {
                    session_id: id.clone(),
                    epoch: old.summary().epoch,
                    confirmed: true
                }
            ))
            .await
            .ok
        );
        assert!(
            task.command(command(
                "open",
                WorkspaceAction::Open {
                    session_id: id.clone()
                }
            ))
            .await
            .ok
        );
        let new = task.lookup(&id).await.unwrap();
        assert!(!old.same_runtime(&new));
        subscribe(&mut slots, &task, "client", &id).await.unwrap();
        assert!(
            slots[0].handle.same_runtime(&new),
            "stable ID must not retain the old runtime"
        );
        let frame = slots[0].connection.frames.recv().await.unwrap();
        let message: crate::protocol::ServerMessage = serde_json::from_str(&frame.text).unwrap();
        assert_eq!(message.epoch, new.summary().epoch);
        assert!(matches!(
            message.body,
            crate::protocol::ServerBody::Hello { .. }
        ));
        slots[0].handle.disconnect("client".into()).await;
    })
    .await;
    assert!(manager.shutdown().await);
    fs::remove_dir_all(root).unwrap();
    outcome.unwrap();
}

#[tokio::test]
async fn separate_sockets_subscribe_to_the_same_runtime() {
    let (root, manager) = fixture();
    let task = manager.clone();
    let outcome = tokio::spawn(async move {
        let id = task.snapshot().await.selected;
        let mut desktop = Vec::new();
        let mut phone = Vec::new();
        subscribe(&mut desktop, &task, "desktop", &id)
            .await
            .unwrap();
        subscribe(&mut phone, &task, "phone", &id).await.unwrap();
        assert!(desktop[0].handle.same_runtime(&phone[0].handle));
        // Repeated subscription on one socket remains idempotent.
        subscribe(&mut phone, &task, "phone", &id).await.unwrap();
        assert_eq!(phone.len(), 1);
        for slots in [&mut desktop, &mut phone] {
            let (_, frame) = next_frame(slots, &mut 0).await;
            let message: crate::protocol::ServerMessage =
                serde_json::from_str(&frame.unwrap().text).unwrap();
            assert_eq!(message.session_id, id);
            assert!(matches!(
                message.body,
                crate::protocol::ServerBody::Hello { .. }
            ));
        }
        desktop[0].handle.disconnect("desktop".into()).await;
        // A desktop disconnect does not close the phone's source receiver.
        assert!(!phone[0].connection.frames.is_closed());
        phone[0].handle.disconnect("phone".into()).await;
    })
    .await;
    assert!(manager.shutdown().await);
    fs::remove_dir_all(root).unwrap();
    outcome.unwrap();
}

#[tokio::test]
async fn deletion_prunes_queued_subscription_and_stale_success_target() {
    let (root, manager) = fixture();
    let captured = manager
        .command(command(
            "open",
            WorkspaceAction::Open {
                session_id: manager.snapshot().await.selected,
            },
        ))
        .await;
    let id = captured.target.clone().unwrap();
    let handle = manager.lookup(&id).await.unwrap();
    let mut slots = Vec::new();
    subscribe(&mut slots, &manager, "client", &id)
        .await
        .unwrap();
    let deleted = manager
        .command(command(
            "delete",
            WorkspaceAction::Delete {
                session_id: id,
                epoch: Some(handle.summary().epoch),
                confirmed: true,
            },
        ))
        .await;
    assert!(deleted.ok);
    prune_deleted(&mut slots, &deleted, "client").await;
    assert!(slots.is_empty());
    let receipt = refreshed_reply(&manager, captured).await;
    assert!(receipt.target.is_none());
    assert!(!receipt.ok);
    assert_eq!(receipt.code, "target_deleted");
    assert_eq!(receipt.selected, deleted.selected);
    assert!(manager.shutdown().await);
    fs::remove_dir_all(root).unwrap();
}
