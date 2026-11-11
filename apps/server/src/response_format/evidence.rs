//! Compact, server-observed turn data. Tool arguments, output and file contents are
//! excluded from the formatter input and this wire payload.
use super::nonempty;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use ts_rs::TS;

/// Bounded observations for one completed turn. File capture includes concurrent edits;
/// completed tool calls establish RPC outcomes, not independently verified test results.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordedEvidence {
    pub tools: Vec<RecordedTool>,
    pub files: Vec<RecordedFile>,
    pub files_state: FileCaptureState,
    pub omitted_tools: bool,
    pub omitted_files: bool,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FileCaptureState { Captured, #[default] Unavailable }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordedTool {
    pub id: String,
    pub label: String,
    pub outcome: ToolOutcome,
    #[ts(type = "number")]
    pub duration_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ToolOutcome { Completed, Error, Unconfirmed }
/// A content change observed between turn admission and settlement, with optional exact
/// line counts from its complete captured patch. Paths retain their original spelling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
pub struct RecordedFile {
    pub id: String,
    pub path: String,
    pub change: FileChangeKind,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FileChangeKind { Added, Modified, Deleted }
impl RecordedEvidence {
    pub(crate) fn valid(&self) -> bool {
        self.tools.len() <= 12 && self.files.len() <= 8
            && self.tools.iter().enumerate().all(|(index, tool)| tool.id == format!("tool:{index}")
                && nonempty(&tool.label, 80) && tool.duration_ms <= 9_007_199_254_740_991)
            && self.files.iter().enumerate().all(|(index, file)| file.id == format!("file:{index}")
                && nonempty(&file.path, 512) && !file.path.chars().any(char::is_control) && !file.path.starts_with('/')
                && file.path.split('/').all(|part| !part.is_empty() && !matches!(part, "." | "..") && !part.eq_ignore_ascii_case(".git"))
                && file.added.is_some() == file.removed.is_some())
            && (self.files.is_empty() || self.files_state == FileCaptureState::Captured)
    }
    pub(crate) fn contains(&self, id: &str) -> bool {
        self.tools.iter().any(|item| item.id == id) || self.files.iter().any(|item| item.id == id)
    }
}

/// Collects the latest twelve paired RPC tool events for the active turn.
/// Durations span event observations, including any transport/scheduling delay.
#[derive(Default)]
pub(crate) struct EvidenceCollector {
    active: bool,
    pending: HashMap<String, (usize, u64)>,
    value: RecordedEvidence,
}
impl EvidenceCollector {
    pub(crate) fn begin(&mut self) { *self = Self { active: true, ..Self::default() }; }
    pub(crate) fn observe(&mut self, event: &Value, elapsed_ms: u64) {
        if !self.active { return; }
        let Some(call) = event["toolCallId"].as_str().filter(|id| nonempty(id, 160)) else { return; };
        match event["type"].as_str() {
            Some("tool_execution_start") if !self.pending.contains_key(call) => {
                if self.value.tools.len() == 12 {
                    self.value.omitted_tools = true;
                    self.value.tools.remove(0);
                    self.pending.retain(|_, (index, _)| { if *index == 0 { false } else { *index -= 1; true } });
                    for (index, tool) in self.value.tools.iter_mut().enumerate() { tool.id = format!("tool:{index}"); }
                }
                let label = match event["toolName"].as_str().unwrap_or("") {
                    "read" => "Read file", "write" => "Write file", "edit" => "Edit file",
                    "bash" => "Shell tool", "codemode" => "Tool batch",
                    "grep" | "ffgrep" | "find" | "fffind" | "ls" => "Search workspace",
                    "web_search" | "source_check" | "fetch_content" => "Research",
                    "Agent" | "SubagentWorkflow" => "Agent request",
                    "lsp_diagnostics" | "lsp_hover" | "lsp_definition" | "lsp_references" | "lsp_document_symbols" | "lsp_workspace_symbols" => "Inspect code",
                    _ => "Other tool",
                };
                let index = self.value.tools.len();
                self.value.tools.push(RecordedTool { id: format!("tool:{index}"), label: label.into(), outcome: ToolOutcome::Unconfirmed, duration_ms: 0 });
                self.pending.insert(call.into(), (index, elapsed_ms));
            }
            Some("tool_execution_end") => {
                if let Some((index, start)) = self.pending.remove(call) {
                    let tool = &mut self.value.tools[index];
                    tool.outcome = match event["isError"].as_bool() { Some(false) => ToolOutcome::Completed, Some(true) => ToolOutcome::Error, None => ToolOutcome::Unconfirmed };
                    tool.duration_ms = elapsed_ms.saturating_sub(start).min(9_007_199_254_740_991);
                }
            }
            _ => {}
        }
    }
    pub(crate) fn finish(&mut self) -> RecordedEvidence {
        self.active = false; self.pending.clear(); std::mem::take(&mut self.value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_recent_outcomes_and_marks_the_trace_as_partial() {
        let mut collector = EvidenceCollector::default(); collector.begin();
        for index in 0..15 {
            collector.observe(&serde_json::json!({"type":"tool_execution_start","toolCallId":index.to_string(),"toolName":if index == 14 { "bash" } else { "read" }}), index * 2);
            collector.observe(&serde_json::json!({"type":"tool_execution_end","toolCallId":index.to_string(),"isError":index == 14}), index * 2 + 1);
        }
        let recorded = collector.finish();
        assert!(recorded.omitted_tools);
        assert_eq!(recorded.tools.len(), 12);
        assert_eq!(recorded.tools[11].outcome, ToolOutcome::Error);
        assert_eq!(recorded.tools[11].label, "Shell tool");
        assert!(recorded.valid());
    }
    #[test]
    fn records_outcomes_and_elapsed_time_without_tool_payloads() {
        let mut collector = EvidenceCollector::default(); collector.begin();
        collector.observe(&serde_json::json!({"type":"tool_execution_start","toolCallId":"call","toolName":"bash","args":{"command":"PRIVATE_COMMAND"}}), 10);
        collector.observe(&serde_json::json!({"type":"tool_execution_end","toolCallId":"call","isError":true,"result":{"content":[{"text":"PRIVATE_OUTPUT"}]}}), 35);
        let captured = collector.finish();
        assert_eq!(captured.tools[0].outcome, ToolOutcome::Error);
        assert_eq!(captured.tools[0].duration_ms, 25);
        assert!(!serde_json::to_string(&captured).unwrap().contains("PRIVATE"));
        collector.begin();
        collector.observe(&serde_json::json!({"type":"tool_execution_end","toolCallId":"call","isError":false}), 50);
        assert!(collector.finish().tools.is_empty(), "late results cannot cross turns");
    }
}
