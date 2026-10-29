use pi_web::rpc::{Error, Handle, Limits, ProcessSpec, RpcCommand, Transport};
use std::{path::PathBuf, time::Duration};
use tokio::time::timeout;

fn limits() -> Limits {
    Limits {
        shutdown_grace: Duration::from_millis(30),
        term_grace: Duration::from_millis(100),
        kill_grace: Duration::from_secs(2),
        write_timeout: Duration::from_millis(200),
        overload_timeout: Duration::from_millis(50),
        ..Limits::default()
    }
}
fn spawn(mode: &str, limits: Limits) -> (Handle, pi_web::rpc::Events) {
    Transport::spawn(
        ProcessSpec {
            executable: PathBuf::from("/usr/bin/python3"),
            args: vec![
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures/mock_pi.py")
                    .into_os_string(),
                mode.into(),
            ],
            cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
        },
        limits,
    )
    .unwrap()
}
async fn stopped(handle: &Handle) {
    let exit = timeout(Duration::from_secs(5), handle.shutdown())
        .await
        .unwrap();
    assert!(exit.reaped, "{exit:?}");
    assert!(exit.cleanup_error.is_none(), "{exit:?}");
}

#[tokio::test]
async fn fragmented_crlf_utf8_event_precedes_ack() {
    let (handle, mut events) = spawn("echo", limits());
    let request = handle.request(
        RpcCommand::Prompt { message: "hello".into(), images: vec![] },
        Duration::from_secs(2),
    );
    let (response, event) = tokio::join!(request, events.recv());
    assert_eq!(response.unwrap()["disposition"], "started");
    assert_eq!(event.unwrap()["text"], "héllo\u{2028}world");
    // The same process accepts another command.
    assert!(
        handle
            .request(RpcCommand::GetState, Duration::from_secs(2))
            .await
            .is_ok()
    );
    stopped(&handle).await;
}

#[tokio::test]
async fn responses_correlate_out_of_order() {
    let (handle, mut events) = spawn("order", limits());
    let (a, b) = tokio::join!(
        handle.request(RpcCommand::GetState, Duration::from_secs(2)),
        handle.request(RpcCommand::GetCommands, Duration::from_secs(2))
    );
    assert_eq!(a.unwrap()["name"], "get_state");
    assert_eq!(b.unwrap()["name"], "get_commands");
    assert_eq!(events.recv().await.unwrap()["type"], "agent_settled");
    stopped(&handle).await;
}

#[tokio::test]
async fn invalid_records_fail_pending_and_reap() {
    for mode in [
        "malformed",
        "utf8",
        "partial",
        "oversize",
        "deep",
        "nodes",
        "mismatch",
        "missing_id",
    ] {
        let (handle, _events) = spawn(
            mode,
            Limits {
                record_bytes: 1024,
                json_nodes: 100,
                ..limits()
            },
        );
        let result = handle
            .request(RpcCommand::GetState, Duration::from_secs(2))
            .await;
        assert!(
            matches!(result, Err(Error::Protocol(_))),
            "{mode}: {result:?}"
        );
        stopped(&handle).await;
    }
}

#[tokio::test]
async fn rejection_timeout_and_late_responses() {
    let (handle, _events) = spawn("reject", limits());
    assert!(matches!(
        handle
            .request(RpcCommand::GetState, Duration::from_secs(2))
            .await,
        Err(Error::Command { .. })
    ));
    stopped(&handle).await;
    let (handle, mut events) = spawn("late", limits());
    assert_eq!(
        handle
            .request(RpcCommand::GetState, Duration::from_millis(200))
            .await,
        Err(Error::Timeout)
    );
    assert_eq!(events.recv().await.unwrap()["type"], "ready");
    assert_eq!(
        handle
            .request(RpcCommand::GetCommands, Duration::from_secs(2))
            .await
            .unwrap()["current"],
        true
    );
    stopped(&handle).await;
}

#[tokio::test]
async fn outstanding_limit_reserves_control_and_cancelled_future_releases_slot() {
    let (handle, mut events) = spawn(
        "priority",
        Limits {
            outstanding: 2,
            ..limits()
        },
    );
    let h = handle.clone();
    let pending = tokio::spawn(async move {
        h.request(
            RpcCommand::Prompt { message: "hello".into(), images: vec![] },
            Duration::from_secs(10),
        )
        .await
    });
    assert_eq!(events.recv().await.unwrap()["type"], "received");
    assert_eq!(
        handle
            .request(RpcCommand::GetState, Duration::from_secs(1))
            .await,
        Err(Error::Overloaded)
    );
    assert!(
        handle
            .request(RpcCommand::Abort, Duration::from_secs(1))
            .await
            .is_ok()
    );
    pending.abort();
    let _ = pending.await;
    assert!(
        handle
            .request(RpcCommand::GetState, Duration::from_secs(1))
            .await
            .is_ok()
    );
    stopped(&handle).await;
}

#[tokio::test]
async fn bounded_events_and_stderr() {
    let (handle, _events) = spawn(
        "flood",
        Limits {
            retained_records: 2,
            ..limits()
        },
    );
    let _ = handle
        .request(RpcCommand::GetState, Duration::from_secs(2))
        .await;
    let exit = timeout(Duration::from_secs(5), handle.wait_exit())
        .await
        .unwrap();
    assert_eq!(exit.reason, Error::Overloaded);
    assert!(exit.reaped && exit.cleanup_error.is_none(), "{exit:?}");
    let (handle, _events) = spawn("noise", limits());
    assert!(
        handle
            .request(RpcCommand::GetState, Duration::from_secs(2))
            .await
            .is_ok()
    );
    let exit = handle.shutdown().await;
    assert_eq!(exit.stderr_tail, vec![b'x'; 64 * 1024]);
    assert!(exit.reaped && exit.cleanup_error.is_none(), "{exit:?}");
}

#[tokio::test]
async fn eof_drains_final_event() {
    let (handle, mut events) = spawn("eof", limits());
    let exit = timeout(Duration::from_secs(5), handle.wait_exit())
        .await
        .unwrap();
    assert_eq!(events.recv().await.unwrap()["type"], "agent_settled");
    assert!(events.recv().await.is_none());
    assert!(exit.reaped && exit.cleanup_error.is_none(), "{exit:?}");
    assert_eq!(
        handle
            .request(RpcCommand::GetState, Duration::from_secs(1))
            .await,
        Err(Error::Closed)
    );
}

#[tokio::test]
async fn shutdown_bypasses_stalled_writer_and_kills_group() {
    for mode in ["stall", "descendant"] {
        let (handle, mut events) = spawn(mode, limits());
        let ready = timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        let pid = ready["pid"].as_i64().unwrap() as i32;
        let h = handle.clone();
        let pending = tokio::spawn(async move {
            h.request(
                RpcCommand::Prompt { message: "x".repeat(500_000), images: vec![] },
                Duration::from_secs(10),
            )
            .await
        });
        tokio::task::yield_now().await;
        stopped(&handle).await;
        assert!(pending.await.unwrap().is_err());
        // SAFETY: probe only the process group created by this test's transport.
        assert_eq!(unsafe { libc::kill(-pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
}

#[tokio::test]
async fn outbound_byte_budget_rejects_without_closing() {
    let (handle, _events) = spawn(
        "echo",
        Limits {
            normal_bytes: 128,
            ..limits()
        },
    );
    assert_eq!(
        handle
            .request(
                RpcCommand::Prompt { message: "x".repeat(200), images: vec![] },
                Duration::from_secs(1)
            )
            .await,
        Err(Error::Overloaded)
    );
    assert!(
        handle
            .request(RpcCommand::GetState, Duration::from_secs(2))
            .await
            .is_ok()
    );
    stopped(&handle).await;
}

#[tokio::test]
async fn stdin_failure_and_crash_reject_pending() {
    let (handle, mut events) = spawn("broken_stdin", limits());
    assert_eq!(events.recv().await.unwrap()["type"], "ready");
    let result = handle
        .request(RpcCommand::GetState, Duration::from_secs(2))
        .await;
    assert!(matches!(result, Err(Error::Io(_))), "{result:?}");
    stopped(&handle).await;
    let (handle, _events) = spawn("crash", limits());
    assert!(
        handle
            .request(RpcCommand::GetState, Duration::from_secs(2))
            .await
            .is_err()
    );
    let exit = handle.wait_exit().await;
    assert_eq!(exit.status.unwrap().code(), Some(7));
    assert!(exit.reaped && exit.cleanup_error.is_none(), "{exit:?}");
}

#[tokio::test]
async fn stalled_write_has_deadline_and_reaps() {
    let (handle, mut events) = spawn("stall", limits());
    assert_eq!(events.recv().await.unwrap()["type"], "ready");
    let result = handle
        .request(
            RpcCommand::Prompt { message: "x".repeat(500_000), images: vec![] },
            Duration::from_secs(3),
        )
        .await;
    assert_eq!(result, Err(Error::Timeout));
    let exit = timeout(Duration::from_secs(5), handle.wait_exit())
        .await
        .unwrap();
    assert_eq!(exit.reason, Error::Timeout);
    assert!(exit.reaped && exit.cleanup_error.is_none(), "{exit:?}");
}

#[tokio::test]
async fn event_byte_budget_fails_visibly() {
    let (handle, _events) = spawn(
        "echo",
        Limits {
            retained_bytes: 32,
            ..limits()
        },
    );
    assert_eq!(
        handle
            .request(RpcCommand::GetState, Duration::from_secs(2))
            .await,
        Err(Error::Overloaded)
    );
    stopped(&handle).await;
}

#[tokio::test]
async fn extension_reply_uses_separate_id_and_flush_completion() {
    use pi_web::rpc::{Cancelled, UiAnswer};
    let (handle, mut events) = spawn("ui", limits());
    handle
        .extension_ui_response(
            "dialog-1",
            UiAnswer::Cancelled {
                cancelled: Cancelled,
            },
        )
        .await
        .unwrap();
    let event = timeout(Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event["reply"]["id"], "dialog-1");
    assert_eq!(event["reply"]["cancelled"], true);
    assert!(
        handle
            .request(RpcCommand::GetState, Duration::from_secs(2))
            .await
            .is_ok()
    );
    stopped(&handle).await;
}
