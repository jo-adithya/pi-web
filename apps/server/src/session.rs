//! One backend-owned session task. Browser attachment never owns the child lifetime.
//! Mutation, request deduplication and snapshot admission occur in this task; pipe
//! drains, blocking history scans and browser writes run independently.
mod admission;
mod commands;
mod history;
mod settings;

use crate::{
    config::{self, Config, Startup},
    metadata::{MetadataStore, SessionMetadata},
    protocol::*,
    rpc::{self, Cancelled, RpcCommand, UiAnswer},
    view::{Activity, ViewPatch, ViewState},
};
use admission::{Admission, Requests};
use serde_json::Value;
use std::{
    collections::VecDeque,
    ffi::OsString,
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
    task::JoinSet,
    time::{Instant, MissedTickBehavior},
};

const RPC_DEADLINE: Duration = Duration::from_secs(15);
const HEAD_PREFIX: &str = "pi-web:history-head:v1:";
const OUTBOUND_BYTES: usize = 16 * 1024 * 1024;

/// Serialized browser frame holding its byte permit until the writer finishes.
/// Dropping a disconnected receiver releases all queued permits.
pub struct Frame {
    pub text: String,
    _permit: OwnedSemaphorePermit,
}
pub struct Connection {
    pub frames: mpsc::Receiver<Frame>,
}
#[derive(Clone)]
pub struct SessionHandle {
    tx: mpsc::Sender<Control>,
    stop: watch::Sender<bool>,
    stopped: watch::Receiver<Option<bool>>,
    id: String,
    summary: watch::Receiver<RuntimeSummary>,
}
impl SessionHandle {
    /// Stable catalog identity and bounded lifecycle state, without taking controller ownership.
    pub(crate) fn same_runtime(&self, other: &Self) -> bool {
        self.tx.same_channel(&other.tx)
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn summary(&self) -> RuntimeSummary {
        self.summary.borrow().clone()
    }
    /// Atomically checks the expected epoch before stopping; returns cleanup success.
    pub async fn stop(&self, epoch: String) -> Result<bool, &'static str> {
        let (send, receive) = oneshot::channel();
        self.tx
            .try_send(Control::Stop(epoch, send))
            .map_err(|_| "overloaded")?;
        match receive.await.map_err(|_| "session_closed")? {
            Ok(_) => Ok(self.shutdown().await),
            Err(code) => Err(code),
        }
    }
    /// Acquires the sole controller and atomically queues hello plus a snapshot.
    pub async fn connect(&self, id: String) -> Result<Connection, &'static str> {
        let (send, receive) = oneshot::channel();
        self.tx
            .try_send(Control::Connect(id, send))
            .map_err(|_| "overloaded")?;
        receive.await.map_err(|_| "session_closed")?
    }
    /// Nonblocking command admission. Full control queues require reconnect/resnapshot.
    pub fn dispatch(&self, id: String, message: BrowserMessage) -> Result<(), &'static str> {
        self.tx
            .try_send(Control::Message(id, message))
            .map_err(|_| "overloaded")
    }
    /// Reliable bounded disconnect notification; callers should await it on socket exit.
    pub async fn disconnect(&self, id: String) {
        let _ = self.tx.send(Control::Disconnect(id)).await;
    }
    /// Stops admission, cancels dialogs, attempts clear/abort and awaits supervised cleanup.
    pub async fn shutdown(&self) -> bool {
        let _ = self.stop.send(true);
        let mut stopped = self.stopped.clone();
        loop {
            if let Some(clean) = *stopped.borrow() {
                return clean;
            }
            if stopped.changed().await.is_err() {
                return false;
            }
        }
    }
}
enum Control {
    Connect(String, oneshot::Sender<Result<Connection, &'static str>>),
    Message(String, BrowserMessage),
    Disconnect(String),
    Stop(String, oneshot::Sender<Result<bool, &'static str>>),
    #[cfg(test)]
    Pause(oneshot::Sender<()>, oneshot::Receiver<()>, usize),
}
struct Client {
    id: String,
    sender: mpsc::Sender<Frame>,
    budget: Arc<Semaphore>,
}
struct PendingDialog {
    dialog: Dialog,
    deadline: Option<Instant>,
}
enum StateReason {
    Startup,
    Settled,
    Handled(String),
    Settings,
}
enum HeadPurpose {
    Before,
    After(history::Scan),
}
struct HeadWait {
    token: String,
    purpose: HeadPurpose,
    reply: Option<HistoryHead>,
    ack: bool,
    deadline: Instant,
}
/// Stdin completion for the latest accepted prompt, independently of its RPC reply.
struct PromptWrite {
    request_id: String,
    written: oneshot::Receiver<Result<(), rpc::Error>>,
}
struct CancelWait {
    id: String,
    settled_before: u64,
    draft: Option<String>,
    deadline: Instant,
}
enum Done {
    Context(String, Result<Value, rpc::Error>),
    Setting(String, Result<Value, rpc::Error>),
    Capabilities(Result<Value, rpc::Error>, Result<Value, rpc::Error>),
    State(StateReason, Result<(Value, u64), rpc::Error>),
    Commands(Result<Value, rpc::Error>),
    HeadAck(String, Result<Value, rpc::Error>),
    History(Result<history::Scan, String>),
    Prompt(String, u64, Result<Value, rpc::Error>),
    Cancel(String, u64, Result<Option<String>, rpc::Error>),
    Ui(String, Result<(), rpc::Error>),
    Terminated(rpc::Exit),
}
struct Runtime {
    config: Config,
    store: Arc<MetadataStore>,
    ownership: crate::ownership::Ownership,
    summary: watch::Sender<RuntimeSummary>,
    stop_reply: Option<oneshot::Sender<Result<bool, &'static str>>>,
    metadata: SessionMetadata,
    epoch: String,
    process: Option<rpc::Handle>,
    events: Option<rpc::Events>,
    cleanup_complete: bool,
    exit_observed: bool,
    view: ViewState,
    commands: Vec<SlashCommand>,
    settings: AgentSettings,
    context_usage: Option<ContextUsage>,
    context_pending: bool,
    context_refresh: bool,
    setting_pending: Option<(String, Option<bool>)>,
    capabilities_pending: bool,
    settings_refresh: bool,
    status: RuntimeStatus,
    client: Option<Client>,
    requests: Requests,
    jobs: JoinSet<Done>,
    dialogs: VecDeque<PendingDialog>,
    head: Option<HeadWait>,
    revision: u64,
    settled: u64,
    seq: u32,
    patches: Vec<ViewPatch>,
    patch_bytes: usize,
    dirty: bool,
    state_requests: usize,
    cancelling: bool,
    cancel_wait: Option<CancelWait>,
    prompt_write: Option<PromptWrite>,
    termination_request: Option<String>,
}

/// Starts one session for an operator-selected canonical project. Metadata ownership
/// is exclusive; startup errors never fall back to an unrelated most-recent session.
pub fn start(config: Config) -> io::Result<SessionHandle> {
    let store = MetadataStore::open(&config.state_dir)?;
    let saved = store.load()?;
    if saved.as_ref().is_some_and(|m| m.cwd != config.cwd) {
        return Err(io::Error::other("metadata belongs to a different project"));
    }
    let mut metadata = match (&config.startup, saved) {
        (Startup::Remembered, Some(saved)) => saved,
        _ => SessionMetadata {
            version: 1,
            app_id: config::identity()?,
            cwd: config.cwd.clone(),
            pi_session_id: None,
            pi_session_path: None,
            persisted: false,
        },
    };
    if let Startup::Session(path) = &config.startup {
        metadata.pi_session_path = Some(crate::metadata::validate_session(
            path,
            &config.session_roots,
            &config.cwd,
        )?);
        // Identity is established by Pi after migration, before metadata persistence.
    }
    start_owned(
        config,
        Arc::new(store),
        metadata,
        crate::ownership::Ownership::default(),
    )
}

/// Starts a manager-prepared record. The shared store retains catalog/legacy locking.
pub(crate) fn start_owned(
    config: Config,
    store: Arc<MetadataStore>,
    mut metadata: SessionMetadata,
    ownership: crate::ownership::Ownership,
) -> io::Result<SessionHandle> {
    if metadata.cwd != config.cwd {
        return Err(io::Error::other("metadata belongs to a different project"));
    }
    if let Some(path) = &metadata.pi_session_path {
        if path.exists() {
            crate::metadata::validate_session(path, &config.session_roots, &config.cwd)?;
        } else if metadata.persisted {
            return Err(io::Error::other(
                "remembered session is missing; select --new or an existing --session explicitly",
            ));
        } else if metadata.pi_session_id.is_some() {
            metadata.pi_session_path = None;
            metadata.pi_session_id = None;
        }
    }
    let status = RuntimeStatus {
        process: ProcessStatus::Starting,
        activity: Activity::Idle,
        last_outcome: None,
        error: None,
        history_warning: Some("Loading recent history…".into()),
        persistence: false,
        cancel_unconfirmed: false,
        notice: None,
    };
    let epoch = config::identity()?;
    ownership.claim(&metadata.app_id, metadata.pi_session_path.as_deref())?;
    let id = metadata.app_id.clone();
    let (summary_tx, summary) = watch::channel(RuntimeSummary {
        epoch: epoch.clone(),
        process: ProcessStatus::Starting,
        activity: Activity::Idle,
    });
    let runtime = Runtime {
        config,
        store,
        ownership,
        summary: summary_tx,
        stop_reply: None,
        metadata,
        epoch,
        process: None,
        events: None,
        cleanup_complete: true,
        exit_observed: true,
        view: ViewState::default(),
        commands: Vec::new(),
        settings: AgentSettings::default(),
        context_usage: None,
        context_pending: false,
        context_refresh: false,
        setting_pending: None,
        capabilities_pending: false,
        settings_refresh: false,
        status,
        client: None,
        requests: Requests::default(),
        jobs: JoinSet::new(),
        dialogs: VecDeque::new(),
        head: None,
        revision: 0,
        settled: 0,
        seq: 0,
        patches: Vec::new(),
        patch_bytes: 0,
        dirty: true,
        state_requests: 0,
        cancelling: false,
        cancel_wait: None,
        prompt_write: None,
        termination_request: None,
    };
    let (tx, rx) = mpsc::channel(32);
    let (stop, stopping) = watch::channel(false);
    let (stopped_tx, stopped) = watch::channel(None);
    tokio::spawn(async move {
        let clean = runtime.run(rx, stopping).await;
        let _ = stopped_tx.send(Some(clean));
    });
    Ok(SessionHandle {
        tx,
        stop,
        stopped,
        id,
        summary,
    })
}
impl Runtime {
    async fn run(
        mut self,
        mut controls: mpsc::Receiver<Control>,
        mut stopping: watch::Receiver<bool>,
    ) -> bool {
        self.launch();
        let mut tick = tokio::time::interval(Duration::from_millis(32));
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            let process = self.process.clone();
            tokio::select! {
                biased;
                _ = stopping.changed() => break,
                control = controls.recv() => match control {
                    #[cfg(test)]
                    Some(Control::Pause(entered, resume, queued)) => {
                        let _ = entered.send(()); let _ = resume.await;
                        tokio::time::timeout(Duration::from_secs(3), async {
                            while self.events.as_ref().map_or(0, rpc::Events::pending) < queued {
                                tokio::task::yield_now().await;
                            }
                        }).await.expect("fixture events did not reach the paused runtime");
                    },
                    Some(control) => self.control(control), None => break
                },
                done = self.jobs.join_next(), if !self.jobs.is_empty() => match done { Some(Ok(done)) => self.done(done), Some(Err(error)) if !error.is_cancelled() => self.fail("An internal session task failed"), _ => {} },
                event = async { self.events.as_mut().unwrap().recv().await }, if self.events.is_some() && self.state_requests == 0 => match event { Some(event) => self.event(event), None => { self.events = None; } },
                exit = async { process.as_ref().unwrap().wait_exit().await }, if process.is_some() && !self.exit_observed => self.exited(exit),
                _ = tick.tick() => { self.expire(); self.flush(); },
            }
            self.finish_cancel();
            self.summary.send_replace(RuntimeSummary {
                epoch: self.epoch.clone(),
                process: self.status.process.clone(),
                activity: self.activity(),
            });
            if self.stop_reply.is_some() {
                break;
            }
        }
        self.client = None;
        let dialog_ids: Vec<_> = self
            .dialogs
            .drain(..)
            .map(|dialog| dialog.dialog.id)
            .collect();
        self.jobs.abort_all();
        while self.jobs.join_next().await.is_some() {}
        if let Some(process) = &self.process {
            for id in dialog_ids {
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    process.extension_ui_response(
                        &id,
                        UiAnswer::Cancelled {
                            cancelled: Cancelled,
                        },
                    ),
                )
                .await;
            }
            let _ = process
                .request(RpcCommand::ClearQueue, Duration::from_secs(2))
                .await;
            let _ = process
                .request(RpcCommand::Abort, Duration::from_secs(10))
                .await;
            let exit = process.shutdown().await;
            self.cleanup_complete = exit.reaped && exit.cleanup_error.is_none();
            if !self.cleanup_complete {
                eprintln!(
                    "pi-web: child cleanup did not complete: {:?}",
                    exit.cleanup_error
                );
            }
        }
        if self.cleanup_complete {
            self.ownership.release(&self.metadata.app_id);
        }
        if let Some(reply) = self.stop_reply.take() {
            let _ = reply.send(Ok(self.cleanup_complete));
        }
        self.cleanup_complete
    }
    fn launch(&mut self) {
        match launch_spec(&self.config, self.metadata.pi_session_path.as_deref()).and_then(|spec| {
            rpc::Transport::spawn(spec, rpc::Limits::default()).map_err(io::Error::other)
        }) {
            Ok((process, events)) => {
                self.process = Some(process);
                self.events = Some(events);
                self.cleanup_complete = false;
                self.exit_observed = false;
                self.request_state(StateReason::Startup);
            }
            Err(_) => {
                self.status.process = ProcessStatus::Failed;
                self.status.error = Some(
                    "Pi could not be started; check the configured executable and session path"
                        .into(),
                );
                self.dirty = true;
            }
        }
    }
    fn control(&mut self, control: Control) {
        match control {
            #[cfg(test)]
            Control::Pause(..) => unreachable!("test pause is handled by the runtime loop"),
            Control::Stop(epoch, reply) => {
                if epoch != self.epoch {
                    let _ = reply.send(Err("stale_epoch"));
                } else if self.stop_reply.is_some() {
                    let _ = reply.send(Err("already_stopping"));
                } else {
                    self.status.process = ProcessStatus::Stopping;
                    self.stop_reply = Some(reply);
                }
            }
            Control::Connect(id, reply) => {
                if self.client.is_some() {
                    let _ = reply.send(Err("already_attached"));
                    return;
                }
                self.flush();
                let (sender, frames) = mpsc::channel(32);
                self.client = Some(Client {
                    id,
                    sender,
                    budget: Arc::new(Semaphore::new(OUTBOUND_BYTES)),
                });
                self.send(ServerBody::Hello {
                    project: self
                        .config
                        .cwd
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into(),
                    process: self.status.process.clone(),
                });
                self.snapshot();
                if reply.send(Ok(Connection { frames })).is_err() {
                    self.detach();
                }
            }
            Control::Disconnect(id) => {
                if self.client.as_ref().is_some_and(|c| c.id == id) {
                    self.detach();
                }
            }
            Control::Message(id, message) => self.command(&id, message),
        }
    }
    fn command(&mut self, client_id: &str, message: BrowserMessage) {
        if !self.client.as_ref().is_some_and(|c| c.id == client_id) {
            return;
        }
        let error = if message.session_id != self.metadata.app_id {
            Some("unknown_session")
        } else if message.epoch != self.epoch {
            Some("stale_epoch")
        } else {
            None
        };
        if let Some(error) = error {
            self.reject(&message.request_id, error);
            return;
        }
        match self.requests.begin(&message) {
            Err(code) => {
                self.reject(&message.request_id, code);
                return;
            }
            Ok(Admission::Duplicate(saved)) => {
                self.send(ServerBody::Result {
                    result: saved.unwrap_or_else(|| {
                        result(&message.request_id, true, "pending", None, None)
                    }),
                });
                return;
            }
            Ok(Admission::Fresh) => {}
        }
        let id = message.request_id;
        match message.action {
            BrowserAction::SetModel { provider, model_id } => {
                if !self.settings_idle() {
                    self.result(&id, false, "busy", None, None);
                    return;
                }
                if !self
                    .settings
                    .models
                    .iter()
                    .any(|m| m.provider == provider && m.id == model_id)
                {
                    self.result(&id, false, "invalid_model", None, None);
                    return;
                }
                self.set_setting(id, RpcCommand::SetModel { provider, model_id });
            }
            BrowserAction::SetThinkingLevel { level } => {
                if !self.settings_idle() {
                    self.result(&id, false, "busy", None, None);
                    return;
                }
                if !self.settings.thinking_levels.contains(&level) {
                    self.result(&id, false, "invalid_thinking_level", None, None);
                    return;
                }
                self.set_setting(id, RpcCommand::SetThinkingLevel { level });
            }
            BrowserAction::Attach => {
                self.flush();
                self.snapshot();
                self.result(&id, true, "attached", None, None);
            }
            BrowserAction::Prompt { text } => {
                // Hold the bounded transport queue until identity reconciliation cuts
                // over at its exact stdout boundary. Never consume a future epoch
                // into the current view while the state response is still pending.
                if self.state_requests != 0 || self.setting_pending.is_some() {
                    self.result(&id, false, "busy", None, None);
                    return;
                }
                // Control priority must not hide activity already queued by Pi.
                let queued = self.events.as_ref().map_or(0, rpc::Events::pending);
                for _ in 0..queued {
                    if let Some(event) = self.events.as_mut().and_then(rpc::Events::try_recv) {
                        self.event(event);
                    }
                }
                if self.status.process != ProcessStatus::Ready
                    || self.state_requests != 0
                    || self.setting_pending.is_some()
                    || self.cancelling
                    || self.view.activity != Activity::Idle
                {
                    self.result(&id, false, "busy", None, None);
                    return;
                }
                self.view.activity = Activity::Submitting;
                self.status.error = None;
                self.status.last_outcome = None;
                self.dirty = true;
                let process = self.process.as_ref().unwrap().clone();
                let settled = self.settled;
                let (written, notice) = oneshot::channel();
                self.prompt_write = Some(PromptWrite {
                    request_id: id.clone(),
                    written: notice,
                });
                self.jobs.spawn(async move {
                    Done::Prompt(
                        id,
                        settled,
                        process
                            .request_with_write_notice(
                                RpcCommand::Prompt { message: text },
                                RPC_DEADLINE,
                                written,
                            )
                            .await,
                    )
                });
            }
            BrowserAction::Cancel => {
                if self.status.process != ProcessStatus::Ready
                    || self.cancelling
                    || matches!(self.view.activity, Activity::Idle | Activity::Cancelling)
                {
                    self.result(&id, false, "not_running", None, None);
                    return;
                }
                self.cancelling = true;
                self.view.activity = Activity::Cancelling;
                self.status.cancel_unconfirmed = false;
                self.dirty = true;
                self.cancel_dialogs();
                let settled_before = self.settled;
                let process = self.process.as_ref().unwrap().clone();
                let prompt_write = self.prompt_write.take();
                self.jobs.spawn(async move {
                    let answer = async {
                        // Control priority must not let Stop overtake a prompt whose
                        // actor admission preceded it. Waiting for stdin (not its RPC
                        // reply) also permits cancellation of a blocked extension.
                        if let Some(prompt) = prompt_write {
                            tokio::time::timeout(RPC_DEADLINE, prompt.written)
                                .await
                                .map_err(|_| rpc::Error::Timeout)?
                                .map_err(|_| rpc::Error::Closed)??;
                        }
                        let queued = process
                            .request(RpcCommand::ClearQueue, Duration::from_secs(5))
                            .await?;
                        let draft = recover_draft(&queued);
                        process
                            .request(RpcCommand::Abort, Duration::from_secs(10))
                            .await?;
                        Ok(draft)
                    }
                    .await;
                    Done::Cancel(id, settled_before, answer)
                });
            }
            BrowserAction::UiReply { dialog_id, answer } => self.reply(id, dialog_id, answer),
            BrowserAction::Terminate { confirmed } => {
                if !confirmed
                    || !self.status.cancel_unconfirmed
                    || self.cleanup_complete
                    || self.termination_request.is_some()
                    || self.status.process == ProcessStatus::Stopping
                {
                    self.result(&id, false, "termination_not_permitted", None, None);
                    return;
                }
                self.termination_request = Some(id.clone());
                self.status.process = ProcessStatus::Stopping;
                self.dirty = true;
                let process = self.process.as_ref().unwrap().clone();
                self.jobs
                    .spawn(async move { Done::Terminated(process.shutdown().await) });
            }
            BrowserAction::Restart { confirmed } => {
                if !confirmed
                    || !self.cleanup_complete
                    || !matches!(
                        self.status.process,
                        ProcessStatus::Failed | ProcessStatus::Exited
                    )
                {
                    self.result(&id, false, "restart_not_permitted", None, None);
                    return;
                }
                self.result(&id, true, "restarting", None, None);
                match config::identity() {
                    Ok(epoch) => self.epoch = epoch,
                    Err(_) => {
                        self.fail("Could not generate a runtime identity");
                        return;
                    }
                }
                invalidate_jobs(&mut self.jobs);
                self.head = None;
                self.requests = Requests::default();
                self.view = ViewState::default();
                self.commands.clear();
                self.reset_settings();
                self.seq = 0;
                self.revision = 0;
                self.settled = 0;
                self.patches.clear();
                self.patch_bytes = 0;
                self.state_requests = 0;
                self.cancelling = false;
                self.cancel_wait = None;
                self.prompt_write = None;
                self.dialogs.clear();
                if !self.metadata.persisted
                    && self
                        .metadata
                        .pi_session_path
                        .as_ref()
                        .is_none_or(|path| !path.exists())
                {
                    self.metadata.pi_session_id = None;
                    self.metadata.pi_session_path = None;
                }
                self.status.process = ProcessStatus::Starting;
                self.status.cancel_unconfirmed = false;
                self.status.error = None;
                self.status.last_outcome = None;
                self.status.history_warning =
                    Some("Reloading persisted history; unpersisted output may be lost".into());
                self.dirty = true;
                self.send(ServerBody::Hello {
                    project: self
                        .config
                        .cwd
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into(),
                    process: ProcessStatus::Starting,
                });
                self.snapshot();
                self.launch();
            }
        }
    }
    /// Drains already-observed activity before admitting an idle-only settings mutation.
    fn settings_idle(&mut self) -> bool {
        if self.state_requests != 0 || self.setting_pending.is_some() || self.capabilities_pending {
            return false;
        }
        let queued = self.events.as_ref().map_or(0, rpc::Events::pending);
        for _ in 0..queued {
            if let Some(event) = self.events.as_mut().and_then(rpc::Events::try_recv) {
                self.event(event);
            }
        }
        self.status.process == ProcessStatus::Ready
            && self.state_requests == 0
            && !self.capabilities_pending
            && self.setting_pending.is_none()
            && !self.cancelling
            && self.activity() == Activity::Idle
    }
    /// Keeps admission closed until the setter and authoritative state refresh complete.
    fn set_setting(&mut self, id: String, command: RpcCommand) {
        self.setting_pending = Some((id.clone(), None));
        self.dirty = true;
        let process = self.process.as_ref().unwrap().clone();
        self.jobs
            .spawn(async move { Done::Setting(id, process.request(command, RPC_DEADLINE).await) });
    }
    /// Serializes optional capability discovery, coalescing intervening refresh requests.
    fn request_capabilities(&mut self) {
        if self.capabilities_pending {
            self.settings_refresh = true;
            return;
        }
        self.capabilities_pending = true;
        let process = self.process.as_ref().unwrap().clone();
        self.jobs.spawn(async move {
            let models = process
                .request(RpcCommand::GetAvailableModels, RPC_DEADLINE)
                .await;
            let levels = process
                .request(RpcCommand::GetAvailableThinkingLevels, RPC_DEADLINE)
                .await;
            Done::Capabilities(models, levels)
        });
    }
    /// Coalesces read-only context samples; a later lifecycle change supersedes an in-flight sample.
    fn request_context(&mut self) {
        let Some(process) = self.process.as_ref().filter(|_| !self.exit_observed) else {
            return;
        };
        if self.context_pending {
            self.context_refresh = true;
            return;
        }
        self.context_pending = true;
        let process = process.clone();
        let epoch = self.epoch.clone();
        self.jobs.spawn(async move {
            Done::Context(
                epoch,
                process
                    .request(RpcCommand::GetSessionStats, RPC_DEADLINE)
                    .await,
            )
        });
    }
    fn send_context(&mut self) {
        self.send(ServerBody::ContextUsage {
            usage: self.context_usage.clone(),
        });
    }
    fn send_settings(&mut self) {
        self.send(ServerBody::Settings {
            settings: self.settings.clone(),
        });
    }
    /// Discards per-epoch settings before replaying a new runtime identity.
    fn reset_settings(&mut self) {
        self.settings = AgentSettings::default();
        self.context_usage = None;
        self.context_pending = false;
        self.context_refresh = false;
        self.setting_pending = None;
        self.capabilities_pending = false;
        self.settings_refresh = false;
    }
    fn request_state(&mut self, reason: StateReason) {
        if self.state_requests != 0 && matches!(reason, StateReason::Settled) {
            return;
        }
        self.state_requests += 1;
        let process = self.process.as_ref().unwrap().clone();
        self.jobs.spawn(async move {
            Done::State(
                reason,
                process
                    .request_ordered(RpcCommand::GetState, RPC_DEADLINE)
                    .await,
            )
        });
    }
    fn done(&mut self, done: Done) {
        if self.exit_observed && !matches!(done, Done::Terminated(..)) {
            return;
        }
        match done {
            Done::Context(epoch, response) => {
                if epoch != self.epoch {
                    return;
                }
                self.context_pending = false;
                if self.context_refresh {
                    self.context_refresh = false;
                    self.request_context();
                } else {
                    self.context_usage = response
                        .ok()
                        .and_then(|data| settings::context_usage(&data["contextUsage"]));
                    self.send_context();
                }
            }
            Done::Setting(id, response) => {
                self.setting_pending = Some((id, Some(response.is_ok())));
                self.request_state(StateReason::Settings);
            }
            Done::Capabilities(models, levels) => {
                self.capabilities_pending = false;
                self.settings.models = models.as_ref().map(settings::models).unwrap_or_default();
                self.settings.thinking_levels =
                    levels.as_ref().map(settings::levels).unwrap_or_default();
                self.send_settings();
                if self.settings_refresh {
                    self.settings_refresh = false;
                    self.request_state(StateReason::Settings);
                } else if self.state_requests == 0
                    && self
                        .setting_pending
                        .as_ref()
                        .is_some_and(|(_, ok)| ok.is_some())
                {
                    let (id, ok) = self.setting_pending.take().unwrap();
                    let ok = ok.unwrap();
                    self.result(
                        &id,
                        ok,
                        if ok {
                            "settings_updated"
                        } else {
                            "settings_update_failed"
                        },
                        None,
                        None,
                    );
                }
                self.dirty = true;
            }
            Done::State(reason, response) => {
                self.state_requests -= 1;
                let allow_replacement = !matches!(reason, StateReason::Startup) && !self.cancelling;
                match response.and_then(|(state, sequence)| {
                    self.persist_identity(&state, allow_replacement)
                        .map(|replaced| (state, replaced, sequence))
                }) {
                    Ok((state, true, sequence)) => {
                        if let StateReason::Handled(id) = reason {
                            self.result(&id, true, "accepted", Some("handled".into()), None);
                        }
                        self.replace_session(sequence, &state);
                    }
                    Ok((state, false, _)) => {
                        self.settings.model = settings::model(&state["model"]);
                        self.settings.thinking_level =
                            serde_json::from_value(state["thinkingLevel"].clone()).ok();
                        self.send_settings();
                        self.request_capabilities();
                        self.request_context();
                        match reason {
                            StateReason::Startup => {
                                if state["isStreaming"] == true || state["isCompacting"] == true {
                                    self.view.activity = Activity::Running;
                                }
                                let process = self.process.as_ref().unwrap().clone();
                                self.jobs.spawn(async move {
                                    Done::Commands(
                                        process
                                            .request(RpcCommand::GetCommands, RPC_DEADLINE)
                                            .await,
                                    )
                                });
                            }
                            StateReason::Handled(id) => {
                                if self.view.activity == Activity::Submitting
                                    && state["isStreaming"] == false
                                    && state["isCompacting"] == false
                                {
                                    self.view.activity = Activity::Idle;
                                }
                                self.result(&id, true, "accepted", Some("handled".into()), None);
                            }
                            StateReason::Settled | StateReason::Settings => {}
                        }
                    }
                    Err(_) => {
                        self.fail("Pi state/identity could not be verified; restart explicitly")
                    }
                }
                self.dirty = true;
            }
            Done::Commands(response) => {
                let valid = response.as_ref().is_ok_and(|data| {
                    data["commands"].as_array().is_some_and(|commands| {
                        commands
                            .iter()
                            .filter(|c| {
                                c["name"] == "pi-web-history-head"
                                    && c["source"] == "extension"
                                    && c["sourceInfo"]["path"].as_str().is_some_and(|p| {
                                        Path::new(p).canonicalize().ok()
                                            == self.config.head_adapter.canonicalize().ok()
                                    })
                            })
                            .count()
                            == 1
                    })
                });
                if !valid {
                    self.fail("Required history-head extension was not registered from the configured path");
                    return;
                }
                self.commands = commands::project(&response.unwrap());
                self.send(ServerBody::Commands {
                    commands: self.commands.clone(),
                });
                self.status.process = ProcessStatus::Ready;
                self.dirty = true;
                self.request_head(HeadPurpose::Before);
            }
            Done::HeadAck(token, response) => {
                if let Some(wait) = &mut self.head
                    && wait.token == token
                {
                    if response
                        .as_ref()
                        .is_ok_and(|v| v["disposition"] == "handled")
                    {
                        wait.ack = true;
                    } else {
                        self.history_error("History checkpoint command was not handled");
                    }
                }
                self.finish_head();
            }
            Done::History(result) => match result {
                Ok(scan) => self.request_head(HeadPurpose::After(scan)),
                Err(error) => self.history_error(&error),
            },
            Done::Prompt(id, before, response) => {
                if self
                    .prompt_write
                    .as_ref()
                    .is_some_and(|pending| pending.request_id == id)
                {
                    self.prompt_write = None;
                }
                match response {
                    Ok(data) => match data["disposition"].as_str() {
                        Some("handled") => self.request_state(StateReason::Handled(id)),
                        Some(disposition @ ("started" | "queued")) => {
                            if self.settled == before && self.view.activity == Activity::Submitting
                            {
                                self.view.activity = Activity::Running;
                            }
                            self.result(&id, true, "accepted", Some(disposition.into()), None);
                            self.dirty = true;
                        }
                        _ => {
                            self.result(&id, false, "invalid_prompt_response", None, None);
                            self.fail("Pi returned an invalid prompt disposition");
                        }
                    },
                    Err(rpc::Error::Command { .. }) => {
                        if self.view.activity == Activity::Submitting {
                            self.view.activity = Activity::Idle;
                        }
                        self.result(&id, false, "prompt_rejected", None, None);
                        self.dirty = true;
                    }
                    Err(_) => {
                        self.result(&id, false, "delivery_unknown", None, None);
                        self.status.error = Some("Prompt delivery is unknown. Do not resend automatically; inspect the transcript or Stop.".into());
                        self.dirty = true;
                    }
                }
            }
            Done::Cancel(id, settled_before, answer) => match answer {
                Ok(draft) => {
                    // The reader queues preceding events before resolving the RPC response.
                    // Consume that bounded prefix before reopening prompt admission.
                    let queued = self.events.as_ref().map_or(0, rpc::Events::pending);
                    for _ in 0..queued {
                        if let Some(event) = self.events.as_mut().and_then(rpc::Events::try_recv) {
                            self.event(event);
                        }
                    }
                    self.cancel_wait = Some(CancelWait {
                        id,
                        settled_before,
                        draft,
                        deadline: Instant::now() + Duration::from_secs(10),
                    });
                    self.finish_cancel();
                }
                Err(_) => {
                    self.status.cancel_unconfirmed = true;
                    self.status.error = Some("Cancellation is unconfirmed. Termination cannot undo edits and may lose output.".into());
                    self.result(&id, false, "cancellation_unconfirmed", None, None);
                    self.dirty = true;
                }
            },
            Done::Ui(id, response) => {
                if !id.is_empty() {
                    self.result(
                        &id,
                        response.is_ok(),
                        if response.is_ok() {
                            "answered"
                        } else {
                            "dialog_write_failed"
                        },
                        None,
                        None,
                    );
                }
                if response.is_err() {
                    self.fail("Extension dialog response could not be written");
                }
            }
            Done::Terminated(exit) => self.exited(exit),
        }
    }
    fn event(&mut self, event: Value) {
        if event["type"] == "extension_ui_request" {
            self.extension(event);
            return;
        }
        if event["type"] == "extension_error" {
            self.status.notice =
                Some("An extension reported an error; see operator diagnostics".into());
            self.dirty = true;
        }
        if matches!(
            event["type"].as_str(),
            Some("thinking_level_changed" | "model_select" | "model_changed")
        ) {
            self.request_state(StateReason::Settled);
        }
        if matches!(
            event["type"].as_str(),
            Some("message_end" | "auto_compaction_end")
        ) {
            self.request_context();
        }
        if event["type"] == "agent_settled" {
            self.settled += 1;
            self.status.last_outcome = Some(
                if event["aborted"] == true {
                    "aborted"
                } else if self
                    .view
                    .messages()
                    .last()
                    .is_some_and(|m| m.error.is_some())
                {
                    "error"
                } else {
                    "success"
                }
                .into(),
            );
            let outcome = match self.status.last_outcome.as_deref() {
                Some("aborted") => RunOutcome::Aborted,
                Some("error") => RunOutcome::Error,
                _ => RunOutcome::Success,
            };
            self.send(ServerBody::RunCompleted {
                run_id: self.settled.to_string(),
                outcome,
            });
            self.request_state(StateReason::Settled);
        }
        let patches = self.view.apply(&event);
        if !patches.is_empty() {
            self.revision = self.revision.wrapping_add(1);
            self.push_patches(patches);
        }
        self.finish_cancel();
    }
    /// Acknowledging abort is not completion: retain the admission gate until Pi settles.
    fn finish_cancel(&mut self) {
        if self.state_requests != 0
            || self
                .events
                .as_ref()
                .is_some_and(|events| events.pending() != 0)
        {
            return;
        }
        if !self
            .cancel_wait
            .as_ref()
            .is_some_and(|wait| self.settled > wait.settled_before)
        {
            return;
        }
        let wait = self.cancel_wait.take().unwrap();
        self.cancelling = false;
        self.status.cancel_unconfirmed = false;
        self.result(&wait.id, true, "cancelled", None, wait.draft);
        self.dirty = true;
    }
    fn push_patches(&mut self, patches: Vec<ViewPatch>) {
        for patch in patches {
            self.patch_bytes += serde_json::to_vec(&patch)
                .expect("presentation serialization")
                .len();
            self.patches.push(patch);
            if self.patch_bytes >= 256 * 1024 || self.patches.len() >= 128 {
                self.flush();
            }
        }
        self.dirty = true;
    }
    fn extension(&mut self, event: Value) {
        let method = event["method"].as_str().unwrap_or("");
        if method == "setStatus" && event["statusKey"] == "codex-fast" {
            self.settings.codex_fast = event["statusText"].as_str().map(|text| {
                clip(
                    &text.chars().filter(|c| !c.is_control()).collect::<String>(),
                    512,
                )
            });
            self.send_settings();
            return;
        }
        if method == "notify" {
            let message = event["message"].as_str().unwrap_or("");
            if let Some(encoded) = message.strip_prefix(HEAD_PREFIX) {
                if message.len() <= 8192
                    && let Ok(HistoryHeadReply::Ok { request_id, head }) =
                        serde_json::from_str(encoded)
                    && let Some(wait) = &mut self.head
                    && wait.token == request_id
                    && valid_head(&head)
                {
                    wait.reply = Some(head);
                }
                self.finish_head();
                return;
            }
            self.status.notice = Some(clip(message, 4096));
            self.dirty = true;
            return;
        }
        if !matches!(method, "confirm" | "select" | "input" | "editor") {
            return;
        }
        let Some(id) = event["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 1024)
        else {
            self.fail("Extension sent an invalid dialog identity");
            return;
        };
        let options: Vec<_> = event["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let invalid = options.len() > 128
            || options.iter().any(|o| o.len() > 512)
            || self.dialogs.len() >= 8
            || self.dialogs.iter().any(|d| d.dialog.id == id);
        // Keep rejecting input until cancellation is confirmed or the child exits;
        // a late dialog must not keep Stop waiting for user interaction.
        if self.cancelling || self.client.is_none() || invalid {
            self.cancel_dialog(id.to_owned());
            self.status.notice = Some("Extension input was cancelled while stopping, without a controller, or because its limits were exceeded".into());
            self.dirty = true;
            return;
        }
        let dialog = Dialog {
            id: id.into(),
            kind: method.into(),
            title: clip(event["title"].as_str().unwrap_or("Extension input"), 4096),
            message: clip(event["message"].as_str().unwrap_or(""), 4096),
            options,
            initial: clip(
                event["prefill"]
                    .as_str()
                    .or(event["initialValue"].as_str())
                    .unwrap_or(""),
                16 * 1024,
            ),
        };
        let deadline = event["timeout"]
            .as_u64()
            .map(|ms| Instant::now() + Duration::from_millis(ms.min(86_400_000)));
        self.dialogs.push_back(PendingDialog { dialog, deadline });
        self.dirty = true;
    }
    fn reply(&mut self, id: String, dialog_id: String, answer: DialogAnswer) {
        let Some(index) = self.dialogs.iter().position(|d| d.dialog.id == dialog_id) else {
            self.result(&id, false, "stale_dialog", None, None);
            return;
        };
        let pending = &self.dialogs[index];
        if pending
            .deadline
            .is_some_and(|deadline| deadline <= Instant::now())
        {
            self.result(&id, false, "stale_dialog", None, None);
            return;
        }
        let valid = match &answer {
            DialogAnswer::Cancelled => true,
            DialogAnswer::Confirmed { .. } => pending.dialog.kind == "confirm",
            DialogAnswer::Value { value } => match pending.dialog.kind.as_str() {
                "input" | "editor" => true,
                "select" => pending.dialog.options.contains(value),
                _ => false,
            },
        };
        if !valid {
            self.result(&id, false, "invalid_answer", None, None);
            return;
        }
        self.dialogs.remove(index);
        self.dirty = true;
        let answer = match answer {
            DialogAnswer::Cancelled => UiAnswer::Cancelled {
                cancelled: Cancelled,
            },
            DialogAnswer::Confirmed { confirmed } => UiAnswer::Confirmed { confirmed },
            DialogAnswer::Value { value } => UiAnswer::Value { value },
        };
        let process = self.process.as_ref().unwrap().clone();
        self.jobs.spawn(async move {
            Done::Ui(id, process.extension_ui_response(&dialog_id, answer).await)
        });
    }
    fn cancel_dialog(&mut self, id: String) {
        if self.jobs.len() >= 32 {
            self.fail("Too many extension dialog requests");
            return;
        }
        if let Some(process) = self.process.clone() {
            self.jobs.spawn(async move {
                Done::Ui(
                    String::new(),
                    process
                        .extension_ui_response(
                            &id,
                            UiAnswer::Cancelled {
                                cancelled: Cancelled,
                            },
                        )
                        .await,
                )
            });
        }
    }
    fn cancel_dialogs(&mut self) {
        let ids: Vec<_> = self.dialogs.drain(..).map(|d| d.dialog.id).collect();
        for id in ids {
            self.cancel_dialog(id);
        }
    }
    fn detach(&mut self) {
        self.client = None;
        if !self.dialogs.is_empty() {
            self.status.notice =
                Some("Pending extension input was cancelled when the browser disconnected".into());
            self.dirty = true;
        }
        self.cancel_dialogs();
    }
    fn request_head(&mut self, purpose: HeadPurpose) {
        if self.head.is_some() {
            self.history_error("A history checkpoint is already pending");
            return;
        }
        let Ok(token) = config::identity() else {
            self.history_error("Could not create history checkpoint");
            return;
        };
        self.head = Some(HeadWait {
            token: token.clone(),
            purpose,
            reply: None,
            ack: false,
            deadline: Instant::now() + RPC_DEADLINE,
        });
        let process = self.process.as_ref().unwrap().clone();
        let message = format!("/pi-web-history-head {token}");
        self.jobs.spawn(async move {
            Done::HeadAck(
                token,
                process
                    .request(RpcCommand::Prompt { message }, RPC_DEADLINE)
                    .await,
            )
        });
    }
    fn finish_head(&mut self) {
        if !self
            .head
            .as_ref()
            .is_some_and(|h| h.ack && h.reply.is_some())
        {
            return;
        }
        let wait = self.head.take().unwrap();
        let head = wait.reply.unwrap();
        if head.session_id != self.metadata.pi_session_id.as_deref().unwrap_or("")
            || head.session_file.as_deref().map(Path::new)
                != self.metadata.pi_session_path.as_deref()
        {
            self.history_error("Pi identity changed during history loading");
            return;
        }
        if !head.idle {
            self.history_error("History loading was superseded by live work");
            return;
        }
        match wait.purpose {
            HeadPurpose::Before => {
                let revision = self.revision;
                let roots = self.config.session_roots.clone();
                let cwd = self.config.cwd.clone();
                self.jobs.spawn(async move {
                    Done::History(
                        tokio::task::spawn_blocking(move || {
                            history::scan(head, revision, roots, cwd)
                        })
                        .await
                        .unwrap_or_else(|_| Err("History worker failed".into())),
                    )
                });
            }
            HeadPurpose::After(scan) => {
                let unchanged = scan.head == head
                    && scan.revision == self.revision
                    && scan.file.as_ref().is_none_or(|(path, before)| {
                        history::fingerprint(path).is_ok_and(|after| after == *before)
                    });
                if !unchanged {
                    self.history_error("History changed while loading; live output was preserved");
                    return;
                }
                self.view.replace_history(scan.messages, scan.older);
                self.status.history_warning = None;
                self.patches.clear();
                self.patch_bytes = 0;
                self.dirty = false;
                self.snapshot();
            }
        }
    }
    /// Validates Pi's identity before persisting it; only an idle live replacement may rebind.
    fn persist_identity(
        &mut self,
        state: &Value,
        allow_replacement: bool,
    ) -> Result<bool, rpc::Error> {
        let bad = || rpc::Error::Protocol("invalid session state".into());
        let id = state["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 1024)
            .ok_or_else(bad)?;
        if !state["isStreaming"].is_boolean() || !state["isCompacting"].is_boolean() {
            return Err(bad());
        }
        let path = match &state["sessionFile"] {
            Value::Null => None,
            Value::String(path) if path.len() <= 4096 => Some(PathBuf::from(path)),
            _ => return Err(bad()),
        };
        let replaced = self
            .metadata
            .pi_session_id
            .as_ref()
            .is_some_and(|old| old != id)
            || self.metadata.pi_session_path.as_ref().is_some_and(|old| {
                path.as_ref().is_none_or(|new| {
                    old != new
                        && old
                            .canonicalize()
                            .ok()
                            .zip(new.canonicalize().ok())
                            .is_none_or(|(old, new)| old != new)
                })
            });
        if replaced
            && (!allow_replacement
                || state["isStreaming"] != false
                || state["isCompacting"] != false)
        {
            return Err(bad());
        }
        if let Some(path) = &path {
            if !path.is_absolute() {
                return Err(bad());
            }
            if path.exists() {
                crate::metadata::validate_session(
                    path,
                    &self.config.session_roots,
                    &self.config.cwd,
                )
                .map_err(|_| bad())?;
            } else {
                let parent = path
                    .parent()
                    .and_then(|p| p.canonicalize().ok())
                    .ok_or_else(bad)?;
                if !self
                    .config
                    .session_roots
                    .iter()
                    .filter_map(|p| p.canonicalize().ok())
                    .any(|root| parent.starts_with(root))
                {
                    return Err(bad());
                }
            }
        }
        self.ownership
            .claim(&self.metadata.app_id, path.as_deref())
            .map_err(|_| rpc::Error::Protocol("session file is owned by another runtime".into()))?;
        self.metadata.pi_session_id = Some(id.into());
        self.metadata.pi_session_path = path;
        self.status.persistence = self
            .metadata
            .pi_session_path
            .as_ref()
            .is_some_and(|p| p.is_file());
        self.metadata.persisted = self.status.persistence || (!replaced && self.metadata.persisted);
        self.store.save(&self.metadata).map_err(|_| bad())?;
        Ok(replaced)
    }
    /// Replaces presentation and command identity without mixing two Pi transcripts.
    fn replace_session(&mut self, sequence: u64, state: &Value) {
        while let Some(event) = self
            .events
            .as_mut()
            .and_then(|events| events.recv_through(sequence))
        {
            self.event(event);
        }
        let Ok(epoch) = config::identity() else {
            self.fail("Could not generate a replacement runtime identity");
            return;
        };
        for id in self.requests.pending_ids() {
            self.result(&id, false, "session_replaced", None, None);
        }
        invalidate_jobs(&mut self.jobs);
        self.prompt_write = None;
        self.cancel_dialogs();
        self.epoch = epoch;
        self.reset_settings();
        self.settings.model = settings::model(&state["model"]);
        self.settings.thinking_level = serde_json::from_value(state["thinkingLevel"].clone()).ok();
        self.requests = Requests::default();
        self.view = ViewState::default();
        self.head = None;
        self.state_requests = 0;
        self.seq = 0;
        self.revision = 0;
        self.settled = 0;
        self.patches.clear();
        self.patch_bytes = 0;
        self.status.last_outcome = None;
        self.status.error = None;
        self.status.history_warning =
            Some("Pi selected another session; loading its recent history".into());
        self.status.notice =
            Some("Pi session changed; previous request identities were invalidated".into());
        self.send(ServerBody::Hello {
            project: self
                .config
                .cwd
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            process: self.status.process.clone(),
        });
        self.snapshot();
        self.request_capabilities();
        self.request_context();
        self.request_head(HeadPurpose::Before);
    }
    fn history_error(&mut self, message: &str) {
        self.head = None;
        self.status.history_warning = Some(clip(message, 512));
        self.dirty = true;
    }
    fn expire(&mut self) {
        if self
            .cancel_wait
            .as_ref()
            .is_some_and(|wait| wait.deadline <= Instant::now())
        {
            let wait = self.cancel_wait.take().unwrap();
            self.status.cancel_unconfirmed = true;
            self.status.error = Some("Abort was acknowledged, but settlement was not observed. Termination may lose output.".into());
            self.result(
                &wait.id,
                false,
                "cancellation_unconfirmed",
                None,
                wait.draft,
            );
            self.dirty = true;
        }
        if self
            .head
            .as_ref()
            .is_some_and(|h| h.deadline <= Instant::now())
        {
            self.history_error("History checkpoint timed out; the agent remains available");
        }
        let mut expired = Vec::new();
        self.dialogs.retain(|d| {
            let keep = d.deadline.is_none_or(|until| until > Instant::now());
            if !keep {
                expired.push(d.dialog.id.clone());
            }
            keep
        });
        if !expired.is_empty() {
            self.dirty = true;
            for id in expired {
                self.cancel_dialog(id);
            }
        }
    }
    fn fail(&mut self, message: &str) {
        if self.status.process == ProcessStatus::Failed {
            return;
        }
        self.status.process = ProcessStatus::Failed;
        self.status.error = Some(clip(message, 512));
        self.status.last_outcome = Some("error".into());
        let patches = self.view.interrupt(message);
        self.push_patches(patches);
        self.dirty = true;
        if let Some(process) = self.process.clone() {
            self.jobs
                .spawn(async move { Done::Terminated(process.shutdown().await) });
        }
    }
    fn exited(&mut self, exit: rpc::Exit) {
        self.exit_observed = true;
        self.cleanup_complete = exit.reaped && exit.cleanup_error.is_none();
        self.events = None;
        self.head = None;
        self.dialogs.clear();
        self.cancelling = false;
        self.cancel_wait = None;
        self.prompt_write = None;
        self.status.cancel_unconfirmed = false;
        self.jobs.abort_all();
        self.state_requests = 0;
        self.status.process = if self.cleanup_complete {
            ProcessStatus::Exited
        } else {
            ProcessStatus::Failed
        };
        self.status.error.get_or_insert_with(|| {
            "Pi exited. Unpersisted partial output may be lost; restart explicitly to resume."
                .into()
        });
        if !self.cleanup_complete {
            self.status.error =
                Some("Pi cleanup failed; restart is disabled. Check operator diagnostics.".into());
        }
        let patches = self.view.interrupt("Interrupted by process exit");
        self.push_patches(patches);
        self.dirty = true;
        if let Some(id) = self.termination_request.take() {
            self.result(
                &id,
                self.cleanup_complete,
                if self.cleanup_complete {
                    "terminated"
                } else {
                    "cleanup_failed"
                },
                None,
                None,
            );
        }
        for id in self.requests.pending_ids() {
            self.result(&id, false, "process_exited_delivery_uncertain", None, None);
        }
    }
    fn activity(&self) -> Activity {
        if self.cancelling {
            Activity::Cancelling
        } else if !self.dialogs.is_empty() {
            Activity::AwaitingInput
        } else if (self.state_requests != 0 || self.setting_pending.is_some())
            && self.view.activity == Activity::Idle
        {
            Activity::Reconciling
        } else {
            self.view.activity.clone()
        }
    }
    fn snapshot(&mut self) {
        self.status.activity = self.activity();
        self.send(ServerBody::Snapshot {
            through_seq: self.seq,
            status: self.status.clone(),
            messages: self.view.messages(),
            dialogs: self.dialogs.iter().map(|d| d.dialog.clone()).collect(),
            older_history: self.view.older_history,
        });
        self.send(ServerBody::Commands {
            commands: self.commands.clone(),
        });
        self.send_settings();
        self.send_context();
    }
    fn flush(&mut self) {
        if !self.dirty && self.patches.is_empty() {
            return;
        }
        let Some(seq) = self.seq.checked_add(1) else {
            self.detach();
            return;
        };
        self.seq = seq;
        self.status.activity = self.activity();
        let patches = std::mem::take(&mut self.patches);
        self.patch_bytes = 0;
        self.dirty = false;
        self.send(ServerBody::Event {
            seq,
            patches,
            status: self.status.clone(),
            dialogs: self.dialogs.iter().map(|d| d.dialog.clone()).collect(),
            older_history: self.view.older_history,
        });
    }
    fn reject(&mut self, id: &str, code: &str) {
        self.send(ServerBody::Result {
            result: result(&clip(id, 64), false, code, None, None),
        });
    }
    fn result(
        &mut self,
        id: &str,
        ok: bool,
        code: &str,
        disposition: Option<String>,
        draft: Option<String>,
    ) {
        if id.is_empty() {
            return;
        }
        let result = result(id, ok, code, disposition, draft);
        self.requests.finish(result.clone());
        self.send(ServerBody::Result { result });
    }
    fn send(&mut self, body: ServerBody) {
        let Some(client) = &self.client else {
            return;
        };
        let message = ServerMessage {
            v: 1,
            session_id: self.metadata.app_id.clone(),
            epoch: self.epoch.clone(),
            body,
        };
        let text = serde_json::to_string(&message).expect("application wire serialization");
        let sent = if text.len() <= OUTBOUND_BYTES {
            client
                .budget
                .clone()
                .try_acquire_many_owned(text.len() as u32)
                .ok()
                .is_some_and(|permit| {
                    client
                        .sender
                        .try_send(Frame {
                            text,
                            _permit: permit,
                        })
                        .is_ok()
                })
        } else {
            false
        };
        if !sent {
            self.detach();
        }
    }
}
fn result(
    id: &str,
    ok: bool,
    code: &str,
    disposition: Option<String>,
    recovered_draft: Option<String>,
) -> CommandResult {
    CommandResult {
        request_id: id.into(),
        ok,
        code: code.into(),
        disposition,
        recovered_draft,
    }
}
fn clip(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].into()
}
fn recover_draft(value: &Value) -> Option<String> {
    let texts: Vec<_> = [
        "steering",
        "followUp",
        "steeringMessages",
        "followUpMessages",
    ]
    .iter()
    .flat_map(|key| value[*key].as_array().into_iter().flatten())
    .filter_map(|v| v.as_str().or_else(|| v["text"].as_str()))
    .collect();
    if texts.is_empty() {
        None
    } else {
        Some(clip(&texts.join("\n\n"), 32 * 1024))
    }
}
/// Drops both unfinished jobs and completed, unconsumed results from the prior epoch.
fn invalidate_jobs(jobs: &mut JoinSet<Done>) {
    *jobs = JoinSet::new();
}

#[cfg(test)]
#[path = "session/epoch_tests.rs"]
mod epoch_tests;

fn valid_head(head: &HistoryHead) -> bool {
    !head.session_id.is_empty()
        && head.session_id.len() <= 1024
        && head
            .leaf_id
            .as_ref()
            .is_none_or(|s| !s.is_empty() && s.len() <= 1024)
        && head.session_file.as_ref().is_none_or(|s| s.len() <= 4096)
}
/// Resolves only the operator's executable and constructs argument-array invocation.
fn launch_spec(config: &Config, session: Option<&Path>) -> io::Result<rpc::ProcessSpec> {
    let executable = if config.pi.components().count() > 1 {
        config.pi.canonicalize()?
    } else {
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(&config.pi))
            .find(|path| path.is_file())
            .ok_or_else(|| io::Error::other("Pi executable not found"))?
            .canonicalize()?
    };
    let root = config.state_dir.join("pi-sessions");
    std::fs::create_dir_all(&root)?;
    let mut args: Vec<OsString> = vec![
        "--mode".into(),
        "rpc".into(),
        "--session-dir".into(),
        root.into_os_string(),
        "--extension".into(),
        config.head_adapter.canonicalize()?.into_os_string(),
    ];
    if let Some(session) = session {
        args.push("--session".into());
        args.push(
            crate::metadata::validate_session(session, &config.session_roots, &config.cwd)?
                .into_os_string(),
        );
    }
    if config.isolated {
        args.extend(
            [
                "--no-extensions",
                "--no-mcp",
                "--no-context-files",
                "--no-skills",
                "--no-prompt-templates",
                "--tools",
                "read",
                "--offline",
            ]
            .map(OsString::from),
        );
    }
    Ok(rpc::ProcessSpec {
        executable,
        args,
        cwd: config.cwd.clone(),
    })
}
