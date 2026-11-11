//! Live, app-owned activity categories. Tool IDs stay private and bounded;
//! tool arguments, results, and reasoning text are never used for labels.
use crate::protocol::WorkPhase;
use serde_json::Value;
use std::collections::VecDeque;

/// Tracks the newest active tool, restoring an earlier tool when parallel work finishes.
/// At most the latest 64 calls with IDs up to 256 bytes are retained per run.
#[derive(Default)]
pub(super) struct Progress {
    tools: VecDeque<(String, WorkPhase)>,
    model: Option<WorkPhase>,
}

impl Progress {
    /// Reduces observed lifecycle events to a safe category; settlement clears the run.
    pub(super) fn apply(&mut self, event: &Value) -> Option<WorkPhase> {
        match event["type"].as_str() {
            Some("agent_start" | "agent_settled") => *self = Self::default(),
            Some("message_start" | "turn_start") => self.model = None,
            Some("message_end") if event["message"]["role"] == "assistant" => self.model = None,
            Some("message_update") if self.tools.is_empty() => {
                match event["assistantMessageEvent"]["type"].as_str() {
                    Some("thinking_start" | "thinking_delta") => self.model = Some(WorkPhase::Thinking),
                    Some("text_start" | "text_delta") => self.model = Some(WorkPhase::Writing),
                    _ => {}
                }
            }
            Some(kind @ ("tool_execution_start" | "tool_execution_end")) => {
                if let Some(id) = event["toolCallId"].as_str().filter(|id| !id.is_empty() && id.len() <= 256) {
                    self.tools.retain(|(active, _)| active != id);
                    if kind == "tool_execution_start" {
                        if self.tools.len() == 64 { self.tools.pop_front(); }
                        self.tools.push_back((id.to_owned(), tool_phase(event["toolName"].as_str().unwrap_or(""))));
                        self.model = None;
                    }
                }
            }
            _ => {}
        }
        self.tools.back().map(|(_, phase)| *phase).or(self.model)
    }
}

/// Maps known tool names to fixed categories; unfamiliar tools use the generic category.
fn tool_phase(name: &str) -> WorkPhase {
    match name {
        "read" => WorkPhase::Reading,
        "edit" | "write" => WorkPhase::Editing,
        "grep" | "ffgrep" | "find" | "fffind" | "ls" | "recall" => WorkPhase::Searching,
        "bash" => WorkPhase::Executing,
        "web_search" | "source_check" | "fetch_content" | "get_search_content" => WorkPhase::Researching,
        "lsp_diagnostics" | "lsp_hover" | "lsp_definition" | "lsp_references"
            | "lsp_document_symbols" | "lsp_workspace_symbols" | "lsp_more" => WorkPhase::Checking,
        "Agent" | "SubagentWorkflow" => WorkPhase::Delegating,
        _ => WorkPhase::Tools,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn categories_are_fixed_and_do_not_expose_tool_data() {
        for (name, expected) in [
            ("read", WorkPhase::Reading), ("edit", WorkPhase::Editing), ("write", WorkPhase::Editing),
            ("ffgrep", WorkPhase::Searching), ("fffind", WorkPhase::Searching), ("ls", WorkPhase::Searching),
            ("bash", WorkPhase::Executing), ("web_search", WorkPhase::Researching),
            ("fetch_content", WorkPhase::Researching), ("lsp_diagnostics", WorkPhase::Checking),
            ("Agent", WorkPhase::Delegating), ("SubagentWorkflow", WorkPhase::Delegating),
            ("codemode", WorkPhase::Tools), ("PRIVATE unknown tool", WorkPhase::Tools),
        ] {
            let phase = Progress::default().apply(&json!({"type":"tool_execution_start", "toolCallId":"PRIVATE id", "toolName":name, "args":{"command":"PRIVATE command"}, "result":"PRIVATE output"}));
            assert_eq!(phase, Some(expected));
            assert!(!serde_json::to_string(&phase).unwrap().contains("PRIVATE"));
        }
    }

    #[test]
    fn parallel_tools_finish_by_id_and_duplicates_do_not_accumulate() {
        let mut progress = Progress::default();
        let read = json!({"type":"tool_execution_start", "toolCallId":"read", "toolName":"read"});
        assert_eq!(progress.apply(&read), Some(WorkPhase::Reading));
        progress.apply(&read);
        assert_eq!(progress.tools.len(), 1);
        assert_eq!(progress.apply(&json!({"type":"tool_execution_start", "toolCallId":"bash", "toolName":"bash"})), Some(WorkPhase::Executing));
        assert_eq!(progress.apply(&json!({"type":"tool_execution_end", "toolCallId":"bash", "isError":true})), Some(WorkPhase::Reading));
        assert_eq!(progress.apply(&json!({"type":"tool_execution_end", "toolCallId":"unknown"})), Some(WorkPhase::Reading));
        assert_eq!(progress.apply(&json!({"type":"tool_execution_end", "toolCallId":"read"})), None);
        progress.apply(&read);
        progress.apply(&json!({"type":"tool_execution_start", "toolCallId":"bash", "toolName":"bash"}));
        assert_eq!(progress.apply(&json!({"type":"tool_execution_end", "toolCallId":"read"})), Some(WorkPhase::Executing));
    }

    #[test]
    fn model_event_kinds_supply_progress_without_reading_content() {
        let mut progress = Progress::default();
        for (kind, expected) in [("thinking_start", WorkPhase::Thinking), ("thinking_delta", WorkPhase::Thinking), ("text_start", WorkPhase::Writing), ("text_delta", WorkPhase::Writing)] {
            assert_eq!(progress.apply(&json!({"type":"message_update", "assistantMessageEvent":{"type":kind, "delta":"PRIVATE reasoning or text"}})), Some(expected));
        }
        assert_eq!(progress.apply(&json!({"type":"tool_execution_end", "toolCallId":"stale"})), Some(WorkPhase::Writing));
        assert_eq!(progress.apply(&json!({"type":"message_end", "message":{"role":"assistant"}})), None);
        progress.apply(&json!({"type":"tool_execution_start", "toolCallId":"read", "toolName":"read"}));
        assert_eq!(progress.apply(&json!({"type":"message_update", "assistantMessageEvent":{"type":"text_delta"}})), Some(WorkPhase::Reading));
        assert_eq!(progress.apply(&json!({"type":"agent_settled", "aborted":true})), None);
        progress.apply(&json!({"type":"tool_execution_start", "toolCallId":"read", "toolName":"read"}));
        assert_eq!(progress.apply(&json!({"type":"agent_start"})), None);
    }

    #[test]
    fn active_call_storage_is_bounded_and_malformed_ids_are_ignored() {
        let mut progress = Progress::default();
        for id in [json!(null), json!(""), json!("x".repeat(257))] {
            assert_eq!(progress.apply(&json!({"type":"tool_execution_start", "toolCallId":id, "toolName":"read"})), None);
        }
        for index in 0..1000 {
            progress.apply(&json!({"type":"tool_execution_start", "toolCallId":index.to_string(), "toolName":"read"}));
        }
        assert_eq!(progress.tools.len(), 64);
        assert_eq!(progress.apply(&json!({"type":"agent_settled"})), None);
        assert!(progress.tools.is_empty());
    }
}
