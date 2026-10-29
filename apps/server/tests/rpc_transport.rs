use pi_web::rpc::{Limits, ProcessSpec, RpcCommand, Transport};
use std::{path::PathBuf, time::Duration};

fn spec(mode: &str) -> ProcessSpec {
    ProcessSpec {
        executable: PathBuf::from("/usr/bin/python3"),
        args: vec![
            format!("{}/tests/fixtures/mock_pi.py", env!("CARGO_MANIFEST_DIR")).into(),
            mode.into(),
        ],
        cwd: PathBuf::from(env!("CARGO_MANIFEST_DIR")),
    }
}

#[tokio::test]
async fn fragmented_event_and_ack_are_independent() {
    let (handle, mut events) = Transport::spawn(spec("echo"), Limits::default()).unwrap();
    let data = handle
        .request(
            RpcCommand::Prompt { message: "hello".into(), images: vec![] },
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert_eq!(data["disposition"], "started");
    assert_eq!(events.recv().await.unwrap()["text"], "héllo\u{2028}world");
    let exit = handle.shutdown().await;
    assert!(exit.cleanup_error.is_none(), "{exit:?}");
    assert!(exit.reaped);
}

use pi_web::rpc::{Cancelled, Error, UiAnswer};
use tokio::time::timeout;

fn fast_limits() -> Limits {
    Limits {
        shutdown_grace: Duration::from_millis(60),
        term_grace: Duration::from_millis(60),
        kill_grace: Duration::from_secs(1),
        ..Limits::default()
    }
}

async fn clean(handle: &pi_web::rpc::Handle) {
    let exit = timeout(Duration::from_secs(4), handle.shutdown())
        .await
        .unwrap();
    assert!(exit.reaped, "{exit:?}");
    assert!(exit.cleanup_error.is_none(), "{exit:?}");
}

#[tokio::test]
async fn correlation_out_of_order_and_settlement() {
    let (h, mut events) = Transport::spawn(spec("order"), fast_limits()).unwrap();
    let (state, commands) = tokio::join!(
        h.request(RpcCommand::GetState, Duration::from_secs(2)),
        h.request(RpcCommand::GetCommands, Duration::from_secs(2))
    );
    assert_eq!(state.unwrap()["name"], "get_state");
    assert_eq!(commands.unwrap()["name"], "get_commands");
    assert_eq!(events.recv().await.unwrap()["type"], "agent_settled");
    clean(&h).await;
}

#[tokio::test]
async fn rejection_is_typed_and_late_ids_are_discarded() {
    let (h, _events) = Transport::spawn(spec("reject"), fast_limits()).unwrap();
    assert_eq!(
        h.request(RpcCommand::GetState, Duration::from_secs(2))
            .await
            .unwrap_err(),
        Error::Command {
            command: "get_state".into(),
            message: "rejected".into()
        }
    );
    clean(&h).await;
    let (h, mut events) = Transport::spawn(spec("late"), fast_limits()).unwrap();
    let first = h.request(RpcCommand::GetState, Duration::from_millis(200));
    let (result, event) = tokio::join!(first, events.recv());
    assert_eq!(result.unwrap_err(), Error::Timeout);
    assert_eq!(event.unwrap()["type"], "ready");
    assert_eq!(
        h.request(RpcCommand::GetCommands, Duration::from_secs(2))
            .await
            .unwrap()["current"],
        true
    );
    clean(&h).await;
}

#[tokio::test]
async fn malformed_records_fail_pending_and_close_admission() {
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
        let limits = Limits {
            record_bytes: 2048,
            json_nodes: 100,
            ..fast_limits()
        };
        let (h, _events) = Transport::spawn(spec(mode), limits).unwrap();
        let error = h
            .request(RpcCommand::GetState, Duration::from_secs(2))
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Protocol(_)), "{mode}: {error:?}");
        assert_eq!(
            h.request(RpcCommand::Abort, Duration::from_secs(1))
                .await
                .unwrap_err(),
            Error::Closed
        );
        clean(&h).await;
    }
}

#[tokio::test]
async fn stderr_tail_and_normal_eof() {
    let (h, _events) = Transport::spawn(spec("noise"), fast_limits()).unwrap();
    assert_eq!(
        h.request(RpcCommand::GetState, Duration::from_secs(2))
            .await
            .unwrap()["ok"],
        true
    );
    let exit = h.shutdown().await;
    assert_eq!(exit.stderr_tail, vec![b'x'; 64 * 1024]);
    assert!(exit.reaped && exit.cleanup_error.is_none());
    let (h, mut events) = Transport::spawn(spec("eof"), fast_limits()).unwrap();
    let exit = timeout(Duration::from_secs(3), h.wait_exit())
        .await
        .unwrap();
    assert!(exit.reaped && exit.cleanup_error.is_none());
    assert_eq!(events.recv().await.unwrap()["type"], "agent_settled");
    assert!(events.recv().await.is_none());
}

#[tokio::test]
async fn sustained_slow_consumer_fails_visibly_after_ack() {
    let limits = Limits {
        retained_records: 2,
        retained_bytes: 8192,
        overload_timeout: Duration::from_millis(80),
        ..fast_limits()
    };
    let (h, mut events) = Transport::spawn(spec("flood"), limits).unwrap();
    assert_eq!(
        h.request(RpcCommand::GetState, Duration::from_secs(2))
            .await
            .unwrap()["ok"],
        true
    );
    let exit = timeout(Duration::from_secs(3), h.wait_exit())
        .await
        .unwrap();
    assert_eq!(exit.reason, Error::Overloaded);
    assert!(exit.reaped && exit.cleanup_error.is_none());
    assert!(events.recv().await.is_some());
    assert!(events.recv().await.is_some());
    assert!(events.recv().await.is_none());
}

#[tokio::test]
async fn extension_replies_have_no_command_response() {
    let (h, mut events) = Transport::spawn(spec("ui"), fast_limits()).unwrap();
    for answer in [
        UiAnswer::Value {
            value: "yes".into(),
        },
        UiAnswer::Confirmed { confirmed: false },
        UiAnswer::Cancelled {
            cancelled: Cancelled,
        },
    ] {
        h.extension_ui_response("dialog-1", answer).await.unwrap();
        let event = events.recv().await.unwrap();
        assert_eq!(event["reply"]["id"], "dialog-1");
        assert_eq!(event["reply"]["type"], "extension_ui_response");
    }
    assert_eq!(
        h.request(RpcCommand::GetState, Duration::from_secs(2))
            .await
            .unwrap()["ok"],
        true
    );
    clean(&h).await;
}

#[tokio::test]
async fn term_kill_reaps_owned_group_and_drop_cleans_up() {
    use std::os::unix::process::ExitStatusExt;
    for mode in ["stall", "descendant"] {
        let (h, mut events) = Transport::spawn(spec(mode), fast_limits()).unwrap();
        let event = timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        let pid = event["pid"].as_i64().unwrap() as i32;
        let exit = timeout(Duration::from_secs(4), h.shutdown()).await.unwrap();
        assert!(exit.reaped && exit.cleanup_error.is_none(), "{exit:?}");
        assert_eq!(exit.status.unwrap().signal(), Some(libc::SIGKILL));
        // SAFETY: existence probe of this test's previously owned process group.
        assert_eq!(unsafe { libc::kill(-pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }
    let (h, mut events) = Transport::spawn(spec("stall"), fast_limits()).unwrap();
    let pid = events.recv().await.unwrap()["pid"].as_i64().unwrap() as i32;
    drop(h);
    timeout(Duration::from_secs(3), async {
        loop {
            // SAFETY: existence probe of this test's owned child only.
            if unsafe { libc::kill(pid, 0) } == -1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

#[tokio::test]
async fn control_admission_survives_normal_outstanding_pressure() {
    let limits = Limits {
        outstanding: 4,
        ..fast_limits()
    };
    let (h, mut events) = Transport::spawn(spec("priority"), limits).unwrap();
    let mut requests = Vec::new();
    for _ in 0..4 {
        let clone = h.clone();
        requests.push(tokio::spawn(async move {
            clone
                .request(
                    RpcCommand::Prompt { message: "wait".into(), images: vec![] },
                    Duration::from_secs(2),
                )
                .await
        }));
    }
    // Allow requests to enter the transport; receipt confirms at least one is pending.
    events.recv().await.unwrap();
    tokio::task::yield_now().await;
    assert_eq!(
        h.request(RpcCommand::Abort, Duration::from_secs(1))
            .await
            .unwrap()["ok"],
        true
    );
    clean(&h).await;
    for request in requests {
        assert!(request.await.unwrap().is_err());
    }
}

#[tokio::test]
async fn limits_and_outbound_byte_budget_are_checked() {
    assert!(matches!(
        Transport::spawn(
            spec("echo"),
            Limits {
                record_bytes: 0,
                ..Limits::default()
            }
        ),
        Err(Error::InvalidLimits)
    ));
    let (h, _events) = Transport::spawn(
        spec("echo"),
        Limits {
            normal_bytes: 100,
            ..fast_limits()
        },
    )
    .unwrap();
    assert_eq!(
        h.request(
            RpcCommand::Prompt { message: "x".repeat(200), images: vec![] },
            Duration::from_secs(1)
        )
        .await
        .unwrap_err(),
        Error::Overloaded
    );
    clean(&h).await;
}

#[tokio::test]
async fn stalled_writer_has_deadline_and_shutdown_fails_pending() {
    let limits = Limits {
        write_timeout: Duration::from_millis(80),
        ..fast_limits()
    };
    let (h, mut events) = Transport::spawn(spec("stall"), limits).unwrap();
    events.recv().await.unwrap();
    let result = h
        .request(
            RpcCommand::Prompt { message: "x".repeat(900_000), images: vec![] },
            Duration::from_secs(2),
        )
        .await;
    assert_eq!(result.unwrap_err(), Error::Timeout);
    let exit = timeout(Duration::from_secs(3), h.wait_exit())
        .await
        .unwrap();
    assert_eq!(exit.reason, Error::Timeout);
    assert!(exit.reaped && exit.cleanup_error.is_none());

    let (h, mut events) = Transport::spawn(spec("silent"), fast_limits()).unwrap();
    let clone = h.clone();
    let request = tokio::spawn(async move {
        clone
            .request(RpcCommand::GetState, Duration::from_secs(10))
            .await
    });
    events.recv().await.unwrap();
    clean(&h).await;
    assert_eq!(request.await.unwrap().unwrap_err(), Error::Closed);
}

#[tokio::test]
async fn receipt_and_request_cancellation_release_budgets() {
    let limits = Limits {
        retained_records: 1,
        retained_bytes: 8192,
        ..fast_limits()
    };
    let (h, mut events) = Transport::spawn(spec("echo"), limits).unwrap();
    for _ in 0..10 {
        let (result, event) = tokio::join!(
            h.request(RpcCommand::GetState, Duration::from_secs(2)),
            events.recv()
        );
        assert!(result.is_ok());
        assert!(event.is_some());
    }
    clean(&h).await;
    let (h, mut events) = Transport::spawn(
        spec("silent"),
        Limits {
            outstanding: 2,
            ..fast_limits()
        },
    )
    .unwrap();
    for _ in 0..3 {
        let clone = h.clone();
        let request = tokio::spawn(async move {
            clone
                .request(RpcCommand::GetState, Duration::from_secs(10))
                .await
        });
        timeout(Duration::from_secs(2), events.recv())
            .await
            .unwrap()
            .unwrap();
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
    }
    clean(&h).await;
}

#[tokio::test]
async fn decoded_node_overhead_counts_toward_retention() {
    // The echo event is <100 encoded bytes but costs >1 KiB with decoded nodes.
    let (h, _events) = Transport::spawn(
        spec("echo"),
        Limits {
            retained_bytes: 1000,
            ..fast_limits()
        },
    )
    .unwrap();
    assert_eq!(
        h.request(RpcCommand::GetState, Duration::from_secs(2))
            .await
            .unwrap_err(),
        Error::Overloaded
    );
    clean(&h).await;
}

#[tokio::test]
async fn immediate_shutdown_waits_for_reaping_and_group_absence() {
    // Exercise the Darwin exiting/not-yet-waitable interval without interpreting
    // a transient EPERM existence probe as either success or permanent failure.
    for _ in 0..20 {
        let (h, _events) = Transport::spawn(spec("echo"), fast_limits()).unwrap();
        clean(&h).await;
    }
}
