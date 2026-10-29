//! Fair multiplexing of original session receivers: no copied replay/forwarding queue.
use super::*;
use crate::{
    protocol::{WorkspaceAction, WorkspaceCommand, WorkspaceReply},
    session::{Connection, Frame, SessionHandle},
};
use std::task::Poll;

#[cfg(test)]
#[path = "multiplex_tests.rs"]
mod tests;

struct Attached {
    id: String,
    handle: SessionHandle,
    connection: Connection,
}
/// Polls each ready receiver once per rotation, retaining the original byte permit.
async fn next_frame(slots: &mut [Attached], cursor: &mut usize) -> (String, Option<Frame>) {
    std::future::poll_fn(|context| {
        for offset in 0..slots.len() {
            let index = (*cursor + offset) % slots.len();
            if let Poll::Ready(frame) = slots[index].connection.frames.poll_recv(context) {
                *cursor = (index + 1) % slots.len();
                return Poll::Ready((slots[index].id.clone(), frame));
            }
        }
        Poll::Pending
    })
    .await
}
async fn send(
    writer: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: Message,
) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(2), writer.send(message)).await,
        Ok(Ok(()))
    )
}
async fn send_catalog(
    writer: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    reply: &WorkspaceReply,
) -> bool {
    let Ok(text) = serde_json::to_string(reply) else {
        return false;
    };
    send(writer, Message::Text(text.into())).await
}

/// Refreshes catalog state at send time; removed targets become explicit failed receipts.
async fn refreshed_reply(manager: &SessionManager, mut reply: WorkspaceReply) -> WorkspaceReply {
    let current = manager.snapshot().await;
    if reply.target.as_ref().is_some_and(|target| {
        !current
            .sessions
            .iter()
            .any(|entry| &entry.session_id == target)
    }) {
        reply.target = None;
        reply.ok = false;
        reply.code = "target_deleted".into();
    }
    reply.workspaces = current.workspaces;
    reply.selected_workspace = current.selected_workspace;
    reply.sessions = current.sessions;
    reply.selected = current.selected;
    reply
}

/// Acquires the current runtime instance, replacing any obsolete receiver for its stable ID.
async fn subscribe(
    slots: &mut Vec<Attached>,
    manager: &SessionManager,
    client: &str,
    session_id: &str,
) -> Result<(), &'static str> {
    let handle = manager.lookup(session_id).await.ok_or("session_not_open")?;
    if let Some(index) = slots.iter().position(|slot| slot.id == session_id) {
        if slots[index].handle.same_runtime(&handle) {
            return Ok(());
        }
        let previous = slots.remove(index);
        previous.handle.disconnect(client.into()).await;
    }
    if slots.len() >= crate::session_manager::MAX_ACTIVE {
        return Err("subscription_limit");
    }
    let connection = handle.connect(client.into()).await?;
    slots.push(Attached {
        id: session_id.into(),
        handle,
        connection,
    });
    Ok(())
}

/// Releases receivers for forgotten entries, including their queued frames and byte permits.
async fn prune_deleted(slots: &mut Vec<Attached>, catalog: &WorkspaceReply, client: &str) {
    let mut index = 0;
    while index < slots.len() {
        if catalog
            .sessions
            .iter()
            .any(|entry| entry.session_id == slots[index].id)
        {
            index += 1;
        } else {
            let slot = slots.remove(index);
            slot.handle.disconnect(client.into()).await;
        }
    }
}

pub(super) async fn socket_loop(socket: WebSocket, mut state: WebState) {
    let Ok(id) = config::identity() else {
        return;
    };
    let (mut writer, mut reader) = socket.split();
    let mut slots: Vec<Attached> = Vec::new();
    let mut cursor = 0;
    let mut jobs = tokio::task::JoinSet::<WorkspaceReply>::new();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    let mut catalog_tick = tokio::time::interval(Duration::from_secs(1));
    let mut last_pong = tokio::time::Instant::now();
    let mut commands = 0;
    let mut window = tokio::time::Instant::now();
    let mut last_catalog = None;
    loop {
        tokio::select! {
            _ = state.stopping.changed() => break,
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > Duration::from_secs(15) || !send(&mut writer, Message::Ping(Vec::new().into())).await { break; }
            }
            _ = catalog_tick.tick() => {
                let snapshot = state.runtime.snapshot().await;
                prune_deleted(&mut slots, &snapshot, &id).await;
                if last_catalog.as_ref() != Some(&snapshot) {
                    if !send_catalog(&mut writer, &snapshot).await { break; }
                    last_catalog = Some(snapshot);
                }
            }
            output = next_frame(&mut slots, &mut cursor), if !slots.is_empty() => {
                let (session_id, frame) = output;
                if let Some(frame) = frame {
                    if !send(&mut writer, Message::Text(frame.text.clone().into())).await { break; }
                    // `frame` holds the session permit through completion of the network write.
                } else if let Some(index) = slots.iter().position(|slot| slot.id == session_id) {
                    let slot = slots.remove(index); slot.handle.disconnect(id.clone()).await;
                    // An active receiver disappearing means overload/detachment, not a transcript stop.
                    let error = crate::protocol::ServerMessage { v: 1, session_id, epoch: slot.handle.summary().epoch, body: crate::protocol::ServerBody::Error { code: "subscription_closed".into() } };
                    if !send(&mut writer, Message::Text(serde_json::to_string(&error).unwrap().into())).await { break; }
                }
            }
            completed = jobs.join_next(), if !jobs.is_empty() => {
                let Some(Ok(reply)) = completed else { break; };
                let reply = refreshed_reply(&state.runtime, reply).await;
                prune_deleted(&mut slots, &reply, &id).await;
                if !send_catalog(&mut writer, &reply).await { break; }
            }
            incoming = reader.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    if window.elapsed() >= Duration::from_secs(1) { window = tokio::time::Instant::now(); commands = 0; }
                    commands += 1; if commands > 32 { break; }
                    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { break; };
                    if value.get("v").and_then(serde_json::Value::as_u64) == Some(2) {
                        let Ok(command) = serde_json::from_value::<WorkspaceCommand>(value) else { break; };
                        if matches!(command.action, WorkspaceAction::Subscribe { .. } | WorkspaceAction::Unsubscribe { .. }) {
                            // Socket-local effects must follow wire order, not JoinSet completion order.
                            let mut reply = state.runtime.command(command.clone()).await;
                            if reply.ok {
                                match &command.action {
                                    WorkspaceAction::Subscribe { session_id } => {
                                        if let Err(code) = subscribe(&mut slots, &state.runtime, &id, session_id).await { reply.ok = false; reply.code = code.into(); }
                                    }
                                    WorkspaceAction::Unsubscribe { session_id } => {
                                        if let Some(index) = slots.iter().position(|slot| slot.id == *session_id) {
                                            let slot = slots.remove(index); slot.handle.disconnect(id.clone()).await;
                                        }
                                    }
                                    _ => unreachable!(),
                                }
                            }
                            let reply = refreshed_reply(&state.runtime, reply).await;
                            if !send_catalog(&mut writer, &reply).await { break; }
                        } else {
                            if jobs.len() >= 8 { break; }
                            let manager = state.runtime.clone();
                            jobs.spawn(async move { manager.command(command).await });
                        }
                    } else {
                        let Ok(message) = serde_json::from_value::<BrowserMessage>(value) else { break; };
                        let Some(slot) = slots.iter().find(|slot| slot.id == message.session_id) else { break; };
                        if slot.handle.dispatch(id.clone(), message).is_err() { break; }
                    }
                }
                Some(Ok(Message::Pong(_))) => last_pong = tokio::time::Instant::now(),
                Some(Ok(Message::Ping(bytes))) => if !send(&mut writer, Message::Pong(bytes)).await { break; },
                _ => break,
            }
        }
    }
    jobs.abort_all();
    // A slow cleanup for one session must not postpone another session's dialog cancellation.
    let mut disconnects = tokio::task::JoinSet::new();
    for slot in slots {
        let id = id.clone();
        disconnects.spawn(async move {
            slot.handle.disconnect(id).await;
        });
    }
    while disconnects.join_next().await.is_some() {}
}
