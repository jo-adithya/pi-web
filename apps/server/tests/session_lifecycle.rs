//! Runtime contracts through the same controller API used by the WebSocket layer.
use pi_web::{
    config::Config,
    protocol::{BrowserAction, BrowserMessage, ServerBody, ServerMessage},
    session::{self, Connection, SessionHandle},
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pi-web-runtime-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let executable = root.join("pi-fixture");
        fs::write(&executable, include_str!("fixtures/runtime_mock.py")).unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        Self(root)
    }
    fn config(&self) -> Config {
        Config::parse([
            "--cwd".into(),
            self.0.to_string_lossy().into(),
            "--state-dir".into(),
            self.0.join("state").to_string_lossy().into(),
            "--pi".into(),
            self.0.join("pi-fixture").to_string_lossy().into(),
            "--isolated".into(),
        ])
        .unwrap()
        .unwrap()
    }
    fn log(&self) -> Vec<serde_json::Value> {
        fs::read_to_string(self.0.join("state/pi-sessions/commands.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
async fn next(connection: &mut Connection) -> ServerMessage {
    let frame = tokio::time::timeout(Duration::from_secs(20), connection.frames.recv())
        .await
        .expect("frame deadline")
        .expect("connection closed");
    serde_json::from_str(&frame.text).unwrap()
}
async fn until(
    connection: &mut Connection,
    predicate: impl Fn(&ServerMessage) -> bool,
) -> ServerMessage {
    for _ in 0..100 {
        let message = next(connection).await;
        if predicate(&message) {
            return message;
        }
    }
    panic!("too many frames");
}
async fn ready(connection: &mut Connection) -> ServerMessage {
    let message = until(connection, |message| matches!(&message.body, ServerBody::Snapshot { status, .. } | ServerBody::Event { status, .. } if matches!(status.process, pi_web::protocol::ProcessStatus::Failed | pi_web::protocol::ProcessStatus::Exited) || (status.process == pi_web::protocol::ProcessStatus::Ready && status.history_warning.is_none()))).await;
    match &message.body {
        ServerBody::Snapshot { status, .. } | ServerBody::Event { status, .. } => assert_eq!(
            status.process,
            pi_web::protocol::ProcessStatus::Ready,
            "startup failed: {status:?}"
        ),
        _ => unreachable!(),
    }
    message
}
fn send(handle: &SessionHandle, identity: &ServerMessage, id: &str, action: BrowserAction) {
    handle
        .dispatch(
            "client".into(),
            BrowserMessage {
                v: 1,
                session_id: identity.session_id.clone(),
                epoch: identity.epoch.clone(),
                request_id: id.into(),
                action,
            },
        )
        .unwrap();
}
fn send_from(
    handle: &SessionHandle,
    client: &str,
    identity: &ServerMessage,
    id: &str,
    action: BrowserAction,
) {
    handle
        .dispatch(
            client.into(),
            BrowserMessage {
                v: 1,
                session_id: identity.session_id.clone(),
                epoch: identity.epoch.clone(),
                request_id: id.into(),
                action,
            },
        )
        .unwrap();
}

async fn result(connection: &mut Connection, id: &str) -> pi_web::protocol::CommandResult {
    let message = until(
        connection,
        |m| matches!(&m.body, ServerBody::Result { result } if result.request_id == id),
    )
    .await;
    let ServerBody::Result { result } = message.body else {
        unreachable!()
    };
    result
}

#[tokio::test]
async fn steering_is_acknowledged_during_a_run_and_never_starts_an_idle_run() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "idle-steer", BrowserAction::Steer { text: "not yet".into(), images: vec![] });
    assert!(!result(&mut connection, "idle-steer").await.ok);
    send(&handle, &identity, "start", BrowserAction::Prompt { text: "retry".into(), images: vec![] });
    assert!(result(&mut connection, "start").await.ok);
    send(&handle, &identity, "correction", BrowserAction::Steer { text: "Keep the existing API".into(), images: vec![] });
    let ack = result(&mut connection, "correction").await;
    assert!(ack.ok, "{ack:?}");
    assert_eq!(ack.disposition.as_deref(), Some("queued"));
    let log = fixture.log();
    assert_eq!(log.iter().filter(|c| c["type"] == "steer").count(), 1);
    assert!(!log.iter().any(|c| c["type"] == "abort"));
    assert!(handle.shutdown().await);
}

/// Adjacent browser commands must reach Pi as prompt, clear_queue, then abort,
/// even when control-priority transport work is ready before the prompt task runs.
#[tokio::test]
async fn immediate_stop_cannot_overtake_an_accepted_prompt() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let child = handle.clone();
    let log_path = fixture.0.join("state/pi-sessions/commands.jsonl");
    let outcome = tokio::spawn(async move {
        let mut connection = child.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(
            &child,
            &identity,
            "instant-prompt",
            BrowserAction::Prompt { text: "immediate-stop".into(), images: vec![] },
        );
        send(&child, &identity, "instant-stop", BrowserAction::Cancel);
        let commands = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let commands: Vec<String> = fs::read_to_string(&log_path)
                    .unwrap()
                    .lines()
                    .filter_map(|line| {
                        let value: serde_json::Value = serde_json::from_str(line).unwrap();
                        let kind = value["type"].as_str().unwrap();
                        (matches!(kind, "clear_queue" | "abort")
                            || value["message"] == "immediate-stop")
                            .then(|| kind.to_owned())
                    })
                    .collect();
                if commands.len() == 3 {
                    break commands;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            commands,
            ["prompt", "clear_queue", "abort"],
            "Stop overtook an accepted prompt on stdin"
        );
        assert_eq!(
            result(&mut connection, "instant-stop").await.code,
            "cancelled"
        );
        assert_eq!(child.summary().activity, pi_web::view::Activity::Idle);
    })
    .await;
    handle.shutdown().await;
    outcome.unwrap();
}

#[tokio::test]
async fn stop_waits_for_stdin_but_not_the_prompt_response() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let child = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = child.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(
            &child,
            &identity,
            "no-ack",
            BrowserAction::Prompt { text: "no-prompt-ack".into(), images: vec![] },
        );
        send(&child, &identity, "stop-no-ack", BrowserAction::Cancel);
        let cancelled = tokio::time::timeout(
            Duration::from_secs(2),
            result(&mut connection, "stop-no-ack"),
        )
        .await
        .expect("Stop waited for the unanswered prompt instead of its stdin write");
        assert_eq!(cancelled.code, "cancelled");
        assert_eq!(child.summary().activity, pi_web::view::Activity::Idle);
    })
    .await;
    handle.shutdown().await;
    outcome.unwrap();
}

/// Pi may request input after Stop has drained existing dialogs. Cancellation
/// must answer those requests without publishing a modal or awaiting the user.
#[tokio::test]
async fn dialogs_arriving_during_stop_are_cancelled_without_becoming_visible() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let child = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = child.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(
            &child,
            &identity,
            "late-input",
            BrowserAction::Prompt { text: "dialog-during-stop".into(), images: vec![] },
        );
        assert!(result(&mut connection, "late-input").await.ok);
        send(&child, &identity, "stop-late-input", BrowserAction::Cancel);
        let stopped = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let message = next(&mut connection).await;
                match message.body {
                    ServerBody::Snapshot { dialogs, .. } | ServerBody::Event { dialogs, .. } => {
                        assert!(dialogs.is_empty(), "Stop published a late extension dialog");
                    }
                    ServerBody::Result { result } if result.request_id == "stop-late-input" => {
                        break result;
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("Stop remained blocked on late extension input");
        assert_eq!(stopped.code, "cancelled");
        assert_eq!(child.summary().activity, pi_web::view::Activity::Idle);
    })
    .await;
    handle.shutdown().await;
    outcome.unwrap();
    let replies: Vec<_> = fixture
        .log()
        .into_iter()
        .filter(|command| {
            command["type"] == "extension_ui_response"
                && command["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("late-"))
        })
        .collect();
    assert_eq!(
        replies.len(),
        4,
        "each standard dialog needs one cancellation"
    );
    assert!(replies.iter().all(|reply| reply["cancelled"] == true));
}

#[tokio::test]
async fn prompt_dedup_busy_retry_and_ordered_cancellation() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        let mut other = task_handle.connect("other".into()).await.unwrap();
        ready(&mut other).await;
        send(
            &task_handle,
            &identity,
            "p1",
            BrowserAction::Prompt { text: "retry".into(), images: vec![] },
        );
        let accepted = result(&mut connection, "p1").await;
        assert_eq!(accepted.disposition.as_deref(), Some("started"));
        send(
            &task_handle,
            &identity,
            "p1",
            BrowserAction::Prompt { text: "retry".into(), images: vec![] },
        );
        assert_eq!(result(&mut connection, "p1").await, accepted);
        send(
            &task_handle,
            &identity,
            "p1",
            BrowserAction::Prompt { text: "different".into(), images: vec![] },
        );
        assert_eq!(
            result(&mut connection, "p1").await.code,
            "request_id_conflict"
        );
        send(
            &task_handle,
            &identity,
            "p1",
            BrowserAction::Prompt { text: "retry".into(), images: vec![] },
        );
        assert_eq!(result(&mut connection, "p1").await, accepted);
        send(
            &task_handle,
            &identity,
            "p2",
            BrowserAction::Prompt { text: "second".into(), images: vec![] },
        );
        assert_eq!(result(&mut connection, "p2").await.code, "busy");
        send(&task_handle, &identity, "cancel", BrowserAction::Cancel);
        let cancelled = result(&mut connection, "cancel").await;
        assert!(cancelled.ok);
        assert_eq!(cancelled.recovered_draft.as_deref(), Some("recover me"));
        send(
            &task_handle,
            &identity,
            "handled",
            BrowserAction::Prompt { text: "/handled".into(), images: vec![] },
        );
        assert_eq!(
            result(&mut connection, "handled")
                .await
                .disposition
                .as_deref(),
            Some("handled")
        );
    })
    .await;
    handle.shutdown().await;
    outcome.unwrap();
    let log = fixture.log();
    assert_eq!(log.iter().filter(|c| c["message"] == "retry").count(), 1);
    let clear = log.iter().position(|c| c["type"] == "clear_queue").unwrap();
    assert_eq!(log[clear + 1]["type"], "abort");
}

#[tokio::test]
async fn disconnect_cancels_dialog_but_keeps_generation_and_snapshot() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(
            &task_handle,
            &identity,
            "p",
            BrowserAction::Prompt { text: "dialog".into(), images: vec![] },
        );
        until(
            &mut connection,
            |m| matches!(&m.body, ServerBody::Event { dialogs, .. } if !dialogs.is_empty()),
        )
        .await;
        task_handle.disconnect("client".into()).await;
        let mut replacement = task_handle.connect("client".into()).await.unwrap();
        let restored = until(&mut replacement, |m| {
            matches!(&m.body, ServerBody::Snapshot { .. })
        })
        .await;
        if let ServerBody::Snapshot {
            messages,
            dialogs,
            status,
            ..
        } = restored.body
        {
            assert!(dialogs.is_empty());
            assert_eq!(messages[0].blocks[0].text, "Hello");
            assert_ne!(status.activity, pi_web::view::Activity::Idle);
            assert!(status.notice.unwrap().contains("cancelled"));
        }
        send(&task_handle, &identity, "stop", BrowserAction::Cancel);
        assert!(result(&mut replacement, "stop").await.ok);
    })
    .await;
    handle.shutdown().await;
    outcome.unwrap();
    let replies: Vec<_> = fixture
        .log()
        .into_iter()
        .filter(|c| c["type"] == "extension_ui_response")
        .collect();
    assert_eq!(replies.len(), 1);
    assert_eq!(replies[0]["cancelled"], true);
}

/// Explicit opt-in: starts the installed Pi binary with isolated read-only tools,
/// no provider prompt, and disposable application/session files.
#[tokio::test]
#[ignore = "starts the locally configured Pi executable; no provider calls"]
async fn native_readiness_and_shutdown() {
    let fixture = Fixture::new();
    let mut config = fixture.config();
    config.pi = "pi-bolt".into();
    let handle = session::start(config).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        ready(&mut connection).await
    })
    .await;
    handle.shutdown().await;
    outcome.unwrap();
}

/// Opt-in large-file native recovery; no provider requests or global configuration writes.
#[tokio::test]
#[ignore = "starts and kills an isolated native Pi child; no provider calls"]
async fn native_large_history_restart_stays_ready() {
    use std::io::Write;
    let fixture = Fixture::new();
    let mut config = fixture.config();
    config.pi = "pi-bolt".into();
    let path = fixture.0.join("large.jsonl");
    let mut file = fs::File::create(&path).unwrap();
    writeln!(file, "{}", serde_json::json!({"type":"session","version":3,"id":"00000000-0000-4000-8000-000000000001","cwd":config.cwd})).unwrap();
    for index in 0..600 {
        if index == 599 {
            write!(file, "{{\"type\":\"message\",\"id\":\"abandoned\",\"parentId\":\"598\",\"message\":{{\"role\":\"user\",\"content\":\"").unwrap();
            for _ in 0..8192 {
                file.write_all(&[b'x'; 4096]).unwrap();
            }
            writeln!(file, "\"}}}}").unwrap();
        }
        writeln!(file,"{}",serde_json::json!({"type":"message","id":index.to_string(),"parentId":(index>0).then(||(index-1).to_string()),"message":{"role":"user","content":format!("ROW_{index}")}})).unwrap();
    }
    drop(file);
    config.startup = pi_web::config::Startup::Session(path);
    config.session_roots.push(config.cwd.clone());
    let handle = session::start(config).unwrap();
    let task_handle = handle.clone();
    let root = fixture.0.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap(); let identity = ready(&mut connection).await;
        let processes = std::process::Command::new("ps").args(["-axo","pid=,ppid=,pgid=,command="]).output().unwrap();
        // Pi-Bolt also forks a helper with identical argv but a different PGID.
        // Only the application's direct child is the controlled RPC engine.
        let parent = std::process::id().to_string();
        let owned: Vec<_> = std::str::from_utf8(&processes.stdout).unwrap().lines().filter(|line| line.split_whitespace().nth(1) == Some(parent.as_str()) && line.contains("--mode rpc") && line.contains(&format!("--session-dir {}/state/pi-sessions",root.display()))).collect();
        assert_eq!(owned.len(),1,"{owned:?}"); let pid: i32 = owned[0].split_whitespace().next().unwrap().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) },0);
        until(&mut connection, |m| matches!(&m.body, ServerBody::Event{status,..} if status.process == pi_web::protocol::ProcessStatus::Exited)).await;
        send(&task_handle,&identity,"restart",BrowserAction::Restart{confirmed:true}); assert!(result(&mut connection,"restart").await.ok);
        let restored = ready(&mut connection).await; assert_ne!(identity.epoch,restored.epoch);
        task_handle.disconnect("client".into()).await; tokio::time::sleep(Duration::from_secs(2)).await;
        let mut replacement = task_handle.connect("replacement".into()).await.unwrap();
        let snapshot = until(&mut replacement,|m|matches!(m.body,ServerBody::Snapshot{..})).await;
        if let ServerBody::Snapshot{status,messages,..}=snapshot.body { assert_eq!(status.process,pi_web::protocol::ProcessStatus::Ready,"{status:?}"); assert!(status.history_warning.is_none(),"{status:?}"); assert_eq!(messages.len(),500); }
    }).await;
    handle.shutdown().await;
    outcome.unwrap();
}

#[tokio::test]
async fn remembers_exact_session_and_rejects_missing_persisted_file() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        ready(&mut connection).await
    })
    .await;
    handle.shutdown().await;
    let previous = outcome.unwrap();
    drop(handle);
    let again = session::start(fixture.config()).unwrap();
    let task_handle = again.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        ready(&mut connection).await
    })
    .await;
    again.shutdown().await;
    let resumed = outcome.unwrap();
    drop(again);
    assert_eq!(previous.session_id, resumed.session_id);
    assert_ne!(previous.epoch, resumed.epoch);
    fs::remove_file(fixture.0.join("state/pi-sessions/mock.jsonl")).unwrap();
    assert!(session::start(fixture.config()).is_err());
}

#[tokio::test]
async fn settlement_during_stop_cannot_admit_a_new_prompt() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap(); let identity = ready(&mut connection).await;
        send(&task_handle, &identity, "p", BrowserAction::Prompt { text: "cancel-race".into(), images: vec![] }); assert!(result(&mut connection, "p").await.ok);
        send(&task_handle, &identity, "stop", BrowserAction::Cancel);
        until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.last_outcome.as_deref() == Some("success"))).await;
        send(&task_handle, &identity, "too-early", BrowserAction::Prompt { text: "must not run".into(), images: vec![] });
        assert_eq!(result(&mut connection, "too-early").await.code, "busy");
        assert!(result(&mut connection, "stop").await.ok);
        send(&task_handle, &identity, "after", BrowserAction::Prompt { text: "/handled".into(), images: vec![] }); let after = result(&mut connection, "after").await; assert!(after.ok, "{after:?}");
    }).await;
    handle.shutdown().await;
    outcome.unwrap();
    assert!(!fixture.log().iter().any(|c| c["message"] == "must not run"));
}

#[tokio::test]
async fn abort_acknowledgment_does_not_replace_settlement() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(
            &task_handle,
            &identity,
            "p",
            BrowserAction::Prompt { text: "late-settlement".into(), images: vec![] },
        );
        assert!(result(&mut connection, "p").await.ok);
        send(&task_handle, &identity, "stop", BrowserAction::Cancel);
        assert!(
            tokio::time::timeout(Duration::from_millis(150), result(&mut connection, "stop"))
                .await
                .is_err(),
            "abort acknowledgment is not settlement"
        );
        send(
            &task_handle,
            &identity,
            "too-early",
            BrowserAction::Prompt { text: "must not run".into(), images: vec![] },
        );
        assert_eq!(result(&mut connection, "too-early").await.code, "busy");
        assert!(result(&mut connection, "stop").await.ok);
        send(
            &task_handle,
            &identity,
            "after",
            BrowserAction::Prompt { text: "/handled".into(), images: vec![] },
        );
        let after = result(&mut connection, "after").await; assert!(after.ok, "{after:?}");
    })
    .await;
    handle.shutdown().await;
    outcome.unwrap();
    assert!(!fixture.log().iter().any(|c| c["message"] == "must not run"));
}

#[tokio::test]
async fn missing_settlement_keeps_admission_closed_and_enables_recovery() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(
            &task_handle,
            &identity,
            "p",
            BrowserAction::Prompt { text: "missing-settlement".into(), images: vec![] },
        );
        assert!(result(&mut connection, "p").await.ok);
        send(&task_handle, &identity, "stop", BrowserAction::Cancel);
        assert_eq!(
            result(&mut connection, "stop").await.code,
            "cancellation_unconfirmed"
        );
        send(
            &task_handle,
            &identity,
            "too-early",
            BrowserAction::Prompt { text: "must not run".into(), images: vec![] },
        );
        assert_eq!(result(&mut connection, "too-early").await.code, "busy");
        send(
            &task_handle,
            &identity,
            "terminate",
            BrowserAction::Terminate { confirmed: true },
        );
        assert!(result(&mut connection, "terminate").await.ok);
    })
    .await;
    handle.shutdown().await;
    outcome.unwrap();
}

#[tokio::test]
async fn identity_reconciliation_does_not_advertise_prompt_readiness() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("pause-settled-state"), "").unwrap();
    let handle = session::start(fixture.config()).unwrap();
    let task = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task.connect("client".into()).await.unwrap(); let identity = ready(&mut connection).await;
        send(&task, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
        let settled = until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.last_outcome.as_deref() == Some("success"))).await;
        let ServerBody::Event { status, .. } = settled.body else { unreachable!() };
        assert_eq!(serde_json::to_value(status.activity).unwrap(), "reconciling", "the prompt gate is closed until identity reconciliation finishes");
        fs::write(fixture.0.join("allow-settled-state"), "").unwrap();
        until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.activity == pi_web::view::Activity::Idle)).await;
        send(&task, &identity, "next", BrowserAction::Prompt { text: "/handled".into(), images: vec![] });
        assert!(result(&mut connection, "next").await.ok);
    }).await;
    handle.shutdown().await;
    outcome.unwrap();
}

#[tokio::test]
async fn unexpected_idle_session_replacement_rebuilds_under_a_new_epoch() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(&task_handle, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
        until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.last_outcome.as_deref() == Some("success") && status.activity == pi_web::view::Activity::Idle)).await;
        send(&task_handle, &identity, "switch", BrowserAction::Prompt { text: "/switch-session".into(), images: vec![] });
        let replacement = until(&mut connection, |m| matches!(&m.body, ServerBody::Hello { .. }) || matches!(&m.body, ServerBody::Event { status, .. } if status.process != pi_web::protocol::ProcessStatus::Ready)).await;
        assert!(matches!(replacement.body, ServerBody::Hello { .. }), "valid idle replacement must rebuild, not kill Pi");
        assert_eq!(replacement.session_id, identity.session_id);
        assert_ne!(replacement.epoch, identity.epoch);
        let snapshot = until(&mut connection, |m| matches!(&m.body, ServerBody::Snapshot { status, .. } if status.history_warning.is_none())).await;
        if let ServerBody::Snapshot { messages, .. } = snapshot.body { assert!(messages.is_empty()); }
        send(&task_handle, &identity, "old", BrowserAction::Prompt { text: "must not run".into(), images: vec![] });
        assert!(!result(&mut connection, "old").await.ok);
        send(&task_handle, &replacement, "new", BrowserAction::Prompt { text: "/handled".into(), images: vec![] });
        assert!(result(&mut connection, "new").await.ok);
    }).await;
    handle.shutdown().await;
    outcome.unwrap();
}

#[tokio::test]
async fn replacement_preserves_events_after_the_state_response() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(&task_handle, &identity, "switch", BrowserAction::Prompt { text: "/switch-start".into(), images: vec![] });
        let replacement = until(&mut connection, |m| matches!(m.body, ServerBody::Hello { .. })).await;
        until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.activity == pi_web::view::Activity::Running)).await;
        send(&task_handle, &replacement, "snapshot", BrowserAction::Attach);
        let snapshot = until(&mut connection, |m| matches!(m.body, ServerBody::Snapshot { .. })).await;
        if let ServerBody::Snapshot { messages, .. } = snapshot.body {
            assert!(messages.iter().any(|message| message.blocks.iter().any(|block| block.text == "NEW_SESSION_LIVE")));
        }
        send(&task_handle, &replacement, "busy", BrowserAction::Prompt { text: "must not run".into(), images: vec![] });
        assert_eq!(result(&mut connection, "busy").await.code, "busy");
    }).await;
    handle.shutdown().await;
    outcome.unwrap();
}

#[tokio::test]
async fn invalid_or_active_identity_replacement_fails_closed() {
    for text in ["/switch-outside", "/switch-active"] {
        let fixture = Fixture::new();
        let handle = session::start(fixture.config()).unwrap();
        let task_handle = handle.clone();
        let outcome = tokio::spawn(async move {
            let mut connection = task_handle.connect("client".into()).await.unwrap();
            let identity = ready(&mut connection).await;
            send(
                &task_handle,
                &identity,
                "switch",
                BrowserAction::Prompt { text: text.into(), images: vec![] },
            );
            assert_eq!(
                result(&mut connection, "switch").await.code,
                "process_exited_delivery_uncertain"
            );
            send(&task_handle, &identity, "snapshot", BrowserAction::Attach);
            let snapshot = until(&mut connection, |m| {
                matches!(m.body, ServerBody::Snapshot { .. })
            })
            .await;
            assert_eq!(snapshot.epoch, identity.epoch);
            if let ServerBody::Snapshot { status, .. } = snapshot.body {
                assert_ne!(status.process, pi_web::protocol::ProcessStatus::Ready);
            }
        })
        .await;
        handle.shutdown().await;
        outcome.unwrap();
    }
}

#[tokio::test]
async fn a_late_history_scan_never_erases_live_messages() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("history-race"), "").unwrap();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        let identity = until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.history_warning.as_ref().is_some_and(|s| s.contains("live output was preserved")))).await;
        send(&task_handle, &identity, "snapshot", BrowserAction::Attach);
        let snapshot = until(&mut connection, |m| matches!(&m.body, ServerBody::Snapshot { .. })).await;
        if let ServerBody::Snapshot { messages, .. } = snapshot.body { assert_eq!(messages.len(), 1); assert_eq!(messages[0].blocks[0].text, "LIVE_DURING_HISTORY"); }
    }).await;
    handle.shutdown().await;
    outcome.unwrap();
}

#[tokio::test]
async fn failed_abort_requires_separately_confirmed_termination() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(
            &task_handle,
            &identity,
            "premature",
            BrowserAction::Terminate { confirmed: true },
        );
        assert!(!result(&mut connection, "premature").await.ok);
        send(
            &task_handle,
            &identity,
            "p",
            BrowserAction::Prompt { text: "ignore-abort".into(), images: vec![] },
        );
        assert!(result(&mut connection, "p").await.ok);
        send(&task_handle, &identity, "stop", BrowserAction::Cancel);
        assert_eq!(
            result(&mut connection, "stop").await.code,
            "cancellation_unconfirmed"
        );
        send(
            &task_handle,
            &identity,
            "busy",
            BrowserAction::Prompt { text: "must not run".into(), images: vec![] },
        );
        assert_eq!(result(&mut connection, "busy").await.code, "busy");
        send(
            &task_handle,
            &identity,
            "no",
            BrowserAction::Terminate { confirmed: false },
        );
        assert!(!result(&mut connection, "no").await.ok);
        send(
            &task_handle,
            &identity,
            "yes",
            BrowserAction::Terminate { confirmed: true },
        );
        send(
            &task_handle,
            &identity,
            "again",
            BrowserAction::Terminate { confirmed: true },
        );
        let results = tokio::time::timeout(Duration::from_secs(3), async {
            let mut results = std::collections::HashMap::new();
            while results.len() < 2 {
                if let ServerBody::Result { result } = next(&mut connection).await.body
                    && matches!(result.request_id.as_str(), "yes" | "again")
                {
                    results.insert(result.request_id.clone(), result);
                }
            }
            results
        })
        .await
        .expect("every termination request must resolve");
        assert!(results["yes"].ok);
        assert!(!results["again"].ok);
    })
    .await;
    handle.shutdown().await;
    outcome.unwrap();
}

#[tokio::test]
async fn failed_handled_reconciliation_resolves_pending_request_on_exit() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(
            &task_handle,
            &identity,
            "handled",
            BrowserAction::Prompt { text: "/handled-fail".into(), images: vec![] },
        );
        let failed =
            tokio::time::timeout(Duration::from_secs(3), result(&mut connection, "handled"))
                .await
                .expect("pending request survived exit");
        assert!(!failed.ok);
        assert_eq!(failed.code, "process_exited_delivery_uncertain");
        send(
            &task_handle,
            &identity,
            "handled",
            BrowserAction::Prompt { text: "/handled-fail".into(), images: vec![] },
        );
        assert_eq!(result(&mut connection, "handled").await, failed);
    })
    .await;
    handle.shutdown().await;
    outcome.unwrap();
}

#[tokio::test]
async fn slow_controller_detaches_without_blocking_runtime_and_resnapshots_bounded_history() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut slow = task_handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut slow).await;
        send(
            &task_handle,
            &identity,
            "flood",
            BrowserAction::Prompt { text: "flood".into(), images: vec![] },
        );
        // A healthy peer drains throughout the flood while the first receiver stalls.
        let mut replacement = task_handle.connect("replacement".into()).await.unwrap();
        until(&mut replacement, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.activity == pi_web::view::Activity::Idle)).await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while slow.frames.recv().await.is_some() {}
        }).await.expect("slow subscriber was not detached");
        send_from(&task_handle, "replacement", &identity, "snapshot", BrowserAction::Attach);
        let snapshot = until(&mut replacement, |m| {
            matches!(&m.body, ServerBody::Snapshot { .. })
        })
        .await;
        if let ServerBody::Snapshot {
            messages, status, ..
        } = snapshot.body
        {
            assert!(messages.len() <= 500);
            assert_eq!(status.process, pi_web::protocol::ProcessStatus::Ready);
            assert!(serde_json::to_vec(&messages).unwrap().len() < 8 * 1024 * 1024);
        }
    })
    .await;
    handle.shutdown().await;
    outcome.unwrap();
}

#[tokio::test]
async fn crash_invalidates_dialogs_and_restart_recovers_unpersisted_identity() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("unpersisted"), "").unwrap();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap(); let identity = ready(&mut connection).await;
        send(&task_handle, &identity, "p", BrowserAction::Prompt { text: "crash-dialog".into(), images: vec![] });
        let exit = until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.process == pi_web::protocol::ProcessStatus::Exited)).await;
        if let ServerBody::Event { dialogs, .. } = exit.body { assert!(dialogs.is_empty(), "dead child left a modal"); }
        send(&task_handle, &identity, "old-dialog", BrowserAction::UiReply { dialog_id: "approval-1".into(), answer: pi_web::protocol::DialogAnswer::Confirmed { confirmed: true } });
        assert_eq!(result(&mut connection, "old-dialog").await.code, "stale_dialog");
        send(&task_handle, &identity, "restart", BrowserAction::Restart { confirmed: true });
        assert!(result(&mut connection, "restart").await.ok); let replacement = ready(&mut connection).await;
        assert_eq!(replacement.session_id, identity.session_id); assert_ne!(replacement.epoch, identity.epoch);
    }).await;
    handle.shutdown().await;
    outcome.unwrap();
}

/// Catalogs follow hello/snapshot, survive reconnect and identity replacement,
/// and are freshly sampled rather than carried across child restarts.
#[tokio::test]
async fn slash_commands_follow_runtime_lifecycle() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("slash-commands.json"),
        r#"[{"name":"first","source":"prompt","description":"First"}]"#,
    )
    .unwrap();
    let handle = session::start(fixture.config()).unwrap();
    let child = handle.clone();
    let root = fixture.0.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = child.connect("client".into()).await.unwrap();
        let hello = next(&mut connection).await;
        assert!(matches!(hello.body, ServerBody::Hello { .. }));
        let first = command_catalog(&mut connection, "first").await;
        assert_eq!(first.epoch, hello.epoch);
        let identity = ready(&mut connection).await;
        child.disconnect("client".into()).await;
        let mut connection = child.connect("client".into()).await.unwrap();
        assert!(matches!(next(&mut connection).await.body, ServerBody::Hello { .. }));
        assert!(matches!(next(&mut connection).await.body, ServerBody::Snapshot { .. }));
        command_catalog(&mut connection, "first").await;
        send(&child, &identity, "crash", BrowserAction::Prompt { text: "crash-dialog".into(), images: vec![] });
        until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.process == pi_web::protocol::ProcessStatus::Exited)).await;
        fs::write(root.join("slash-commands.json"), r#"[{"name":"second","source":"skill"}]"#).unwrap();
        send(&child, &identity, "restart", BrowserAction::Restart { confirmed: true });
        let hello = until(&mut connection, |m| matches!(m.body, ServerBody::Hello { .. })).await;
        assert_ne!(hello.epoch, identity.epoch);
        assert_eq!(command_catalog(&mut connection, "second").await.epoch, hello.epoch);
        let identity = ready(&mut connection).await;
        send(&child, &identity, "switch", BrowserAction::Prompt { text: "/switch-session".into(), images: vec![] });
        let replacement = until(&mut connection, |m| matches!(m.body, ServerBody::Hello { .. })).await;
        assert_ne!(replacement.epoch, identity.epoch);
        assert_eq!(command_catalog(&mut connection, "second").await.epoch, replacement.epoch);
    }).await;
    handle.shutdown().await;
    outcome.unwrap();
    assert_eq!(
        fixture
            .log()
            .iter()
            .filter(|c| c["type"] == "get_commands")
            .count(),
        2
    );
}

/// HTML previews stay original and never start a formatter process.
#[tokio::test]
async fn html_previews_bypass_response_formatting_and_survive_reconnect() {
    use pi_web::{response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    let original = "Before the preview.\n\n```html preview\n<div>Keep this HTML unchanged.</div>\n```\n\nAfter the preview.";
    fs::write(fixture.0.join("coding-response.txt"), original).unwrap();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "preview", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if message.role == "assistant" && message.complete && message.presentation != Some(ResponsePresentation::Hidden))))).await;
    let ServerBody::Event { patches, .. } = frame.body else { unreachable!() };
    let message = patches.iter().find_map(|patch| match patch {
        ViewPatch::Message { message } if message.role == "assistant" && message.complete && message.presentation != Some(ResponsePresentation::Hidden) => Some(message),
        _ => None,
    }).unwrap();
    assert!(message.presentation.is_none(), "HTML previews must use the original renderer, not a pending or simplified reply");
    assert_eq!(message.blocks[0].text, original);
    assert!(!fixture.0.join("formatter-launch.json").exists(), "no formatter process or model call is needed");
    assert!(!fixture.0.join("formatter-calls.jsonl").exists());
    let mut observer = handle.connect("observer".into()).await.unwrap();
    let snapshot = until(&mut observer, |frame| matches!(frame.body, ServerBody::Snapshot { .. })).await;
    let ServerBody::Snapshot { messages, .. } = snapshot.body else { unreachable!() };
    let restored = messages.iter().find(|message| message.blocks.iter().any(|block| block.text == original)).unwrap();
    assert!(restored.presentation.is_none());
    assert!(handle.shutdown().await);
}

/// Simplification is once per settled answer, never once per token/tool turn or browser attach.
#[tokio::test]
async fn response_formatter_waits_for_settlement_and_scopes_each_turns_observations() {
    use pi_web::{response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    fs::write(fixture.0.join("formatter-timing-delays"), "").unwrap();
    fs::write(fixture.0.join("work-timing-delays"), "").unwrap();
    fs::write(fixture.0.join("retry-agent-start"), "").unwrap();
    let mut config = fixture.config();
    config.response_model = pi_web::config::ResponseModel { provider: "fixture".into(), id: "cheap".into() };
    let handle = session::start(config.clone()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "stream", BrowserAction::Prompt { text: "still-working".into(), images: vec![] });
    let streaming = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if message.role == "assistant")))).await;
    let ServerBody::Event { patches, .. } = streaming.body else { unreachable!() };
    assert!(patches.iter().all(|patch| !matches!(patch, ViewPatch::Message { message } if message.role == "assistant" && message.presentation != Some(ResponsePresentation::Hidden))), "all intermediate previews stay hidden, including loading placeholders");
    assert!(!fixture.0.join("formatter-calls.jsonl").exists(), "must not simplify streamed tokens");
    send(&handle, &identity, "abort", BrowserAction::Cancel);
    result(&mut connection, "abort").await;
    send(&handle, &identity, "complete", BrowserAction::Prompt { text: "format-multiple".into(), images: vec![] });
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Ready { .. })))))).await;
    let ServerBody::Event { patches, .. } = frame.body else { unreachable!() };
    let message = patches.iter().find_map(|patch| match patch { ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Ready { .. })) => Some(message), _ => None }).unwrap();
    assert!(message.blocks.iter().any(|block| block.text.contains("**Completed** safely.")), "original is preserved");
    let presentation = serde_json::to_value(&message.presentation).unwrap();
    let timing = &presentation["timings"];
    assert!(timing.is_object(), "completed formatting must expose measured stages");
    assert_eq!(timing["model"], "fixture/cheap");
    assert_eq!(timing["cached"], false);
    assert!(timing["workMs"].as_u64().expect("Pi work must be recorded separately") >= 150, "includes prompt preparation and intermediate tool turns");
    assert!(timing["startupMs"].as_u64().unwrap() >= 40);
    assert!(timing["firstTextMs"].as_u64().unwrap() >= 50);
    assert!(timing["modelMs"].as_u64().unwrap() >= timing["firstTextMs"].as_u64().unwrap() + 60);
    assert!(timing["totalMs"].as_u64().unwrap() >= timing["queueMs"].as_u64().unwrap() + timing["startupMs"].as_u64().unwrap() + timing["modelMs"].as_u64().unwrap() + timing["cleanupMs"].as_u64().unwrap());
    let log = || fs::read_to_string(fixture.0.join("formatter-calls.jsonl")).unwrap().lines().map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()).collect::<Vec<_>>();
    assert_eq!(log().len(), 1);
    assert!(log()[0]["input"]["answer"].as_str().unwrap().starts_with("Earlier finding: restart is required.\n\n**Completed** safely."), "all replies reach one formatter request in chronological order");
    assert!(!log()[0]["input"].to_string().contains("PRIVATE_THINKING"));
    assert!(!log()[0]["input"].to_string().contains("Hello"));
    let mut observer = handle.connect("observer".into()).await.unwrap();
    let snapshot = until(&mut observer, |frame| matches!(&frame.body, ServerBody::Snapshot { messages, .. } if messages.iter().any(|message| matches!(message.presentation, Some(ResponsePresentation::Ready { .. }))))).await;
    let ServerBody::Snapshot { messages, .. } = snapshot.body else { unreachable!() };
    assert!(messages.iter().filter(|message| message.blocks.iter().any(|block| block.text.contains("Earlier finding: restart is required."))).all(|message| message.presentation == Some(ResponsePresentation::Hidden)));
    assert_eq!(messages.iter().filter(|message| matches!(message.presentation, Some(ResponsePresentation::Ready { .. }))).count(), 1, "one final simple reply, not one per Pi message");
    handle.disconnect("observer".into()).await;
    for flag in ["--no-tools", "--no-extensions", "--no-context-files", "--no-session", "--no-mcp"] { assert!(log()[0]["args"].as_array().unwrap().iter().any(|arg| arg == flag)); }
    handle.disconnect("client".into()).await;
    let mut connection = handle.connect("client".into()).await.unwrap();
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Snapshot { messages, .. } if messages.iter().any(|message| matches!(message.presentation, Some(ResponsePresentation::Ready { .. }))))).await;
    send(&handle, &frame, "duplicate-settlement", BrowserAction::Prompt { text: "format-duplicate".into(), images: vec![] });
    until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Ready { .. })))))).await;
    assert_eq!(log().len(), 2, "duplicate settlement adds no call, but a new turn gets its own observations");
    assert!(!log()[1]["input"].to_string().contains("Earlier finding:"), "a new query must not borrow earlier replies");
    let saved: Vec<serde_json::Value> = fs::read_dir(fixture.0.join("state/response-formats")).unwrap().map(|entry| serde_json::from_slice(&fs::read(entry.unwrap().path()).unwrap()).unwrap()).collect();
    assert!(saved.iter().any(|entry| entry["presentation"]["timings"] == *timing), "original timings must survive restart");
    assert!(handle.shutdown().await);
    let handle = session::start(config).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "after-restart", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Ready { .. })))))).await;
    assert_eq!(log().len(), 3, "a fresh prompt after restart cannot borrow another turn’s observations");
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn response_formatter_publishes_only_one_reply_after_the_entire_run_settles() {
    use pi_web::{response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    fs::write(fixture.0.join("pause-final-settlement"), "").unwrap();
    fs::write(fixture.0.join("formatter-hold"), "").unwrap();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "query", BrowserAction::Prompt { text: "format-multiple".into(), images: vec![] });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !fixture.0.join("final-answer-waiting").exists() { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.unwrap();
    let mut observer = handle.connect("observer".into()).await.unwrap();
    let snapshot = until(&mut observer, |frame| matches!(&frame.body, ServerBody::Snapshot { .. })).await;
    let ServerBody::Snapshot { messages, .. } = snapshot.body else { unreachable!() };
    let answers: Vec<_> = messages.iter().filter(|message| message.role == "assistant").collect();
    assert_eq!(answers.len(), 2, "fixture includes an intermediate and a completed final Pi message");
    assert!(answers.iter().all(|message| message.presentation == Some(ResponsePresentation::Hidden)), "even message_end/agent_end must not reveal a simple-reply placeholder");
    assert!(!fixture.0.join("formatter-calls.jsonl").exists());
    tokio::time::sleep(Duration::from_millis(80)).await;
    fs::remove_file(fixture.0.join("pause-final-settlement")).unwrap();
    until(&mut observer, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if message.presentation == Some(ResponsePresentation::Pending))))).await;
    fs::remove_file(fixture.0.join("formatter-hold")).unwrap();
    until(&mut observer, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Ready { .. })))))).await;
    let mut final_view = handle.connect("final-view".into()).await.unwrap();
    let snapshot = until(&mut final_view, |frame| matches!(&frame.body, ServerBody::Snapshot { .. })).await;
    let ServerBody::Snapshot { messages, .. } = snapshot.body else { unreachable!() };
    assert_eq!(messages.iter().filter(|message| message.role == "assistant" && message.presentation != Some(ResponsePresentation::Hidden)).count(), 1);
    let timings = messages.iter().find_map(|message| match &message.presentation {
        Some(ResponsePresentation::Ready { timings: Some(timings), .. }) => Some(timings),
        _ => None,
    }).unwrap();
    assert!(timings.work_ms.unwrap() >= 80, "Pi work includes waiting for settlement after the final text");
    assert_eq!(fs::read_to_string(fixture.0.join("formatter-calls.jsonl")).unwrap().lines().count(), 1);
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn response_formatter_preserves_parser_failure_after_restart_without_inference() {
    use pi_web::{response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    fs::write(fixture.0.join("formatter-persist-history"), "").unwrap();
    fs::write(fixture.0.join("formatter-response.json"), r#"{"summary":"DO_NOT_PERSIST_MODEL_TEXT","blocks":[{"type":"workflow","title":"Unrecognized block","text":"DO_NOT_PERSIST_MODEL_TEXT"}]}"#).unwrap();
    let config = fixture.config();
    let handle = session::start(config.clone()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Error { .. })))))).await;
    let ServerBody::Event { patches, .. } = frame.body else { unreachable!() };
    let expected = patches.iter().find_map(|patch| match patch {
        ViewPatch::Message { message } => match &message.presentation { Some(ResponsePresentation::Error { message, .. }) => Some(message.clone()), _ => None }, _ => None,
    }).unwrap();
    assert!(expected.contains(r#"unknown variant "workflow""#) && expected.contains("line ") && expected.contains("column "), "{expected}");
    assert!(!expected.contains("DO_NOT_PERSIST_MODEL_TEXT"));
    let files: Vec<_> = fs::read_dir(fixture.0.join("state/response-formats")).unwrap().map(|entry| entry.unwrap().path()).collect();
    assert_eq!(files.len(), 1);
    let saved = fs::read_to_string(&files[0]).unwrap();
    assert!(!saved.contains("DO_NOT_PERSIST_MODEL_TEXT"), "rejected output must not leak into saved diagnostics");
    let saved: serde_json::Value = serde_json::from_str(&saved).unwrap();
    assert_eq!(saved["presentation"]["message"], expected);
    assert!(handle.shutdown().await);
    let handle = session::start(config).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Snapshot { messages, .. } if messages.iter().any(|message| message.role == "assistant"))).await;
    let ServerBody::Snapshot { messages, .. } = frame.body else { unreachable!() };
    assert!(messages.iter().any(|message| matches!(&message.presentation, Some(ResponsePresentation::Error { message, retryable: true, timings: Some(timings) }) if *message == expected && timings.cached)));
    assert_eq!(fs::read_to_string(fixture.0.join("formatter-calls.jsonl")).unwrap().lines().count(), 1, "restoring a parser error must not invoke a model");
    assert_eq!(fixture.log().iter().filter(|command| command["type"] == "prompt" && command["message"] == "complete").count(), 1);
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn response_formatter_errors_are_retryable_without_reprompting_pi() {
    use pi_web::{response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    fs::write(fixture.0.join("formatter-invalid"), "").unwrap();
    let mut config = fixture.config();
    config.response_model = pi_web::config::ResponseModel { provider: "fixture".into(), id: "cheap".into() };
    let handle = session::start(config).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "complete", BrowserAction::Prompt { text: "format-multiple".into(), images: vec![] });
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Error { .. })))))).await;
    let ServerBody::Event { patches, .. } = frame.body else { unreachable!() };
    let message_id = patches.iter().find_map(|patch| match patch { ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Error { .. })) => Some(message.id.clone()), _ => None }).unwrap();
    fs::remove_file(fixture.0.join("formatter-invalid")).unwrap();
    send(&handle, &identity, "retry", BrowserAction::RetryResponse { message_id: message_id.clone() });
    assert!(result(&mut connection, "retry").await.ok);
    let retried = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Ready { .. })))))).await;
    let ServerBody::Event { patches, .. } = retried.body else { unreachable!() };
    let timings = patches.iter().find_map(|patch| match patch {
        ViewPatch::Message { message } => match &message.presentation {
            Some(ResponsePresentation::Ready { timings: Some(timings), .. }) => Some(timings),
            _ => None,
        },
        _ => None,
    }).unwrap();
    assert_eq!(timings.work_ms, None, "a formatting retry must not reuse the previous run clock or include user retry delay");
    assert_eq!(fs::read_to_string(fixture.0.join("formatter-calls.jsonl")).unwrap().lines().count(), 2);
    let calls: Vec<serde_json::Value> = fs::read_to_string(fixture.0.join("formatter-calls.jsonl")).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    assert_eq!(calls[0]["input"]["answer"], calls[1]["input"]["answer"], "retry uses every original reply, not just the final message");
    assert!(calls[1]["input"]["answer"].as_str().unwrap().starts_with("Earlier finding:"));
    assert_eq!(fixture.log().iter().filter(|command| command["type"] == "prompt" && command["message"] == "format-multiple").count(), 1, "retry must not rerun agent work");
    send(&handle, &identity, "retry-ready", BrowserAction::RetryResponse { message_id });
    assert!(!result(&mut connection, "retry-ready").await.ok);
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn response_formatter_is_nonblocking_and_reaps_its_child_on_shutdown() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("formatter-hold"), "").unwrap();
    let mut config = fixture.config();
    config.response_model = pi_web::config::ResponseModel { provider: "fixture".into(), id: "cheap".into() };
    let handle = session::start(config).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !fixture.0.join("formatter-calls.jsonl").exists() { tokio::time::sleep(Duration::from_millis(5)).await; }
    }).await.unwrap();
    send(&handle, &identity, "attach-while-formatting", BrowserAction::Attach);
    assert!(result(&mut connection, "attach-while-formatting").await.ok);
    let launch: serde_json::Value = serde_json::from_str(&fs::read_to_string(fixture.0.join("formatter-launch.json")).unwrap()).unwrap();
    assert!(handle.shutdown().await);
    assert!(!std::path::Path::new(launch["cwd"].as_str().unwrap()).exists(), "private cwd must be cleaned");
    let pid = launch["pid"].as_i64().unwrap() as libc::pid_t;
    // Signal zero checks existence without signaling the fixture process.
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "formatter must be reaped before shutdown returns");
}

#[tokio::test]
async fn response_formatter_accepts_large_streamed_json_and_restores_it_without_inference() {
    use pi_web::{response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    let table = serde_json::json!({"type":"table","title":"Data","columns":["A","B","C","D","E","F"],"rows":vec![vec!["x".repeat(190); 6]; 32]});
    let expected = serde_json::json!({"summary":"Four detailed tables.","blocks":vec![table; 4]});
    let text = expected.to_string();
    assert!(text.len() > 128 * 1024, "exercise generation and storage beyond the previous output and metadata caps");
    fs::write(fixture.0.join("formatter-response.json"), text).unwrap();
    fs::write(fixture.0.join("formatter-timing-delays"), "").unwrap();
    fs::write(fixture.0.join("formatter-persist-history"), "").unwrap();
    let config = fixture.config();
    let handle = session::start(config.clone()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Ready { .. } | ResponsePresentation::Error { .. })))))).await;
    let ServerBody::Event { patches, .. } = frame.body else { unreachable!() };
    let response = patches.iter().find_map(|patch| match patch {
        ViewPatch::Message { message } => match &message.presentation { Some(ResponsePresentation::Ready { response, .. }) => Some(response), _ => None }, _ => None,
    }).expect("valid streamed content must not be rejected by a fixed JSON byte cap");
    let mut actual = serde_json::to_value(response).unwrap();
    actual.as_object_mut().unwrap().remove("recorded");
    assert_eq!(actual, expected);
    assert!(handle.shutdown().await);
    let handle = session::start(config).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Snapshot { messages, .. } if messages.iter().any(|message| matches!(message.presentation, Some(ResponsePresentation::Ready { .. }))))).await;
    let ServerBody::Snapshot { messages, .. } = frame.body else { unreachable!() };
    let restored = messages.iter().find_map(|message| match &message.presentation { Some(ResponsePresentation::Ready { response, timings: Some(timings) }) => { assert!(timings.cached); Some(response) }, _ => None }).unwrap();
    let mut actual = serde_json::to_value(restored).unwrap();
    actual.as_object_mut().unwrap().remove("recorded");
    assert_eq!(actual, expected, "the complete large document must remain readable after restart");
    assert_eq!(fs::read_to_string(fixture.0.join("formatter-calls.jsonl")).unwrap().lines().count(), 1);
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn response_formatter_binds_observed_tool_outcomes_without_private_arguments_or_output() {
    use pi_web::{response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Ready { .. })))))).await;
    let wire = serde_json::to_value(&frame).unwrap();
    let response = wire["body"]["patches"].as_array().unwrap().iter().find_map(|patch| patch.get("message").and_then(|message| message.get("presentation")).and_then(|presentation| presentation.get("response"))).unwrap();
    assert_eq!(response["recorded"]["tools"][0]["label"], "Read file");
    assert_eq!(response["recorded"]["tools"][0]["outcome"], "completed");
    assert!(!response.to_string().contains("fixture content"));
    assert!(!response.to_string().contains("fixture.txt"));
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn history_pages_and_lazy_originals_release_old_payloads_without_model_calls() {
    use pi_web::{protocol::{HistoryRequest, HistoryResponse}, response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    fs::write(fixture.0.join("history-pages"), "").unwrap();
    fs::write(fixture.0.join("formatter-persist-history"), "").unwrap();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    for index in 0..45 {
        fs::write(fixture.0.join("formatter-response.json"), serde_json::json!({"summary":format!("Saved reply {index}"),"blocks":[]}).to_string()).unwrap();
        fs::write(fixture.0.join("coding-response.txt"), format!("Original reply {index}")).unwrap();
        send(&handle, &identity, &format!("turn-{index}"), BrowserAction::Prompt { text: "complete".into(), images: vec![] });
        until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(&message.presentation, Some(ResponsePresentation::Ready { response, .. }) if response.summary == format!("Saved reply {index}")))))).await;
    }
    handle.disconnect("client".into()).await;
    let mut connection = handle.connect("client".into()).await.unwrap();
    let snapshot = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Snapshot { .. })).await;
    let ServerBody::Snapshot { messages, older_history, .. } = snapshot.body else { unreachable!() };
    assert!(older_history);
    assert_eq!(messages.iter().filter(|message| message.role == "user").count(), 10);
    assert_eq!(messages.len(), 20, "hidden replies and their source text are released, not just hidden in the UI");
    assert!(messages.iter().filter(|message| message.role == "assistant").all(|message| message.blocks.is_empty()));
    let start = messages[0].id.clone();
    let HistoryResponse::Page { cursor, older_cursor, messages: older, .. } = handle.read_history(HistoryRequest::Page { cursor: None, start: Some(start) }).await.unwrap() else { panic!("expected page") };
    let summaries = |messages: &[pi_web::view::DisplayMessage]| messages.iter().filter_map(|message| match &message.presentation { Some(ResponsePresentation::Ready { response, .. }) => Some(response.summary.clone()), _ => None }).collect::<Vec<_>>();
    assert_eq!(summaries(&older), (25..35).map(|index| format!("Saved reply {index}")).collect::<Vec<_>>());
    assert!(older.iter().filter(|message| message.role == "assistant").all(|message| message.blocks.is_empty()));
    let key = older.iter().find_map(|message| message.source_key.clone()).unwrap();
    let original = handle.read_history(HistoryRequest::Original { cursor: Some(cursor.clone()), source_key: key.clone() }).await.unwrap();
    assert!(matches!(original, HistoryResponse::Original { text, .. } if text == "Original reply 25"));
    let mut next = older_cursor;
    for range in [15..25, 5..15] {
        let HistoryResponse::Page { messages, older_cursor, .. } = handle.read_history(HistoryRequest::Page { cursor: next, start: None }).await.unwrap() else { panic!("expected older page") };
        assert_eq!(summaries(&messages), range.map(|index| format!("Saved reply {index}")).collect::<Vec<_>>());
        next = older_cursor;
    }
    let HistoryResponse::Page { messages: first, older_cursor: end, .. } = handle.read_history(HistoryRequest::Page { cursor: next, start: None }).await.unwrap() else { panic!("expected oldest page") };
    assert!(end.is_none());
    assert_eq!(summaries(&first), (0..5).map(|index| format!("Saved reply {index}")).collect::<Vec<_>>());
    let HistoryResponse::Page { messages: newer, .. } = handle.read_history(HistoryRequest::Page { cursor: Some(cursor.clone()), start: None }).await.unwrap() else { panic!("expected newer page") };
    assert_eq!(summaries(&newer), summaries(&older));
    assert!(handle.read_history(HistoryRequest::Page { cursor: Some("p1:999999999999:outside".into()), start: None }).await.is_err());
    send(&handle, &identity, "working", BrowserAction::Prompt { text: "keep-working".into(), images: vec![] });
    until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { status, .. } if status.activity == pi_web::view::Activity::Running)).await;
    let original = handle.read_history(HistoryRequest::Original { cursor: Some(cursor), source_key: key }).await.unwrap();
    assert!(matches!(original, HistoryResponse::Original { text, .. } if text == "Original reply 25"));
    assert_eq!(fs::read_to_string(fixture.0.join("formatter-calls.jsonl")).unwrap().lines().count(), 45, "navigation and Original must never invoke a formatter");
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn response_formatter_keeps_all_results_beyond_eight_entries_and_48_kib_on_restart() {
    use pi_web::{protocol::{HistoryRequest, HistoryResponse}, response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    fs::write(fixture.0.join("formatter-persist-history"), "").unwrap();
    let config = fixture.config();
    let handle = session::start(config.clone()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    let mut expected = Vec::new();
    for index in 0..12 {
        let summary = format!("Saved result {index}");
        let response = serde_json::json!({"summary":summary,"blocks":(0..4).map(|block| serde_json::json!({"type":"note","title":format!("Context {block}"),"text":"x".repeat(1100)})).collect::<Vec<_>>()});
        fs::write(fixture.0.join("formatter-response.json"), response.to_string()).unwrap();
        fs::write(fixture.0.join("coding-response.txt"), format!("Original reply {index}")).unwrap();
        send(&handle, &identity, &format!("complete-{index}"), BrowserAction::Prompt { text: "complete".into(), images: vec![] });
        let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(&message.presentation, Some(ResponsePresentation::Ready { response, .. }) if response.summary == summary))))).await;
        let ServerBody::Event { patches, .. } = frame.body else { unreachable!() };
        expected.push(patches.into_iter().find_map(|patch| match patch {
            ViewPatch::Message { message } => match message.presentation { Some(ResponsePresentation::Ready { response, .. }) => Some(response), _ => None }, _ => None,
        }).unwrap());
    }
    assert!(serde_json::to_vec(&expected).unwrap().len() > 48 * 1024);
    assert!(handle.shutdown().await);
    let handle = session::start(config).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Snapshot { messages, .. } if messages.iter().any(|message| message.role == "assistant"))).await;
    let ServerBody::Snapshot { messages, .. } = frame.body else { unreachable!() };
    let restored: Vec<_> = messages.iter().filter_map(|message| match &message.presentation { Some(ResponsePresentation::Ready { response, timings: Some(timings) }) => { assert!(timings.cached); Some(response.clone()) }, _ => None }).collect();
    assert_eq!(restored, expected[2..], "the latest ten replies load after restart");
    let HistoryResponse::Page { messages: older, older_cursor, .. } = handle.read_history(HistoryRequest::Page { cursor: None, start: Some(messages[0].id.clone()) }).await.unwrap() else { panic!("expected older page") };
    assert!(older_cursor.is_none());
    let mut all: Vec<_> = older.into_iter().filter_map(|message| match message.presentation { Some(ResponsePresentation::Ready { response, .. }) => Some(response), _ => None }).collect();
    all.extend(restored);
    assert_eq!(all, expected, "every saved simple reply must survive disk retention and restart across pages");
    assert_eq!(fs::read_to_string(fixture.0.join("formatter-calls.jsonl")).unwrap().lines().count(), 12, "restoration must not make model calls");
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn response_formatter_restores_saved_history_after_server_restart_without_inference() {
    use pi_web::{response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    fs::write(fixture.0.join("formatter-persist-history"), "").unwrap();
    let source = "  const value = \"<script>literal()</script>\";\r\n";
    let mut generated = serde_json::json!({"summary":"Useful result. ".repeat(100),"canvas":{"layout":"task_outcome","headline":"Completed","focus":9},"blocks":vec![serde_json::json!({"type":"note","title":"Supporting context","text":"Useful detail. ".repeat(200)}); 10]});
    generated["blocks"].as_array_mut().unwrap().push(serde_json::json!({"type":"code","title":"Code example","language":"typescript","code":source}));
    fs::write(fixture.0.join("formatter-response.json"), generated.to_string()).unwrap();
    let config = fixture.config();
    let handle = session::start(config.clone()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Ready { .. })))))).await;
    let ServerBody::Event { patches, .. } = frame.body else { unreachable!() };
    let expected = patches.iter().find_map(|patch| match patch {
        ViewPatch::Message { message } => match &message.presentation { Some(ResponsePresentation::Ready { response, .. }) => Some(response.clone()), _ => None }, _ => None,
    }).unwrap();
    assert!(handle.shutdown().await);

    let handle = session::start(config).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Snapshot { messages, .. } if messages.iter().any(|message| message.role == "assistant"))).await;
    let ServerBody::Snapshot { messages, .. } = frame.body else { unreachable!() };
    let restored: Vec<_> = messages.iter().filter(|message| message.role == "assistant").collect();
    assert_eq!(restored.len(), 1);
    let Some(ResponsePresentation::Ready { response, timings: Some(timings) }) = &restored[0].presentation else { panic!("a retained saved answer must survive a full server restart: {:?}", restored[0].presentation) };
    assert_eq!(*response, expected);
    assert_eq!(response.blocks.len(), 11);
    assert_eq!(serde_json::to_value(response).unwrap()["blocks"][10]["code"], source);
    assert_eq!(response.canvas.as_ref().unwrap().layout, pi_web::response_format::CanvasLayout::Answer);
    assert!(timings.cached);
    assert_eq!(fs::read_to_string(fixture.0.join("formatter-calls.jsonl")).unwrap().lines().count(), 1, "restoring a saved presentation makes no new model call");
    assert_eq!(fixture.log().iter().filter(|command| command["type"] == "prompt" && command["message"] == "complete").count(), 1, "restoring history must never rerun the coding task");
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn response_formatter_delivers_visual_blocks_in_one_formatting_call() {
    use pi_web::{response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    let expected = serde_json::json!({"summary":"Visual component example. Values are illustrative.","blocks":[
        {"type":"table","title":"Comparison","columns":["Option","Time"],"rows":[["A","2 s"],["B","3 s"]]},
        {"type":"facts","title":"Key facts","items":[{"label":"Layouts","value":"4"}]},
        {"type":"comparison","title":"Change","before":"Long text.","after":"Short visual answer."},
        {"type":"flow","title":"Answer path","items":["Pi","Formatter","UI"]}
    ]});
    fs::write(fixture.0.join("formatter-response.json"), expected.to_string()).unwrap();
    let config = fixture.config();
    let handle = session::start(config.clone()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Ready { .. })))))).await;
    let ServerBody::Event { patches, .. } = frame.body else { unreachable!() };
    let response = patches.iter().find_map(|patch| match patch {
        ViewPatch::Message { message } => match &message.presentation { Some(ResponsePresentation::Ready { response, .. }) => Some(response), _ => None },
        _ => None,
    }).unwrap();
    let mut actual = serde_json::to_value(response).unwrap();
    let recorded = actual.as_object_mut().unwrap().remove("recorded").expect("backend observations are attached separately");
    assert_eq!(recorded["tools"][0]["outcome"], "completed");
    assert_eq!(actual, expected);
    assert!(handle.shutdown().await);
    let handle = session::start(config).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "cached", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Ready { .. })))))).await;
    assert_eq!(fs::read_to_string(fixture.0.join("formatter-calls.jsonl")).unwrap().lines().count(), 2, "one call per turn, not per component; fresh turns keep separate observations");
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn response_formatter_delivers_adaptive_plans_and_resolves_only_observed_references() {
    use pi_web::{response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    let expected = serde_json::json!({"summary":"One server routes the request.","canvas":{"layout":"explanation","headline":"Sessions stay separate","focus":0},"blocks":[
        {"type":"diagram","title":"Routing","nodes":[{"id":"a","label":"Browser","kind":"input"},{"id":"b","label":"Server","kind":"process"}],"edges":[{"from":"a","to":"b","label":"request","relation":"direct"}]},
        {"type":"evidence","title":"Observed work","items":["tool:0"]}
    ]});
    fs::write(fixture.0.join("formatter-response.json"), expected.to_string()).unwrap();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(message.presentation, Some(ResponsePresentation::Ready { .. })))))).await;
    let wire = serde_json::to_value(&frame).unwrap();
    let presentation = wire["body"]["patches"].as_array().unwrap().iter().find_map(|patch| patch.get("message").and_then(|message| message.get("presentation"))).unwrap();
    let mut response = presentation["response"].clone();
    let recorded = response.as_object_mut().unwrap().remove("recorded").unwrap();
    assert_eq!(response, expected);
    assert_eq!(recorded["tools"][0]["id"], "tool:0");
    assert!(presentation["timings"]["captureMs"].is_u64());
    assert_eq!(fs::read_to_string(fixture.0.join("formatter-calls.jsonl")).unwrap().lines().count(), 1);
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn response_formatter_rejects_unavailable_reference_ids_without_inventing_observations() {
    use pi_web::{response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    fs::write(fixture.0.join("formatter-response.json"), r#"{"summary":"Done","blocks":[{"type":"evidence","title":"Work","items":["file:7"]}]}"#).unwrap();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    let frame = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(&message.presentation, Some(ResponsePresentation::Error { message, .. }) if message.contains("unavailable evidence")))))).await;
    assert!(!serde_json::to_string(&frame).unwrap().contains("fixture content"));
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn response_formatter_rejects_tool_attempts() {
    use pi_web::{response_format::ResponsePresentation, view::ViewPatch};
    let fixture = Fixture::new();
    fs::write(fixture.0.join("formatter-tool"), "").unwrap();
    let mut config = fixture.config();
    config.response_model = pi_web::config::ResponseModel { provider: "fixture".into(), id: "cheap".into() };
    let handle = session::start(config).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { patches, .. } if patches.iter().any(|patch| matches!(patch, ViewPatch::Message { message } if matches!(&message.presentation, Some(ResponsePresentation::Error { message, .. }) if message.contains("tool call")))))).await;
    assert!(handle.shutdown().await);
}

async fn command_catalog(connection: &mut Connection, expected: &str) -> ServerMessage {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let message = next(connection).await;
            let body = serde_json::to_value(&message.body).unwrap();
            if body["type"] == "commands" {
                let commands = body["commands"].as_array().unwrap();
                if commands.is_empty() {
                    continue;
                }
                assert_eq!(commands.len(), 1);
                assert_eq!(commands[0]["name"], expected, "stale command catalog");
                assert!(commands[0].get("sourceInfo").is_none());
                return message;
            }
        }
    })
    .await
    .expect("command catalog was not delivered")
}

/// Live status is a safe category, replayed on reconnect without raw tool data.
#[tokio::test]
async fn live_work_phase_tracks_tools_and_reconnects_without_exposing_payloads() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("pause-tool"), "").unwrap();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
    let active = until(&mut connection, |frame| {
        serde_json::to_value(frame).unwrap()["body"]["status"]["workPhase"] == "reading"
    }).await;
    let serialized = serde_json::to_string(&active).unwrap();
    for private in ["tool-1", "fixture.txt", "fixture content", "toolName", "args", "partialResult"] {
        assert!(!serialized.contains(private), "tool details must remain private");
    }
    let mut observer = handle.connect("observer".into()).await.unwrap();
    let snapshot = until(&mut observer, |frame| matches!(frame.body, ServerBody::Snapshot { .. })).await;
    assert_eq!(serde_json::to_value(snapshot).unwrap()["body"]["status"]["workPhase"], "reading");
    fs::remove_file(fixture.0.join("pause-tool")).unwrap();
    let settled = until(&mut connection, |frame| matches!(&frame.body, ServerBody::Event { status, .. } if status.activity == pi_web::view::Activity::Idle)).await;
    assert!(serde_json::to_value(settled).unwrap()["body"]["status"].get("workPhase").is_none());
    assert_eq!(fixture.log().iter().filter(|command| command["type"] == "prompt" && command["message"] == "complete").count(), 1, "progress must not prompt the agent");
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn tool_execution_payloads_never_reach_browser_frames() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let child = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = child.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(&child, &identity, "complete", BrowserAction::Prompt { text: "complete".into(), images: vec![] });
        let mut completed = false;
        loop {
            let frame = next(&mut connection).await;
            let serialized = serde_json::to_string(&frame).unwrap();
            for private in ["tool-1", "fixture.txt", "fixture content", "\"tools\"", "\"tool\""] {
                assert!(!serialized.contains(private), "tool payload published: {serialized}");
            }
            completed |= serialized.contains("Completed");
            if matches!(&frame.body, ServerBody::Event { status, .. } if completed && status.activity == pi_web::view::Activity::Idle) {
                break;
            }
        }
        send(&child, &identity, "snapshot", BrowserAction::Attach);
        let snapshot = until(&mut connection, |m| matches!(m.body, ServerBody::Snapshot { .. })).await;
        let value = serde_json::to_value(snapshot).unwrap();
        assert!(value["body"].get("tools").is_none());
        assert!(!value.to_string().contains("fixture content"));
    }).await;
    handle.shutdown().await;
    outcome.unwrap();
}

/// Read-only stats reach the footer, refresh after settlement, and survive browser reattachment.
#[tokio::test]
async fn context_usage_refreshes_and_replays_without_private_stats() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "context-attach", BrowserAction::Attach);
    until(&mut connection, |m| matches!(&m.body, ServerBody::ContextUsage { usage: Some(u) } if u.tokens == Some(12500) && u.context_window == 100000)).await;
    send(
        &handle,
        &identity,
        "context-run",
        BrowserAction::Prompt { text: "complete".into(), images: vec![] },
    );
    until(&mut connection, |m| matches!(&m.body, ServerBody::ContextUsage { usage: Some(u) } if u.tokens == Some(25000))).await;
    handle.disconnect("client".into()).await;
    let mut connection = handle.connect("client".into()).await.unwrap();
    let replay = until(&mut connection, |m| {
        matches!(&m.body, ServerBody::ContextUsage { usage: Some(_) })
    })
    .await;
    let value = serde_json::to_string(&replay).unwrap();
    assert!(value.contains("25000"));
    assert!(!value.contains("PRIVATE") && !value.contains("cost"));
    assert!(handle.shutdown().await);
}

/// Compaction refreshes usage before another message or settlement arrives.
#[tokio::test]
async fn compaction_end_refreshes_context_and_manual_command_returns_idle() {
    use pi_web::view::Activity;
    for prompt in ["compact-overflow", "/compact"] {
        let fixture = Fixture::new();
        let handle = session::start(fixture.config()).unwrap();
        let mut connection = handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(&handle, &identity, "context-attach", BrowserAction::Attach);
        until(&mut connection, |m| matches!(&m.body, ServerBody::ContextUsage { usage: Some(u) } if u.tokens == Some(12500))).await;
        send(&handle, &identity, "compact", BrowserAction::Prompt { text: prompt.into(), images: vec![] });
        let expected = if prompt == "/compact" { Activity::Idle } else { Activity::Running };
        let outcome = tokio::time::timeout(Duration::from_secs(3), async {
            let mut refreshed = false;
            let mut completed = false;
            while !refreshed || !completed {
                match next(&mut connection).await.body {
                    ServerBody::ContextUsage { usage: Some(u) } => refreshed |= u.tokens == Some(4000),
                    ServerBody::Event { status, .. } => completed |= status.activity == expected,
                    _ => {}
                }
            }
        }).await;
        assert!(handle.shutdown().await);
        outcome.expect("compaction must refresh context and leave the compaction phase");
    }
}

/// Standalone extension compaction has no subsequent prompt acknowledgement or settlement.
#[tokio::test]
async fn compaction_reconciles_idle_and_active_runs_without_another_event() {
    use pi_web::view::{Activity, ViewPatch};
    for (prompt, expected) in [
        ("compact-after-settlement", Activity::Idle),
        ("compact-active", Activity::Running),
    ] {
        let fixture = Fixture::new();
        let handle = session::start(fixture.config()).unwrap();
        let mut connection = handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(&handle, &identity, "compact", BrowserAction::Prompt { text: prompt.into(), images: vec![] });
        let outcome = tokio::time::timeout(Duration::from_secs(3), async {
            let mut saw_compaction = false;
            let mut refreshed = false;
            let mut activity = Activity::Idle;
            loop {
                match next(&mut connection).await.body {
                    ServerBody::ContextUsage { usage: Some(u) } => refreshed |= u.tokens == Some(4000),
                    ServerBody::Event { status, patches, .. } => {
                        saw_compaction |= patches.iter().any(|p| matches!(p, ViewPatch::Activity { activity: Activity::Compacting }));
                        activity = status.activity;
                    }
                    _ => {}
                }
                if saw_compaction && refreshed && activity == expected { break; }
            }
            send(&handle, &identity, "next", BrowserAction::Prompt { text: "/handled".into(), images: vec![] });
            let receipt = result(&mut connection, "next").await;
            if expected == Activity::Idle { assert!(receipt.ok, "{receipt:?}"); }
            else { assert_eq!(receipt.code, "busy"); }
        }).await;
        assert!(handle.shutdown().await);
        outcome.unwrap_or_else(|_| panic!("{prompt} did not reconcile to {expected:?}"));
    }
}

#[tokio::test]
async fn unavailable_context_does_not_fail_the_session() {
    for marker in ["unsupported-context", "unknown-context"] {
        let fixture = Fixture::new();
        fs::write(fixture.0.join(marker), "").unwrap();
        let handle = session::start(fixture.config()).unwrap();
        let mut connection = handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(&handle, &identity, "context-attach", BrowserAction::Attach);
        let context = until(&mut connection, |m| {
            matches!(&m.body, ServerBody::ContextUsage { .. })
        })
        .await;
        match context.body {
            ServerBody::ContextUsage { usage } => assert!(usage.is_none_or(|u| u.tokens.is_none())),
            _ => unreachable!(),
        }
        assert!(handle.shutdown().await);
    }
}

/// Startup settings replay is a bounded public projection, including extension status.
#[tokio::test]
async fn settings_are_replayed_without_private_model_configuration() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(&handle, &identity, "settings-attach", BrowserAction::Attach);
    let mut settings = None;
    loop {
        let message = next(&mut connection).await;
        let value = serde_json::to_value(&message).unwrap();
        if value["body"]["type"] == "settings" {
            settings = Some(value["body"]["settings"].clone());
        }
        if matches!(message.body, ServerBody::Result { .. }) {
            break;
        }
    }
    assert!(handle.shutdown().await);
    let settings = settings.expect("attach must replay settings");
    assert_eq!(settings["model"]["id"], "fixture-model");
    assert_eq!(
        settings["thinkingLevels"],
        serde_json::json!(["off", "high"])
    );
    assert_eq!(settings["codexFast"], "codex fast (requested)");
    assert!(!settings.to_string().contains("PRIVATE"));
}

/// Settings use exact RPC payloads, serialize against prompts and validate advertised membership.
#[tokio::test]
async fn settings_mutations_validate_and_serialize_with_prompts() {
    use pi_web::protocol::ThinkingLevel;
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    until(
        &mut connection,
        |m| matches!(&m.body, ServerBody::Settings { settings } if !settings.models.is_empty()),
    )
    .await;
    send(
        &handle,
        &identity,
        "bad-model",
        BrowserAction::SetModel {
            provider: "fixture".into(),
            model_id: "unknown".into(),
        },
    );
    assert_eq!(
        result(&mut connection, "bad-model").await.code,
        "invalid_model"
    );
    send(
        &handle,
        &identity,
        "bad-level",
        BrowserAction::SetThinkingLevel {
            level: ThinkingLevel::Max,
        },
    );
    assert_eq!(
        result(&mut connection, "bad-level").await.code,
        "invalid_thinking_level"
    );
    send(
        &handle,
        &identity,
        "model",
        BrowserAction::SetModel {
            provider: "fixture".into(),
            model_id: "second".into(),
        },
    );
    send(
        &handle,
        &identity,
        "blocked-prompt",
        BrowserAction::Prompt { text: "must not execute".into(), images: vec![] },
    );
    assert_eq!(result(&mut connection, "blocked-prompt").await.code, "busy");
    assert!(result(&mut connection, "model").await.ok);
    send(
        &handle,
        &identity,
        "level",
        BrowserAction::SetThinkingLevel {
            level: ThinkingLevel::High,
        },
    );
    assert!(result(&mut connection, "level").await.ok);
    handle.disconnect("client".into()).await;
    let mut connection = handle.connect("client".into()).await.unwrap();
    let replay = until(&mut connection, |m| {
        matches!(&m.body, ServerBody::Settings { .. })
    })
    .await;
    let ServerBody::Settings { settings } = replay.body else {
        unreachable!()
    };
    assert_eq!(settings.model.unwrap().id, "second");
    assert_eq!(settings.thinking_level, Some(ThinkingLevel::High));
    assert_eq!(settings.codex_fast, None);
    send(
        &handle,
        &identity,
        "running",
        BrowserAction::Prompt { text: "running".into(), images: vec![] },
    );
    assert!(result(&mut connection, "running").await.ok);
    send(
        &handle,
        &identity,
        "busy-setting",
        BrowserAction::SetThinkingLevel {
            level: ThinkingLevel::Off,
        },
    );
    assert_eq!(result(&mut connection, "busy-setting").await.code, "busy");
    let log = fixture.log();
    assert_eq!(log.iter().filter(|v| v["type"] == "set_model").count(), 1);
    assert!(log.iter().any(|v| v["type"] == "set_model"
        && v["modelId"] == "second"
        && v["provider"] == "fixture"));
    assert_eq!(
        log.iter()
            .filter(|v| v["type"] == "set_thinking_level")
            .count(),
        1
    );
    assert!(
        log.iter()
            .any(|v| v["type"] == "set_thinking_level" && v["level"] == "high")
    );
    assert!(!log.iter().any(|v| v["message"] == "must not execute"));
    assert!(handle.shutdown().await);
}

/// Only actual settlement produces a completion; attaching never replays one.
#[tokio::test]
async fn run_completion_is_live_only_and_once_per_settlement() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    until(
        &mut connection,
        |m| matches!(&m.body, ServerBody::Settings { settings } if !settings.models.is_empty()),
    )
    .await;
    send(
        &handle,
        &identity,
        "complete",
        BrowserAction::Prompt { text: "complete".into(), images: vec![] },
    );
    let completed = until(&mut connection, |m| {
        matches!(m.body, ServerBody::RunCompleted { .. })
    })
    .await;
    assert!(
        matches!(completed.body, ServerBody::RunCompleted { run_id, outcome: pi_web::protocol::RunOutcome::Success } if run_id == "1")
    );
    send(&handle, &identity, "replay", BrowserAction::Attach);
    loop {
        let message = next(&mut connection).await;
        assert!(!matches!(message.body, ServerBody::RunCompleted { .. }));
        if matches!(&message.body, ServerBody::Result { result } if result.request_id == "replay") {
            break;
        }
    }
    handle.disconnect("client".into()).await;
    let mut connection = handle.connect("client".into()).await.unwrap();
    loop {
        let message = next(&mut connection).await;
        assert!(!matches!(message.body, ServerBody::RunCompleted { .. }));
        if matches!(message.body, ServerBody::Settings { .. }) {
            break;
        }
    }
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn rejected_settings_preserve_confirmed_state_and_optional_apis_do_not_fail_startup() {
    use pi_web::protocol::ThinkingLevel;
    for unsupported in [false, true] {
        let fixture = Fixture::new();
        fs::write(
            fixture.0.join(if unsupported {
                "unsupported-settings"
            } else {
                "reject-settings"
            }),
            "",
        )
        .unwrap();
        let handle = session::start(fixture.config()).unwrap();
        let mut connection = handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        if !unsupported {
            until(&mut connection, |m| matches!(&m.body, ServerBody::Settings { settings } if !settings.models.is_empty())).await;
            send(
                &handle,
                &identity,
                "reject",
                BrowserAction::SetThinkingLevel {
                    level: ThinkingLevel::High,
                },
            );
            let reply = result(&mut connection, "reject").await;
            assert!(!reply.ok);
            assert_eq!(reply.code, "settings_update_failed");
        }
        send(&handle, &identity, "replay-settings", BrowserAction::Attach);
        let replay = until(&mut connection, |m| {
            matches!(m.body, ServerBody::Settings { .. })
        })
        .await;
        let ServerBody::Settings { settings } = replay.body else {
            unreachable!()
        };
        assert_eq!(settings.thinking_level, Some(ThinkingLevel::Off));
        if unsupported {
            assert!(settings.models.is_empty());
            assert!(settings.thinking_levels.is_empty());
        }
        assert!(handle.shutdown().await);
    }
}

#[tokio::test]
async fn lsp_status_updates_clears_and_replays_to_other_devices() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("lsp-status"), "").unwrap();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    assert_eq!(
        serde_json::to_value(&identity).unwrap()["body"]["status"]["lspStatus"],
        "LSP: 1/2 servers"
    );
    for (index, (command, expected)) in [
        ("/lsp-update", Some("LSP: 2/2 servers, 1 warning(s)")),
        ("/lsp-clear", None),
    ]
    .into_iter()
    .enumerate()
    {
        let id = format!("lsp-{index}");
        send(
            &handle,
            &identity,
            &id,
            BrowserAction::Prompt { text: command.into(), images: vec![] },
        );
        assert!(result(&mut connection, &id).await.ok);
        let mut peer = handle.connect(format!("peer-{index}")).await.unwrap();
        let replay = ready(&mut peer).await;
        let status = serde_json::to_value(replay).unwrap()["body"]["status"].clone();
        assert_eq!(status["lspStatus"], serde_json::json!(expected));
        assert!(!status.to_string().contains("PRIVATE"));
    }
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn handled_commands_refresh_settings_and_sanitize_only_codex_status() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(
        &handle,
        &identity,
        "slash-settings",
        BrowserAction::Prompt { text: "/settings".into(), images: vec![] },
    );
    assert!(result(&mut connection, "slash-settings").await.ok);
    send(&handle, &identity, "replay-settings", BrowserAction::Attach);
    let replay = until(&mut connection, |m| matches!(&m.body, ServerBody::Settings { settings } if settings.thinking_level == Some(pi_web::protocol::ThinkingLevel::High) && settings.codex_fast.as_ref().is_some_and(|text| text.len() == 512))).await;
    let ServerBody::Settings { settings } = replay.body else {
        unreachable!()
    };
    assert_eq!(settings.codex_fast.unwrap(), "é".repeat(256));
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn shared_clients_route_results_and_stop_with_independent_request_ids() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let child = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut first = child.connect("client".into()).await.unwrap();
        let identity = ready(&mut first).await;
        let mut second = child.connect("second".into()).await.unwrap();
        ready(&mut second).await;
        send(&child, &identity, "connected", BrowserAction::UiReply {
            dialog_id: "missing".into(), answer: pi_web::protocol::DialogAnswer::Cancelled,
        });
        until(&mut first, |m| {
            assert!(!matches!(m.body, ServerBody::Hello { .. } | ServerBody::Snapshot { .. }), "peer connect reset existing subscriber");
            matches!(&m.body, ServerBody::Result { result } if result.request_id == "connected")
        }).await;

        send(&child, &identity, "same", BrowserAction::Prompt { text: "retry".into(), images: vec![] });
        send_from(&child, "second", &identity, "same", BrowserAction::Prompt { text: "retry".into(), images: vec![] });
        let accepted = result(&mut first, "same").await;
        assert!(accepted.ok);
        assert_eq!(result(&mut second, "same").await.code, "busy");
        for connection in [&mut first, &mut second] {
            until(connection, |m| {
                assert!(!matches!(m.body, ServerBody::Hello { .. }), "peer attachment reset an existing subscriber");
                assert!(!matches!(m.body, ServerBody::Result { .. }), "peer result leaked");
                matches!(&m.body, ServerBody::Event { status, .. } if status.activity == pi_web::view::Activity::Retrying)
            }).await;
        }
        // Exact retries stay scoped to their sender, including rejected commands.
        send(&child, &identity, "same", BrowserAction::Prompt { text: "retry".into(), images: vec![] });
        send_from(&child, "second", &identity, "same", BrowserAction::Prompt { text: "retry".into(), images: vec![] });
        assert_eq!(result(&mut first, "same").await, accepted);
        assert_eq!(result(&mut second, "same").await.code, "busy");
        send_from(&child, "second", &identity, "stop", BrowserAction::Cancel);
        assert!(result(&mut second, "stop").await.ok);
        // Attach is a requester-only replay; use a result as a barrier on the peer.
        send_from(&child, "second", &identity, "attach", BrowserAction::Attach);
        assert!(result(&mut second, "attach").await.ok);
        send(&child, &identity, "barrier", BrowserAction::UiReply {
            dialog_id: "missing".into(), answer: pi_web::protocol::DialogAnswer::Cancelled,
        });
        until(&mut first, |m| {
            assert!(!matches!(m.body, ServerBody::Hello { .. } | ServerBody::Snapshot { .. }));
            if let ServerBody::Result { result } = &m.body { assert_eq!(result.request_id, "barrier"); return true; }
            false
        }).await;
    }).await;
    handle.shutdown().await;
    outcome.unwrap();
    assert_eq!(
        fixture
            .log()
            .iter()
            .filter(|v| v["type"] == "prompt" && v["message"] == "retry")
            .count(),
        1
    );
}

#[tokio::test]
async fn shared_dialog_first_reply_wins_and_only_last_disconnect_cancels() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let child = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut first = child.connect("client".into()).await.unwrap();
        let identity = ready(&mut first).await;
        let mut second = child.connect("second".into()).await.unwrap();
        ready(&mut second).await;
        send(&child, &identity, "prompt", BrowserAction::Prompt { text: "dialog".into(), images: vec![] });
        for connection in [&mut first, &mut second] {
            until(connection, |m| matches!(&m.body, ServerBody::Event { dialogs, .. } if !dialogs.is_empty())).await;
        }
        let answer = || BrowserAction::UiReply { dialog_id: "approval-1".into(), answer: pi_web::protocol::DialogAnswer::Confirmed { confirmed: true } };
        send(&child, &identity, "answer", answer());
        send_from(&child, "second", &identity, "answer", answer());
        assert!(result(&mut first, "answer").await.ok);
        assert_eq!(result(&mut second, "answer").await.code, "stale_dialog");
        send_from(&child, "second", &identity, "stop", BrowserAction::Cancel);
        assert!(result(&mut second, "stop").await.ok);
        // Wait for idle reconciliation before the next run.
        for attempt in 0..100 {
            assert!(attempt < 99, "idle reconciliation did not finish");
            send_from(&child, "second", &identity, &format!("state-{attempt}"), BrowserAction::Attach);
            let state = until(&mut second, |m| matches!(m.body, ServerBody::Snapshot { .. })).await;
            if matches!(state.body, ServerBody::Snapshot { status, .. } if status.activity == pi_web::view::Activity::Idle) { break; }
            tokio::task::yield_now().await;
        }
        send_from(&child, "second", &identity, "prompt2", BrowserAction::Prompt { text: "dialog".into(), images: vec![] });
        until(&mut second, |m| matches!(&m.body, ServerBody::Event { dialogs, .. } if !dialogs.is_empty())).await;
        child.disconnect("client".into()).await;
        send_from(&child, "second", &identity, "state2", BrowserAction::Attach);
        let snapshot = until(&mut second, |m| matches!(m.body, ServerBody::Snapshot { .. })).await;
        assert!(matches!(snapshot.body, ServerBody::Snapshot { dialogs, .. } if dialogs.len() == 1));
        child.disconnect("second".into()).await;
        let mut third = child.connect("third".into()).await.unwrap();
        until(&mut third, |m| matches!(&m.body, ServerBody::Snapshot { dialogs, .. } | ServerBody::Event { dialogs, .. } if dialogs.is_empty())).await;
        until(&mut third, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.notice.as_deref() == Some("dialog-cancelled"))).await;
    }).await;
    handle.shutdown().await;
    outcome.unwrap();
    let replies: Vec<_> = fixture
        .log()
        .into_iter()
        .filter(|v| v["type"] == "extension_ui_response" && v["id"] == "approval-1")
        .collect();
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0]["confirmed"], true);
    assert_eq!(replies[1]["cancelled"], true);
}

#[tokio::test]
async fn shared_attachment_limit_is_released_by_disconnect() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let mut connections = Vec::new();
    for i in 0..8 {
        connections.push(handle.connect(i.to_string()).await.unwrap());
    }
    assert!(matches!(
        handle.connect("ninth".into()).await,
        Err("too_many_clients")
    ));
    handle.disconnect("0".into()).await;
    assert!(handle.connect("ninth".into()).await.is_ok());
    handle.shutdown().await;
}

/// Two subscribers share one server-side refresh, including focus bursts while the agent works.
#[tokio::test]
async fn codex_usage_is_private_shared_and_independent_of_agent_activity() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("codex-usage"), "").unwrap();
    let mut config = fixture.config();
    config.isolated = false;
    let handle = session::start(config).unwrap();
    let mut client = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut client).await;
    let mut phone = handle.connect("phone".into()).await.unwrap();
    ready(&mut phone).await;
    send(
        &handle,
        &identity,
        "working",
        BrowserAction::Prompt { text: "hold".into(), images: vec![] },
    );
    assert!(result(&mut client, "working").await.ok);
    send(
        &handle,
        &identity,
        "quota-desktop",
        BrowserAction::RefreshCodexUsage,
    );
    send_from(
        &handle,
        "phone",
        &identity,
        "quota-phone",
        BrowserAction::RefreshCodexUsage,
    );
    let desktop = until(
        &mut client,
        |m| matches!(&m.body, ServerBody::CodexUsage { usage } if !usage.windows.is_empty()),
    )
    .await;
    let mobile = until(
        &mut phone,
        |m| matches!(&m.body, ServerBody::CodexUsage { usage } if !usage.windows.is_empty()),
    )
    .await;
    assert_eq!(desktop.body, mobile.body);
    send(
        &handle,
        &identity,
        "quota-burst",
        BrowserAction::RefreshCodexUsage,
    );
    assert!(result(&mut client, "quota-burst").await.ok);
    let log = fixture.log();
    assert_eq!(
        log.iter()
            .filter(|c| c["message"]
                .as_str()
                .is_some_and(|m| m.starts_with("/pi-web-codex-usage ")))
            .count(),
        1
    );
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn codex_usage_never_prompts_without_verified_extension_or_in_isolated_mode() {
    for isolated in [false, true] {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("codex-usage"), "").unwrap();
        fs::write(fixture.0.join("wrong-quota-path"), "").unwrap();
        let mut config = fixture.config();
        config.isolated = isolated;
        let handle = session::start(config).unwrap();
        let mut client = handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut client).await;
        send(
            &handle,
            &identity,
            "quota",
            BrowserAction::RefreshCodexUsage,
        );
        assert!(result(&mut client, "quota").await.ok);
        assert!(!fixture.log().iter().any(|c| {
            c["message"]
                .as_str()
                .is_some_and(|m| m.starts_with("/pi-web-codex-usage "))
        }));
        assert!(handle.shutdown().await);
    }
}

#[tokio::test]
async fn codex_usage_model_change_clears_cached_account_data() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("codex-usage"), "").unwrap();
    let mut config = fixture.config();
    config.isolated = false;
    let handle = session::start(config).unwrap();
    let mut client = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut client).await;
    send(
        &handle,
        &identity,
        "quota",
        BrowserAction::RefreshCodexUsage,
    );
    until(
        &mut client,
        |m| matches!(&m.body, ServerBody::CodexUsage { usage } if !usage.windows.is_empty()),
    )
    .await;
    send(
        &handle,
        &identity,
        "model",
        BrowserAction::SetModel {
            provider: "fixture".into(),
            model_id: "second".into(),
        },
    );
    until(&mut client, |m| matches!(&m.body, ServerBody::CodexUsage { usage } if usage.windows.is_empty() && usage.unavailable)).await;
    assert!(result(&mut client, "model").await.ok);
    send(
        &handle,
        &identity,
        "non-codex",
        BrowserAction::RefreshCodexUsage,
    );
    assert!(result(&mut client, "non-codex").await.ok);
    assert_eq!(
        fixture
            .log()
            .iter()
            .filter(|c| c["message"]
                .as_str()
                .is_some_and(|m| m.starts_with("/pi-web-codex-usage ")))
            .count(),
        1
    );
    assert!(handle.shutdown().await);
}

#[tokio::test]
async fn workflows_survive_idle_and_reconnect_and_show_notification_preview() {
    use pi_web::protocol::{BackgroundKind, BackgroundStatus};
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let mut client = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut client).await;
    send(
        &handle,
        &identity,
        "workflow",
        BrowserAction::Prompt { text: "/workflow-launch".into(), images: vec![] },
    );
    let launch = until(
        &mut client,
        |m| matches!(&m.body, ServerBody::BackgroundTasks { tasks } if tasks.len() == 1),
    )
    .await;
    assert!(
        matches!(launch.body, ServerBody::BackgroundTasks { tasks } if tasks[0].kind == BackgroundKind::Workflow && tasks[0].status == BackgroundStatus::Active)
    );
    assert!(result(&mut client, "workflow").await.ok);
    ready(&mut client).await;
    let mut observer = handle.connect("observer".into()).await.unwrap();
    let replay = until(
        &mut observer,
        |m| matches!(&m.body, ServerBody::BackgroundTasks { tasks } if tasks.len() == 1),
    )
    .await;
    assert!(
        matches!(replay.body, ServerBody::BackgroundTasks { tasks } if tasks[0].status == BackgroundStatus::Active)
    );
    send(
        &handle,
        &identity,
        "workflow-done",
        BrowserAction::Prompt { text: "/workflow-complete".into(), images: vec![] },
    );
    let done = until(&mut client, |m| matches!(&m.body, ServerBody::BackgroundTasks { tasks } if tasks.first().is_some_and(|t| t.status == BackgroundStatus::Completed))).await;
    assert!(
        matches!(done.body, ServerBody::BackgroundTasks { tasks } if tasks[0].result.as_deref() == Some("Workflow verified") && !serde_json::to_string(&tasks).unwrap().contains("PRIVATE"))
    );
    assert!(result(&mut client, "workflow-done").await.ok);
    handle.shutdown().await;
}

#[tokio::test]
async fn background_tasks_survive_idle_and_reconnect_then_interrupt_and_reset() {
    use pi_web::protocol::{BackgroundStatus, ProcessStatus};
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(
        &handle,
        &identity,
        "bg",
        BrowserAction::Prompt { text: "/background-launch".into(), images: vec![] },
    );
    let launched = until(
        &mut connection,
        |m| matches!(&m.body, ServerBody::BackgroundTasks { tasks } if tasks.len() == 1),
    )
    .await;
    let ServerBody::BackgroundTasks { tasks } = launched.body else {
        unreachable!()
    };
    assert_eq!(tasks[0].status, BackgroundStatus::Active);
    assert!(!serde_json::to_string(&tasks).unwrap().contains("PRIVATE"));
    assert!(result(&mut connection, "bg").await.ok);
    ready(&mut connection).await;
    let mut observer = handle.connect("observer".into()).await.unwrap();
    let replay = until(
        &mut observer,
        |m| matches!(&m.body, ServerBody::BackgroundTasks { tasks } if tasks.len() == 1),
    )
    .await;
    assert!(
        matches!(replay.body, ServerBody::BackgroundTasks { tasks } if tasks[0].status == BackgroundStatus::Active)
    );
    send(
        &handle,
        &identity,
        "done-bg",
        BrowserAction::Prompt { text: "/background-complete".into(), images: vec![] },
    );
    let done = until(&mut connection, |m| matches!(&m.body, ServerBody::BackgroundTasks { tasks } if tasks[0].status == BackgroundStatus::Completed)).await;
    assert!(
        matches!(done.body, ServerBody::BackgroundTasks { tasks } if tasks[0].result.as_deref() == Some("Verified result"))
    );
    assert!(result(&mut connection, "done-bg").await.ok);
    ready(&mut connection).await;
    send(
        &handle,
        &identity,
        "stop-bg",
        BrowserAction::Prompt { text: "/background-crash".into(), images: vec![] },
    );
    until(&mut connection, |m| matches!(&m.body, ServerBody::BackgroundTasks { tasks } if tasks.iter().any(|t| t.status == BackgroundStatus::Unknown))).await;
    until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.process == ProcessStatus::Exited)).await;
    send(
        &handle,
        &identity,
        "restart-bg",
        BrowserAction::Restart { confirmed: true },
    );
    until(&mut connection, |m| {
        matches!(&m.body, ServerBody::Hello { .. }) && m.epoch != identity.epoch
    })
    .await;
    let reset = until(&mut connection, |m| {
        matches!(&m.body, ServerBody::BackgroundTasks { .. })
    })
    .await;
    assert!(matches!(reset.body, ServerBody::BackgroundTasks { tasks } if tasks.is_empty()));
    handle.shutdown().await;
}

#[tokio::test]
async fn unsupported_model_rejects_image_prompts_without_rpc_or_consuming_draft() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let task_handle = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = task_handle.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(&task_handle, &identity, "image-only", BrowserAction::Prompt { text: String::new(), images: vec!["a".repeat(64)] });
        let rejected = result(&mut connection, "image-only").await;
        assert!(!rejected.ok); assert_eq!(rejected.code, "model_does_not_support_images");
        send(&task_handle, &identity, "malformed", BrowserAction::Prompt { text: "describe".into(), images: vec!["../../file".into()] });
        assert_eq!(result(&mut connection, "malformed").await.code, "invalid_prompt");
    }).await;
    handle.shutdown().await; outcome.unwrap();
    assert!(!fixture.log().iter().any(|command| command.get("images").is_some()));
}
