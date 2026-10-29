use pi_web::protocol::{HistoryHeadReply, ProcessStatus, SessionDescriptor, typescript_bindings};
use serde_json::{Value, json};

#[test]
fn shared_fixture_round_trips_with_browser_field_names() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/protocol/session.json")).unwrap();
    let session: SessionDescriptor = serde_json::from_value(fixture.clone()).unwrap();
    assert_eq!(session.process, ProcessStatus::Starting);
    assert_eq!(serde_json::to_value(session).unwrap(), fixture);
}

#[test]
fn invalid_descriptor_shapes_are_rejected() {
    for invalid in [
        json!({ "sessionId": "test", "epoch": "epoch", "process": "unknown" }),
        json!({ "sessionId": "test", "epoch": "epoch" }),
        json!({ "sessionId": 42, "epoch": "epoch", "process": "ready" }),
        json!({ "sessionId": "test", "epoch": null, "process": "ready" }),
    ] {
        assert!(serde_json::from_value::<SessionDescriptor>(invalid).is_err());
    }
}

#[test]
fn private_head_fixture_matches_generated_adapter_shape() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/protocol/history-head.json")).unwrap();
    let reply: HistoryHeadReply = serde_json::from_value(fixture.clone()).unwrap();
    assert!(matches!(&reply, HistoryHeadReply::Ok { head, .. } if head.idle));
    assert_eq!(serde_json::to_value(reply).unwrap(), fixture);
    for error in ["invalid_request", "metadata_limit", "metadata_unavailable"] {
        let fixture = json!({"status":"error", "requestId":null, "code":error});
        let reply: HistoryHeadReply = serde_json::from_value(fixture.clone()).unwrap();
        assert_eq!(serde_json::to_value(reply).unwrap(), fixture);
    }
}

#[test]
fn invalid_private_head_shapes_are_rejected() {
    for invalid in [
        json!({"status":"unknown", "requestId":"head-1"}),
        json!({"status":"ok", "requestId":"head-1"}),
        json!({"status":"ok", "requestId":null, "head":{}}),
        json!({"status":"ok", "requestId":"head-1", "head":{"sessionId":"s", "idle":"true"}}),
        json!({"status":"error", "requestId":"head-1", "code":"unknown"}),
    ] {
        assert!(serde_json::from_value::<HistoryHeadReply>(invalid).is_err());
    }
}

#[test]
fn generated_types_are_current() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/src/generated/protocol.ts");
    assert_eq!(
        std::fs::read_to_string(path).expect("run bun run types:generate"),
        typescript_bindings(),
        "run bun run types:generate"
    );
}
