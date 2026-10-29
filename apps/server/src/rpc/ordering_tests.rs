use super::*;

fn silent_peer(limits: Limits) -> (Handle, Events) {
    Transport::spawn(
        ProcessSpec {
            executable: "/usr/bin/python3".into(),
            args: vec![
                format!("{}/tests/fixtures/mock_pi.py", env!("CARGO_MANIFEST_DIR")).into(),
                "silent".into(),
            ],
            cwd: env!("CARGO_MANIFEST_DIR").into(),
        },
        limits,
    )
    .unwrap()
}

#[tokio::test]
async fn write_notice_precedes_an_unanswered_rpc_response() {
    let (handle, _events) = silent_peer(Limits::default());
    let child = handle.clone();
    let (written, notice) = oneshot::channel();
    let request = tokio::spawn(async move {
        child
            .request_with_write_notice(
                RpcCommand::Prompt { message: "hold response".into(), images: vec![] },
                Duration::from_secs(5),
                written,
            )
            .await
    });
    let observation = tokio::time::timeout(Duration::from_secs(2), notice).await;
    let still_pending = !request.is_finished();
    let exit = handle.shutdown().await;
    let result = request.await.unwrap();
    assert_eq!(observation.unwrap().unwrap(), Ok(()));
    assert!(still_pending, "write notice waited for the RPC response");
    assert_eq!(result, Err(Error::Closed));
    assert!(exit.reaped && exit.cleanup_error.is_none());
}

#[tokio::test]
async fn failed_admission_cannot_report_a_successful_write() {
    let (handle, _events) = silent_peer(Limits {
        normal_bytes: 100,
        ..Limits::default()
    });
    let (written, notice) = oneshot::channel();
    let result = handle
        .request_with_write_notice(
            RpcCommand::Prompt { message: "x".repeat(200), images: vec![] },
            Duration::from_secs(2),
            written,
        )
        .await;
    let notification = tokio::time::timeout(Duration::from_secs(1), notice).await;
    let exit = handle.shutdown().await;
    assert_eq!(result, Err(Error::Overloaded));
    assert!(notification.unwrap().is_err());
    assert!(exit.reaped && exit.cleanup_error.is_none());
}

#[tokio::test]
async fn response_boundary_preserves_later_events_and_retention() {
    let budget = Arc::new(Semaphore::new(4));
    let (sender, receiver) = mpsc::channel(2);
    let mut events = Events {
        receiver,
        buffered: None,
    };
    for sequence in [1, 3] {
        sender
            .send(Record {
                sequence,
                value: serde_json::json!({"sequence": sequence}),
                _bytes: budget.clone().acquire_owned().await.unwrap(),
                _count: budget.clone().acquire_owned().await.unwrap(),
            })
            .await
            .unwrap();
    }
    assert_eq!(events.recv_through(2).unwrap()["sequence"], 1);
    assert!(events.recv_through(2).is_none());
    assert_eq!(budget.available_permits(), 2);
    assert_eq!(events.recv().await.unwrap()["sequence"], 3);
    assert_eq!(budget.available_permits(), 4);
}
