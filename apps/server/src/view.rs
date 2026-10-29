//! Bounded presentation of Pi messages. Provider replay data and arbitrary tool
//! details never become browser state. The transcript remains in Pi storage.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use ts_rs::TS;

pub const MAX_MESSAGES: usize = 500;
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub const MAX_BLOCKS: usize = 64;
pub const MAX_DISPLAY_BYTES: usize = 8 * 1024 * 1024;

/// Text kinds have distinct rendering rules.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Text,
    Thinking,
    Notice,
    Image,
}

/// One safe display block, without provider signatures, binary images or schemas.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DisplayBlock {
    pub kind: BlockKind,
    pub text: String,
}

/// A bounded message preview. `id` belongs to this view, not necessarily Pi storage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DisplayMessage {
    pub id: String,
    pub role: String,
    pub blocks: Vec<DisplayBlock>,
    pub complete: bool,
    pub error: Option<String>,
    pub truncated: bool,
}

/// Agent activity is independent of process readiness and browser connectivity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Activity {
    Idle,
    Submitting,
    Reconciling,
    Running,
    Retrying,
    Compacting,
    AwaitingInput,
    Cancelling,
    Failed,
}

/// Converts visible message content to bounded previews, omitting tool text/metadata,
/// tool calls, and internal subagent completion notifications.
/// Empty completed assistant messages are omitted unless they carry an error; live
/// placeholders remain available for subsequent text/thinking deltas.
/// Unknown custom roles remain visible as `custom` text without forwarding metadata.
pub fn normalize_message(id: String, message: &Value, complete: bool) -> Option<DisplayMessage> {
    let role = message.get("role")?.as_str()?;
    if role == "system"
        || (role == "custom"
            && (message["display"] == false || message["customType"] == "subagent-notification"))
    {
        return None;
    }
    let tool_image = role == "toolResult";
    let role = match role {
        "user" | "assistant" | "branchSummary" | "compactionSummary" | "bashExecution" => role,
        _ => "custom",
    };
    let mut result = DisplayMessage {
        id: clipped(&id, 1024).0,
        role: role.to_owned(),
        blocks: Vec::new(),
        complete,
        error: message["errorMessage"]
            .as_str().filter(|_| !tool_image)
            .map(|text| clipped(text, 4096).0),
        truncated: false,
    };
    let mut remaining = MAX_MESSAGE_BYTES;
    if let Some(text) = message["content"].as_str().filter(|_| !tool_image) {
        push_block(&mut result, &mut remaining, BlockKind::Text, text);
    } else if let Some(blocks) = message["content"].as_array() {
        for block in blocks {
            if tool_image && !matches!(block["type"].as_str(), Some("image_ref" | "image_unavailable")) { continue; }
            let (kind, text) = match block["type"].as_str() {
                Some("text") => (
                    BlockKind::Text,
                    block["text"].as_str().unwrap_or("").to_owned(),
                ),
                Some("thinking") => (
                    BlockKind::Thinking,
                    block["thinking"].as_str().unwrap_or("").to_owned(),
                ),
                Some("image_ref") if block["ref"].as_str().is_some_and(|id| id.len() == 64 && id.bytes().all(|c| c.is_ascii_hexdigit())) => (BlockKind::Image, block["ref"].as_str().unwrap().to_owned()),
                Some("image" | "image_unavailable") => (
                    BlockKind::Notice,
                    "Image unavailable (unsupported format or preview limit)".to_owned(),
                ),
                _ => continue,
            };
            push_block(&mut result, &mut remaining, kind, &text);
        }
    } else if let Some(text) = message["summary"]
        .as_str()
        .or_else(|| message["output"].as_str()).filter(|_| !tool_image)
    {
        push_block(&mut result, &mut remaining, BlockKind::Text, text);
    }
    if (tool_image || complete && role == "assistant") && result.blocks.is_empty() && result.error.is_none() {
        return None;
    }
    Some(result)
}

fn push_block(message: &mut DisplayMessage, remaining: &mut usize, kind: BlockKind, text: &str) {
    if message.blocks.len() >= MAX_BLOCKS || *remaining == 0 {
        message.truncated = true;
        return;
    }
    let (text, truncated) = clipped(text, *remaining);
    *remaining -= text.len();
    message.truncated |= truncated;
    message.blocks.push(DisplayBlock { kind, text });
}

/// Bounded changes published by the runtime; history replacement uses a snapshot
/// marker so the broadcast ring never retains multiple multi-megabyte snapshots.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ViewPatch {
    Message {
        message: DisplayMessage,
    },
    Delta {
        id: String,
        index: u32,
        thinking: bool,
        text: String,
        truncated: bool,
    },
    Remove {
        id: String,
    },
    Activity {
        activity: Activity,
    },
    SnapshotNeeded,
}

/// Pure event reducer. It retains previews, never RPC envelopes or cumulative
/// provider snapshots. Completion changes activity only at `agent_settled`.
pub struct ViewState {
    messages: VecDeque<(DisplayMessage, usize)>,
    // Raw Pi content indices map to compact visible block indices.
    content_indices: [Option<usize>; MAX_BLOCKS],
    current: HashMap<String, String>,
    counter: u64,
    retained: usize,
    pub activity: Activity,
    pub older_history: bool,
}
impl Default for ViewState {
    fn default() -> Self {
        Self {
            messages: VecDeque::new(),
            content_indices: [None; MAX_BLOCKS],
            current: HashMap::new(),
            counter: 0,
            retained: 0,
            activity: Activity::Idle,
            older_history: false,
        }
    }
}
impl ViewState {
    /// Clones the retained view for an attach/rebase snapshot, not for each delta.
    pub fn messages(&self) -> Vec<DisplayMessage> {
        self.messages.iter().map(|(m, _)| m.clone()).collect()
    }
    /// Serialized preview bytes, excluding container allocation overhead.
    pub fn retained_bytes(&self) -> usize {
        self.retained
    }

    /// Installs a caller-validated stable history. Callers must reject stale scans
    /// before this operation; it intentionally replaces the old view atomically.
    pub fn replace_history(&mut self, messages: Vec<DisplayMessage>, older: bool) {
        self.messages.clear();
        self.current.clear();
        self.content_indices.fill(None);
        self.retained = 0;
        self.older_history = older;
        for message in messages {
            self.upsert(message, &mut Vec::new());
        }
    }

    /// Marks unfinished previews interrupted after a confirmed transport/process
    /// failure. Completed content survives and no prompt is replayed.
    pub fn interrupt(&mut self, reason: &str) -> Vec<ViewPatch> {
        let mut patches = Vec::new();
        let error = clipped(reason, 4096).0;
        for (message, bytes) in &mut self.messages {
            if !message.complete {
                self.retained -= *bytes;
                message.complete = true;
                message.error = Some(error.clone());
                *bytes = serde_json::to_vec(message)
                    .expect("display serialization")
                    .len();
                self.retained += *bytes;
                patches.push(ViewPatch::Message {
                    message: message.clone(),
                });
            }
        }
        self.current.clear();
        self.set_activity(Activity::Failed, &mut patches);
        self.trim(&mut patches);
        patches
    }

    /// Applies one documented Pi event. Unknown events have no presentation effect.
    pub fn apply(&mut self, event: &Value) -> Vec<ViewPatch> {
        let mut patches = Vec::new();
        match event["type"].as_str() {
            Some("agent_start") => self.set_activity(Activity::Running, &mut patches),
            Some("auto_retry_start" | "summarization_retry_scheduled") => {
                self.set_activity(Activity::Retrying, &mut patches)
            }
            Some("compaction_start" | "summarization_retry_attempt_start") => {
                self.set_activity(Activity::Compacting, &mut patches)
            }
            Some("agent_settled") => {
                self.current.clear();
                self.set_activity(Activity::Idle, &mut patches);
            }
            Some("message_start" | "message_end") => {
                let complete = event["type"] == "message_end";
                let raw = &event["message"];

                if raw["role"] == "assistant" && !complete {
                    self.content_indices.fill(None);
                    if let Some(blocks) = raw["content"].as_array() {
                        let mut visible = 0;
                        for (index, block) in blocks.iter().take(MAX_BLOCKS).enumerate() {
                            if matches!(block["type"].as_str(), Some("text" | "thinking" | "image" | "image_ref" | "image_unavailable"))
                            {
                                self.content_indices[index] = Some(visible);
                                visible += 1;
                            }
                        }
                    } else if raw["content"].is_string() {
                        self.content_indices[0] = Some(0);
                    }
                }
                if let Some(mut message) = normalize_message(String::new(), raw, complete) {
                    let id = if complete {
                        self.current.remove(&message.role)
                    } else {
                        None
                    };
                    message.id = id.unwrap_or_else(|| {
                        self.counter += 1;
                        format!("live-{}", self.counter)
                    });
                    if !complete {
                        self.current
                            .insert(message.role.clone(), message.id.clone());
                    }
                    self.upsert(message, &mut patches);
                } else if complete
                    && raw["role"] == "assistant"
                    && let Some(id) = self.current.remove("assistant")
                    && let Some(index) = self.messages.iter().position(|(m, _)| m.id == id)
                {
                    let (_, bytes) = self.messages.remove(index).expect("existing message");
                    self.retained -= bytes;
                    patches.push(ViewPatch::Remove { id });
                }
            }
            Some("message_update") => self.update(&event["assistantMessageEvent"], &mut patches),
            _ => {}
        }
        patches
    }

    fn set_activity(&mut self, activity: Activity, patches: &mut Vec<ViewPatch>) {
        if self.activity != activity {
            self.activity = activity.clone();
            patches.push(ViewPatch::Activity { activity });
        }
    }
    fn upsert(&mut self, message: DisplayMessage, patches: &mut Vec<ViewPatch>) {
        let size = serde_json::to_vec(&message)
            .expect("display serialization")
            .len();
        if let Some((old, old_size)) = self.messages.iter_mut().find(|(m, _)| m.id == message.id) {
            self.retained -= *old_size;
            *old = message.clone();
            *old_size = size;
        } else {
            self.messages.push_back((message.clone(), size));
        }
        self.retained += size;
        patches.push(ViewPatch::Message { message });
        self.trim(patches);
    }
    fn trim(&mut self, patches: &mut Vec<ViewPatch>) {
        while self.messages.len() > MAX_MESSAGES || self.retained > MAX_DISPLAY_BYTES {
            let Some((message, bytes)) = self.messages.pop_front() else {
                break;
            };
            self.retained -= bytes;
            self.older_history = true;
            self.current.retain(|_, id| *id != message.id);
            patches.push(ViewPatch::Remove { id: message.id });
        }
    }
    fn update(&mut self, update: &Value, patches: &mut Vec<ViewPatch>) {
        let Some(id) = self.current.get("assistant").cloned() else {
            return;
        };
        let Some(index) = update["contentIndex"]
            .as_u64()
            .filter(|i| *i < MAX_BLOCKS as u64)
            .map(|i| i as usize)
        else {
            return;
        };
        let Some((message, size)) = self.messages.iter_mut().find(|(m, _)| m.id == id) else {
            return;
        };
        let kind = update["type"].as_str().unwrap_or("");
        if !matches!(
            kind,
            "text_start"
                | "thinking_start"
                | "text_delta"
                | "thinking_delta"
                | "text_end"
                | "thinking_end"
        ) {
            return;
        }
        if kind.ends_with("_delta") && !update["delta"].is_string() {
            return;
        }
        let previous_block_count = message.blocks.len();
        let index = match self.content_indices[index] {
            Some(index) if index < message.blocks.len() => index,
            Some(_) => return,
            None if message.blocks.len() < MAX_BLOCKS => {
                let visible = message.blocks.len();
                self.content_indices[index] = Some(visible);
                message.blocks.push(DisplayBlock {
                    kind: BlockKind::Text,
                    text: String::new(),
                });
                visible
            }
            None => return,
        };
        let thinking = kind.starts_with("thinking");
        if kind.ends_with("_delta") {
            let Some(delta) = update["delta"].as_str() else {
                return;
            };
            let used: usize = message.blocks.iter().map(|b| b.text.len()).sum();
            let (text, truncated) = clipped(delta, MAX_MESSAGE_BYTES.saturating_sub(used));
            let next_kind = if thinking {
                BlockKind::Thinking
            } else {
                BlockKind::Text
            };
            let shape_changed = previous_block_count != message.blocks.len()
                || message.blocks[index].kind != next_kind
                || (truncated && !message.truncated);
            message.blocks[index].kind = next_kind;
            message.truncated |= truncated;
            if shape_changed {
                let new_size = serde_json::to_vec(message)
                    .expect("display serialization")
                    .len();
                self.retained = self.retained - *size + new_size;
                *size = new_size;
            }
            if text.is_empty() && !shape_changed {
                return;
            }
            message.blocks[index].text.push_str(&text);
            // Normal delta work is proportional to new bytes, not cumulative text.
            let growth = serde_json::to_string(&text)
                .expect("string serialization")
                .len()
                - 2;
            *size += growth;
            self.retained += growth;
            patches.push(ViewPatch::Delta {
                id,
                index: index as u32,
                thinking,
                text,
                truncated: message.truncated,
            });
        } else {
            let old_size = *size;
            let used: usize = message
                .blocks
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != index)
                .map(|(_, b)| b.text.len())
                .sum();
            let block = &mut message.blocks[index];
            block.kind = if thinking {
                BlockKind::Thinking
            } else {
                BlockKind::Text
            };
            if kind.ends_with("_end") {
                let (text, cut) = clipped(
                    update["content"].as_str().unwrap_or(""),
                    MAX_MESSAGE_BYTES.saturating_sub(used),
                );
                block.text = text;
                message.truncated |= cut;
            }
            *size = serde_json::to_vec(message)
                .expect("display serialization")
                .len();
            self.retained = self.retained - old_size + *size;
            patches.push(ViewPatch::Message {
                message: message.clone(),
            });
        }
        self.trim(patches);
    }
}

/// Returns a valid UTF-8 prefix and whether bytes were omitted, never splitting a scalar.
pub fn clipped(text: &str, limit: usize) -> (String, bool) {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), end < text.len())
}
