//! Explicit no-inference integration with two installed Pi runtimes and isolated extensions/tools.
use pi_web::{
    config::{self, Config},
    protocol::*,
    session::Connection,
    session_manager::SessionManager,
};
use std::{fs, time::Duration};
async fn ready(connection: &mut Connection) -> ServerMessage {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(30), connection.frames.recv())
            .await
            .unwrap()
            .unwrap();
        let message: ServerMessage = serde_json::from_str(&frame.text).unwrap();
        if let ServerBody::Snapshot { status, .. } | ServerBody::Event { status, .. } =
            &message.body
        {
            assert!(
                !matches!(
                    status.process,
                    ProcessStatus::Failed | ProcessStatus::Exited
                ),
                "{status:?}"
            );
            if status.process == ProcessStatus::Ready && status.history_warning.is_none() {
                return message;
            }
        }
    }
}
#[tokio::test]
#[ignore = "starts two installed Pi processes; no provider calls"]
async fn two_native_children_stop_reopen_and_shutdown_independently() {
    let root = std::env::temp_dir().join(format!(
        "pi-web-manager-native-{}",
        config::identity().unwrap()
    ));
    fs::create_dir(&root).unwrap();
    let options = Config::parse([
        "--cwd".into(),
        root.to_string_lossy().into(),
        "--state-dir".into(),
        root.join("state").to_string_lossy().into(),
        "--isolated".into(),
    ])
    .unwrap()
    .unwrap();
    let manager = SessionManager::start(options).unwrap();
    let task = manager.clone();
    let outcome = tokio::spawn(async move {
        let a = task.snapshot().await.selected;
        let created = task
            .command(WorkspaceCommand {
                v: 2,
                request_id: "create".into(),
                action: WorkspaceAction::Create,
            })
            .await;
        assert!(created.ok, "{created:?}");
        let b = created.selected;
        let first = task.lookup(&a).await.unwrap();
        let second = task.lookup(&b).await.unwrap();
        let mut ca = first.connect("native".into()).await.unwrap();
        let mut cb = second.connect("native".into()).await.unwrap();
        let ia = ready(&mut ca).await;
        let ib = ready(&mut cb).await;
        let stopped = task
            .command(WorkspaceCommand {
                v: 2,
                request_id: "stop".into(),
                action: WorkspaceAction::Stop {
                    session_id: a.clone(),
                    epoch: ia.epoch.clone(),
                    confirmed: true,
                },
            })
            .await;
        assert!(stopped.ok, "{stopped:?}");
        assert_eq!(second.summary().epoch, ib.epoch);
        assert_eq!(second.summary().process, ProcessStatus::Ready);
        let opened = task
            .command(WorkspaceCommand {
                v: 2,
                request_id: "open".into(),
                action: WorkspaceAction::Open {
                    session_id: a.clone(),
                },
            })
            .await;
        assert!(opened.ok, "{opened:?}");
        let fresh = task.lookup(&a).await.unwrap();
        let mut cc = fresh.connect("native-new".into()).await.unwrap();
        let ic = ready(&mut cc).await;
        assert_eq!(ic.session_id, ia.session_id);
        assert_ne!(ic.epoch, ia.epoch);
        assert_eq!(second.summary().epoch, ib.epoch);
    })
    .await;
    let clean = manager.shutdown().await;
    drop(manager);
    fs::remove_dir_all(&root).unwrap();
    assert!(clean);
    outcome.unwrap();
}
