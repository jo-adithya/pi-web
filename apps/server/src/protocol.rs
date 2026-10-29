//! Browser and private adapter wire types. Rust owns the generated TypeScript.
//! Decoding these shapes does not authorize commands or validate session identity.

use crate::view::{Activity, BlockKind, DisplayBlock, DisplayMessage, ViewPatch};
use serde::{Deserialize, Serialize};
use ts_rs::{Config, TS};

/// Child-process lifecycle, independent of browser connectivity and agent activity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ProcessStatus {
    Starting,
    Ready,
    Stopping,
    Exited,
    Failed,
}

/// Public runtime identity. Neither identifier is a Pi session file path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescriptor {
    /// Stable application session identifier.
    pub session_id: String,
    /// Fresh identifier for each runtime incarnation.
    pub epoch: String,
    pub process: ProcessStatus,
}

/// Pi-owned identity sampled synchronously by the read-only history-head adapter.
/// This is internal backend metadata: never forward the session path to a browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryHead {
    pub session_id: String,
    /// Configured Pi path, not proof that the file exists or the leaf is persisted.
    pub session_file: Option<String>,
    /// Current active-branch leaf; null means Pi has no entries.
    pub leaf_id: Option<String>,
    /// Pi's instantaneous idle state, not a lock against later activity.
    pub idle: bool,
}

/// Fixed, non-sensitive failures returned by the private history-head adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum HistoryHeadError {
    InvalidRequest,
    MetadataLimit,
    MetadataUnavailable,
}

/// Reply inside a `pi-web:history-head:v1:` RPC notification.
/// The backend must match its own request ID, validate limits, and consume this
/// control message separately from user-visible extension notifications.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HistoryHeadReply {
    Ok {
        request_id: String,
        head: HistoryHead,
    },
    Error {
        /// Null only when the incoming correlation token is invalid.
        request_id: Option<String>,
        code: HistoryHeadError,
    },
}

/// Pi thinking levels; availability is advertised per selected model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// Public model identity, excluding credentials, endpoints and pricing configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ModelOption {
    pub id: String,
    pub provider: String,
    pub name: String,
}

/// Confirmed settings and advertised capabilities. Null means unavailable.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettings {
    pub models: Vec<ModelOption>,
    pub model: Option<ModelOption>,
    pub thinking_level: Option<ThinkingLevel>,
    pub thinking_levels: Vec<ThinkingLevel>,
    /// Sanitized extension text describes a request, not confirmed service routing.
    pub codex_fast: Option<String>,
}

/// Pi's current context estimate in tokens; null tokens means temporarily unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ContextUsage {
    #[ts(type = "number | null")]
    pub tokens: Option<u64>,
    #[ts(type = "number")]
    pub context_window: u64,
}

/// Outcome of one actual agent settlement in the current epoch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    Success,
    Error,
    Aborted,
}

/// Only the controlling browser may issue these bounded, session-scoped actions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum BrowserAction {
    SetModel {
        provider: String,
        model_id: String,
    },
    SetThinkingLevel {
        level: ThinkingLevel,
    },
    Attach,
    Prompt {
        text: String,
    },
    Cancel,
    UiReply {
        dialog_id: String,
        answer: DialogAnswer,
    },
    Terminate {
        confirmed: bool,
    },
    Restart {
        confirmed: bool,
    },
}

/// Browser envelope. Shape decoding precedes bounds, version, controller and epoch checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserMessage {
    pub v: u16,
    pub session_id: String,
    pub epoch: String,
    pub request_id: String,
    pub action: BrowserAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum DialogAnswer {
    Cancelled,
    Confirmed { confirmed: bool },
    Value { value: String },
}

/// One outstanding standard extension dialog. Content is always rendered as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Dialog {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub message: String,
    pub options: Vec<String>,
    pub initial: String,
}

/// Independent process/activity/outcome states; a lost browser is not a stopped agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub process: ProcessStatus,
    pub activity: Activity,
    pub last_outcome: Option<String>,
    pub error: Option<String>,
    pub history_warning: Option<String>,
    pub persistence: bool,
    pub cancel_unconfirmed: bool,
    pub notice: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub request_id: String,
    pub ok: bool,
    pub code: String,
    pub disposition: Option<String>,
    pub recovered_draft: Option<String>,
}

/// Origin of a Pi slash command offered for autocomplete.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SlashCommandSource {
    Extension,
    Prompt,
    Skill,
}

/// Bounded browser projection of a Pi command, excluding private origin metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct SlashCommand {
    pub name: String,
    pub description: Option<String>,
    pub source: SlashCommandSource,
}

/// Ordered application messages. Snapshots supersede earlier events through their sequence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ServerBody {
    ContextUsage {
        usage: Option<ContextUsage>,
    },
    Settings {
        settings: AgentSettings,
    },
    RunCompleted {
        run_id: String,
        outcome: RunOutcome,
    },
    Commands {
        commands: Vec<SlashCommand>,
    },
    Hello {
        project: String,
        process: ProcessStatus,
    },
    Snapshot {
        through_seq: u32,
        status: RuntimeStatus,
        messages: Vec<DisplayMessage>,
        dialogs: Vec<Dialog>,
        older_history: bool,
    },
    Event {
        seq: u32,
        patches: Vec<ViewPatch>,
        status: RuntimeStatus,
        dialogs: Vec<Dialog>,
        older_history: bool,
    },
    Result {
        result: CommandResult,
    },
    Error {
        code: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ServerMessage {
    pub v: u16,
    pub session_id: String,
    pub epoch: String,
    pub body: ServerBody,
}

/// Small lifecycle view available without acquiring a conversation controller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSummary {
    pub epoch: String,
    pub process: ProcessStatus,
    pub activity: Activity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum SlotStatus {
    Open,
    Stopping,
    Stopped,
    CleanupFailed,
}

/// Catalog presentation excludes all filesystem and private Pi identities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub workspace_id: String,
    pub session_id: String,
    pub title: String,
    pub lifecycle: SlotStatus,
    pub runtime: Option<RuntimeSummary>,
}
/// Registered project identity; only the deliberately shared project path is exposed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceItem {
    pub workspace_id: String,
    pub name: String,
    pub path: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceAction {
    List,
    Create,
    CreateIn {
        workspace_id: String,
    },
    AddWorkspace {
        path: String,
        confirmed: bool,
    },
    SelectWorkspace {
        workspace_id: String,
    },
    Open {
        session_id: String,
    },
    Stop {
        session_id: String,
        epoch: String,
        confirmed: bool,
    },
    /// Persists a trimmed, nonempty title of at most 64 UTF-8 bytes without control characters.
    Rename {
        session_id: String,
        title: String,
    },
    /// Deletes the saved Pi transcript after cleanup and forgets the catalog entry.
    Delete {
        session_id: String,
        epoch: Option<String>,
        confirmed: bool,
    },
    Subscribe {
        session_id: String,
    },
    Unsubscribe {
        session_id: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceCommand {
    pub v: u16,
    pub request_id: String,
    pub action: WorkspaceAction,
}

/// Workspace v2 envelope; session frames remain independently versioned v1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReply {
    pub v: u16,
    pub request_id: Option<String>,
    pub ok: bool,
    pub code: String,
    /// Immutable selected conversation for successful create/open/add/select operations.
    pub target: Option<String>,
    /// Current workspace selection; periodic snapshots may change this independently.
    pub selected: String,
    pub sessions: Vec<CatalogItem>,
    pub workspaces: Vec<WorkspaceItem>,
    pub selected_workspace: String,
}

/// Generates shared declarations without writing files.
///
/// Keep this explicit list in dependency order when adding wire types.
/// Generated declarations provide static typing; runtime validation is separate.
pub fn typescript_bindings() -> String {
    let config = Config::default();
    let mut output =
        String::from("// Generated by ts-rs. Run `bun run types:generate`; do not edit.\n\n");
    for (docs, declaration) in [
        (ProcessStatus::docs(), ProcessStatus::decl(&config)),
        (SessionDescriptor::docs(), SessionDescriptor::decl(&config)),
        (HistoryHead::docs(), HistoryHead::decl(&config)),
        (HistoryHeadError::docs(), HistoryHeadError::decl(&config)),
        (HistoryHeadReply::docs(), HistoryHeadReply::decl(&config)),
        (Activity::docs(), Activity::decl(&config)),
        (BlockKind::docs(), BlockKind::decl(&config)),
        (DisplayBlock::docs(), DisplayBlock::decl(&config)),
        (DisplayMessage::docs(), DisplayMessage::decl(&config)),
        (ViewPatch::docs(), ViewPatch::decl(&config)),
        (DialogAnswer::docs(), DialogAnswer::decl(&config)),
        (Dialog::docs(), Dialog::decl(&config)),
        (ThinkingLevel::docs(), ThinkingLevel::decl(&config)),
        (ModelOption::docs(), ModelOption::decl(&config)),
        (AgentSettings::docs(), AgentSettings::decl(&config)),
        (ContextUsage::docs(), ContextUsage::decl(&config)),
        (RunOutcome::docs(), RunOutcome::decl(&config)),
        (BrowserAction::docs(), BrowserAction::decl(&config)),
        (BrowserMessage::docs(), BrowserMessage::decl(&config)),
        (RuntimeStatus::docs(), RuntimeStatus::decl(&config)),
        (CommandResult::docs(), CommandResult::decl(&config)),
        (
            SlashCommandSource::docs(),
            SlashCommandSource::decl(&config),
        ),
        (SlashCommand::docs(), SlashCommand::decl(&config)),
        (ServerBody::docs(), ServerBody::decl(&config)),
        (ServerMessage::docs(), ServerMessage::decl(&config)),
        (RuntimeSummary::docs(), RuntimeSummary::decl(&config)),
        (SlotStatus::docs(), SlotStatus::decl(&config)),
        (CatalogItem::docs(), CatalogItem::decl(&config)),
        (WorkspaceItem::docs(), WorkspaceItem::decl(&config)),
        (WorkspaceAction::docs(), WorkspaceAction::decl(&config)),
        (WorkspaceCommand::docs(), WorkspaceCommand::decl(&config)),
        (WorkspaceReply::docs(), WorkspaceReply::decl(&config)),
    ] {
        if let Some(docs) = docs {
            output.push_str(&docs);
            output.push('\n');
        }
        output.push_str("export ");
        output.push_str(&declaration);
        output.push_str("\n\n");
    }
    output
}
