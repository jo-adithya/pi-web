//! Continuous source-anchored discussions and retained imports. Revision checks protect concurrent devices.
use crate::{local_review::validate_path, metadata::MetadataStore};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub(crate) const MAX_BYTES: usize = 16 * 1024 * 1024;
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request { pub revision: Option<u64>, pub document: Option<Document> }

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Document {
    pub version: u8,
    pub revision: u64,
    pub rounds: Vec<Round>,
    pub threads: Vec<Thread>,
    pub routes: Routes,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Routes { pub explain: Option<Model>, pub review: Option<Model>, pub budget: usize }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Model { pub provider: String, pub id: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Round { pub id: String, pub label: String, pub source: String, pub files: Vec<File> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct File {
    pub path: String, pub previous_path: Option<String>, pub status: String,
    pub patch: String, pub fingerprint: String, pub reviewed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkout_key: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Anchor {
    pub round: String, pub path: String, pub start: usize, pub end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live: Option<LiveSource>,
}
/// A live discussion retains only its quoted diff rows and identity for detecting stale code.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LiveSource {
    pub quote: String, pub fingerprint: String, pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkout_key: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Thread {
    pub id: String, pub anchor: Anchor, pub chapter: String, pub kind: Kind,
    pub status: Status, pub messages: Vec<Message>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind { Discussion, Author, Finding }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Status { Open, Addressed, Verified }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Message { pub role: Role, pub text: String, pub model: Option<String>, pub usage: Option<String> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Role { Human, Assistant, Author }
impl Default for Document {
    fn default() -> Self { Self { version: 1, revision: 0, rounds: vec![], threads: vec![], routes: Routes { explain: None, review: None, budget: 16 * 1024 } } }
}
fn bounded(value: &str, max: usize) -> bool { !value.trim().is_empty() && value.len() <= max && !value.contains('\0') }
fn id(value: &str) -> bool { bounded(value, 80) && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') }
impl Document {
    /// Checks identities, byte budgets and anchors against a bounded live quote or retained source patch.
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1 || self.revision > 9_007_199_254_740_990 || self.rounds.len() > 16 || self.threads.len() > 128
            || !(4096..=48 * 1024).contains(&self.routes.budget) { return Err("Review limits: 16 rounds, 128 threads, 4–48 KiB AI input budget"); }
        for model in [&self.routes.explain, &self.routes.review].into_iter().flatten() {
            if [&model.provider, &model.id].iter().any(|s| !bounded(s, 256) || s.starts_with('-') || s.chars().any(char::is_control)) { return Err("Invalid review model"); }
        }
        let mut ids = HashSet::new();
        for round in &self.rounds {
            if !id(&round.id) || !ids.insert(&round.id) || !bounded(&round.label, 160) || !bounded(&round.source, 1024) || round.files.len() > 1000 { return Err("Invalid review round"); }
            let mut paths = HashSet::new();
            for file in &round.files {
                if validate_path(&file.path).is_err() || !paths.insert(&file.path)
                    || file.previous_path.as_ref().is_some_and(|path| validate_path(path).is_err())
                    || file.checkout_key.as_ref().is_some_and(|key| key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()))
                    || !bounded(&file.fingerprint, 256) || !bounded(&file.status, 32) || file.patch.len() > 64 * 1024 || file.patch.contains('\0') {
                    return Err("Invalid saved file; patches must fit within 64 KiB");
                }
            }
        }
        let mut threads = HashSet::new();
        for thread in &self.threads {
            if !id(&thread.id) || !threads.insert(&thread.id) || thread.chapter.len() > 80 || thread.messages.is_empty() || thread.messages.len() > 32 { return Err("Invalid review thread"); }
            let anchor = &thread.anchor;
            if let Some(live) = &anchor.live {
                if anchor.round != "live" || validate_path(&anchor.path).is_err()
                    || anchor.start == 0 || anchor.end < anchor.start || anchor.end > 1_000_000_000
                    || !bounded(&live.quote, 64 * 1024) || !bounded(&live.fingerprint, 256) || !bounded(&live.target, 1024)
                    || live.quote.split('\n').count() != anchor.end - anchor.start + 1
                    || live.checkout_key.as_ref().is_some_and(|key| key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit())) {
                    return Err("Invalid live discussion source");
                }
            } else {
                let file = self.rounds.iter().find(|r| r.id == anchor.round)
                    .and_then(|r| r.files.iter().find(|f| f.path == anchor.path)).ok_or("Thread source round or file is missing")?;
                if anchor.start == 0 || anchor.end < anchor.start || anchor.end > file.patch.trim_end_matches('\n').split('\n').count() { return Err("Thread anchor is outside its captured patch"); }
            }
            for message in &thread.messages {
                if !bounded(&message.text, 16000) || message.model.as_ref().is_some_and(|s| !bounded(s, 512)) || message.usage.as_ref().is_some_and(|s| !bounded(s, 2048)) { return Err("Review message exceeds its limits"); }
            }
        }
        if serde_json::to_vec(self).map_err(|_| "Cannot encode review")?.len() > MAX_BYTES { return Err("Saved review exceeds 16 MiB. Export and clear completed work before adding discussions"); }
        Ok(())
    }
}

/// Loads or atomically replaces one conversation's review. The caller serializes writes until persistence completes.
/// Conflict is separate from validation and storage failures; a failed write preserves the previous document.
pub(crate) fn transact(store: &MetadataStore, session: &str, request: Request) -> Result<Document, (&'static str, u16)> {
    let store = store.child("reviews").map_err(|_| ("Cannot open private review storage", 500))?;
    let name = format!("{session}.json");
    let current: Document = store.load_bounded_document(&name, MAX_BYTES).map_err(|_| ("Saved review is unreadable; existing data was retained", 500))?.unwrap_or_default();
    current.validate().map_err(|message| (message, 500))?;
    match request.document {
        None if request.revision.is_none() => Ok(current),
        Some(mut document) => {
            if request.revision != Some(current.revision) { return Err(("Review changed on another device. Reload saved review before editing", 409)); }
            for old in &current.rounds {
                if let Some(next) = document.rounds.iter().find(|round| round.id == old.id) {
                    if old.source != next.source || old.files.len() != next.files.len() || old.files.iter().zip(&next.files).any(|(a, b)| a.path != b.path || a.previous_path != b.previous_path || a.patch != b.patch || a.fingerprint != b.fingerprint || a.status != b.status || a.checkout_key != b.checkout_key) {
                        return Err(("Saved source patches are immutable; capture a new round", 400));
                    }
                }
            }
            for old in &current.threads {
                if let Some(next) = document.threads.iter().find(|thread| thread.id == old.id) {
                    if serde_json::to_value(&old.anchor).ok() != serde_json::to_value(&next.anchor).ok()
                        || next.messages.len() < old.messages.len()
                        || old.messages.iter().zip(&next.messages).any(|(a, b)| serde_json::to_value(a).ok() != serde_json::to_value(b).ok()) {
                        return Err(("Thread anchors and existing replies are immutable", 400));
                    }
                }
            }
            document.revision = current.revision + 1;
            document.validate().map_err(|message| (message, 400))?;
            store.save_document(&name, &document).map_err(|_| ("Could not save review; previous data was retained", 500))?;
            Ok(document)
        }
        _ => Err(("Expected an empty load request or a document and revision", 400)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_roundless_discussions_and_keeps_their_source_and_replies_immutable() {
        let root = std::env::temp_dir().join(format!("pi-live-review-{}", crate::config::identity().unwrap()));
        let store = MetadataStore::open(&root).unwrap();
        let mut doc = Document::default();
        doc.threads.push(serde_json::from_value(serde_json::json!({
            "id":"thread-1", "anchor": {"round":"live", "path":"a.ts", "start":5, "end":6,
                "live": {"quote":"-old\n+new", "fingerprint":"one", "target":"{\"scope\":\"unstaged\"}"}},
            "chapter":"", "kind":"discussion", "status":"open",
            "messages":[{"role":"human", "text":"Does this preserve retries?", "model":null, "usage":null}]
        })).unwrap());
        let saved = transact(&store, "session", Request { revision: Some(0), document: Some(doc) }).unwrap();
        assert!(saved.rounds.is_empty());
        let loaded = transact(&store, "session", Request::default()).unwrap();
        assert_eq!(loaded.threads[0].anchor.live.as_ref().unwrap().quote, "-old\n+new");
        let mut forged = saved.clone();
        forged.threads[0].anchor.live.as_mut().unwrap().quote = "-old\n+forged".into();
        assert_eq!(transact(&store, "session", Request { revision: Some(1), document: Some(forged) }).err().unwrap().1, 400);
        let mut reply = saved.clone();
        reply.threads[0].messages.push(Message { role: Role::Human, text: "Please check cancellation too.".into(), model: None, usage: None });
        assert_eq!(transact(&store, "session", Request { revision: Some(1), document: Some(reply) }).unwrap().revision, 2);
        let mut invalid = saved;
        invalid.threads[0].anchor.end = 7;
        assert_eq!(invalid.validate().unwrap_err(), "Invalid live discussion source");
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_dangling_threads_and_oversized_budgets() {
        let mut doc = Document::default();
        doc.routes.budget = 100_000;
        assert!(doc.validate().is_err());
        doc.routes.budget = 4096;
        doc.threads.push(Thread { id: "thread-1".into(), anchor: Anchor { round: "missing".into(), path: "a".into(), start: 1, end: 1, live: None }, chapter: "".into(), kind: Kind::Discussion, status: Status::Open, messages: vec![Message { role: Role::Human, text: "question".into(), model: None, usage: None }] });
        assert_eq!(doc.validate().unwrap_err(), "Thread source round or file is missing");
    }
}
