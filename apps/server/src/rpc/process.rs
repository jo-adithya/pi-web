use super::*;
use std::process::Stdio;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStderr, ChildStdout, Command},
    time::{sleep, timeout},
};

pub(super) fn spawn(spec: ProcessSpec, limits: Limits) -> Result<(Handle, Events), Error> {
    let mut child = Command::new(spec.executable)
        .args(spec.args)
        .current_dir(spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Error::Io(e.to_string()))?;
    let pid = child.id().expect("new child has a PID") as i32;
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let shared = Arc::new(Shared {
        state: Mutex::new(State::default()),
        records: Arc::new(Semaphore::new(limits.retained_records)),
        bytes: Arc::new(Semaphore::new(limits.retained_bytes)),
        limits: limits.clone(),
    });
    let (normal, normal_rx) = mpsc::channel(limits.normal_queue);
    let (control, control_rx) = mpsc::channel(limits.control_queue);
    let (event_tx, receiver) = mpsc::channel(limits.retained_records);
    let (stop, mut stop_rx) = watch::channel(false);
    let (exit_tx, exit) = watch::channel(None);
    let owner = Arc::new(Owner {
        shared: shared.clone(),
        normal,
        control,
        normal_bytes: Arc::new(Semaphore::new(limits.normal_bytes)),
        control_bytes: Arc::new(Semaphore::new(limits.control_bytes)),
        outstanding: Arc::new(Semaphore::new(limits.outstanding)),
        normal_outstanding: Arc::new(Semaphore::new(limits.outstanding.saturating_sub(1))),
        next_id: AtomicU64::new(1),
        stop,
        exit,
    });
    tokio::spawn(async move {
        let mut reader = tokio::spawn(read_stdout(stdout, shared.clone(), event_tx));
        let writer_shared = shared.clone();
        let mut writer = tokio::spawn(write_stdin(stdin, normal_rx, control_rx, writer_shared));
        let tail = Arc::new(Mutex::new(Vec::new()));
        let mut diagnostics = tokio::spawn(read_stderr(stderr, tail.clone()));
        let mut status = None;
        let mut reader_done = false;
        let mut writer_done = false;
        let reason = tokio::select! {
            _ = stop_rx.changed() => Error::Closed,
            result = &mut reader => { reader_done = true; task_error(result) },
            result = &mut writer => { writer_done = true; task_error(result) },
            result = child.wait() => {
                match result {
                    Ok(value) => {
                        status = Some(value);
                        // Drain records already in the pipe before publishing normal EOF.
                        match timeout(limits.write_timeout, &mut reader).await {
                            Ok(result) => { reader_done = true; task_error(result) },
                            Err(_) => Error::Timeout,
                        }
                    },
                    Err(error) => Error::Io(error.to_string()),
                }
            }
        };
        shared.close(reason.clone());
        // Abort drops stdin even when write_all is stalled. Join before grace begins.
        if !writer_done {
            writer.abort();
            let _ = writer.await;
        }
        if !reader_done {
            reader.abort();
            let _ = reader.await;
        }
        let cleanup_error = cleanup(&mut child, pid, &mut status, &limits).await.err();
        // Escaped descendants may retain a pipe; they cannot hold completion forever.
        if timeout(limits.kill_grace, &mut diagnostics).await.is_err() {
            diagnostics.abort();
            let _ = diagnostics.await;
        }
        let result = Exit {
            reason,
            reaped: status.is_some(),
            status,
            cleanup_error,
            stderr_tail: tail.lock().unwrap().clone(),
        };
        let _ = exit_tx.send(Some(result));
    });
    Ok((
        Handle { owner },
        Events {
            receiver,
            buffered: None,
        },
    ))
}

fn task_error(result: Result<Error, tokio::task::JoinError>) -> Error {
    result.unwrap_or_else(|error| Error::Io(format!("pipe task failed: {error}")))
}

async fn write_stdin(
    mut stdin: tokio::process::ChildStdin,
    mut normal: mpsc::Receiver<Outbound>,
    mut control: mpsc::Receiver<Outbound>,
    shared: Arc<Shared>,
) -> Error {
    loop {
        let next = tokio::select! { biased; value = control.recv() => value, value = normal.recv() => value };
        let Some(mut message) = next else {
            return Error::Closed;
        };
        if let Some(id) = &message.id
            && !shared.state.lock().unwrap().pending.contains_key(id)
        {
            continue;
        }
        let result = timeout(shared.limits.write_timeout, async {
            stdin.write_all(&message.bytes).await?;
            stdin.flush().await
        })
        .await;
        let error = match result {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(Error::Io(e.to_string())),
            Err(_) => Some(Error::Timeout),
        };
        if let Some(sender) = message.written.take() {
            let _ = sender.send(error.clone().map_or(Ok(()), Err));
        }
        if let Some(error) = error {
            return error;
        }
    }
}

async fn read_stdout(
    mut stdout: ChildStdout,
    shared: Arc<Shared>,
    events: mpsc::Sender<Record>,
) -> Error {
    let mut chunk = [0; 8192];
    let mut line = Vec::new();
    let mut sequence = 0u64;
    loop {
        let read = match stdout.read(&mut chunk).await {
            Ok(n) => n,
            Err(e) => return Error::Io(e.to_string()),
        };
        if read == 0 {
            return if line.is_empty() {
                Error::Closed
            } else {
                Error::Protocol("partial record at EOF".into())
            };
        }
        for &byte in &chunk[..read] {
            if byte != b'\n' {
                if line.len() == shared.limits.record_bytes {
                    return Error::Protocol("record byte budget exceeded".into());
                }
                line.push(byte);
                continue;
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            sequence = match sequence.checked_add(1) {
                Some(sequence) => sequence,
                None => return Error::Protocol("stdout sequence exhausted".into()),
            };
            if let Err(error) = dispatch(&line, sequence, &shared, &events).await {
                return error;
            }
            line.clear();
        }
    }
}

async fn dispatch(
    line: &[u8],
    sequence: u64,
    shared: &Shared,
    events: &mpsc::Sender<Record>,
) -> Result<(), Error> {
    let (value, nodes) = parser::parse(line, shared.limits.json_depth, shared.limits.json_nodes)
        .map_err(Error::Protocol)?;
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Protocol("record requires string type".into()))?;
    // Conservatively charge map entries, Vec spare capacity, strings and Value storage.
    let charge = line
        .len()
        .checked_add(nodes.checked_mul(256).ok_or(Error::Overloaded)?)
        .ok_or(Error::Overloaded)?;
    if charge > shared.limits.retained_bytes {
        return Err(Error::Overloaded);
    }
    if kind == "response" {
        let id = value
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Protocol("response requires string id".into()))?;
        let command = value
            .get("command")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Protocol("response requires string command".into()))?;
        let success = value
            .get("success")
            .and_then(Value::as_bool)
            .ok_or_else(|| Error::Protocol("response requires boolean success".into()))?;
        let expected = shared
            .state
            .lock()
            .unwrap()
            .pending
            .get(id)
            .map(|p| p.command);
        let Some(expected) = expected else {
            return Ok(());
        };
        if command != expected {
            return Err(Error::Protocol("response command mismatch".into()));
        }
        if !success && value.get("error").and_then(Value::as_str).is_none() {
            return Err(Error::Protocol(
                "failed response requires string error".into(),
            ));
        }
    }
    let deadline = Instant::now() + shared.limits.overload_timeout;
    let bytes = timeout_at(
        deadline,
        shared.bytes.clone().acquire_many_owned(charge as u32),
    )
    .await
    .map_err(|_| Error::Overloaded)?
    .map_err(|_| Error::Closed)?;
    let count = timeout_at(deadline, shared.records.clone().acquire_owned())
        .await
        .map_err(|_| Error::Overloaded)?
        .map_err(|_| Error::Closed)?;
    let record = Record {
        sequence,
        value,
        _bytes: bytes,
        _count: count,
    };
    if record.value["type"] == "response" {
        let id = record.value["id"].as_str().expect("validated response id");
        if let Some(pending) = shared.state.lock().unwrap().pending.remove(id) {
            let _ = pending.sender.send(Ok(record));
        }
    } else {
        timeout_at(deadline, events.send(record))
            .await
            .map_err(|_| Error::Overloaded)?
            .map_err(|_| Error::Closed)?;
    }
    Ok(())
}

async fn read_stderr(mut stderr: ChildStderr, tail: Arc<Mutex<Vec<u8>>>) {
    let mut chunk = [0; 8192];
    while let Ok(n) = stderr.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        let mut tail = tail.lock().unwrap();
        let discard = (tail.len() + n).saturating_sub(64 * 1024);
        tail.drain(..discard);
        tail.extend_from_slice(&chunk[..n]);
    }
}

/// Signals only the group created at spawn. ESRCH proves absence; EPERM is failure.
fn signal_group(pid: i32, signal: i32) -> Result<bool, String> {
    // SAFETY: positive child PID is negated to address its owned process group; no pointers.
    if unsafe { libc::kill(-pid, signal) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(error.to_string())
    }
}

async fn wait_group(
    child: &mut Child,
    pid: i32,
    status: &mut Option<std::process::ExitStatus>,
    grace: Duration,
) -> Result<bool, String> {
    let deadline = Instant::now() + grace;
    loop {
        if status.is_none() {
            *status = child.try_wait().map_err(|e| e.to_string())?;
        }
        let probe = signal_group(pid, 0);
        if matches!(probe, Ok(false)) && status.is_some() {
            return Ok(true);
        }
        // Darwin can report EPERM while a child is exiting but not yet waitable.
        // Retry within the deadline, requiring both reaping and ESRCH for success.
        if Instant::now() >= deadline {
            return probe.map(|_| false);
        }
        sleep(Duration::from_millis(10)).await;
    }
}

async fn cleanup(
    child: &mut Child,
    pid: i32,
    status: &mut Option<std::process::ExitStatus>,
    limits: &Limits,
) -> Result<(), String> {
    if wait_group(child, pid, status, limits.shutdown_grace).await? {
        return Ok(());
    }
    let term = signal_group(pid, libc::SIGTERM);
    if wait_group(child, pid, status, limits.term_grace).await? {
        return Ok(());
    }
    term?;
    let kill = signal_group(pid, libc::SIGKILL);
    if wait_group(child, pid, status, limits.kill_grace).await? {
        return Ok(());
    }
    kill?;
    Err("process group remained live or child was not reaped after KILL deadline".into())
}
