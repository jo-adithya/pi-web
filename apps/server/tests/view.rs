#[path = "../src/view.rs"]
pub mod view;
use serde_json::{Value, json};
use view::*;
fn start(state: &mut ViewState) {
    state.apply(&json!({"type":"message_start","message":{"role":"assistant","content":[]}}));
}
#[test]
fn final_messages_replace_deltas_and_agent_end_is_not_settlement() {
    let mut state = ViewState::default();
    state.apply(&json!({"type":"agent_start"}));
    start(&mut state);
    state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}));
    state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"draft"}}));
    assert_eq!(state.messages()[0].blocks[0].text, "draft");
    state.apply(&json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"authoritative"}]}}));
    assert_eq!(state.messages().len(), 1);
    assert_eq!(state.messages()[0].blocks[0].text, "authoritative");
    state.apply(&json!({"type":"agent_end","willRetry":true}));
    assert_eq!(state.activity, Activity::Running);
    state.apply(&json!({"type":"auto_retry_start"}));
    assert_eq!(state.activity, Activity::Retrying);
    state.apply(&json!({"type":"compaction_start"}));
    assert_eq!(state.activity, Activity::Compacting);
    state.apply(&json!({"type":"agent_settled","aborted":true}));
    assert_eq!(state.activity, Activity::Idle);
}
#[test]
fn strips_hidden_provider_data_and_bounds_preview_blocks_and_utf8() {
    assert!(
        normalize_message(
            "id".into(),
            &json!({"role":"system","content":"private"}),
            true
        )
        .is_none()
    );
    assert!(
        normalize_message(
            "id".into(),
            &json!({"role":"custom","display":false,"content":"private"}),
            true
        )
        .is_none()
    );
    let message = normalize_message("id".into(), &json!({"role":"assistant","responseId":"secret", "content":[{"type":"text","text":"safe","textSignature":"secret"},{"type":"image","data":"secret"},{"type":"thinking","thinking":"preview","thinkingSignature":"secret"}]}), true).unwrap();
    assert!(!serde_json::to_string(&message).unwrap().contains("secret"));
    let blocks: Vec<Value> = (0..1000)
        .map(|_| json!({"type":"text","text":"🌍".repeat(1024)}))
        .collect();
    let message =
        normalize_message("id".into(), &json!({"role":"user","content":blocks}), true).unwrap();
    assert!(message.truncated);
    assert!(message.blocks.len() <= MAX_BLOCKS);
    assert!(message.blocks.iter().map(|b| b.text.len()).sum::<usize>() <= MAX_MESSAGE_BYTES);
    assert_eq!(clipped("🌍x", 3), ("".into(), true));
}
#[test]
fn sparse_and_invalid_deltas_cannot_evade_accounting_or_allocate_unbounded_blocks() {
    let mut state = ViewState::default();
    start(&mut state);
    state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":63,"delta":"\"🌍"}}));
    let expected: usize = state
        .messages()
        .iter()
        .map(|m| serde_json::to_vec(m).unwrap().len())
        .sum();
    assert_eq!(state.retained_bytes(), expected);
    state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1_000_000,"delta":"ignored"}}));
    assert_eq!(state.messages()[0].blocks.len(), 1);
    state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"x".repeat(128 * 1024)}}));
    assert!(state.messages()[0].truncated);
    assert!(
        state.messages()[0]
            .blocks
            .iter()
            .map(|b| b.text.len())
            .sum::<usize>()
            <= MAX_MESSAGE_BYTES
    );
}
#[test]
fn internal_task_notifications_never_enter_live_presentation() {
    let text = "<task-notification><status>Done</status></task-notification>";
    let mut state = ViewState::default();
    for event in ["message_start", "message_end"] {
        assert!(
            state
                .apply(&json!({"type":event,"message":{
                    "role":"custom","customType":"subagent-notification",
                    "display":true,"content":text
                }}))
                .is_empty()
        );
    }
    assert!(state.messages().is_empty());
    for (role, custom_type) in [
        ("user", "subagent-notification"),
        ("assistant", "subagent-notification"),
        ("custom", "ordinary-extension"),
    ] {
        state.apply(&json!({"type":"message_end","message":{
            "role":role,"customType":custom_type,"display":true,"content":text
        }}));
    }
    assert_eq!(state.messages().len(), 3);
    assert!(
        state
            .messages()
            .iter()
            .all(|message| message.blocks[0].text == text)
    );
}

#[test]
fn display_has_count_and_byte_bounds() {
    let mut state = ViewState::default();
    for i in 0..600 {
        state.apply(&json!({"type":"message_end","message":{"role":"user","content":format!("{i}:{}", "x".repeat(20_000))}}));
    }
    assert!(state.messages().len() <= MAX_MESSAGES);
    assert!(state.older_history);
    assert!(state.retained_bytes() <= MAX_DISPLAY_BYTES);
}

#[test]
fn invalid_delta_does_not_mutate_state_and_capped_deltas_stop_publishing() {
    let mut state = ViewState::default();
    start(&mut state);
    let initial = state.messages();
    assert!(state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":63,"delta":null}})).is_empty());
    assert_eq!(state.messages(), initial);
    let huge = json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"x".repeat(MAX_MESSAGE_BYTES + 1)}});
    assert!(!state.apply(&huge).is_empty());
    assert!(state.apply(&huge).is_empty());
    assert_eq!(
        state.retained_bytes(),
        serde_json::to_vec(&state.messages()[0]).unwrap().len()
    );
}

#[test]
fn stable_history_replaces_live_ids_once() {
    let mut state = ViewState::default();
    start(&mut state);
    let message = normalize_message(
        "persisted".into(),
        &json!({"role":"assistant","content":"same answer"}),
        true,
    )
    .unwrap();
    state.replace_history(vec![message.clone()], true);
    assert_eq!(state.messages(), vec![message]);
    assert!(state.older_history);
    state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"stale"}}));
    assert_eq!(state.messages()[0].blocks[0].text, "same answer");
}

#[test]
fn tool_payloads_are_ignored_and_empty_final_previews_removed() {
    let mut state = ViewState::default();
    for kind in [
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
    ] {
        assert!(state.apply(&json!({"type":kind,"toolCallId":"secret","toolName":"secret","args":{"secret":true},"result":{"content":[{"type":"text","text":"secret"}]}})).is_empty());
    }
    assert_eq!(state.retained_bytes(), 0);
    start(&mut state);
    for kind in ["toolcall_start", "toolcall_delta", "toolcall_end"] {
        assert!(state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":kind,"contentIndex":0,"delta":"secret","toolCall":{"name":"secret","arguments":{"secret":true}}}})).is_empty());
    }
    let patches = state.apply(&json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","name":"secret","arguments":{"secret":true}}]}}));
    assert!(
        patches
            .iter()
            .any(|p| matches!(p, ViewPatch::Remove { .. }))
    );
    assert!(state.messages().is_empty());
    assert_eq!(state.retained_bytes(), 0);
    assert!(
        normalize_message(
            "id".into(),
            &json!({"role":"toolResult","content":"secret","errorMessage":"secret"}),
            true
        )
        .is_none()
    );
    let error = normalize_message("id".into(), &json!({"role":"assistant","content":[{"type":"toolCall","name":"secret"}],"errorMessage":"failed"}), true).unwrap();
    assert_eq!(error.error.as_deref(), Some("failed"));
    assert!(error.blocks.is_empty());
}

#[test]
fn visible_stream_indices_remain_aligned_across_hidden_blocks_and_snapshots() {
    for initial in [
        json!([]),
        json!([
            {"type":"text","text":"first"},
            {"type":"toolCall","id":"secret","name":"secret","arguments":{"secret":true}},
            {"type":"thinking","thinking":"second"}
        ]),
    ] {
        let mut state = ViewState::default();
        state.apply(
            &json!({"type":"message_start","message":{"role":"assistant","content":initial}}),
        );
        for (index, kind, text) in [(0, "text", "first"), (2, "thinking", "second")] {
            if initial.as_array().unwrap().is_empty() {
                state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":format!("{kind}_start"),"contentIndex":index}}));
            }
            let patches = state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":format!("{kind}_delta"),"contentIndex":index,"delta":"!"}}));
            assert!(
                matches!(&patches[0], ViewPatch::Delta { index: visible, .. } if *visible == index / 2)
            );
            state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":format!("{kind}_end"),"contentIndex":index,"content":text}}));
        }
        assert_eq!(state.messages()[0].blocks.len(), 2);
        assert_eq!(state.messages()[0].blocks[0].text, "first");
        assert_eq!(state.messages()[0].blocks[1].text, "second");
        assert_eq!(state.messages()[0].blocks[1].kind, BlockKind::Thinking);
        let patches = state.apply(&json!({"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final first"},{"type":"toolCall","name":"secret"},{"type":"text","text":"final second"}]}}));
        assert!(!serde_json::to_string(&patches).unwrap().contains("secret"));
        assert_eq!(state.messages().len(), 1);
        assert_eq!(state.messages()[0].blocks.len(), 2);
        assert_eq!(state.messages()[0].blocks[1].text, "final second");
        assert_eq!(
            state.retained_bytes(),
            serde_json::to_vec(&state.messages()[0]).unwrap().len()
        );
    }
}

#[test]
fn text_after_a_tool_uses_the_next_visible_index() {
    let mut state = ViewState::default();
    start(&mut state);
    for (index, text) in [(0, "before"), (2, "after")] {
        state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":index,"delta":text}}));
    }
    assert_eq!(
        state.messages()[0]
            .blocks
            .iter()
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>(),
        ["before", "after"]
    );
}

#[test]
fn truncated_initial_snapshots_do_not_leave_invalid_visible_indices() {
    let mut state = ViewState::default();
    state.apply(&json!({"type":"message_start","message":{"role":"assistant","content":[{"type":"text","text":"x".repeat(MAX_MESSAGE_BYTES)},{"type":"toolCall","arguments":"secret"},{"type":"text","text":"omitted"}]}}));
    assert!(state.apply(&json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":2,"delta":"still omitted"}})).is_empty());
    assert_eq!(state.messages()[0].blocks.len(), 1);
    assert_eq!(
        state.retained_bytes(),
        serde_json::to_vec(&state.messages()[0]).unwrap().len()
    );
}
