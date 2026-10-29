//! Explicit, origin-bound device subscriptions for this server's workspace catalog.
//! One bounded worker serializes persistence and delivery; sessions only try-enqueue.
use crate::metadata::MetadataStore;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::{SecretKey, elliptic_curve::rand_core::OsRng};
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    io,
    path::Path,
    pin::Pin,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot};
use web_push::{
    ContentEncoding, SubscriptionInfo, VapidSignatureBuilder, WebPushMessage, WebPushMessageBuilder,
};

const MAX_SUBSCRIBERS: usize = 16;
const LIFETIME: u64 = 30 * 24 * 60 * 60;
const PAYLOAD: &[u8] =
    br#"{"title":"Pi Web","body":"A workspace task finished. Open Pi Web to review."}"#;

/// Accepts only stable Chromium FCM endpoints, without URL normalization.
/// Source: Chromium components/push_messaging/push_messaging_constants.cc.
fn valid_endpoint(endpoint: &str) -> bool {
    endpoint.len() <= 2048
        && [
            "https://fcm.googleapis.com/fcm/send/",
            "https://fcm.googleapis.com/wp/",
        ]
        .iter()
        .any(|prefix| {
            endpoint.strip_prefix(prefix).is_some_and(|token| {
                !token.is_empty()
                    && token
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_:-".contains(&b))
            })
        })
}
fn secret_valid(secret: &str) -> bool {
    secret.len() == 64 && secret.bytes().all(|b| b.is_ascii_hexdigit())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Keys {
    p256dh: String,
    auth: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Subscription {
    endpoint: String,
    keys: Keys,
    expiration_time: Option<u64>,
}
impl Subscription {
    fn valid(&self) -> bool {
        valid_endpoint(&self.endpoint)
            && self.keys.p256dh.len() == 87
            && URL_SAFE_NO_PAD
                .decode(&self.keys.p256dh)
                .ok()
                .is_some_and(|key| {
                    key.len() == 65 && key[0] == 4 && p256::PublicKey::from_sec1_bytes(&key).is_ok()
                })
            && self.keys.auth.len() == 22
            && URL_SAFE_NO_PAD
                .decode(&self.keys.auth)
                .ok()
                .is_some_and(|key| key.len() == 16)
            && self
                .expiration_time
                .is_none_or(|expiry| expiry / 1000 > now())
    }
    fn info(&self) -> SubscriptionInfo {
        SubscriptionInfo::new(&self.endpoint, &self.keys.p256dh, &self.keys.auth)
    }
}
/// All operations additionally require the current HTTP capability and exact Origin.
#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Setup {},
    Subscribe {
        secret: String,
        subscription: Subscription,
    },
    Remove {
        secret: String,
    },
    Test {
        secret: String,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Device {
    secret: String,
    origin: String,
    expires: u64,
    subscription: Subscription,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    private_key: String,
    devices: Vec<Device>,
}
impl Record {
    fn load(store: &MetadataStore) -> io::Result<Self> {
        let record = match store.load_record::<Self>("push.json")? {
            Some(record) => record,
            None => Self {
                version: 1,
                private_key: URL_SAFE_NO_PAD.encode(SecretKey::random(&mut OsRng).to_bytes()),
                devices: vec![],
            },
        };
        if record.version != 1
            || record.devices.len() > MAX_SUBSCRIBERS
            || VapidSignatureBuilder::from_base64_no_sub(&record.private_key).is_err()
            || record.devices.iter().any(|d| {
                !secret_valid(&d.secret)
                    || !valid_endpoint(&d.subscription.endpoint)
                    || d.origin.len() > 300
            })
        {
            return Err(io::Error::other("invalid private push metadata"));
        }
        store.save_record("push.json", &record)?;
        Ok(record)
    }
}
/// Clears persistent devices while preserving the signing key. Requires exclusive store ownership.
/// Call with the server stopped; capability rotation and ordinary restarts do not revoke devices.
pub fn revoke_all(root: &Path) -> io::Result<()> {
    let store = MetadataStore::open(root)?;
    let mut record = Record::load(&store)?;
    record.devices.clear();
    store.save_record("push.json", &record)
}

type Delivery = Pin<Box<dyn Future<Output = Result<u16, ()>> + Send>>;
trait Transport: Send + 'static {
    fn send(&self, message: WebPushMessage) -> Delivery;
}
struct Provider(reqwest::Client);
impl Transport for Provider {
    fn send(&self, message: WebPushMessage) -> Delivery {
        // web-push owns encryption and VAPID. Its HTTP builder performs no I/O or logging.
        let request = web_push::request_builder::build_request::<Vec<u8>>(message);
        let mut outbound = self.0.post(request.uri().to_string());
        for (name, value) in request.headers() {
            outbound = outbound.header(name.as_str(), value.as_bytes());
        }
        let outbound = outbound.body(request.into_body());
        Box::pin(async move {
            // Status is sufficient; never buffer/log provider response bodies or endpoint errors.
            outbound
                .send()
                .await
                .map(|response| response.status().as_u16())
                .map_err(|_| ())
        })
    }
}
type RequestReply = (
    Request,
    oneshot::Sender<Result<serde_json::Value, &'static str>>,
);
/// A best-effort bounded mailbox. Queue saturation never delays session settlement.
#[derive(Clone)]
pub struct PushService {
    tx: mpsc::Sender<RequestReply>,
    completions: mpsc::Sender<tokio::time::Instant>,
}
impl PushService {
    /// Opens private state and starts one delivery worker. No network traffic occurs without consent.
    pub fn start(root: &Path, origin: String) -> io::Result<Self> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .connect_timeout(Duration::from_secs(4))
            .build()
            .map_err(|_| io::Error::other("push transport initialization failed"))?;
        Self::with_transport(root, origin, Provider(client))
    }
    fn with_transport(root: &Path, origin: String, transport: impl Transport) -> io::Result<Self> {
        let store = MetadataStore::open(root)?;
        let record = Record::load(&store)?;
        let (tx, mut rx) = mpsc::channel::<RequestReply>(8);
        let (completions, mut completed) = mpsc::channel::<tokio::time::Instant>(32);
        tokio::spawn(async move {
            let mut worker = Worker {
                store,
                record,
                origin,
                transport,
                last_test: None,
                pending_test: None,
            };
            loop {
                tokio::select! {
                    biased;
                    command = rx.recv() => match command {
                        Some((request, reply)) => {
                            let _ = reply.send(worker.request(request));
                            if let Some(secret) = worker.pending_test.take() { worker.deliver(Some(&secret)).await; }
                        }
                        None => break,
                    },
                    completion = completed.recv() => match completion {
                        Some(queued) if queued.elapsed() < Duration::from_secs(30) => worker.deliver(None).await,
                        Some(_) => {},
                        None => break,
                    },
                }
            }
        });
        Ok(Self { tx, completions })
    }
    /// Enqueues a main-run completion; the session's run gate suppresses duplicates and aborts.
    pub(crate) fn completed(&self) {
        let _ = self.completions.try_send(tokio::time::Instant::now());
    }
    /// Admits one bounded management operation; timeout can mean persistence succeeded.
    pub async fn request(&self, request: Request) -> Result<serde_json::Value, &'static str> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .try_send((request, tx))
            .map_err(|_| "busy")?;
        tokio::time::timeout(Duration::from_secs(12), rx)
            .await
            .map_err(|_| "busy")?
            .map_err(|_| "unavailable")?
    }
}
struct Worker<T> {
    store: MetadataStore,
    record: Record,
    origin: String,
    transport: T,
    last_test: Option<tokio::time::Instant>,
    pending_test: Option<String>,
}
impl<T: Transport> Worker<T> {
    fn save(&mut self, next: Record) -> Result<(), &'static str> {
        self.store
            .save_record("push.json", &next)
            .map_err(|_| "storage")?;
        self.record = next;
        Ok(())
    }
    fn request(&mut self, request: Request) -> Result<serde_json::Value, &'static str> {
        match request {
            Request::Setup {} => {
                let key = VapidSignatureBuilder::from_base64_no_sub(&self.record.private_key)
                    .map_err(|_| "storage")?
                    .get_public_key();
                return Ok(serde_json::json!({ "publicKey": URL_SAFE_NO_PAD.encode(key) }));
            }
            Request::Subscribe {
                secret,
                subscription,
            } => {
                if !secret_valid(&secret) || !subscription.valid() {
                    return Err("invalid");
                }
                let mut next = self.record.clone();
                next.devices.retain(|d| d.expires > now());
                if next
                    .devices
                    .iter()
                    .any(|d| d.subscription.endpoint == subscription.endpoint && d.secret != secret)
                {
                    return Err("conflict");
                }
                next.devices.retain(|d| d.secret != secret);
                if next.devices.len() >= MAX_SUBSCRIBERS {
                    return Err("full");
                }
                let expires = subscription
                    .expiration_time
                    .map_or(now() + LIFETIME, |time| (time / 1000).min(now() + LIFETIME));
                next.devices.push(Device {
                    secret,
                    subscription,
                    expires,
                    origin: self.origin.clone(),
                });
                self.save(next)?;
            }
            Request::Remove { secret } => {
                if !secret_valid(&secret) {
                    return Err("invalid");
                }
                let mut next = self.record.clone();
                next.devices
                    .retain(|d| d.secret != secret || d.origin != self.origin);
                self.save(next)?;
            }
            Request::Test { secret } => {
                if !secret_valid(&secret) {
                    return Err("invalid");
                }
                if !self
                    .record
                    .devices
                    .iter()
                    .any(|d| d.secret == secret && d.origin == self.origin && d.expires > now())
                {
                    return Err("missing");
                }
                if self
                    .last_test
                    .is_some_and(|last| last.elapsed() < Duration::from_secs(60))
                {
                    return Err("rate_limited");
                }
                self.last_test = Some(tokio::time::Instant::now());
                self.pending_test = Some(secret);
            }
        }
        Ok(serde_json::Value::Null)
    }
    async fn deliver(&mut self, only: Option<&str>) {
        let mut next = self.record.clone();
        next.devices.retain(|d| d.expires > now());
        let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
        for device in &self.record.devices {
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            if device.origin != self.origin
                || device.expires <= now()
                || only.is_some_and(|s| s != device.secret)
            {
                continue;
            }
            let info = device.subscription.info();
            let message = (|| {
                let mut signature =
                    VapidSignatureBuilder::from_base64(&self.record.private_key, &info)?;
                signature.add_claim("sub", self.origin.clone());
                let mut message = WebPushMessageBuilder::new(&info);
                message.set_vapid_signature(signature.build()?);
                message.set_payload(ContentEncoding::Aes128Gcm, PAYLOAD);
                message.set_ttl(300);
                message.build()
            })();
            if let Ok(message) = message {
                let result = tokio::time::timeout_at(deadline, self.transport.send(message)).await;
                if matches!(result, Ok(Ok(404 | 410))) {
                    next.devices.retain(|d| d.secret != device.secret);
                }
            }
        }
        if next.devices.len() != self.record.devices.len() {
            let _ = self.save(next);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_are_only_stable_chromium_fcm_paths() {
        assert!(valid_endpoint(
            "https://fcm.googleapis.com/wp/token:abc_123-xyz"
        ));
        assert!(valid_endpoint("https://fcm.googleapis.com/fcm/send/token"));
        for endpoint in [
            "http://fcm.googleapis.com/wp/token",
            "https://127.0.0.1/wp/token",
            "https://fcm.googleapis.com.evil/wp/token",
            "https://fcm.googleapis.com:443/wp/token",
            "https://user@fcm.googleapis.com/wp/token",
            "https://fcm.googleapis.com/wp/token?q=x",
            "https://fcm.googleapis.com/wp/token#x",
            "https://fcm.googleapis.com/wp/../token",
            "https://fcm.googleapis.com/wp/",
            "https://fcm.googleapis.com/preprod/wp/token",
        ] {
            assert!(!valid_endpoint(endpoint), "accepted {endpoint}");
        }
    }
    use std::sync::{Arc, Mutex};
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "pi-web-push-{}",
                crate::config::identity().unwrap()
            ));
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&root)
                .unwrap();
            Self(root)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[derive(Clone)]
    struct Mock {
        sent: Arc<Mutex<Vec<String>>>,
        status: u16,
    }
    impl Transport for Mock {
        fn send(&self, message: WebPushMessage) -> Delivery {
            self.sent.lock().unwrap().push(message.endpoint.to_string());
            let status = self.status;
            Box::pin(async move { if status == 0 { Err(()) } else { Ok(status) } })
        }
    }
    fn subscription(token: &str) -> Subscription {
        use p256::elliptic_curve::sec1::ToEncodedPoint;
        let key = SecretKey::random(&mut OsRng);
        Subscription {
            endpoint: format!("https://fcm.googleapis.com/wp/{token}"),
            expiration_time: None,
            keys: Keys {
                p256dh: URL_SAFE_NO_PAD.encode(key.public_key().to_encoded_point(false).as_bytes()),
                auth: URL_SAFE_NO_PAD.encode([7; 16]),
            },
        }
    }
    fn worker(root: &Path, status: u16) -> Worker<Mock> {
        let store = MetadataStore::open(root).unwrap();
        let record = Record::load(&store).unwrap();
        Worker {
            store,
            record,
            origin: "https://desktop.tail.ts.net".into(),
            transport: Mock {
                sent: Arc::default(),
                status,
            },
            last_test: None,
            pending_test: None,
        }
    }
    fn add(worker: &mut Worker<Mock>, secret: &str, token: &str) {
        worker
            .request(Request::Subscribe {
                secret: secret.repeat(64),
                subscription: subscription(token),
            })
            .unwrap();
    }
    #[tokio::test]
    async fn device_optout_expiry_origin_and_provider_failures_are_isolated() {
        let root = Temp::new();
        let mut w = worker(&root.0, 201);
        add(&mut w, "a", "a");
        add(&mut w, "b", "b");
        w.request(Request::Remove {
            secret: "a".repeat(64),
        })
        .unwrap();
        w.deliver(None).await;
        assert_eq!(
            *w.transport.sent.lock().unwrap(),
            vec!["https://fcm.googleapis.com/wp/b"]
        );
        for status in [500, 429, 0] {
            w.transport.status = status;
            w.deliver(None).await;
            assert_eq!(w.record.devices.len(), 1);
        }
        for status in [404, 410] {
            w.transport.status = status;
            w.deliver(None).await;
            assert!(w.record.devices.is_empty());
            add(&mut w, "b", "b");
        }
        w.record.devices[0].expires = now();
        w.deliver(None).await;
        assert!(w.record.devices.is_empty());
        add(&mut w, "a", "a");
        let count = w.transport.sent.lock().unwrap().len();
        w.origin = "https://other.tail.ts.net".into();
        w.deliver(None).await;
        assert_eq!(w.transport.sent.lock().unwrap().len(), count);
    }
    #[tokio::test]
    async fn limits_key_validation_conflicts_and_test_throttle() {
        let root = Temp::new();
        let mut w = worker(&root.0, 201);
        let mut invalid = subscription("valid");
        invalid.keys.auth = "A".repeat(22);
        // 22 valid base64 characters can still encode invalid trailing bits or a wrong key.
        invalid.keys.p256dh = "A".repeat(87);
        assert!(
            w.request(Request::Subscribe {
                secret: "a".repeat(64),
                subscription: invalid
            })
            .is_err()
        );
        assert!(
            w.request(Request::Remove {
                secret: "short".into()
            })
            .is_err()
        );
        for index in 0..MAX_SUBSCRIBERS {
            w.request(Request::Subscribe {
                secret: format!("{index:064x}"),
                subscription: subscription(&format!("t{index}")),
            })
            .unwrap();
        }
        assert_eq!(
            w.request(Request::Subscribe {
                secret: "f".repeat(64),
                subscription: subscription("extra")
            }),
            Err("full")
        );
        assert_eq!(
            w.request(Request::Subscribe {
                secret: "f".repeat(64),
                subscription: subscription("t0")
            }),
            Err("conflict")
        );
        assert!(
            w.request(Request::Test {
                secret: "0".repeat(64)
            })
            .is_ok()
        );
        assert_eq!(
            w.request(Request::Test {
                secret: "0".repeat(64)
            }),
            Err("rate_limited")
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(PAYLOAD).unwrap(),
            serde_json::json!({"title":"Pi Web", "body":"A workspace task finished. Open Pi Web to review."})
        );
    }
    #[tokio::test]
    async fn signing_identity_survives_restart_and_explicit_revocation() {
        use std::os::unix::fs::PermissionsExt;
        let root = Temp::new();
        let key;
        {
            let mut w = worker(&root.0, 201);
            add(&mut w, "a", "a");
            key = w.record.private_key.clone();
        }
        {
            let w = worker(&root.0, 201);
            assert_eq!(w.record.private_key, key);
            assert_eq!(w.record.devices.len(), 1);
        }
        revoke_all(&root.0).unwrap();
        let w = worker(&root.0, 201);
        assert_eq!(w.record.private_key, key);
        assert!(w.record.devices.is_empty());
        assert_eq!(
            std::fs::metadata(root.0.join("push.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    /// Exercise the real runtime event path with a local child, never a provider socket.
    async fn detached_settlement(aborted: bool) {
        use crate::{
            config::Config,
            protocol::{BrowserAction, BrowserMessage, ProcessStatus, ServerBody, ServerMessage},
            session_manager::SessionManager,
        };
        use std::os::unix::fs::PermissionsExt;
        let root = Temp::new();
        let executable = root.0.join("fixture");
        let fixture = include_str!("../tests/fixtures/runtime_mock.py").replacen(
            "            if text == \"complete\":",
            "            if text == \"complete\":\n                open(\"push-waiting\", \"w\").close()\n                while not os.path.exists(\"push-release\"):\n                    time.sleep(0.005)", 1);
        let fixture = fixture.replacen("emit({\"type\": \"agent_settled\", \"aborted\": False})", &format!("emit({{\"type\": \"agent_settled\", \"aborted\": {}}})\n                emit({{\"type\": \"agent_settled\", \"aborted\": {}}})", if aborted { "True" } else { "False" }, if aborted { "True" } else { "False" }), 1);
        std::fs::write(&executable, fixture).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = Config::parse([
            "--cwd".into(),
            root.0.to_string_lossy().into_owned(),
            "--state-dir".into(),
            root.0.join("state").to_string_lossy().into_owned(),
            "--pi".into(),
            executable.to_string_lossy().into_owned(),
            "--isolated".into(),
        ])
        .unwrap()
        .unwrap();
        let mock = Mock {
            sent: Arc::default(),
            status: 201,
        };
        let push = PushService::with_transport(
            &root.0.join("push"),
            "https://desktop.tail.ts.net".into(),
            mock.clone(),
        )
        .unwrap();
        push.request(Request::Subscribe {
            secret: "a".repeat(64),
            subscription: subscription("device"),
        })
        .await
        .unwrap();
        let manager = SessionManager::start_with_push(config, Some(push.clone())).unwrap();
        let handle = manager
            .lookup(&manager.snapshot().await.selected)
            .await
            .unwrap();
        let outcome = tokio::time::timeout(Duration::from_secs(10), async {
            let mut connection = handle.connect("client".into()).await.unwrap();
            let identity = loop {
                let frame = connection.frames.recv().await.unwrap();
                let message: ServerMessage = serde_json::from_str(&frame.text).unwrap();
                if matches!(&message.body, ServerBody::Snapshot { status, .. } | ServerBody::Event { status, .. } if status.process == ProcessStatus::Ready && status.history_warning.is_none()) { break message; }
            };
            handle.dispatch("client".into(), BrowserMessage { v: 1, session_id: identity.session_id, epoch: identity.epoch, request_id: "complete".into(), action: BrowserAction::Prompt { text: "complete".into(), images: vec![] } }).unwrap();
            while !root.0.join("push-waiting").exists() { tokio::time::sleep(Duration::from_millis(5)).await; }
            while handle.summary().activity != crate::view::Activity::Running { tokio::time::sleep(Duration::from_millis(5)).await; }
            assert!(mock.sent.lock().unwrap().is_empty());
            handle.disconnect("client".into()).await; drop(connection);
            std::fs::write(root.0.join("push-release"), "").unwrap();
            // Idle is published after authoritative settlement was consumed.
            while handle.summary().activity != crate::view::Activity::Idle { tokio::time::sleep(Duration::from_millis(5)).await; }
        }).await;
        manager.shutdown().await;
        if !aborted {
            tokio::time::timeout(Duration::from_secs(2), async {
                while mock.sent.lock().unwrap().is_empty() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        }
        push.request(Request::Setup {}).await.unwrap();
        outcome.unwrap();
        assert_eq!(mock.sent.lock().unwrap().len(), usize::from(!aborted));
    }
    #[tokio::test]
    async fn completion_delivers_after_last_detach_and_duplicate_settlement_is_suppressed() {
        detached_settlement(false).await;
    }
    #[tokio::test]
    async fn aborted_settlement_never_delivers() {
        detached_settlement(true).await;
    }
}
