//! Bounded request deduplication scoped to one runtime epoch.
use crate::protocol::{BrowserAction, BrowserMessage, CommandResult, DialogAnswer};
use std::collections::VecDeque;

const MAX_CACHE_BYTES: usize = 512 * 1024;
const MAX_RESULTS: usize = 128;

pub(super) enum Admission {
    Fresh(String),
    Duplicate(Option<CommandResult>),
}
struct Entry {
    client: String,
    token: String,
    message: BrowserMessage,
    result: Option<CommandResult>,
    bytes: usize,
}
/// Bounded per-epoch retries keyed by connection and browser request identity.
#[derive(Default)]
pub(super) struct Requests {
    entries: VecDeque<Entry>,
    bytes: usize,
    next: u64,
}
impl Requests {
    /// Retains validated requests and returns an internal token for async completions.
    /// Identical retries share a result only within the same connection.
    pub(super) fn begin(
        &mut self,
        client: &str,
        message: &BrowserMessage,
    ) -> Result<Admission, &'static str> {
        validate(message)?;
        if let Some(entry) = self
            .entries
            .iter()
            .find(|entry| entry.client == client && entry.message.request_id == message.request_id)
        {
            return if &entry.message == message {
                Ok(Admission::Duplicate(entry.result.clone()))
            } else {
                Err("request_id_conflict")
            };
        }
        let next = self.next.checked_add(1).ok_or("overloaded")?;
        let token = next.to_string();
        let size = serde_json::to_vec(message)
            .map_err(|_| "invalid_command")?
            .len()
            + client.len()
            + token.len();
        while self.entries.len() >= MAX_RESULTS || self.bytes + size > MAX_CACHE_BYTES {
            let Some(index) = self.entries.iter().position(|entry| entry.result.is_some()) else {
                return Err("overloaded");
            };
            self.bytes -= self.entries.remove(index).unwrap().bytes;
        }
        self.next = next;
        self.bytes += size;
        self.entries.push_back(Entry {
            client: client.into(),
            token: token.clone(),
            message: message.clone(),
            result: None,
            bytes: size,
        });
        Ok(Admission::Fresh(token))
    }
    /// Internal tokens still awaiting completion, including disconnected requesters.
    pub(super) fn pending_ids(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|entry| entry.result.is_none())
            .map(|entry| entry.token.clone())
            .collect()
    }
    /// Restores the browser identity and returns the owning connection for delivery.
    pub(super) fn finish(&mut self, mut result: CommandResult) -> Option<(String, CommandResult)> {
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.token == result.request_id)?;
        result.request_id = entry.message.request_id.clone();
        entry.result = Some(result.clone());
        Some((entry.client.clone(), result))
    }
}

/// Shape decoding alone is insufficient: enforce all browser-owned string limits.
pub(super) fn validate(message: &BrowserMessage) -> Result<(), &'static str> {
    if message.v != 1 {
        return Err("protocol_version");
    }
    if !token(&message.request_id) || message.session_id.len() > 64 || message.epoch.len() > 64 {
        return Err("invalid_identity");
    }
    match &message.action {
        BrowserAction::SetModel { provider, model_id }
            if !super::settings::identity(provider) || !super::settings::identity(model_id) =>
        {
            Err("invalid_model")
        }
        BrowserAction::Prompt { text, images } if (text.trim().is_empty() && images.is_empty()) || text.len() > 32 * 1024 || images.len() > 4 || images.iter().any(|id| !crate::images::valid_ref(id)) => {
            Err("invalid_prompt")
        }
        BrowserAction::UiReply { dialog_id, answer } => {
            if dialog_id.is_empty() || dialog_id.len() > 1024 {
                return Err("invalid_dialog");
            }
            if matches!(answer, DialogAnswer::Value { value } if value.len() > 16 * 1024) {
                return Err("invalid_answer");
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(text: &str) -> BrowserMessage {
        BrowserMessage {
            v: 1,
            session_id: "session".into(),
            epoch: "epoch".into(),
            request_id: "request".into(),
            action: BrowserAction::Prompt { text: text.into(), images: vec![] },
        }
    }
    #[test]
    fn identical_retries_are_deduplicated_but_conflicting_payloads_fail() {
        let mut requests = Requests::default();
        let message = request("hello");
        let Ok(Admission::Fresh(token)) = requests.begin("client", &message) else {
            panic!("fresh request")
        };
        assert!(matches!(
            requests.begin("client", &message),
            Ok(Admission::Duplicate(None))
        ));
        assert!(matches!(
            requests.begin("client", &request("changed")),
            Err("request_id_conflict")
        ));
        let result = CommandResult {
            request_id: "request".into(),
            ok: true,
            code: "accepted".into(),
            disposition: Some("started".into()),
            recovered_draft: None,
        };
        let mut completion = result.clone();
        completion.request_id = token;
        requests.finish(completion);
        assert!(
            matches!(requests.begin("client", &message), Ok(Admission::Duplicate(Some(saved))) if saved == result)
        );
    }
    #[test]
    fn clients_with_identical_request_ids_keep_independent_pending_results() {
        let mut requests = Requests::default();
        let message = request("hello");
        let Ok(Admission::Fresh(first)) = requests.begin("first", &message) else {
            panic!("fresh request")
        };
        let Ok(Admission::Fresh(second)) = requests.begin("second", &message) else {
            panic!("fresh request")
        };
        assert_ne!(first, second);
        assert_eq!(requests.pending_ids(), vec![first.clone(), second.clone()]);
        let (owner, saved) = requests
            .finish(CommandResult {
                request_id: second,
                ok: false,
                code: "busy".into(),
                disposition: None,
                recovered_draft: None,
            })
            .unwrap();
        assert_eq!(owner, "second");
        assert_eq!(saved.request_id, "request");
        assert!(matches!(
            requests.begin("first", &message),
            Ok(Admission::Duplicate(None))
        ));
        assert!(
            matches!(requests.begin("second", &message), Ok(Admission::Duplicate(Some(result))) if result == saved)
        );
        assert_eq!(requests.pending_ids(), vec![first]);
    }
    #[test]
    fn invalid_bounds_rejected_before_retention() {
        let mut requests = Requests::default();
        for text in [String::new(), " ".into(), "x".repeat(32 * 1024 + 1)] {
            assert!(requests.begin("client", &request(&text)).is_err());
        }
        assert_eq!(requests.bytes, 0);
        let mut message = request("x");
        message.v = 2;
        assert_eq!(validate(&message), Err("protocol_version"));
        message.v = 1;
        message.request_id = "bad id".into();
        assert!(validate(&message).is_err());
    }
    #[test]
    fn pending_work_is_not_evicted_to_accept_more_commands() {
        let mut requests = Requests::default();
        for index in 0..128 {
            let mut message = request("x");
            message.request_id = index.to_string();
            assert!(requests.begin("client", &message).is_ok());
        }
        assert!(matches!(
            requests.begin("client", &request("last")),
            Err("overloaded")
        ));
        assert_eq!(requests.entries.len(), 128);
    }
}
