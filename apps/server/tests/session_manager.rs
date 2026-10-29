//! Multiple-runtime ownership through the public manager/controller interfaces.
use pi_web::{
    config::{self, Config},
    protocol::*,
    session::Connection,
    session_manager::SessionManager,
};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("pi-web-manager-{}", config::identity().unwrap()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("pi"), include_str!("fixtures/runtime_mock.py")).unwrap();
        fs::set_permissions(root.join("pi"), fs::Permissions::from_mode(0o700)).unwrap();
        Self(root.canonicalize().unwrap())
    }
    fn config(&self) -> Config {
        Config::parse([
            "--cwd".into(),
            self.0.to_string_lossy().into(),
            "--state-dir".into(),
            self.0.join("state").to_string_lossy().into(),
            "--pi".into(),
            self.0.join("pi").to_string_lossy().into(),
            "--isolated".into(),
        ])
        .unwrap()
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn command(id: &str, action: WorkspaceAction) -> WorkspaceCommand {
    WorkspaceCommand {
        v: 2,
        request_id: id.into(),
        action,
    }
}
async fn until(
    connection: &mut Connection,
    predicate: impl Fn(&ServerMessage) -> bool,
) -> ServerMessage {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(10), connection.frames.recv())
            .await
            .unwrap()
            .unwrap();
        let message: ServerMessage = serde_json::from_str(&frame.text).unwrap();
        if predicate(&message) {
            return message;
        }
    }
}
async fn ready(connection: &mut Connection) -> ServerMessage {
    until(connection, |message| matches!(&message.body, ServerBody::Snapshot { status, .. } | ServerBody::Event { status, .. } if status.process == ProcessStatus::Ready && status.history_warning.is_none())).await
}

#[tokio::test]
async fn independent_generation_stop_and_reopen_preserve_other_runtime() {
    let fixture = Fixture::new();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let task = manager.clone();
    let outcome = tokio::spawn(async move {
        let first = task.snapshot().await.selected;
        let created = task.command(command("create", WorkspaceAction::Create)).await; assert!(created.ok, "{created:?}");
        let second = created.selected.clone(); assert_ne!(first, second);
        assert_eq!(task.command(command("create", WorkspaceAction::Create)).await, created);
        assert!(!task.command(command("create", WorkspaceAction::List)).await.ok);
        let a = task.lookup(&first).await.unwrap(); let b = task.lookup(&second).await.unwrap();
        let mut ca = a.connect("client".into()).await.unwrap(); let mut cb = b.connect("client".into()).await.unwrap();
        let ia = ready(&mut ca).await; let ib = ready(&mut cb).await;
        for (handle, identity) in [(&a, &ia), (&b, &ib)] {
            handle.dispatch("client".into(), BrowserMessage { v: 1, session_id: identity.session_id.clone(), epoch: identity.epoch.clone(), request_id: "prompt".into(), action: BrowserAction::Prompt { text: "retry".into(), images: vec![] } }).unwrap();
        }
        for connection in [&mut ca, &mut cb] { until(connection, |message| matches!(&message.body, ServerBody::Result { result } if result.request_id == "prompt" && result.ok)).await; }
        a.dispatch("client".into(), BrowserMessage { v: 1, session_id: first.clone(), epoch: ia.epoch.clone(), request_id: "cancel".into(), action: BrowserAction::Cancel }).unwrap();
        until(&mut ca, |message| matches!(&message.body, ServerBody::Result { result } if result.request_id == "cancel" && result.ok)).await;
        assert_ne!(b.summary().activity, pi_web::view::Activity::Idle);
        let stale = task.command(command("stale", WorkspaceAction::Stop { session_id: first.clone(), epoch: config::identity().unwrap(), confirmed: true })).await;
        assert!(!stale.ok); assert_eq!(stale.code, "stale_epoch");
        let stopped = task.command(command("stop", WorkspaceAction::Stop { session_id: first.clone(), epoch: ia.epoch.clone(), confirmed: true })).await; assert!(stopped.ok, "{stopped:?}");
        assert!(task.lookup(&first).await.is_none()); assert_eq!(b.summary().epoch, ib.epoch);
        assert!(task.command(command("open", WorkspaceAction::Open { session_id: first.clone() })).await.ok);
        let reopened = task.lookup(&first).await.unwrap(); assert_eq!(reopened.id(), first); assert_ne!(reopened.summary().epoch, ia.epoch);
        let mut fresh = reopened.connect("new".into()).await.unwrap(); ready(&mut fresh).await;
        b.disconnect("client".into()).await; let mut fresh_b = b.connect("new".into()).await.unwrap();
        let snapshot = until(&mut fresh_b, |message| matches!(&message.body, ServerBody::Snapshot { .. })).await;
        assert_eq!(snapshot.epoch, ib.epoch); assert!(serde_json::to_string(&snapshot).unwrap().contains("Hello"));
    }).await;
    assert!(manager.shutdown().await);
    outcome.unwrap();
}

#[tokio::test]
async fn concurrent_creation_is_bounded_and_restart_opens_only_selection() {
    let fixture = Fixture::new();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let task = manager.clone();
    let outcome = tokio::spawn(async move {
        let mut jobs = tokio::task::JoinSet::new();
        for i in 0..8 {
            let manager = task.clone();
            jobs.spawn(async move {
                manager
                    .command(command(&format!("create-{i}"), WorkspaceAction::Create))
                    .await
            });
        }
        let mut accepted = 0;
        while let Some(reply) = jobs.join_next().await {
            accepted += usize::from(reply.unwrap().ok);
        }
        assert_eq!(accepted, 3);
        assert_eq!(task.snapshot().await.sessions.len(), 4);
        assert!(
            SessionManager::start(fixture.config()).is_err(),
            "root lock must survive runtime changes"
        );
        let selected = task.snapshot().await.selected;
        assert!(task.shutdown().await);
        drop(task);
        (fixture, selected)
    })
    .await;
    assert!(manager.shutdown().await);
    drop(manager);
    let (fixture, selected) = outcome.unwrap();
    let resumed = SessionManager::start(fixture.config()).unwrap();
    let snapshot = resumed.snapshot().await;
    assert_eq!(snapshot.selected, selected);
    assert_eq!(snapshot.sessions.len(), 4);
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .filter(|entry| entry.lifecycle == SlotStatus::Open)
            .count(),
        1
    );
    assert!(resumed.shutdown().await);
}

#[tokio::test]
async fn legacy_record_is_adopted_without_relocation_or_corruption_fallback() {
    let fixture = Fixture::new();
    let handle = pi_web::session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("legacy".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    assert!(handle.shutdown().await);
    drop(connection);
    drop(handle);
    let original = fs::read(fixture.0.join("state/state.json")).unwrap();
    let manager = SessionManager::start(fixture.config()).unwrap();
    assert_eq!(manager.snapshot().await.selected, identity.session_id);
    assert!(manager.shutdown().await);
    drop(manager);
    assert_eq!(
        fs::read(fixture.0.join("state/state.json")).unwrap(),
        original
    );
    fs::write(fixture.0.join("state/catalog.json"), b"{}").unwrap();
    assert!(SessionManager::start(fixture.config()).is_err());
}

#[tokio::test]
async fn folders_are_remembered_and_only_selected_runtime_restarts() {
    let fixture = Fixture::new();
    let second = fixture.0.join("second");
    fs::create_dir(&second).unwrap();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let action = serde_json::from_value(
        serde_json::json!({"type":"add_workspace", "path":second, "confirmed":true}),
    )
    .expect("folder action must be supported");
    let added = manager.command(command("add", action)).await;
    assert!(added.ok, "{added:?}");
    assert_eq!(added.code, "workspace_added");
    assert!(manager.shutdown().await);
    drop(manager);
    let mut config = fixture.config();
    // Parsing without --cwd must resolve the registry, rather than the shell directory.
    config = Config::parse([
        "--state-dir".into(),
        config.state_dir.to_string_lossy().into(),
        "--pi".into(),
        config.pi.to_string_lossy().into(),
        "--isolated".into(),
    ])
    .unwrap()
    .unwrap();
    let resumed = SessionManager::start(config).unwrap();
    let snapshot = resumed.snapshot().await;
    assert_eq!(snapshot.selected, added.selected);
    assert_eq!(snapshot.sessions.len(), 2);
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .filter(|s| s.lifecycle == SlotStatus::Open)
            .count(),
        1
    );
    assert!(resumed.shutdown().await);
}

#[tokio::test]
async fn folder_validation_deduplication_global_capacity_and_explicit_creation() {
    let fixture = Fixture::new();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let first = manager.snapshot().await;
    for (i, path) in [
        "relative".to_string(),
        fixture.0.join("pi").display().to_string(),
        fixture.0.join("missing").display().to_string(),
        "/bad\0path".into(),
    ]
    .into_iter()
    .enumerate()
    {
        let reply = manager
            .command(command(
                &format!("invalid-{i}"),
                WorkspaceAction::AddWorkspace {
                    path,
                    confirmed: true,
                },
            ))
            .await;
        assert!(!reply.ok);
        assert_eq!(reply.workspaces.len(), 1);
    }
    let second = fixture.0.join("second");
    fs::create_dir(&second).unwrap();
    let action = WorkspaceAction::AddWorkspace {
        path: second.display().to_string(),
        confirmed: true,
    };
    assert_eq!(
        manager
            .command(command(
                "unconfirmed",
                WorkspaceAction::AddWorkspace {
                    path: second.display().to_string(),
                    confirmed: false
                }
            ))
            .await
            .code,
        "confirmation_required"
    );
    let (added, duplicate) = tokio::join!(
        manager.command(command("add", action.clone())),
        manager.command(command("add", action))
    );
    assert!(added.ok);
    assert_eq!(added, duplicate);
    let alias = fixture.0.join("alias");
    std::os::unix::fs::symlink(&second, &alias).unwrap();
    assert_eq!(
        manager
            .command(command(
                "alias",
                WorkspaceAction::AddWorkspace {
                    path: alias.display().to_string(),
                    confirmed: true
                }
            ))
            .await
            .code,
        "workspace_exists"
    );
    for (name, session_id, cwd) in [
        ("first", &first.selected, &fixture.0),
        ("second", &added.selected, &second),
    ] {
        let handle = manager.lookup(session_id).await.unwrap();
        let mut connection = handle.connect(name.into()).await.unwrap();
        ready(&mut connection).await;
        let root = if name == "first" {
            fixture.0.join("state")
        } else {
            let registry: serde_json::Value = serde_json::from_slice(
                &fs::read(fixture.0.join("state/workspaces/registry.json")).unwrap(),
            )
            .unwrap();
            PathBuf::from(registry["entries"][1]["stateDir"].as_str().unwrap())
        };
        let state: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join("sessions").join(session_id).join("state.json")).unwrap(),
        )
        .unwrap();
        let transcript = fs::read_to_string(state["piSessionPath"].as_str().unwrap()).unwrap();
        let header: serde_json::Value =
            serde_json::from_str(transcript.lines().next().unwrap()).unwrap();
        assert_eq!(
            header["cwd"],
            cwd.canonicalize().unwrap().display().to_string()
        );
        assert!(PathBuf::from(state["piSessionPath"].as_str().unwrap()).starts_with(root));
    }
    for i in 0..2 {
        let created = manager
            .command(command(
                &format!("create-{i}"),
                WorkspaceAction::CreateIn {
                    workspace_id: first.selected_workspace.clone(),
                },
            ))
            .await;
        assert!(created.ok);
        assert_eq!(created.selected_workspace, first.selected_workspace);
        assert!(
            created
                .sessions
                .iter()
                .any(|s| Some(&s.session_id) == created.target.as_ref()
                    && s.workspace_id == first.selected_workspace)
        );
    }
    assert_eq!(
        manager
            .command(command(
                "full",
                WorkspaceAction::CreateIn {
                    workspace_id: added.selected_workspace.clone()
                }
            ))
            .await
            .code,
        "active_limit"
    );
    let third = fixture.0.join("third");
    fs::create_dir(&third).unwrap();
    let added_stopped = manager
        .command(command(
            "add-full",
            WorkspaceAction::AddWorkspace {
                path: third.display().to_string(),
                confirmed: true,
            },
        ))
        .await;
    assert!(added_stopped.ok);
    assert!(manager.lookup(&added_stopped.selected).await.is_none());
    let selected = manager
        .command(command(
            "select",
            WorkspaceAction::SelectWorkspace {
                workspace_id: added.selected_workspace.clone(),
            },
        ))
        .await;
    assert!(selected.ok);
    assert_eq!(selected.target, Some(added.selected.clone()));
    assert_eq!(
        selected
            .sessions
            .iter()
            .filter(|s| s.lifecycle == SlotStatus::Open)
            .count(),
        4
    );
    let before = manager.snapshot().await;
    for (i, action) in [
        WorkspaceAction::CreateIn {
            workspace_id: config::identity().unwrap(),
        },
        WorkspaceAction::SelectWorkspace {
            workspace_id: config::identity().unwrap(),
        },
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            manager
                .command(command(&format!("unknown-{i}"), action))
                .await
                .code,
            "unknown_workspace"
        );
    }
    let after = manager.snapshot().await;
    assert_eq!(before.workspaces, after.workspaces);
    assert_eq!(before.selected_workspace, after.selected_workspace);
    assert_eq!(before.selected, after.selected);
    assert_eq!(
        before
            .sessions
            .iter()
            .map(|s| &s.session_id)
            .collect::<Vec<_>>(),
        after
            .sessions
            .iter()
            .map(|s| &s.session_id)
            .collect::<Vec<_>>()
    );
    let dormant = manager
        .command(command(
            "select-dormant",
            WorkspaceAction::SelectWorkspace {
                workspace_id: added_stopped.selected_workspace.clone(),
            },
        ))
        .await;
    assert!(dormant.ok);
    assert_eq!(dormant.target, Some(added_stopped.selected.clone()));
    assert!(manager.lookup(&added_stopped.selected).await.is_none());
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn registry_errors_are_explicit_and_do_not_launch_children() {
    let fixture = Fixture::new();
    let second = fixture.0.join("second");
    fs::create_dir(&second).unwrap();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let registry_path = fixture.0.join("state/workspaces/registry.json");
    fs::remove_file(&registry_path).unwrap();
    fs::create_dir(&registry_path).unwrap();
    let failed = manager
        .command(command(
            "fail",
            WorkspaceAction::AddWorkspace {
                path: second.display().to_string(),
                confirmed: true,
            },
        ))
        .await;
    assert_eq!(failed.code, "workspace_write_failed");
    assert_eq!(failed.workspaces.len(), 1);
    assert_eq!(failed.sessions.len(), 1);
    fs::remove_dir(&registry_path).unwrap();
    let added = manager
        .command(command(
            "retry",
            WorkspaceAction::AddWorkspace {
                path: second.display().to_string(),
                confirmed: true,
            },
        ))
        .await;
    assert!(added.ok);
    assert!(manager.shutdown().await);
    drop(manager);
    fs::remove_dir(&second).unwrap();
    let mut remembered = fixture.config();
    remembered.explicit_cwd = false;
    assert!(
        SessionManager::start(remembered).is_err(),
        "missing selected folder must not silently reset history"
    );
    fs::create_dir(&second).unwrap();
    fs::write(&registry_path, b"{}").unwrap();
    assert!(
        SessionManager::start(fixture.config()).is_err(),
        "corrupt registry must not silently reset"
    );
}

#[tokio::test]
async fn startup_modes_target_remembered_project_and_explicit_cwd_overrides_it() {
    let fixture = Fixture::new();
    let second = fixture.0.join("second");
    fs::create_dir(&second).unwrap();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let first = manager.snapshot().await;
    let added = manager
        .command(command(
            "add",
            WorkspaceAction::AddWorkspace {
                path: second.display().to_string(),
                confirmed: true,
            },
        ))
        .await;
    let handle = manager.lookup(&added.selected).await.unwrap();
    let mut connection = handle.connect("test".into()).await.unwrap();
    ready(&mut connection).await;
    assert!(manager.shutdown().await);
    drop(connection);
    drop(handle);
    drop(manager);
    let mut options = fixture.config();
    options.explicit_cwd = false;
    options.startup = pi_web::config::Startup::New;
    let manager = SessionManager::start(options).unwrap();
    let snapshot = manager.snapshot().await;
    assert_eq!(snapshot.selected_workspace, added.selected_workspace);
    assert_ne!(snapshot.selected, added.selected);
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .filter(|s| s.workspace_id == first.selected_workspace)
            .count(),
        1
    );
    let handle = manager.lookup(&snapshot.selected).await.unwrap();
    let mut connection = handle.connect("test".into()).await.unwrap();
    ready(&mut connection).await;
    assert!(manager.shutdown().await);
    drop(connection);
    drop(handle);
    drop(manager);
    let registry: serde_json::Value = serde_json::from_slice(
        &fs::read(fixture.0.join("state/workspaces/registry.json")).unwrap(),
    )
    .unwrap();
    let root = PathBuf::from(registry["entries"][1]["stateDir"].as_str().unwrap());
    let metadata: serde_json::Value = serde_json::from_slice(
        &fs::read(
            root.join("sessions")
                .join(&added.selected)
                .join("state.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let mut options = fixture.config();
    options.explicit_cwd = false;
    options.startup =
        pi_web::config::Startup::Session(metadata["piSessionPath"].as_str().unwrap().into());
    let manager = SessionManager::start(options).unwrap();
    assert_eq!(manager.snapshot().await.selected, added.selected);
    assert!(manager.shutdown().await);
    drop(manager);
    let manager = SessionManager::start(fixture.config()).unwrap();
    assert_eq!(manager.snapshot().await.selected, first.selected);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn workspace_registry_enforces_sixteen_folder_bound() {
    let fixture = Fixture::new();
    let manager = SessionManager::start(fixture.config()).unwrap();
    for i in 1..=16 {
        let folder = fixture.0.join(if i == 1 {
            "界".repeat(30)
        } else {
            format!("folder-{i}")
        });
        fs::create_dir(&folder).unwrap();
        let reply = manager
            .command(command(
                &format!("add-{i}"),
                WorkspaceAction::AddWorkspace {
                    path: folder.display().to_string(),
                    confirmed: true,
                },
            ))
            .await;
        if i < 16 {
            assert!(reply.ok, "{reply:?}");
        } else {
            assert_eq!(reply.code, "workspace_limit");
        }
    }
    let snapshot = manager.snapshot().await;
    assert_eq!(snapshot.workspaces.len(), 16);
    assert!(snapshot.workspaces.iter().all(|w| w.name.len() <= 64));
    assert_eq!(snapshot.workspaces[1].name, "界".repeat(21));
    assert_eq!(snapshot.sessions.len(), 16);
    assert_eq!(
        snapshot
            .sessions
            .iter()
            .filter(|s| s.lifecycle == SlotStatus::Open)
            .count(),
        4
    );
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn unavailable_dormant_folder_does_not_block_healthy_workspace() {
    let fixture = Fixture::new();
    let second = fixture.0.join("second");
    fs::create_dir(&second).unwrap();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let first = manager.snapshot().await;
    let added = manager
        .command(command(
            "add",
            WorkspaceAction::AddWorkspace {
                path: second.display().to_string(),
                confirmed: true,
            },
        ))
        .await;
    assert!(added.ok);
    let handle = manager.lookup(&added.selected).await.unwrap();
    let stopped = manager
        .command(command(
            "stop-second",
            WorkspaceAction::Stop {
                session_id: added.selected.clone(),
                epoch: handle.summary().epoch,
                confirmed: true,
            },
        ))
        .await;
    assert!(stopped.ok);
    drop(handle);
    fs::rename(&second, fixture.0.join("moved-second")).unwrap();
    let selected = manager
        .command(command(
            "healthy",
            WorkspaceAction::SelectWorkspace {
                workspace_id: first.selected_workspace.clone(),
            },
        ))
        .await;
    assert!(selected.ok, "{selected:?}");
    assert!(
        manager
            .command(command("create-healthy", WorkspaceAction::Create))
            .await
            .ok
    );
    let before = manager.snapshot().await;
    for (token, action) in [
        (
            "open-missing",
            WorkspaceAction::Open {
                session_id: added.selected.clone(),
            },
        ),
        (
            "create-missing",
            WorkspaceAction::CreateIn {
                workspace_id: added.selected_workspace.clone(),
            },
        ),
    ] {
        let reply = manager.command(command(token, action)).await;
        assert_eq!(reply.code, "workspace_unavailable");
        assert_eq!(reply.sessions.len(), before.sessions.len());
        assert_eq!(reply.selected_workspace, before.selected_workspace);
        assert!(manager.lookup(&added.selected).await.is_none());
    }
    let selected = manager
        .command(command(
            "select-missing",
            WorkspaceAction::SelectWorkspace {
                workspace_id: added.selected_workspace.clone(),
            },
        ))
        .await;
    assert!(selected.ok);
    assert_eq!(
        manager
            .command(command("create-selected-missing", WorkspaceAction::Create))
            .await
            .code,
        "workspace_unavailable"
    );
    assert!(manager.shutdown().await);
    drop(manager);
    let mut remembered = fixture.config();
    remembered.explicit_cwd = false;
    assert!(SessionManager::start(remembered).is_err());
    let manager = SessionManager::start(fixture.config())
        .expect("healthy explicit cwd must override missing selection");
    let snapshot = manager.snapshot().await;
    assert_eq!(snapshot.selected_workspace, first.selected_workspace);
    assert_eq!(snapshot.workspaces.len(), 2);
    assert_eq!(snapshot.sessions.len(), before.sessions.len());
    assert!(
        snapshot
            .sessions
            .iter()
            .any(|s| s.session_id == added.selected && s.lifecycle == SlotStatus::Stopped)
    );
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn replaced_workspace_symlink_is_unavailable_even_for_active_conversation() {
    let fixture = Fixture::new();
    let second = fixture.0.join("second");
    let replacement = fixture.0.join("replacement");
    fs::create_dir(&second).unwrap();
    fs::create_dir(&replacement).unwrap();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let added = manager
        .command(command(
            "add",
            WorkspaceAction::AddWorkspace {
                path: second.display().to_string(),
                confirmed: true,
            },
        ))
        .await;
    assert!(added.ok);
    let handle = manager.lookup(&added.selected).await.unwrap();
    let mut connection = handle.connect("test".into()).await.unwrap();
    ready(&mut connection).await;
    fs::rename(&second, fixture.0.join("moved-second")).unwrap();
    std::os::unix::fs::symlink(&replacement, &second).unwrap();
    for (token, action) in [
        (
            "open-replaced",
            WorkspaceAction::Open {
                session_id: added.selected.clone(),
            },
        ),
        (
            "create-replaced",
            WorkspaceAction::CreateIn {
                workspace_id: added.selected_workspace.clone(),
            },
        ),
    ] {
        let reply = manager.command(command(token, action)).await;
        assert_eq!(reply.code, "workspace_unavailable");
        assert_eq!(reply.sessions.len(), 2);
    }
    assert!(
        manager
            .command(command(
                "stop-second",
                WorkspaceAction::Stop {
                    session_id: added.selected.clone(),
                    epoch: handle.summary().epoch,
                    confirmed: true,
                }
            ))
            .await
            .ok
    );
    drop(connection);
    drop(handle);
    assert_eq!(
        manager
            .command(command(
                "reopen-replaced",
                WorkspaceAction::Open {
                    session_id: added.selected.clone()
                }
            ))
            .await
            .code,
        "workspace_unavailable"
    );
    assert!(manager.lookup(&added.selected).await.is_none());
    assert!(manager.shutdown().await);
    drop(manager);
    let mut remembered = fixture.config();
    remembered.explicit_cwd = false;
    assert!(SessionManager::start(remembered).is_err());
    assert_eq!(fs::read_dir(&replacement).unwrap().count(), 0);
}

#[tokio::test]
async fn dormant_registry_paths_remain_structurally_validated() {
    let fixture = Fixture::new();
    let second = fixture.0.join("second");
    fs::create_dir(&second).unwrap();
    let manager = SessionManager::start(fixture.config()).unwrap();
    assert!(
        manager
            .command(command(
                "add",
                WorkspaceAction::AddWorkspace {
                    path: second.display().to_string(),
                    confirmed: true,
                }
            ))
            .await
            .ok
    );
    assert!(manager.shutdown().await);
    drop(manager);
    let registry_path = fixture.0.join("state/workspaces/registry.json");
    let original: serde_json::Value =
        serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
    for path in [
        "relative".to_string(),
        format!("{}/./second", fixture.0.display()),
        format!("{}/second/../second", fixture.0.display()),
        "/bad\0path".to_string(),
        format!("/{}", "x".repeat(1024)),
    ] {
        let mut invalid = original.clone();
        invalid["entries"][1]["cwd"] = path.clone().into();
        fs::write(&registry_path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(
            SessionManager::start(fixture.config()).is_err(),
            "invalid dormant path accepted: {path:?}"
        );
    }
}

#[tokio::test]
async fn delete_last_conversation_removes_transcript_and_replaces_without_launch() {
    let action: WorkspaceAction = serde_json::from_value(serde_json::json!({
        "type": "delete", "sessionId": config::identity().unwrap(), "epoch": null, "confirmed": true
    }))
    .expect("delete action must be supported");
    let _ = action;
    let fixture = Fixture::new();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let first = manager.snapshot().await.selected;
    let handle = manager.lookup(&first).await.unwrap();
    let mut connection = handle.connect("delete".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    let metadata_path = fixture
        .0
        .join("state/sessions")
        .join(&first)
        .join("state.json");
    let metadata = fs::read(&metadata_path).unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&metadata).unwrap();
    let transcript_path = saved["piSessionPath"].as_str().unwrap();
    assert!(std::path::Path::new(transcript_path).is_file());
    let project_file = fixture.0.join("project.txt");
    fs::write(&project_file, "project content").unwrap();
    let request = command("delete", serde_json::from_value(serde_json::json!({"type":"delete", "sessionId":first, "epoch":identity.epoch, "confirmed":true})).unwrap());
    let deleted = manager.command(request.clone()).await;
    assert!(deleted.ok, "{deleted:?}");
    assert_eq!(deleted.code, "deleted");
    assert_eq!(deleted.sessions.len(), 1);
    assert_ne!(deleted.selected, first);
    assert_eq!(deleted.target.as_ref(), Some(&deleted.selected));
    assert_eq!(deleted.sessions[0].lifecycle, SlotStatus::Stopped);
    assert!(manager.lookup(&first).await.is_none());
    assert_eq!(manager.command(request).await, deleted);
    assert_eq!(fs::read(&metadata_path).unwrap(), metadata);
    assert!(!std::path::Path::new(transcript_path).exists());
    assert_eq!(fs::read_to_string(project_file).unwrap(), "project content");
    assert!(manager.shutdown().await);
    drop(connection);
    drop(handle);
    drop(manager);
    let resumed = SessionManager::start(fixture.config()).unwrap();
    assert_eq!(resumed.snapshot().await.selected, deleted.selected);
    assert_eq!(resumed.snapshot().await.sessions.len(), 1);
    assert!(resumed.shutdown().await);
}

fn delete(session_id: &str, epoch: Option<String>, confirmed: bool) -> WorkspaceAction {
    WorkspaceAction::Delete {
        session_id: session_id.into(),
        epoch,
        confirmed,
    }
}

#[tokio::test]
async fn delete_validation_stopped_selection_and_failed_save() {
    let fixture = Fixture::new();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let first = manager.snapshot().await.selected;
    let handle = manager.lookup(&first).await.unwrap();
    let mut connection = handle.connect("validation".into()).await.unwrap();
    let epoch = ready(&mut connection).await.epoch;
    for (token, action, code) in [
        (
            "unknown",
            delete(&config::identity().unwrap(), None, true),
            "unknown_session",
        ),
        (
            "unconfirmed",
            delete(&first, Some(epoch.clone()), false),
            "confirmation_required",
        ),
        ("missing", delete(&first, None, true), "stale_epoch"),
        (
            "stale",
            delete(&first, Some(config::identity().unwrap()), true),
            "stale_epoch",
        ),
        (
            "invalid",
            delete(&first, Some("bad".into()), true),
            "invalid_or_stopping",
        ),
    ] {
        let reply = manager.command(command(token, action)).await;
        assert!(!reply.ok);
        assert_eq!(reply.code, code);
        assert_eq!(reply.sessions.len(), 1);
        assert!(manager.lookup(&first).await.is_some());
    }
    let created = manager
        .command(command("create", WorkspaceAction::Create))
        .await;
    assert!(created.ok);
    let second = created.selected;
    let second_handle = manager.lookup(&second).await.unwrap();
    let mut second_connection = second_handle
        .connect("stopped-delete".into())
        .await
        .unwrap();
    ready(&mut second_connection).await;
    let second_saved: serde_json::Value = serde_json::from_slice(
        &fs::read(
            fixture
                .0
                .join("state/sessions")
                .join(&second)
                .join("state.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let second_path = std::path::Path::new(second_saved["piSessionPath"].as_str().unwrap());
    assert!(second_path.exists());
    assert!(
        manager
            .command(command(
                "stop",
                WorkspaceAction::Stop {
                    session_id: second.clone(),
                    epoch: second_handle.summary().epoch,
                    confirmed: true
                }
            ))
            .await
            .ok
    );
    let catalog_path = fixture.0.join("state/catalog.json");
    let original = fs::read(&catalog_path).unwrap();
    fs::remove_file(&catalog_path).unwrap();
    fs::create_dir(&catalog_path).unwrap();
    let failed = manager
        .command(command("fail", delete(&first, Some(epoch), true)))
        .await;
    assert_eq!(failed.code, "catalog_write_failed_after_transcript_deleted");
    assert_eq!(failed.sessions.len(), 2);
    let saved: serde_json::Value = serde_json::from_slice(
        &fs::read(
            fixture
                .0
                .join("state/sessions")
                .join(&first)
                .join("state.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(!std::path::Path::new(saved["piSessionPath"].as_str().unwrap()).exists());
    let missing_failed = manager
        .command(command("fail-missing", delete(&first, None, true)))
        .await;
    assert_eq!(missing_failed.code, "catalog_write_failed");
    assert!(manager.lookup(&first).await.is_none());
    fs::remove_dir(&catalog_path).unwrap();
    fs::write(&catalog_path, original).unwrap();
    fs::set_permissions(&catalog_path, fs::Permissions::from_mode(0o600)).unwrap();
    let deleted = manager
        .command(command("delete-stopped", delete(&second, None, true)))
        .await;
    assert!(deleted.ok, "{deleted:?}");
    assert_eq!(deleted.selected, first);
    assert_eq!(deleted.target, Some(first.clone()));
    assert_eq!(deleted.sessions.len(), 1);
    assert!(!second_path.exists());
    let retried = manager
        .command(command("retry", delete(&first, None, true)))
        .await;
    assert!(retried.ok, "{retried:?}");
    assert_ne!(retried.selected, first);
    assert!(manager.shutdown().await);
}

#[tokio::test]
async fn delete_legacy_in_other_workspace_preserves_selection_and_metadata_on_restart() {
    let fixture = Fixture::new();
    let handle = pi_web::session::start(fixture.config()).unwrap();
    let mut connection = handle.connect("legacy".into()).await.unwrap();
    ready(&mut connection).await;
    assert!(handle.shutdown().await);
    drop(connection);
    drop(handle);
    let metadata_path = fixture.0.join("state/state.json");
    let metadata = fs::read(&metadata_path).unwrap();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let first = manager.snapshot().await.selected;
    let epoch = manager.lookup(&first).await.unwrap().summary().epoch;
    let second = fixture.0.join("second");
    fs::create_dir(&second).unwrap();
    let added = manager
        .command(command(
            "add",
            WorkspaceAction::AddWorkspace {
                path: second.display().to_string(),
                confirmed: true,
            },
        ))
        .await;
    assert!(added.ok);
    let deleted = manager
        .command(command("delete", delete(&first, Some(epoch), true)))
        .await;
    assert!(deleted.ok);
    assert_eq!(deleted.selected_workspace, added.selected_workspace);
    assert_eq!(deleted.selected, added.selected);
    assert_ne!(deleted.target.as_ref(), Some(&added.selected));
    let replacement = deleted.target.unwrap();
    assert!(manager.lookup(&replacement).await.is_none());
    assert_eq!(fs::read(&metadata_path).unwrap(), metadata);
    assert!(manager.shutdown().await);
    drop(manager);
    let resumed = SessionManager::start(fixture.config()).unwrap();
    let snapshot = resumed.snapshot().await;
    assert_eq!(snapshot.selected, replacement);
    assert!(
        !snapshot
            .sessions
            .iter()
            .any(|entry| entry.session_id == first)
    );
    assert_eq!(fs::read(&metadata_path).unwrap(), metadata);
    assert!(resumed.shutdown().await);
}

#[tokio::test]
async fn delete_reserves_runtime_during_cleanup_and_deduplicates_pending_request() {
    let fixture = Fixture::new();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let first = manager.snapshot().await.selected;
    let handle = manager.lookup(&first).await.unwrap();
    let mut connection = handle.connect("delete".into()).await.unwrap();
    let identity = ready(&mut connection).await;
    let request = command("delete", delete(&first, Some(identity.epoch), true));
    let task = manager.clone();
    let pending_request = request.clone();
    let pending = tokio::spawn(async move { task.command(pending_request).await });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = manager.snapshot().await;
            if snapshot
                .sessions
                .iter()
                .any(|entry| entry.session_id == first && entry.lifecycle == SlotStatus::Stopping)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        manager
            .command(command("other-delete", delete(&first, None, true)))
            .await
            .code,
        "cleanup_not_complete"
    );
    assert_eq!(
        manager
            .command(command("open", WorkspaceAction::Open { session_id: first }))
            .await
            .code,
        "cleanup_not_complete"
    );
    let duplicate = manager.command(request).await;
    assert!(duplicate.ok);
    assert_eq!(pending.await.unwrap(), duplicate);
    assert!(manager.shutdown().await);
}

/// Every rejection retains the catalog and the target bytes, then permits a corrected retry.
#[tokio::test]
async fn delete_rejects_invalid_saved_transcripts_and_retries_missing_file() {
    for case in [
        "pi-id",
        "app-id",
        "cwd",
        "header",
        "outside",
        "symlink",
        "dangling",
        "parent-symlink",
        "directory",
        "unlink",
        "missing",
    ] {
        let fixture = Fixture::new();
        let manager = SessionManager::start(fixture.config()).unwrap();
        let first = manager.snapshot().await.selected;
        let handle = manager.lookup(&first).await.unwrap();
        let mut connection = handle.connect("validation".into()).await.unwrap();
        let epoch = ready(&mut connection).await.epoch;
        assert!(
            manager
                .command(command(
                    "stop",
                    WorkspaceAction::Stop {
                        session_id: first.clone(),
                        epoch,
                        confirmed: true
                    }
                ))
                .await
                .ok
        );
        let metadata_path = fixture
            .0
            .join("state/sessions")
            .join(&first)
            .join("state.json");
        let original_metadata = fs::read(&metadata_path).unwrap();
        let mut saved: serde_json::Value = serde_json::from_slice(&original_metadata).unwrap();
        let path = PathBuf::from(saved["piSessionPath"].as_str().unwrap());
        let transcript = fs::read(&path).unwrap();
        let other = fixture.0.join("other.jsonl");
        match case {
            "pi-id" => saved["piSessionId"] = "different-pi-id".into(),
            "app-id" => saved["appId"] = config::identity().unwrap().into(),
            "cwd" => saved["cwd"] = fixture.0.join("elsewhere").display().to_string().into(),
            "header" => fs::write(&path, "not a session\n").unwrap(),
            "outside" => {
                fs::write(&other, &transcript).unwrap();
                saved["piSessionPath"] = other.display().to_string().into();
            }
            "symlink" | "dangling" => {
                fs::remove_file(&path).unwrap();
                if case == "symlink" {
                    fs::write(&other, &transcript).unwrap();
                }
                std::os::unix::fs::symlink(&other, &path).unwrap();
            }
            "parent-symlink" => {
                let alias = fixture.0.join("alias");
                std::os::unix::fs::symlink(path.parent().unwrap(), &alias).unwrap();
                saved["piSessionPath"] = alias
                    .join(path.file_name().unwrap())
                    .display()
                    .to_string()
                    .into();
            }
            "directory" => {
                fs::remove_file(&path).unwrap();
                fs::create_dir(&path).unwrap();
            }
            "unlink" => {
                fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o500))
                    .unwrap()
            }
            "missing" => fs::remove_file(&path).unwrap(),
            _ => unreachable!(),
        }
        fs::write(&metadata_path, serde_json::to_vec(&saved).unwrap()).unwrap();
        let reply = manager
            .command(command("delete", delete(&first, None, true)))
            .await;
        if case == "unlink" {
            fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        if case == "missing" {
            assert!(reply.ok, "{case}: {reply:?}");
        } else {
            assert_eq!(reply.code, "transcript_delete_failed", "{case}");
            assert_eq!(reply.sessions[0].session_id, first, "{case}");
            if case == "outside" || case == "symlink" {
                assert_eq!(fs::read(&other).unwrap(), transcript);
            }
            match case {
                "symlink" | "dangling" => fs::remove_file(&path).unwrap(),
                "directory" => fs::remove_dir(&path).unwrap(),
                _ => {}
            }
            fs::write(&metadata_path, original_metadata).unwrap();
            fs::write(&path, transcript).unwrap();
            let retry = manager
                .command(command("retry", delete(&first, None, true)))
                .await;
            assert!(retry.ok, "{case}: {retry:?}");
        }
        assert!(!path.exists(), "{case}");
        assert!(manager.shutdown().await);
    }
}

#[tokio::test]
async fn delete_refuses_another_active_runtime_path_and_hardlink() {
    for hardlink in [false, true] {
        let fixture = Fixture::new();
        let manager = SessionManager::start(fixture.config()).unwrap();
        let first = manager.snapshot().await.selected;
        let handle = manager.lookup(&first).await.unwrap();
        let mut connection = handle.connect("owner".into()).await.unwrap();
        let epoch = ready(&mut connection).await.epoch;
        assert!(
            manager
                .command(command(
                    "stop",
                    WorkspaceAction::Stop {
                        session_id: first.clone(),
                        epoch,
                        confirmed: true
                    }
                ))
                .await
                .ok
        );
        let created = manager
            .command(command("create", WorkspaceAction::Create))
            .await;
        assert!(created.ok);
        let active = manager.lookup(&created.selected).await.unwrap();
        let mut active_connection = active.connect("active".into()).await.unwrap();
        ready(&mut active_connection).await;
        let first_metadata = fixture
            .0
            .join("state/sessions")
            .join(&first)
            .join("state.json");
        let mut saved: serde_json::Value =
            serde_json::from_slice(&fs::read(&first_metadata).unwrap()).unwrap();
        let active_saved: serde_json::Value = serde_json::from_slice(
            &fs::read(
                fixture
                    .0
                    .join("state/sessions")
                    .join(&created.selected)
                    .join("state.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let active_path = PathBuf::from(active_saved["piSessionPath"].as_str().unwrap());
        let bytes = fs::read(&active_path).unwrap();
        if hardlink {
            let alias = first_metadata.parent().unwrap().join("alias.jsonl");
            fs::hard_link(&active_path, &alias).unwrap();
            saved["piSessionPath"] = alias.display().to_string().into();
        } else {
            saved["piSessionPath"] = active_saved["piSessionPath"].clone();
        }
        fs::write(first_metadata, serde_json::to_vec(&saved).unwrap()).unwrap();
        let reply = manager
            .command(command("delete", delete(&first, None, true)))
            .await;
        assert_eq!(reply.code, "transcript_delete_failed");
        assert_eq!(reply.sessions.len(), 2);
        assert!(manager.lookup(&created.selected).await.is_some());
        assert_eq!(fs::read(active_path).unwrap(), bytes);
        assert!(manager.shutdown().await);
    }
}

#[tokio::test]
async fn delete_partial_failure_restart_requires_explicit_recovery() {
    let fixture = Fixture::new();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let first = manager.snapshot().await.selected;
    let handle = manager.lookup(&first).await.unwrap();
    let mut connection = handle.connect("partial".into()).await.unwrap();
    let epoch = ready(&mut connection).await.epoch;
    let catalog_path = fixture.0.join("state/catalog.json");
    let original = fs::read(&catalog_path).unwrap();
    fs::remove_file(&catalog_path).unwrap();
    fs::create_dir(&catalog_path).unwrap();
    let reply = manager
        .command(command("delete", delete(&first, Some(epoch), true)))
        .await;
    assert_eq!(reply.code, "catalog_write_failed_after_transcript_deleted");
    assert_eq!(reply.selected, first);
    fs::remove_dir(&catalog_path).unwrap();
    fs::write(&catalog_path, original).unwrap();
    fs::set_permissions(&catalog_path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(manager.shutdown().await);
    drop(connection);
    drop(handle);
    drop(manager);
    let error = match SessionManager::start(fixture.config()) {
        Ok(manager) => {
            manager.shutdown().await;
            panic!("missing persisted transcript must reject remembered startup");
        }
        Err(error) => error,
    };
    assert!(
        error.to_string().contains("remembered session is missing"),
        "{error}"
    );
    let mut config = fixture.config();
    config.startup = config::Startup::New;
    let recovered = SessionManager::start(config).unwrap();
    let reply = recovered
        .command(command("retry", delete(&first, None, true)))
        .await;
    assert!(reply.ok, "{reply:?}");
    assert!(!reply.sessions.iter().any(|entry| entry.session_id == first));
    assert!(recovered.shutdown().await);
}

#[tokio::test]
async fn rename_persists_trimmed_title_without_changing_selection_or_runtime() {
    let fixture = Fixture::new();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let before = manager.snapshot().await;
    let action: WorkspaceAction = serde_json::from_value(serde_json::json!({
        "type": "rename", "sessionId": before.selected, "title": "  New title  "
    }))
    .expect("rename action must be supported");
    let request = command("rename", action);
    let renamed = manager.command(request.clone()).await;
    assert!(renamed.ok, "{renamed:?}");
    assert_eq!(renamed.code, "renamed");
    assert_eq!(renamed.target, None);
    assert_eq!(renamed.selected, before.selected);
    assert_eq!(renamed.selected_workspace, before.selected_workspace);
    assert_eq!(renamed.sessions[0].title, "New title");
    assert_eq!(
        renamed.sessions[0].runtime.as_ref().unwrap().epoch,
        before.sessions[0].runtime.as_ref().unwrap().epoch
    );
    assert_eq!(manager.command(request).await, renamed);
    assert!(manager.shutdown().await);
    drop(manager);
    let resumed = SessionManager::start(fixture.config()).unwrap();
    assert_eq!(resumed.snapshot().await.sessions[0].title, "New title");
    assert!(resumed.shutdown().await);
}

#[tokio::test]
async fn rename_stopped_conversation_in_other_workspace_preserves_transcript() {
    let fixture = Fixture::new();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let first = manager.snapshot().await.selected;
    let handle = manager.lookup(&first).await.unwrap();
    let mut connection = handle.connect("rename".into()).await.unwrap();
    let epoch = ready(&mut connection).await.epoch;
    assert!(
        manager
            .command(command(
                "stop",
                WorkspaceAction::Stop {
                    session_id: first.clone(),
                    epoch,
                    confirmed: true,
                }
            ))
            .await
            .ok
    );
    let metadata_path = fixture
        .0
        .join("state/sessions")
        .join(&first)
        .join("state.json");
    let metadata = fs::read(&metadata_path).unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&metadata).unwrap();
    let path = saved["piSessionPath"].as_str().unwrap();
    let transcript = fs::read(path).unwrap();
    let second = fixture.0.join("second");
    fs::create_dir(&second).unwrap();
    let added = manager
        .command(command(
            "add",
            WorkspaceAction::AddWorkspace {
                path: second.display().to_string(),
                confirmed: true,
            },
        ))
        .await;
    assert!(added.ok);
    let renamed = manager
        .command(command(
            "rename",
            WorkspaceAction::Rename {
                session_id: first.clone(),
                title: "Archived conversation".into(),
            },
        ))
        .await;
    assert!(renamed.ok);
    assert_eq!(renamed.target, None);
    assert_eq!(renamed.selected, added.selected);
    assert_eq!(renamed.selected_workspace, added.selected_workspace);
    let entry = renamed
        .sessions
        .iter()
        .find(|entry| entry.session_id == first)
        .unwrap();
    assert_eq!(entry.title, "Archived conversation");
    assert_eq!(entry.lifecycle, SlotStatus::Stopped);
    assert!(entry.runtime.is_none());
    assert!(manager.lookup(&first).await.is_none());
    assert_eq!(fs::read(&metadata_path).unwrap(), metadata);
    assert_eq!(fs::read(path).unwrap(), transcript);
    assert!(manager.shutdown().await);
    drop(connection);
    drop(handle);
    drop(manager);
    let mut options = fixture.config();
    options.explicit_cwd = false;
    let resumed = SessionManager::start(options).unwrap();
    let snapshot = resumed.snapshot().await;
    assert_eq!(snapshot.selected, added.selected);
    let entry = snapshot
        .sessions
        .iter()
        .find(|entry| entry.session_id == first)
        .unwrap();
    assert_eq!(entry.title, "Archived conversation");
    assert_eq!(entry.lifecycle, SlotStatus::Stopped);
    assert!(resumed.shutdown().await);
}

#[tokio::test]
async fn rename_validates_utf8_bytes_and_preserves_title_on_save_failure() {
    let fixture = Fixture::new();
    let manager = SessionManager::start(fixture.config()).unwrap();
    let before = manager.snapshot().await;
    let action = |title: String| WorkspaceAction::Rename {
        session_id: before.selected.clone(),
        title,
    };
    for (i, title) in [
        "".into(),
        " \u{2003} ".into(),
        "x".repeat(65),
        "界".repeat(22),
        "bad\nname".into(),
        "bad\0name".into(),
        "bad\u{7f}name".into(),
        "bad\u{85}name".into(),
    ]
    .into_iter()
    .enumerate()
    {
        let rejected = manager
            .command(command(&format!("invalid-{i}"), action(title)))
            .await;
        assert!(!rejected.ok);
        assert_eq!(rejected.code, "invalid_title");
        assert_eq!(rejected.sessions[0].title, before.sessions[0].title);
    }
    let unknown = manager
        .command(command(
            "unknown",
            WorkspaceAction::Rename {
                session_id: config::identity().unwrap(),
                title: "Valid".into(),
            },
        ))
        .await;
    assert_eq!(unknown.code, "unknown_session");
    let title = format!("{}a", "界".repeat(21));
    let accepted = manager
        .command(command("boundary", action(format!("  {title}  "))))
        .await;
    assert!(accepted.ok);
    assert_eq!(accepted.sessions[0].title, title);
    assert_eq!(
        manager
            .command(command("boundary", action("different".into())))
            .await
            .code,
        "request_id_conflict"
    );
    let catalog_path = fixture.0.join("state/catalog.json");
    let original = fs::read(&catalog_path).unwrap();
    fs::remove_file(&catalog_path).unwrap();
    fs::create_dir(&catalog_path).unwrap();
    let request = command("failure", action("Unsaved".into()));
    let failed = manager.command(request.clone()).await;
    assert!(!failed.ok);
    assert_eq!(failed.code, "catalog_write_failed");
    assert_eq!(failed.sessions[0].title, title);
    assert_eq!(manager.snapshot().await.sessions[0].title, title);
    fs::remove_dir(&catalog_path).unwrap();
    fs::write(&catalog_path, &original).unwrap();
    fs::set_permissions(&catalog_path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(manager.command(request).await, failed);
    assert_eq!(fs::read(&catalog_path).unwrap(), original);
    assert!(manager.shutdown().await);
    drop(manager);
    let resumed = SessionManager::start(fixture.config()).unwrap();
    assert_eq!(resumed.snapshot().await.sessions[0].title, title);
    assert!(resumed.shutdown().await);
}
