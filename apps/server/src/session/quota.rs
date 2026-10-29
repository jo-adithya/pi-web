//! Runtime-owned, bounded Codex usage cache shared by all conversation subscribers.
use crate::protocol::{CodexUsage, CodexWindow};
use serde::Deserialize;
use tokio::time::{Duration, Instant};

pub(super) const PREFIX: &str = "pi-web:codex-usage:v1:";
const DEDUPE: Duration = Duration::from_secs(3);
#[derive(Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Reply {
    Checking {
        request_id: String,
        clear: bool,
    },
    Unavailable {
        request_id: String,
        clear: bool,
    },
    Ok {
        request_id: String,
        clear: bool,
        windows: Vec<CodexWindow>,
        observed_at: u32,
    },
}
struct Pending {
    token: String,
    deadline: Instant,
    ack: bool,
    reply: Option<Reply>,
}
/// No network timer: expiry only finishes existing work. Identity changes discard all cached data.
pub(super) struct Cache {
    pub value: CodexUsage,
    pending: Option<Pending>,
    success: Option<Instant>,
}
impl Default for Cache {
    fn default() -> Self {
        Self {
            value: CodexUsage {
                unavailable: true,
                ..CodexUsage::default()
            },
            pending: None,
            success: None,
        }
    }
}
impl Cache {
    /// Coalesces in-flight requests and successful focus bursts for three seconds, including taps.
    pub fn begin(&mut self, token: String, now: Instant) -> bool {
        if self.pending.is_some()
            || self
                .success
                .is_some_and(|at| now.duration_since(at) < DEDUPE)
        {
            return false;
        }
        self.pending = Some(Pending {
            token,
            deadline: now + Duration::from_secs(15),
            ack: false,
            reply: None,
        });
        self.value.loading = true;
        true
    }
    pub fn ack(&mut self, token: &str, handled: bool) {
        let Some(wait) = &mut self.pending else {
            return;
        };
        if wait.token != token {
            return;
        }
        if !handled {
            self.fail();
            return;
        }
        wait.ack = true;
        self.finish();
    }
    /// Consumes only bounded correlated private replies, never forwarding provider text.
    pub fn notify(&mut self, encoded: &str) {
        if encoded.len() > 4096 {
            return;
        }
        let Ok(reply) = serde_json::from_str::<Reply>(encoded) else {
            return;
        };
        let (token, clear) = match &reply {
            Reply::Checking { request_id, clear }
            | Reply::Unavailable { request_id, clear }
            | Reply::Ok {
                request_id, clear, ..
            } => (request_id, *clear),
        };
        let Some(wait) = &mut self.pending else {
            return;
        };
        if &wait.token != token {
            return;
        }
        if let Reply::Ok {
            windows,
            observed_at,
            ..
        } = &reply
        {
            if *observed_at == 0
                || windows.is_empty()
                || windows.len() > 2
                || windows.iter().any(|w| {
                    !w.used_percent.is_finite()
                        || !(0.0..=100.0).contains(&w.used_percent)
                        || w.duration_seconds == 0
                        || w.duration_seconds > 366 * 86400
                        || w.resets_at < *observed_at
                        || w.resets_at - observed_at > 366 * 86400
                })
                || (windows.len() == 2 && windows[0].identity == windows[1].identity)
            {
                return;
            }
        }
        if clear {
            self.value = CodexUsage {
                loading: true,
                unavailable: true,
                ..CodexUsage::default()
            };
            self.success = None;
        }
        if matches!(reply, Reply::Checking { .. }) {
            return;
        }
        wait.reply = Some(reply);
        self.finish();
    }
    fn finish(&mut self) {
        if !self
            .pending
            .as_ref()
            .is_some_and(|w| w.ack && w.reply.is_some())
        {
            return;
        }
        let reply = self.pending.take().unwrap().reply.unwrap();
        match reply {
            Reply::Ok {
                windows,
                observed_at,
                ..
            } => {
                self.value = CodexUsage {
                    windows,
                    observed_at: Some(observed_at),
                    loading: false,
                    stale: false,
                    unavailable: false,
                };
                self.success = Some(Instant::now());
            }
            _ => self.fail(),
        }
    }
    fn fail(&mut self) {
        self.pending = None;
        self.value.loading = false;
        self.value.stale = !self.value.windows.is_empty();
        self.value.unavailable = true;
    }
    pub fn expire(&mut self, now: Instant) -> bool {
        if self.pending.as_ref().is_some_and(|w| w.deadline <= now) {
            self.fail();
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn success(token: &str) -> String {
        format!(
            r#"{{"status":"ok","requestId":"{token}","clear":false,"observedAt":100,"windows":[{{"identity":"primary","durationSeconds":18000,"usedPercent":72.5,"resetsAt":200}}]}}"#
        )
    }
    #[test]
    fn subscribers_coalesce_and_both_ack_and_reply_are_required() {
        let mut cache = Cache::default();
        let now = Instant::now();
        assert!(cache.begin("one".into(), now));
        assert!(!cache.begin("phone".into(), now));
        cache.notify(&success("wrong"));
        assert!(cache.value.windows.is_empty());
        cache.notify(&success("one"));
        assert!(cache.value.windows.is_empty());
        cache.ack("one", true);
        assert_eq!(cache.value.windows[0].used_percent, 72.5);
        assert!(!cache.begin("burst".into(), now + Duration::from_secs(1)));
        assert!(cache.begin("tap".into(), now + Duration::from_secs(4)));
        cache.ack("tap", false);
        assert!(cache.value.stale);
        assert_eq!(cache.value.windows.len(), 1);
    }
    #[test]
    fn timeout_retains_success_but_account_clear_and_reset_discard_it() {
        let mut cache = Cache::default();
        let now = Instant::now();
        cache.begin("one".into(), now);
        cache.ack("one", true);
        cache.notify(&success("one"));
        cache.begin("two".into(), now + Duration::from_secs(4));
        assert!(cache.expire(now + Duration::from_secs(20)));
        assert!(cache.value.stale);
        cache.begin("three".into(), now + Duration::from_secs(21));
        cache.notify(r#"{"status":"checking","requestId":"three","clear":true}"#);
        assert!(cache.value.windows.is_empty());
        cache = Cache::default();
        cache.notify(&success("three"));
        assert!(cache.value.windows.is_empty());
    }
    #[test]
    fn malformed_limits_cannot_replace_success() {
        for invalid in [
            success("one").replace("72.5", "101"),
            success("one").replace("18000", "0"),
            success("one").replace("200", "99"),
        ] {
            let mut cache = Cache::default();
            let now = Instant::now();
            cache.begin("one".into(), now);
            cache.ack("one", true);
            cache.notify(&invalid);
            assert!(cache.value.loading);
            assert!(cache.expire(now + Duration::from_secs(16)));
            assert!(cache.value.windows.is_empty());
        }
    }
}
