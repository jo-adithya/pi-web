//! Bounded projection of opensec-pi-subagents 0.20.0 Agent and workflow events, separate from history.
use crate::protocol::{BackgroundKind, BackgroundStatus, BackgroundTask};
use serde_json::Value;
use std::collections::VecDeque;

const TASKS: usize = 32;
const PENDING: usize = 64;
#[derive(Clone)]
struct Record {
    task: BackgroundTask,
    started: u64,
}
struct Invocation {
    call: String,
    resume: Option<String>,
    since: u64,
}
/// Retains only observed background launches. Terminal records may precede their launch reply.
#[derive(Default)]
pub(crate) struct Background {
    tasks: VecDeque<Record>,
    records: VecDeque<Record>,
    pending: VecDeque<Invocation>,
}
impl Background {
    pub fn tasks(&self) -> Vec<BackgroundTask> {
        self.tasks.iter().map(|r| r.task.clone()).collect()
    }
    /// Applies one ordered RPC event; returns whether the public projection changed.
    pub fn apply(&mut self, event: &Value) -> bool {
        let relevant = match event["type"].as_str() {
            Some("tool_execution_start" | "tool_execution_end") => {
                event["toolName"] == "Agent" || event["toolName"] == "SubagentWorkflow"
            }
            Some("message_end") => {
                event["message"]["role"] == "custom"
                    && event["message"]["customType"] == "subagent-notification"
            }
            Some("entry_appended") => {
                event["entry"]["type"] == "custom"
                    && event["entry"]["customType"] == "subagents:record"
            }
            _ => false,
        };
        if !relevant {
            return false;
        }
        let before = self.tasks();
        self.reduce(event);
        before != self.tasks()
    }
    fn reduce(&mut self, e: &Value) {
        match e["type"].as_str() {
            Some("tool_execution_end") if e["toolName"] == "SubagentWorkflow" => {
                self.workflow_launch(e);
            }
            Some("message_end") => self.workflow_terminal(&e["message"]["details"]),
            Some("tool_execution_start") if e["toolName"] == "Agent" => {
                let Some(call) = correlation_id(&e["toolCallId"]) else {
                    return;
                };
                if self.pending.iter().any(|p| p.call == call) {
                    return;
                }
                let resume = identifier(&e["args"]["resume"]);
                // RPC delivery can lag the producer's clock. Use the last observed
                // invocation timestamp, never the runtime's receive time, as the floor.
                // Equal-millisecond records are ambiguous and cannot settle a resume.
                let since = resume
                    .as_ref()
                    .and_then(|id| {
                        self.records
                            .iter()
                            .chain(self.tasks.iter())
                            .find(|r| &r.task.id == id && r.task.kind == BackgroundKind::Agent)
                    })
                    .map_or(0, |r| r.started + 1);
                if let Some(id) = &resume {
                    self.records
                        .retain(|r| &r.task.id != id || r.task.kind != BackgroundKind::Agent);
                }
                self.pending.push_back(Invocation {
                    call,
                    resume,
                    since,
                });
                if self.pending.len() > PENDING {
                    self.pending.pop_front();
                }
            }
            Some("tool_execution_end") if e["toolName"] == "Agent" => {
                let Some(call) = correlation_id(&e["toolCallId"]) else {
                    return;
                };
                let invocation = self
                    .pending
                    .iter()
                    .position(|p| p.call == call)
                    .and_then(|i| self.pending.remove(i));
                let d = &e["result"]["details"];
                if e["isError"] != false || d["status"] != "background" {
                    return;
                }
                let Some(id) = identifier(&d["agentId"]) else {
                    return;
                };
                let resumed = invocation.filter(|p| p.resume.as_ref() == Some(&id));
                let since = resumed.as_ref().map_or(0, |p| p.since);
                if resumed.is_none()
                    && self
                        .tasks
                        .iter()
                        .any(|r| r.task.id == id && r.task.kind == BackgroundKind::Agent)
                {
                    return;
                }
                let mut record = Record {
                    started: since,
                    task: BackgroundTask {
                        id: id.clone(),
                        kind: BackgroundKind::Agent,
                        name: text(&d["displayName"], 128).unwrap_or_else(|| "Agent".into()),
                        description: text(&d["description"], 512).unwrap_or_default(),
                        status: BackgroundStatus::Active,
                        result: None,
                        error: None,
                        truncated: false,
                    },
                };
                if let Some(terminal) = self.records.iter().find(|r| {
                    r.task.id == id && r.task.kind == BackgroundKind::Agent && r.started >= since
                }) {
                    record.task.status = terminal.task.status.clone();
                    record.task.result = terminal.task.result.clone();
                    record.task.error = terminal.task.error.clone();
                    record.task.truncated = terminal.task.truncated;
                    record.started = terminal.started;
                }
                self.tasks
                    .retain(|r| r.task.id != id || r.task.kind != BackgroundKind::Agent);
                self.tasks.push_back(record);
                if self.tasks.len() > TASKS {
                    self.tasks.pop_front();
                }
            }
            Some("entry_appended")
                if e["entry"]["type"] == "custom"
                    && e["entry"]["customType"] == "subagents:record" =>
            {
                let d = &e["entry"]["data"];
                let Some(id) = identifier(&d["id"]) else {
                    return;
                };
                let status = match d["status"].as_str() {
                    Some("completed") => BackgroundStatus::Completed,
                    Some("steered") => BackgroundStatus::Steered,
                    Some("error") => BackgroundStatus::Error,
                    Some("aborted") => BackgroundStatus::Aborted,
                    Some("stopped") => BackgroundStatus::Stopped,
                    _ => return,
                };
                let (Some(started), Some(completed)) =
                    (millis(&d["startedAt"]), millis(&d["completedAt"]))
                else {
                    return;
                };
                if completed < started {
                    return;
                }
                if self
                    .pending
                    .iter()
                    .any(|p| p.resume.as_ref() == Some(&id) && started < p.since)
                {
                    return;
                }
                if self.records.iter().any(|r| {
                    r.task.id == id && r.task.kind == BackgroundKind::Agent && r.started >= started
                }) {
                    return;
                }
                let record = Record {
                    started,
                    task: BackgroundTask {
                        id: id.clone(),
                        kind: BackgroundKind::Agent,
                        name: String::new(),
                        description: String::new(),
                        status,
                        result: text(&d["result"], 8192),
                        error: text(&d["error"], 1024),
                        truncated: d["result"].as_str().is_some_and(|s| s.len() > 8192)
                            || d["error"].as_str().is_some_and(|s| s.len() > 1024),
                    },
                };
                if let Some(task) = self.tasks.iter_mut().find(|r| {
                    r.task.id == id && r.task.kind == BackgroundKind::Agent && started >= r.started
                }) {
                    task.started = started;
                    task.task.status = record.task.status.clone();
                    task.task.result = record.task.result.clone();
                    task.task.error = record.task.error.clone();
                    task.task.truncated = record.task.truncated;
                }
                self.records
                    .retain(|r| r.task.id != id || r.task.kind != BackgroundKind::Agent);
                self.records.push_back(record);
                if self.records.len() > PENDING {
                    self.records.pop_front();
                }
            }
            _ => {}
        }
    }
    /// Workflows always detach and return only a task ID; metadata and progress stay in the producer.
    fn workflow_launch(&mut self, e: &Value) {
        if e["isError"] != false || correlation_id(&e["toolCallId"]).is_none() {
            return;
        }
        let Some(id) = workflow_id(&e["result"]["details"]["taskId"]) else {
            return;
        };
        if self
            .tasks
            .iter()
            .any(|r| r.task.id == id && r.task.kind == BackgroundKind::Workflow)
        {
            return;
        }
        let record = self
            .records
            .iter()
            .find(|r| r.task.id == id && r.task.kind == BackgroundKind::Workflow)
            .cloned()
            .unwrap_or_else(|| Record {
                started: 0,
                task: BackgroundTask {
                    name: id.clone(),
                    id,
                    kind: BackgroundKind::Workflow,
                    description: String::new(),
                    status: BackgroundStatus::Active,
                    result: None,
                    error: None,
                    truncated: false,
                },
            });
        self.tasks.push_back(record);
        if self.tasks.len() > TASKS {
            self.tasks.pop_front();
        }
    }
    /// Tool workflows settle via delayed custom messages, carrying only a result preview.
    /// Unobserved launches remain private; early completions are buffered for launch races.
    fn workflow_terminal(&mut self, d: &Value) {
        let Some(id) = workflow_id(&d["id"]) else {
            return;
        };
        let status = match d["status"].as_str() {
            Some("completed") => BackgroundStatus::Completed,
            Some("error") => BackgroundStatus::Error,
            Some("stopped") => BackgroundStatus::Stopped,
            _ => return,
        };
        if self
            .records
            .iter()
            .any(|r| r.task.id == id && r.task.kind == BackgroundKind::Workflow)
            || self.tasks.iter().any(|r| {
                r.task.id == id
                    && r.task.kind == BackgroundKind::Workflow
                    && !matches!(
                        r.task.status,
                        BackgroundStatus::Active | BackgroundStatus::Unknown
                    )
            })
        {
            return;
        }
        let record = Record {
            started: 0,
            task: BackgroundTask {
                name: id.clone(),
                id: id.clone(),
                kind: BackgroundKind::Workflow,
                description: text(&d["description"], 512).unwrap_or_default(),
                status,
                result: text(&d["resultPreview"], 8192),
                error: text(&d["error"], 1024),
                truncated: d["resultPreview"].as_str().is_some_and(|s| s.len() > 8192)
                    || d["error"].as_str().is_some_and(|s| s.len() > 1024),
            },
        };
        if let Some(task) = self
            .tasks
            .iter_mut()
            .find(|r| r.task.id == id && r.task.kind == BackgroundKind::Workflow)
        {
            *task = record.clone();
        }
        self.records.push_back(record);
        if self.records.len() > PENDING {
            self.records.pop_front();
        }
    }
    /// Process loss leaves active work uncertain; completed results remain readable.
    pub fn interrupt(&mut self) -> bool {
        self.pending.clear();
        let mut changed = false;
        for record in &mut self.tasks {
            if record.task.status == BackgroundStatus::Active {
                record.task.status = BackgroundStatus::Unknown;
                changed = true;
            }
        }
        changed
    }
}
/// Retains opaque provider call IDs for equality-only correlation, up to 512 UTF-8 bytes.
/// Responses providers join IDs with `|`; these IDs are not agent identifiers.
fn correlation_id(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|s| !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control))
        .map(str::to_owned)
}
fn identifier(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        })
        .map(str::to_owned)
}
/// Workflow run IDs have a distinct namespace and are fresh even for resumed runs.
fn workflow_id(v: &Value) -> Option<String> {
    identifier(v).filter(|id| {
        id.strip_prefix("wf_").is_some_and(|suffix| {
            suffix.len() >= 6
                && suffix
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
    })
}
fn millis(v: &Value) -> Option<u64> {
    v.as_u64().filter(|n| *n <= 9_007_199_254_740_991)
}
fn text(v: &Value, max: usize) -> Option<String> {
    v.as_str().map(|s| {
        let mut end = s.len().min(max);
        while !s.is_char_boundary(end) {
            end -= 1;
        }
        s[..end].to_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn launch(id: &str, call: &str) -> Value {
        json!({"type":"tool_execution_end","toolName":"Agent","toolCallId":call,"isError":false,"result":{"content":[{"text":"PRIVATE prompt /path"}],"details":{"status":"background","agentId":id,"displayName":"Scout","description":"Inspect events","outputFile":"/private"}}})
    }
    fn terminal(id: &str, started: u64) -> Value {
        json!({"type":"entry_appended","entry":{"type":"custom","customType":"subagents:record","data":{"id":id,"status":"completed","result":"Done","startedAt":started,"completedAt":started+1}}})
    }
    fn workflow_launch(id: &str) -> Value {
        json!({"type":"tool_execution_end","toolName":"SubagentWorkflow","toolCallId":"call|fc","isError":false,"result":{"details":{"taskId":id},"content":[{"text":"PRIVATE script /path"}]}})
    }
    fn workflow_terminal(id: &str, status: &str) -> Value {
        json!({"type":"message_end","message":{"role":"custom","customType":"subagent-notification","content":"PRIVATE full notification","details":{"id":id,"description":"Workflow Review","status":status,"resultPreview":"Checked changes"}}})
    }
    #[test]
    fn workflow_launch_and_terminal_preview() {
        let mut b = Background::default();
        assert!(b.apply(&workflow_launch("wf_012345abcdef")));
        assert_eq!(b.tasks()[0].kind, BackgroundKind::Workflow);
        assert_eq!(b.tasks()[0].status, BackgroundStatus::Active);
        assert!(b.apply(&workflow_terminal("wf_012345abcdef", "completed")));
        assert_eq!(b.tasks()[0].status, BackgroundStatus::Completed);
        assert_eq!(b.tasks()[0].result.as_deref(), Some("Checked changes"));
        assert!(
            !serde_json::to_string(&b.tasks())
                .unwrap()
                .contains("PRIVATE")
        );
    }
    #[test]
    fn workflow_races_duplicates_statuses_and_new_resume_ids() {
        let mut b = Background::default();
        for (id, status, expected) in [
            ("wf_aaaaaa", "completed", BackgroundStatus::Completed),
            ("wf_bbbbbb", "error", BackgroundStatus::Error),
            ("wf_cccccc", "stopped", BackgroundStatus::Stopped),
        ] {
            let mut terminal = workflow_terminal(id, status);
            terminal["message"]["details"]["error"] = json!("Failure detail");
            assert!(!b.apply(&terminal));
            assert!(b.apply(&workflow_launch(id)));
            assert_eq!(b.tasks().last().unwrap().status, expected);
            assert!(!b.apply(&terminal));
            assert!(!b.apply(&workflow_launch(id)));
        }
        assert!(b.apply(&workflow_launch("wf_dddddd"))); // Resume produces a new ID.
        assert!(b.interrupt());
        assert_eq!(b.tasks().last().unwrap().status, BackgroundStatus::Unknown);
        assert!(b.apply(&workflow_terminal("wf_dddddd", "completed")));
        assert_eq!(
            b.tasks().last().unwrap().status,
            BackgroundStatus::Completed
        );
        assert_eq!(b.tasks().len(), 4);
    }
    #[test]
    fn workflow_validation_bounds_and_agent_isolation() {
        let mut b = Background::default();
        for i in 0..100 {
            let id = format!("wf_{i:06}");
            let mut terminal = workflow_terminal(&id, "error");
            terminal["message"]["details"]["resultPreview"] = json!("😀".repeat(3000));
            terminal["message"]["details"]["error"] = json!("x".repeat(2000));
            b.apply(&workflow_launch(&id));
            b.apply(&terminal);
        }
        assert_eq!(b.tasks.len(), TASKS);
        assert_eq!(b.records.len(), PENDING);
        assert_eq!(b.tasks()[0].result.as_ref().unwrap().len(), 8192);
        assert_eq!(b.tasks()[0].error.as_ref().unwrap().len(), 1024);
        assert!(b.tasks()[0].truncated);
        let before = b.tasks();
        for id in ["agent", "wf_", "wf_ABCDEF", "wf_../private"] {
            assert!(!b.apply(&workflow_launch(id)));
        }
        let mut failed = workflow_launch("wf_failed");
        failed["isError"] = json!(true);
        assert!(!b.apply(&failed));
        let mut missing = workflow_launch("wf_missing");
        missing["result"]["details"] = json!({});
        assert!(!b.apply(&missing));
        assert!(!b.apply(&workflow_terminal("wf_000099", "running")));
        let mut unrelated = workflow_terminal("wf_000099", "completed");
        unrelated["message"]["customType"] = json!("other");
        assert!(!b.apply(&unrelated));
        assert_eq!(b.tasks(), before);
        b.apply(&launch("wf_shared", "agent-call"));
        b.apply(&workflow_launch("wf_shared"));
        b.apply(&terminal("wf_shared", 1));
        assert_eq!(b.tasks().last().unwrap().status, BackgroundStatus::Active);
        b.apply(&workflow_terminal("wf_shared", "error"));
        assert_eq!(b.tasks().last().unwrap().status, BackgroundStatus::Error);
        assert_eq!(b.tasks()[TASKS - 2].status, BackgroundStatus::Completed);
    }
    #[test]
    fn codex_call_ids_correlate_launch_and_resume() {
        let mut b = Background::default();
        assert!(b.apply(&launch("a", "call_first|fc_first")));
        assert_eq!(b.tasks()[0].status, BackgroundStatus::Active);
        b.apply(&terminal("a", 1));
        b.apply(&json!({"type":"tool_execution_start","toolName":"Agent","toolCallId":"call_resume|fc_resume","args":{"resume":"a"}}));
        assert!(b.apply(&launch("a", "call_resume|fc_resume")));
        assert_eq!(b.tasks()[0].status, BackgroundStatus::Active);
        assert!(b.pending.is_empty());
        assert!(!b.apply(&terminal("a", 1)));
        assert!(b.apply(&terminal("a", 2)));
        assert_eq!(b.tasks()[0].status, BackgroundStatus::Completed);
        assert!(!b.apply(&launch("invalid|agent", "call_other|fc_other")));
        for invalid in [String::new(), "x".repeat(513), "call\ninvalid".into()] {
            assert!(!b.apply(&launch("b", &invalid)));
        }
        assert!(b.apply(&launch("b", &"x".repeat(512))));
    }
    #[test]
    fn completion_before_launch_duplicates_and_private_payloads() {
        let mut b = Background::default();
        assert!(!b.apply(&terminal("a", 1))); // Foreground records alone are private.
        assert!(b.apply(&launch("a", "call")));
        assert_eq!(b.tasks()[0].status, BackgroundStatus::Completed);
        assert_eq!(b.tasks()[0].result.as_deref(), Some("Done"));
        assert!(!b.apply(&launch("a", "call")));
        assert!(!b.apply(&terminal("a", 1)));
        assert!(
            !serde_json::to_string(&b.tasks())
                .unwrap()
                .contains("private")
        );
        assert!(
            !serde_json::to_string(&b.tasks())
                .unwrap()
                .contains("PRIVATE")
        );
    }
    #[test]
    fn resume_rejects_old_records_and_notifications_and_accepts_new_terminal() {
        let mut b = Background::default();
        b.apply(&launch("a", "first"));
        b.apply(&terminal("a", 1));
        b.apply(&json!({"type":"tool_execution_start","toolName":"Agent","toolCallId":"resume","args":{"resume":"a"}}));
        let since = b.pending[0].since;
        b.apply(&terminal("a", 1));
        b.apply(&launch("a", "resume"));
        assert_eq!(b.tasks()[0].status, BackgroundStatus::Active);
        b.apply(&terminal("a", 1));
        b.apply(&json!({"type":"message_end","message":{"role":"custom","customType":"subagent-notification","details":{"id":"a","status":"completed"}}}));
        assert_eq!(b.tasks()[0].status, BackgroundStatus::Active);
        b.apply(&terminal("a", since));
        assert_eq!(b.tasks()[0].status, BackgroundStatus::Completed);
    }
    #[test]
    fn fast_resume_terminal_before_reply_and_process_loss() {
        let mut b = Background::default();
        b.apply(&launch("a", "first"));
        b.apply(&json!({"type":"tool_execution_start","toolName":"Agent","toolCallId":"resume","args":{"resume":"a"}}));
        b.apply(&terminal("a", b.pending[0].since));
        b.apply(&launch("a", "resume"));
        assert_eq!(b.tasks()[0].status, BackgroundStatus::Completed);
        b.apply(&launch("b", "second"));
        assert!(b.interrupt());
        assert_eq!(b.tasks()[1].status, BackgroundStatus::Unknown);
        assert_eq!(b.tasks()[0].status, BackgroundStatus::Completed);
        assert!(!b.interrupt());
    }
    #[test]
    fn bounds_and_malformed_inputs() {
        let mut b = Background::default();
        for i in 0..100 {
            let id = format!("a{i}");
            b.apply(&json!({"type":"tool_execution_start","toolName":"Agent","toolCallId":id}));
            b.apply(&launch(&id, "unmatched"));
            let mut end = terminal(&id, 1);
            end["entry"]["data"]["result"] = json!("😀".repeat(4096));
            b.apply(&end);
        }
        assert_eq!(b.tasks.len(), TASKS);
        assert_eq!(b.pending.len(), PENDING);
        assert_eq!(b.records.len(), PENDING);
        assert_eq!(b.tasks()[0].result.as_ref().unwrap().len(), 8192);
        assert!(b.tasks()[0].truncated);
        let before = b.tasks();
        for mut event in [launch("bad", "bad"), launch("bad", "bad")] {
            event["toolName"] = json!("read");
            b.apply(&event);
        }
        let mut invalid = terminal("a99", 2);
        invalid["entry"]["data"]["completedAt"] = json!(-1);
        b.apply(&invalid);
        let mut invalid = launch("bad", "bad");
        invalid["result"]["details"]["status"] = json!("completed");
        b.apply(&invalid);
        assert_eq!(b.tasks(), before);
    }
}
