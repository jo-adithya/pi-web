//! Bounded request deduplication scoped to one runtime epoch.
use crate::protocol::{BrowserAction, BrowserMessage, CommandResult, DialogAnswer};
use std::collections::VecDeque;

const MAX_CACHE_BYTES: usize = 512 * 1024;
const MAX_RESULTS: usize = 128;

pub(super) enum Admission {
    Fresh,
    Duplicate(Option<CommandResult>),
}
#[derive(Default)]
pub(super) struct Requests {
    entries: VecDeque<(BrowserMessage, Option<CommandResult>, usize)>,
    bytes: usize,
}
impl Requests {
    /// Remembers exact typed requests, retaining pending entries until resolved.
    /// Identical retries return their result; changed payloads never execute again.
    pub(super) fn begin(&mut self, message: &BrowserMessage) -> Result<Admission, &'static str> {
        validate(message)?;
        if let Some((old, result, _)) = self
            .entries
            .iter()
            .find(|(old, _, _)| old.request_id == message.request_id)
        {
            return if old == message {
                Ok(Admission::Duplicate(result.clone()))
            } else {
                Err("request_id_conflict")
            };
        }
        let size = serde_json::to_vec(message)
            .map_err(|_| "invalid_command")?
            .len();
        while self.entries.len() >= MAX_RESULTS || self.bytes + size > MAX_CACHE_BYTES {
            let Some(index) = self
                .entries
                .iter()
                .position(|(_, result, _)| result.is_some())
            else {
                return Err("overloaded");
            };
            self.bytes -= self.entries.remove(index).unwrap().2;
        }
        self.bytes += size;
        self.entries.push_back((message.clone(), None, size));
        Ok(Admission::Fresh)
    }
    /// Outstanding IDs are finalized on process exit, without changing completed results.
    pub(super) fn pending_ids(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(_, result, _)| result.is_none())
            .map(|(request, _, _)| request.request_id.clone())
            .collect()
    }
    pub(super) fn finish(&mut self, result: CommandResult) {
        if let Some((_, saved, _)) = self
            .entries
            .iter_mut()
            .find(|(request, _, _)| request.request_id == result.request_id)
        {
            *saved = Some(result);
        }
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
        BrowserAction::Prompt { text } if text.trim().is_empty() || text.len() > 32 * 1024 => {
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
            action: BrowserAction::Prompt { text: text.into() },
        }
    }
    #[test]
    fn identical_retries_are_deduplicated_but_conflicting_payloads_fail() {
        let mut requests = Requests::default();
        let message = request("hello");
        assert!(matches!(requests.begin(&message), Ok(Admission::Fresh)));
        assert!(matches!(
            requests.begin(&message),
            Ok(Admission::Duplicate(None))
        ));
        assert!(matches!(
            requests.begin(&request("changed")),
            Err("request_id_conflict")
        ));
        let result = CommandResult {
            request_id: "request".into(),
            ok: true,
            code: "accepted".into(),
            disposition: Some("started".into()),
            recovered_draft: None,
        };
        requests.finish(result.clone());
        assert!(
            matches!(requests.begin(&message), Ok(Admission::Duplicate(Some(saved))) if saved == result)
        );
    }
    #[test]
    fn invalid_bounds_rejected_before_retention() {
        let mut requests = Requests::default();
        for text in [String::new(), " ".into(), "x".repeat(32 * 1024 + 1)] {
            assert!(requests.begin(&request(&text)).is_err());
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
            assert!(requests.begin(&message).is_ok());
        }
        assert!(matches!(
            requests.begin(&request("last")),
            Err("overloaded")
        ));
        assert_eq!(requests.entries.len(), 128);
    }
}
