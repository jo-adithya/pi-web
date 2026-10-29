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
            BrowserAction::Prompt {
                text: "immediate-stop".into(),
            },
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
            BrowserAction::Prompt {
                text: "no-prompt-ack".into(),
            },
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
            BrowserAction::Prompt {
                text: "dialog-during-stop".into(),
            },
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
        assert!(matches!(
            task_handle.connect("other".into()).await,
            Err("already_attached")
        ));
        send(
            &task_handle,
            &identity,
            "p1",
            BrowserAction::Prompt {
                text: "retry".into(),
            },
        );
        let accepted = result(&mut connection, "p1").await;
        assert_eq!(accepted.disposition.as_deref(), Some("started"));
        send(
            &task_handle,
            &identity,
            "p1",
            BrowserAction::Prompt {
                text: "retry".into(),
            },
        );
        assert_eq!(result(&mut connection, "p1").await, accepted);
        send(
            &task_handle,
            &identity,
            "p1",
            BrowserAction::Prompt {
                text: "different".into(),
            },
        );
        assert_eq!(
            result(&mut connection, "p1").await.code,
            "request_id_conflict"
        );
        send(
            &task_handle,
            &identity,
            "p1",
            BrowserAction::Prompt {
                text: "retry".into(),
            },
        );
        assert_eq!(result(&mut connection, "p1").await, accepted);
        send(
            &task_handle,
            &identity,
            "p2",
            BrowserAction::Prompt {
                text: "second".into(),
            },
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
            BrowserAction::Prompt {
                text: "/handled".into(),
            },
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
            BrowserAction::Prompt {
                text: "dialog".into(),
            },
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
        send(&task_handle, &identity, "p", BrowserAction::Prompt { text: "cancel-race".into() }); assert!(result(&mut connection, "p").await.ok);
        send(&task_handle, &identity, "stop", BrowserAction::Cancel);
        until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.last_outcome.as_deref() == Some("success"))).await;
        send(&task_handle, &identity, "too-early", BrowserAction::Prompt { text: "must not run".into() });
        assert_eq!(result(&mut connection, "too-early").await.code, "busy");
        assert!(result(&mut connection, "stop").await.ok);
        send(&task_handle, &identity, "after", BrowserAction::Prompt { text: "/handled".into() }); assert!(result(&mut connection, "after").await.ok);
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
            BrowserAction::Prompt {
                text: "late-settlement".into(),
            },
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
            BrowserAction::Prompt {
                text: "must not run".into(),
            },
        );
        assert_eq!(result(&mut connection, "too-early").await.code, "busy");
        assert!(result(&mut connection, "stop").await.ok);
        send(
            &task_handle,
            &identity,
            "after",
            BrowserAction::Prompt {
                text: "/handled".into(),
            },
        );
        assert!(result(&mut connection, "after").await.ok);
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
            BrowserAction::Prompt {
                text: "missing-settlement".into(),
            },
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
            BrowserAction::Prompt {
                text: "must not run".into(),
            },
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
        send(&task, &identity, "complete", BrowserAction::Prompt { text: "complete".into() });
        let settled = until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.last_outcome.as_deref() == Some("success"))).await;
        let ServerBody::Event { status, .. } = settled.body else { unreachable!() };
        assert_eq!(serde_json::to_value(status.activity).unwrap(), "reconciling", "the prompt gate is closed until identity reconciliation finishes");
        fs::write(fixture.0.join("allow-settled-state"), "").unwrap();
        until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.activity == pi_web::view::Activity::Idle)).await;
        send(&task, &identity, "next", BrowserAction::Prompt { text: "/handled".into() });
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
        send(&task_handle, &identity, "complete", BrowserAction::Prompt { text: "complete".into() });
        until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.last_outcome.as_deref() == Some("success") && status.activity == pi_web::view::Activity::Idle)).await;
        send(&task_handle, &identity, "switch", BrowserAction::Prompt { text: "/switch-session".into() });
        let replacement = until(&mut connection, |m| matches!(&m.body, ServerBody::Hello { .. }) || matches!(&m.body, ServerBody::Event { status, .. } if status.process != pi_web::protocol::ProcessStatus::Ready)).await;
        assert!(matches!(replacement.body, ServerBody::Hello { .. }), "valid idle replacement must rebuild, not kill Pi");
        assert_eq!(replacement.session_id, identity.session_id);
        assert_ne!(replacement.epoch, identity.epoch);
        let snapshot = until(&mut connection, |m| matches!(&m.body, ServerBody::Snapshot { status, .. } if status.history_warning.is_none())).await;
        if let ServerBody::Snapshot { messages, .. } = snapshot.body { assert!(messages.is_empty()); }
        send(&task_handle, &identity, "old", BrowserAction::Prompt { text: "must not run".into() });
        assert!(!result(&mut connection, "old").await.ok);
        send(&task_handle, &replacement, "new", BrowserAction::Prompt { text: "/handled".into() });
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
        send(&task_handle, &identity, "switch", BrowserAction::Prompt { text: "/switch-start".into() });
        let replacement = until(&mut connection, |m| matches!(m.body, ServerBody::Hello { .. })).await;
        until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.activity == pi_web::view::Activity::Running)).await;
        send(&task_handle, &replacement, "snapshot", BrowserAction::Attach);
        let snapshot = until(&mut connection, |m| matches!(m.body, ServerBody::Snapshot { .. })).await;
        if let ServerBody::Snapshot { messages, .. } = snapshot.body {
            assert!(messages.iter().any(|message| message.blocks.iter().any(|block| block.text == "NEW_SESSION_LIVE")));
        }
        send(&task_handle, &replacement, "busy", BrowserAction::Prompt { text: "must not run".into() });
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
                BrowserAction::Prompt { text: text.into() },
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
            BrowserAction::Prompt {
                text: "ignore-abort".into(),
            },
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
            BrowserAction::Prompt {
                text: "must not run".into(),
            },
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
            BrowserAction::Prompt {
                text: "/handled-fail".into(),
            },
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
            BrowserAction::Prompt {
                text: "/handled-fail".into(),
            },
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
            BrowserAction::Prompt {
                text: "flood".into(),
            },
        );
        let mut replacement = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                match task_handle.connect("replacement".into()).await {
                    Ok(connection) => break connection,
                    Err("already_attached") => tokio::time::sleep(Duration::from_millis(20)).await,
                    Err(error) => panic!("unexpected connect error: {error}"),
                }
            }
        })
        .await
        .expect("slow client was never evicted");
        drop(slow);
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
        send(&task_handle, &identity, "p", BrowserAction::Prompt { text: "crash-dialog".into() });
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
        send(&child, &identity, "crash", BrowserAction::Prompt { text: "crash-dialog".into() });
        until(&mut connection, |m| matches!(&m.body, ServerBody::Event { status, .. } if status.process == pi_web::protocol::ProcessStatus::Exited)).await;
        fs::write(root.join("slash-commands.json"), r#"[{"name":"second","source":"skill"}]"#).unwrap();
        send(&child, &identity, "restart", BrowserAction::Restart { confirmed: true });
        let hello = until(&mut connection, |m| matches!(m.body, ServerBody::Hello { .. })).await;
        assert_ne!(hello.epoch, identity.epoch);
        assert_eq!(command_catalog(&mut connection, "second").await.epoch, hello.epoch);
        let identity = ready(&mut connection).await;
        send(&child, &identity, "switch", BrowserAction::Prompt { text: "/switch-session".into() });
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

#[tokio::test]
async fn tool_execution_payloads_never_reach_browser_frames() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let child = handle.clone();
    let outcome = tokio::spawn(async move {
        let mut connection = child.connect("client".into()).await.unwrap();
        let identity = ready(&mut connection).await;
        send(&child, &identity, "complete", BrowserAction::Prompt { text: "complete".into() });
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
        BrowserAction::Prompt {
            text: "complete".into(),
        },
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
        BrowserAction::Prompt {
            text: "must not execute".into(),
        },
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
        BrowserAction::Prompt {
            text: "running".into(),
        },
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
        BrowserAction::Prompt {
            text: "complete".into(),
        },
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
async fn handled_commands_refresh_settings_and_sanitize_only_codex_status() {
    let fixture = Fixture::new();
    let handle = session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("client".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    send(
        &handle,
        &identity,
        "slash-settings",
        BrowserAction::Prompt {
            text: "/settings".into(),
        },
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
