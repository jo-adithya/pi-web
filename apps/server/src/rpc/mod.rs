//! Bounded Unix JSONL transport for one operator-configured Pi process.
//!
//! Drain [`Events`] independently of requests. Prompt results are acknowledgments;
//! `agent_settled` remains an event. Dropping the last handle initiates supervised
//! cleanup; keep a handle and await [`Handle::shutdown`] for cleanup evidence.
//! The Tokio runtime must remain alive through cleanup. Descendants which detach
//! from the owned process group are outside this transport's cleanup guarantee.

mod parser;
mod process;

use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    ffi::OsString,
    fmt,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
    time::{Instant, timeout_at},
};

/// Operator-owned launch settings; executable and cwd must be absolute paths.
#[derive(Debug)]
pub struct ProcessSpec {
    pub executable: PathBuf,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
}

/// Hard memory/admission limits and bounded I/O/cleanup deadlines.
#[derive(Clone, Debug)]
pub struct Limits {
    pub record_bytes: usize,
    pub json_depth: usize,
    pub json_nodes: usize,
    pub retained_records: usize,
    pub retained_bytes: usize,
    pub normal_queue: usize,
    pub normal_bytes: usize,
    pub control_queue: usize,
    pub control_bytes: usize,
    /// Total pending requests; one slot is reserved for control commands.
    pub outstanding: usize,
    pub overload_timeout: Duration,
    pub write_timeout: Duration,
    pub shutdown_grace: Duration,
    pub term_grace: Duration,
    pub kill_grace: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            record_bytes: 32 * 1024 * 1024,
            json_depth: 64,
            json_nodes: 262_144,
            retained_records: 64,
            retained_bytes: 64 * 1024 * 1024,
            normal_queue: 16,
            normal_bytes: 1024 * 1024,
            control_queue: 8,
            control_bytes: 256 * 1024,
            outstanding: 32,
            overload_timeout: Duration::from_millis(250),
            write_timeout: Duration::from_secs(2),
            shutdown_grace: Duration::from_secs(1),
            term_grace: Duration::from_secs(3),
            kill_grace: Duration::from_secs(3),
        }
    }
}
impl Limits {
    fn validate(&self) -> Result<(), Error> {
        let sizes = [
            self.record_bytes,
            self.json_depth,
            self.json_nodes,
            self.retained_records,
            self.retained_bytes,
            self.normal_queue,
            self.normal_bytes,
            self.control_queue,
            self.control_bytes,
            self.outstanding,
        ];
        if sizes
            .iter()
            .any(|&n| n == 0 || n > u32::MAX as usize || n > Semaphore::MAX_PERMITS)
            || self.json_depth > 64
            || self.outstanding < 2
            || [
                self.overload_timeout,
                self.write_timeout,
                self.shutdown_grace,
                self.term_grace,
                self.kill_grace,
            ]
            .iter()
            .any(|duration| duration.is_zero() || Instant::now().checked_add(*duration).is_none())
        {
            return Err(Error::InvalidLimits);
        }
        Ok(())
    }
}

/// Narrow command vocabulary. Extension replies use [`Handle::extension_ui_response`].
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RpcCommand {
    GetState,
    GetSessionStats,
    GetCommands,
    GetAvailableModels,
    GetAvailableThinkingLevels,
    SetModel {
        provider: String,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    SetThinkingLevel {
        level: crate::protocol::ThinkingLevel,
    },
    Prompt {
        message: String,
    },
    ClearQueue,
    Abort,
}
impl RpcCommand {
    fn name(&self) -> &'static str {
        match self {
            Self::GetState => "get_state",
            Self::GetSessionStats => "get_session_stats",
            Self::GetCommands => "get_commands",
            Self::GetAvailableModels => "get_available_models",
            Self::GetAvailableThinkingLevels => "get_available_thinking_levels",
            Self::SetModel { .. } => "set_model",
            Self::SetThinkingLevel { .. } => "set_thinking_level",
            Self::Prompt { .. } => "prompt",
            Self::ClearQueue => "clear_queue",
            Self::Abort => "abort",
        }
    }
    fn control(&self) -> bool {
        matches!(self, Self::ClearQueue | Self::Abort)
    }
}

/// A dialog answer, serialized using Pi's separate extension request ID namespace.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum UiAnswer {
    Value { value: String },
    Confirmed { confirmed: bool },
    Cancelled { cancelled: Cancelled },
}
/// Serializes only `true`, so cancellation cannot accidentally mean acceptance.
#[derive(Debug)]
pub struct Cancelled;
impl Serialize for Cancelled {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    InvalidLimits,
    InvalidProcessSpec,
    Closed,
    Overloaded,
    Timeout,
    Protocol(String),
    Io(String),
    Command { command: String, message: String },
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for Error {}

/// Final lifecycle evidence. A cleanup error forbids claiming the group is gone.
#[derive(Debug, Clone)]
pub struct Exit {
    pub reason: Error,
    pub status: Option<std::process::ExitStatus>,
    pub reaped: bool,
    pub cleanup_error: Option<String>,
    /// Private diagnostics for operator use; never an ordinary protocol event.
    pub stderr_tail: Vec<u8>,
}

struct Record {
    sequence: u64,
    value: Value,
    _bytes: OwnedSemaphorePermit,
    _count: OwnedSemaphorePermit,
}
/// Single-consumer bounded event stream. Receipt releases transport retention permits.
pub struct Events {
    receiver: mpsc::Receiver<Record>,
    buffered: Option<Record>,
}
impl Events {
    pub async fn recv(&mut self) -> Option<Value> {
        match self.buffered.take() {
            Some(record) => Some(record.value),
            None => self.receiver.recv().await.map(|record| record.value),
        }
    }

    /// Number of events already queued; a snapshot, not an idle guarantee.
    pub(crate) fn pending(&self) -> usize {
        self.receiver.len() + usize::from(self.buffered.is_some())
    }

    /// Takes one queued event without waiting, releasing its retention permits.
    pub(crate) fn try_recv(&mut self) -> Option<Value> {
        self.buffered
            .take()
            .or_else(|| self.receiver.try_recv().ok())
            .map(|record| record.value)
    }

    /// Takes only events preceding an acknowledged stdout record, retaining later events.
    pub(crate) fn recv_through(&mut self, sequence: u64) -> Option<Value> {
        if self.buffered.is_none() {
            self.buffered = self.receiver.try_recv().ok();
        }
        if self
            .buffered
            .as_ref()
            .is_some_and(|record| record.sequence <= sequence)
        {
            return self.buffered.take().map(|record| record.value);
        }
        None
    }
}
struct Pending {
    command: &'static str,
    sender: oneshot::Sender<Result<Record, Error>>,
}
#[derive(Default)]
struct State {
    closed: bool,
    pending: HashMap<String, Pending>,
}
struct Shared {
    state: Mutex<State>,
    records: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
    limits: Limits,
}
impl Shared {
    fn close(&self, error: Error) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        for (_, pending) in state.pending.drain() {
            let _ = pending.sender.send(Err(error.clone()));
        }
    }
}
struct Outbound {
    bytes: Vec<u8>,
    _budget: OwnedSemaphorePermit,
    id: Option<String>,
    written: Option<oneshot::Sender<Result<(), Error>>>,
}
struct Owner {
    shared: Arc<Shared>,
    normal: mpsc::Sender<Outbound>,
    control: mpsc::Sender<Outbound>,
    normal_bytes: Arc<Semaphore>,
    control_bytes: Arc<Semaphore>,
    outstanding: Arc<Semaphore>,
    normal_outstanding: Arc<Semaphore>,
    next_id: AtomicU64,
    stop: watch::Sender<bool>,
    exit: watch::Receiver<Option<Exit>>,
}
impl Drop for Owner {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}
/// Cloneable request endpoint; closure is shared by all clones.
#[derive(Clone)]
pub struct Handle {
    owner: Arc<Owner>,
}
struct Registration {
    shared: Arc<Shared>,
    id: String,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.shared.state.lock().unwrap().pending.remove(&self.id);
    }
}

#[cfg(test)]
mod ordering_tests;

/// Launch entry point; no startup RPC is sent implicitly.
pub struct Transport;
impl Transport {
    /// Starts pipe drains immediately. Errors cover invalid limits/paths and spawn failure.
    pub fn spawn(spec: ProcessSpec, limits: Limits) -> Result<(Handle, Events), Error> {
        limits.validate()?;
        if !spec.executable.is_absolute() || !spec.cwd.is_absolute() {
            return Err(Error::InvalidProcessSpec);
        }
        process::spawn(spec, limits)
    }
}
impl Handle {
    /// Returns response.data, not agent completion. Admission is nonblocking;
    /// timeout/cancellation removes correlation and late replies are discarded.
    pub async fn request(&self, command: RpcCommand, timeout: Duration) -> Result<Value, Error> {
        self.request_ordered(command, timeout)
            .await
            .map(|(value, _)| value)
    }

    /// Returns the data and stdout sequence at acknowledgment for an atomic event cutover.
    pub(crate) async fn request_ordered(
        &self,
        command: RpcCommand,
        timeout: Duration,
    ) -> Result<(Value, u64), Error> {
        self.request_inner(command, timeout, None).await
    }

    /// Reports stdin write completion separately from the RPC response. A dependent
    /// control request must await this notice before entering the priority queue.
    /// Pre-write admission failure or cancellation closes the notice without success.
    pub(crate) async fn request_with_write_notice(
        &self,
        command: RpcCommand,
        timeout: Duration,
        written: oneshot::Sender<Result<(), Error>>,
    ) -> Result<Value, Error> {
        self.request_inner(command, timeout, Some(written))
            .await
            .map(|(value, _)| value)
    }

    async fn request_inner(
        &self,
        command: RpcCommand,
        timeout: Duration,
        written: Option<oneshot::Sender<Result<(), Error>>>,
    ) -> Result<(Value, u64), Error> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or(Error::InvalidLimits)?;
        if self.owner.shared.state.lock().unwrap().closed {
            return Err(Error::Closed);
        }
        let _normal_slot = if command.control() {
            None
        } else {
            Some(
                self.owner
                    .normal_outstanding
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| Error::Overloaded)?,
            )
        };
        let _slot = self
            .owner
            .outstanding
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Overloaded)?;
        let id = self
            .owner
            .next_id
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| Error::Closed)?
            .to_string();
        let control = command.control();
        let name = command.name();
        #[derive(Serialize)]
        struct Request<'a> {
            id: &'a str,
            #[serde(flatten)]
            command: &'a RpcCommand,
        }
        let bytes = self.encode(
            &Request {
                id: &id,
                command: &command,
            },
            control,
        )?;
        let (sender, receiver) = oneshot::channel();
        {
            let mut state = self.owner.shared.state.lock().unwrap();
            if state.closed {
                return Err(Error::Closed);
            }
            state.pending.insert(
                id.clone(),
                Pending {
                    command: name,
                    sender,
                },
            );
        }
        let _registration = Registration {
            shared: self.owner.shared.clone(),
            id: id.clone(),
        };
        self.enqueue(bytes, control, Some(id), written)?;
        let mut record = timeout_at(deadline, receiver)
            .await
            .map_err(|_| Error::Timeout)?
            .map_err(|_| Error::Closed)??;
        if record.value["success"] == false {
            return Err(Error::Command {
                command: name.into(),
                message: record.value["error"]
                    .as_str()
                    .expect("validated error")
                    .into(),
            });
        }
        Ok((
            record
                .value
                .get_mut("data")
                .map(Value::take)
                .unwrap_or(Value::Null),
            record.sequence,
        ))
    }

    /// Writes a dialog reply and awaits the write only; Pi sends no command response.
    /// The runtime must validate that this dialog ID is currently outstanding.
    pub async fn extension_ui_response(&self, id: &str, answer: UiAnswer) -> Result<(), Error> {
        #[derive(Serialize)]
        struct Reply<'a> {
            r#type: &'static str,
            id: &'a str,
            #[serde(flatten)]
            answer: UiAnswer,
        }
        if self.owner.shared.state.lock().unwrap().closed {
            return Err(Error::Closed);
        }
        let bytes = self.encode(
            &Reply {
                r#type: "extension_ui_response",
                id,
                answer,
            },
            true,
        )?;
        let (tx, rx) = oneshot::channel();
        self.enqueue(bytes, true, None, Some(tx))?;
        rx.await.map_err(|_| Error::Closed)?
    }

    fn encode(&self, value: &impl Serialize, control: bool) -> Result<Vec<u8>, Error> {
        // Bound encoded length, including escaping overhead, while serializing.
        struct Capped {
            bytes: Vec<u8>,
            max: usize,
        }
        impl std::io::Write for Capped {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if bytes.len() > self.max - self.bytes.len() {
                    return Err(std::io::Error::other("command byte budget exceeded"));
                }
                self.bytes.extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let max = if control {
            self.owner.shared.limits.control_bytes
        } else {
            self.owner.shared.limits.normal_bytes
        };
        let mut sink = Capped {
            bytes: Vec::new(),
            max: max - 1,
        };
        serde_json::to_writer(&mut sink, value).map_err(|_| Error::Overloaded)?;
        sink.bytes.push(b'\n');
        Ok(sink.bytes)
    }
    fn enqueue(
        &self,
        bytes: Vec<u8>,
        control: bool,
        id: Option<String>,
        written: Option<oneshot::Sender<Result<(), Error>>>,
    ) -> Result<(), Error> {
        if self.owner.shared.state.lock().unwrap().closed {
            return Err(Error::Closed);
        }
        let (queue, budget) = if control {
            (&self.owner.control, &self.owner.control_bytes)
        } else {
            (&self.owner.normal, &self.owner.normal_bytes)
        };
        let permit = budget
            .clone()
            .try_acquire_many_owned(bytes.len() as u32)
            .map_err(|_| Error::Overloaded)?;
        queue
            .try_send(Outbound {
                bytes,
                _budget: permit,
                id,
                written,
            })
            .map_err(|e| match e {
                mpsc::error::TrySendError::Full(_) => Error::Overloaded,
                mpsc::error::TrySendError::Closed(_) => Error::Closed,
            })
    }
    /// Initiates cleanup independently of a stalled command writer, then awaits reaping.
    pub async fn shutdown(&self) -> Exit {
        self.owner.shared.close(Error::Closed);
        let _ = self.owner.stop.send(true);
        self.wait_exit().await
    }
    /// Awaits spontaneous exit or previously requested shutdown, including pipe-task joins.
    pub async fn wait_exit(&self) -> Exit {
        let mut exit = self.owner.exit.clone();
        loop {
            if let Some(result) = exit.borrow().clone() {
                return result;
            }
            exit.changed()
                .await
                .expect("supervisor retains completion sender");
        }
    }
}
