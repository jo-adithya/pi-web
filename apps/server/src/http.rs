//! Loopback listener with one configured browser origin. Host, Origin and a per-launch capability guard
//! every stateful route. The server exposes neither arbitrary RPC nor arbitrary filesystem access.
use crate::{config, protocol::BrowserMessage, session_manager::SessionManager};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, HeaderValue, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{SinkExt, StreamExt};
use std::{
    io::{self, Read},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Semaphore, watch};

mod listener;
mod multiplex;
pub use listener::BoundedListener;

const SOCKET_PROTOCOL: &str = "pi-web.v1";
const CAPABILITY_PROTOCOL_PREFIX: &str = "pi-web.cap.";

#[derive(Clone)]
pub struct WebState {
    pub runtime: SessionManager,
    authority: String,
    origin: String,
    socket_origin: String,
    pub capability: String,
    pub web_dir: PathBuf,
    pub stopping: watch::Receiver<bool>,
    slots: Arc<Semaphore>,
    assets: Arc<Semaphore>,
    push: Option<crate::push::PushService>,
    push_slots: Arc<Semaphore>,
    image_slots: Arc<Semaphore>,
    file_slots: Arc<Semaphore>,
    review_slots: Arc<Semaphore>,
    structural_slots: Arc<Semaphore>,
    group_slots: Arc<Semaphore>,
    context_cache: Arc<std::sync::Mutex<crate::context_review::Cache>>,
    structural_cache: Arc<std::sync::Mutex<crate::structural_review::Cache>>,
}
impl WebState {
    /// Constructs a single-origin boundary for loopback HTTP or an explicitly configured
    /// private HTTPS proxy. The proxy must preserve Host and Origin; forwarded headers
    /// never authorize requests. Remote mode replaces the local browser origin.
    pub fn new(
        runtime: SessionManager,
        port: u16,
        remote_origin: Option<config::RemoteOrigin>,
        capability: String,
        web_dir: PathBuf,
        stopping: watch::Receiver<bool>,
    ) -> Self {
        let (authority, origin, socket_origin) = match remote_origin {
            Some(origin) => (
                origin.authority().to_owned(),
                origin.as_str().to_owned(),
                format!("wss://{}", origin.authority()),
            ),
            None => (
                format!("127.0.0.1:{port}"),
                format!("http://127.0.0.1:{port}"),
                format!("ws://127.0.0.1:{port}"),
            ),
        };
        Self {
            runtime,
            authority,
            origin,
            socket_origin,
            capability,
            web_dir,
            stopping,
            slots: Arc::new(Semaphore::new(8)),
            assets: Arc::new(Semaphore::new(8)),
            push: None,
            push_slots: Arc::new(Semaphore::new(4)),
            image_slots: Arc::new(Semaphore::new(2)),
            file_slots: Arc::new(Semaphore::new(2)),
            review_slots: Arc::new(Semaphore::new(2)),
            structural_slots: Arc::new(Semaphore::new(1)),
            group_slots: Arc::new(Semaphore::new(1)),
            context_cache: Arc::new(std::sync::Mutex::new(
                crate::context_review::Cache::default(),
            )),
            structural_cache: Arc::new(std::sync::Mutex::new(
                crate::structural_review::Cache::default(),
            )),
        }
    }
    /// Enables explicitly opted-in phone delivery through the server-owned worker.
    pub fn with_push(mut self, push: crate::push::PushService) -> Self {
        self.push = Some(push);
        self
    }
    /// Validates an explicit origin-scoped proof before upgrading or admitting a client.
    /// Inspect raw headers: Axum's parsed protocol set removes duplicate values.
    fn authenticated(&self, headers: &HeaderMap) -> bool {
        let mut public_protocol = false;
        let mut capability = None;
        for value in headers.get_all(header::SEC_WEBSOCKET_PROTOCOL) {
            let Ok(value) = value.to_str() else {
                return false;
            };
            for protocol in value.split(',').map(str::trim) {
                if protocol == SOCKET_PROTOCOL {
                    if public_protocol {
                        return false;
                    }
                    public_protocol = true;
                } else if let Some(proof) = protocol.strip_prefix(CAPABILITY_PROTOCOL_PREFIX) {
                    if capability.is_some()
                        || proof.len() != 64
                        || !proof.bytes().all(|b| b.is_ascii_hexdigit())
                    {
                        return false;
                    }
                    capability = Some(proof);
                } else {
                    return false;
                }
            }
        }
        public_protocol && capability.is_some_and(|proof| secret_equal(proof, &self.capability))
    }
}
/// Builds routes with authentication and restrictive browser headers applied even to errors.
pub fn router(state: WebState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/assets/{*path}", get(asset))
        .route("/auth", post(auth))
        .route("/sw.js", get(service_worker))
        .route("/push", post(push_request))
        .route("/files/{session}", post(workspace_files))
        .route("/review/{session}", post(local_review))
        .route("/review/{session}/structural", post(structural_review))
        .route("/review/{session}/context", post(context_review))
        .route("/review/{session}/commits", post(commit_review))
        .route("/review/{session}/branches", post(branch_review))
        .route("/review/{session}/groups", post(group_review))
        .route("/images/{session}", post(upload_image))
        .route("/images/{session}/{id}", post(load_image))
        .route("/ws", get(upgrade))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(middleware::from_fn_with_state(state.clone(), boundary))
        .with_state(state)
}
async fn boundary(State(state): State<WebState>, request: Request<Body>, next: Next) -> Response {
    let host = request.headers().get_all(header::HOST);
    let valid_host = host.iter().count() == 1
        && host
            .iter()
            .next()
            .is_some_and(|h| h == state.authority.as_str());
    let origins = request.headers().get_all(header::ORIGIN);
    let valid_origin =
        origins.iter().count() <= 1 && origins.iter().all(|origin| origin == state.origin.as_str());
    let stateful = matches!(request.uri().path(), "/auth" | "/ws" | "/push")
        || request.uri().path().starts_with("/images/")
        || request.uri().path().starts_with("/files/")
        || request.uri().path().starts_with("/review/");
    let cross_site = request
        .headers()
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site");
    let public_navigation = request.method() == axum::http::Method::GET
        && request.uri().path() == "/"
        && request
            .headers()
            .get("sec-fetch-mode")
            .is_some_and(|v| v == "navigate")
        && request
            .headers()
            .get("sec-fetch-dest")
            .is_some_and(|v| v == "document");
    let mut response = if !valid_host
        || !valid_origin
        || (cross_site && !public_navigation)
        || (stateful && origins.iter().count() != 1)
    {
        if request.uri().path().starts_with("/review/") {
            (
                StatusCode::FORBIDDEN,
                axum::Json(serde_json::json!({"error": "Invalid request origin or host"})),
            )
                .into_response()
        } else {
            StatusCode::FORBIDDEN.into_response()
        }
    } else if request.uri().path() == "/ws" && !state.authenticated(request.headers()) {
        StatusCode::UNAUTHORIZED.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_str(&format!("default-src 'none'; script-src 'self'; worker-src 'self'; manifest-src 'self'; style-src 'self'; connect-src 'self' {}; img-src 'self' blob:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", state.socket_origin)).unwrap());
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    response
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthRequest {
    capability: String,
}
async fn auth(State(state): State<WebState>, request: Request<Body>) -> Response {
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .is_none_or(|v| v != "application/json")
    {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    let body = match tokio::time::timeout(
        Duration::from_secs(2),
        to_bytes(request.into_body(), 256),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
    };
    let Ok(input) = serde_json::from_slice::<AuthRequest>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !secret_equal(&input.capability, &state.capability) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    // Cookies cross loopback ports. Verification grants no ambient browser authority.
    StatusCode::NO_CONTENT.into_response()
}
/// Fixed worker path shares static-file bounds, no-store headers and same-origin policy.
async fn service_worker(State(state): State<WebState>) -> Response {
    static_file(&state, "sw.js".into()).await
}
async fn push_request(State(state): State<WebState>, request: Request<Body>) -> Response {
    let proofs = request.headers().get_all("x-pi-capability");
    if proofs.iter().count() != 1
        || !proofs
            .iter()
            .next()
            .and_then(|v| v.to_str().ok())
            .is_some_and(|proof| secret_equal(proof, &state.capability))
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .is_none_or(|v| v != "application/json")
    {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    let Ok(_permit) = state.push_slots.try_acquire() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let body =
        match tokio::time::timeout(Duration::from_secs(2), to_bytes(request.into_body(), 4096))
            .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
            Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
        };
    let Ok(input) = serde_json::from_slice::<crate::push::Request>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(push) = &state.push else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    match push.request(input).await {
        Ok(value) => axum::Json(value).into_response(),
        Err("invalid") => StatusCode::BAD_REQUEST.into_response(),
        Err("conflict") => StatusCode::CONFLICT.into_response(),
        Err("missing") => StatusCode::NOT_FOUND.into_response(),
        Err("full" | "rate_limited") => StatusCode::TOO_MANY_REQUESTS.into_response(),
        Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}
async fn index(State(state): State<WebState>) -> Response {
    static_file(&state, "index.html".into()).await
}
async fn asset(State(state): State<WebState>, Path(path): Path<String>) -> Response {
    if path.is_empty()
        || !path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        || path.contains("..")
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    static_file(&state, format!("assets/{path}")).await
}
async fn static_file(state: &WebState, relative: String) -> Response {
    let Ok(permit) = state.assets.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let root = state.web_dir.clone();
    let extension = relative.rsplit('.').next().unwrap_or("");
    let mime = match extension {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webmanifest" => "application/manifest+json; charset=utf-8",
        "woff2" => "font/woff2",
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    let result = tokio::task::spawn_blocking(move || -> io::Result<Vec<u8>> {
        // Cancellation of the HTTP future must not release a still-running worker's slot.
        let _permit = permit;
        let root = root.canonicalize()?;
        let path = root.join(relative).canonicalize()?;
        if !path.starts_with(root) {
            return Err(io::Error::other("asset outside root"));
        }
        let file = std::fs::File::open(path)?;
        if !file.metadata()?.is_file() {
            return Err(io::Error::other("not a file"));
        }
        let mut bytes = Vec::new();
        file.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(io::Error::other("asset exceeds limit"));
        }
        Ok(bytes)
    })
    .await;
    match result {
        Ok(Ok(bytes)) => ([(header::CONTENT_TYPE, mime)], bytes).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}
async fn upgrade(State(state): State<WebState>, ws: WebSocketUpgrade) -> Response {
    let Ok(permit) = state.slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    // Echo only the public protocol, never the credential-bearing offer.
    ws.protocols([SOCKET_PROTOCOL])
        .max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .write_buffer_size(0)
        .max_write_buffer_size(12 * 1024 * 1024)
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            multiplex::socket_loop(socket, state).await
        })
}
fn secret_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn static_workers_have_independent_bounded_admission() {
        let root =
            std::env::temp_dir().join(format!("pi-web-assets-{}", config::identity().unwrap()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("index.html"), "fixture").unwrap();
        let options = config::Config::parse([
            "--cwd".into(),
            root.to_string_lossy().into_owned(),
            "--state-dir".into(),
            root.join("state").to_string_lossy().into_owned(),
            "--pi".into(),
            "/missing/pi".into(),
        ])
        .unwrap()
        .unwrap();
        let runtime = crate::session_manager::SessionManager::start(options).unwrap();
        let (_, stopping) = watch::channel(false);
        let state = WebState::new(
            runtime.clone(),
            9876,
            None,
            "a".repeat(64),
            root.clone(),
            stopping,
        );
        let mut permits: Vec<_> = (0..8)
            .map(|_| state.assets.clone().try_acquire_owned().unwrap())
            .collect();
        assert_eq!(
            static_file(&state, "index.html".into()).await.status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        permits.pop();
        assert_eq!(
            static_file(&state, "index.html".into()).await.status(),
            StatusCode::OK
        );
        runtime.shutdown().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Image reads use POST with an explicit proof and Origin, just like uploads.
/// An img tag cannot supply the capability; the client displays a fetched blob.
fn image_proof(state: &WebState, headers: &HeaderMap) -> bool {
    let proofs = headers.get_all("x-pi-capability");
    proofs.iter().count() == 1
        && proofs
            .iter()
            .next()
            .and_then(|v| v.to_str().ok())
            .is_some_and(|proof| secret_equal(proof, &state.capability))
}
async fn upload_image(
    State(state): State<WebState>,
    Path(session): Path<String>,
    request: Request<Body>,
) -> Response {
    if !image_proof(&state, request.headers()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(_permit) = state.image_slots.try_acquire() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let Some(runtime) = state.runtime.lookup(&session).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let body = match tokio::time::timeout(
        Duration::from_secs(5),
        to_bytes(request.into_body(), crate::images::MAX_UPLOAD_BYTES),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
    };
    match runtime.images.upload(body.to_vec()) {
        Ok(id) => axum::Json(serde_json::json!({"id":id})).into_response(),
        Err(_) => StatusCode::UNPROCESSABLE_ENTITY.into_response(),
    }
}
async fn load_image(
    State(state): State<WebState>,
    Path((session, id)): Path<(String, String)>,
    request: Request<Body>,
) -> Response {
    if !image_proof(&state, request.headers()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(_permit) = state.image_slots.try_acquire() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let Some(runtime) = state.runtime.lookup(&session).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(image) = runtime.images.get(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    (
        [(header::CONTENT_TYPE, image.mime)],
        image.bytes.as_ref().clone(),
    )
        .into_response()
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FilesRequest {
    query: String,
}

/// Lists bounded filename matches in the session's registered workspace.
async fn workspace_files(
    State(state): State<WebState>,
    Path(session): Path<String>,
    request: Request<Body>,
) -> Response {
    if !image_proof(&state, request.headers()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .is_none_or(|v| v != "application/json")
    {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    let Ok(permit) = state.file_slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let body =
        match tokio::time::timeout(Duration::from_secs(2), to_bytes(request.into_body(), 2048))
            .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
            Err(_) => return StatusCode::REQUEST_TIMEOUT.into_response(),
        };
    let Ok(input) = serde_json::from_slice::<FilesRequest>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if input.query.len() > 256 || input.query.chars().any(char::is_control) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(root) = state.runtime.workspace_directory(&session).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match tokio::task::spawn_blocking(move || {
        // The blocking task owns admission even if the HTTP future is cancelled.
        let _permit = permit;
        crate::workspace_files::search(&root, &input.query)
    })
    .await
    {
        Ok(Ok(result)) => axum::Json(result).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod file_tests {
    use super::*;

    #[tokio::test]
    async fn file_workers_have_independent_bounded_admission() {
        let root =
            std::env::temp_dir().join(format!("pi-web-file-slots-{}", config::identity().unwrap()));
        std::fs::create_dir(&root).unwrap();
        let options = config::Config::parse([
            "--cwd".into(),
            root.to_string_lossy().into_owned(),
            "--state-dir".into(),
            root.join("state").to_string_lossy().into_owned(),
            "--pi".into(),
            "/missing/pi".into(),
        ])
        .unwrap()
        .unwrap();
        let runtime = SessionManager::start(options).unwrap();
        let (_, stopping) = watch::channel(false);
        let state = WebState::new(
            runtime.clone(),
            9876,
            None,
            "a".repeat(64),
            root.clone(),
            stopping,
        );
        let first = state.file_slots.clone().try_acquire_owned().unwrap();
        let second = state.file_slots.clone().try_acquire_owned().unwrap();
        let session = runtime.snapshot().await.selected;
        let request = || {
            Request::builder()
                .header("x-pi-capability", "a".repeat(64))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"query":""}"#))
                .unwrap()
        };
        assert_eq!(
            workspace_files(State(state.clone()), Path(session.clone()), request())
                .await
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert!(state.image_slots.try_acquire().is_ok());
        // Dropping the awaiting future must leave a blocking worker's permit owned.
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let worker = tokio::task::spawn_blocking(move || {
            let _permit = first;
            started_tx.send(()).unwrap();
            finish_rx.recv().unwrap();
        });
        started_rx.await.unwrap();
        worker.abort();
        assert!(state.file_slots.clone().try_acquire_owned().is_err());
        finish_tx.send(()).unwrap();
        worker.await.unwrap();
        assert_eq!(
            workspace_files(State(state), Path(session), request())
                .await
                .status(),
            StatusCode::OK
        );
        drop(second);
        runtime.shutdown().await;
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// Reviews only the registered workspace, including sessions without a running Pi process.
async fn local_review(
    State(state): State<WebState>,
    Path(session): Path<String>,
    request: Request<Body>,
) -> Response {
    fn error(status: StatusCode, message: &str) -> Response {
        (status, axum::Json(serde_json::json!({"error": message}))).into_response()
    }
    if !image_proof(&state, request.headers()) {
        return error(StatusCode::UNAUTHORIZED, "Capability required");
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .is_none_or(|v| v != "application/json")
    {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }
    let Ok(permit) = state.review_slots.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "Review workers are busy");
    };
    let body =
        match tokio::time::timeout(Duration::from_secs(2), to_bytes(request.into_body(), 2048))
            .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => {
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Review request exceeds 2 KiB",
                );
            }
            Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "Review request timed out"),
        };
    let Ok(input) = serde_json::from_slice::<crate::local_review::Request>(&body) else {
        return error(StatusCode::BAD_REQUEST, "Invalid review request");
    };
    let Some(root) = state.runtime.workspace_directory(&session).await else {
        return error(StatusCode::NOT_FOUND, "Session workspace not found");
    };
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        // The task retains admission through child kill/reap even if the HTTP future is dropped.
        let _permit = permit;
        crate::local_review::review(&root, input, cancelled).await
    });
    let result = worker.await;
    drop(cancel);
    match result {
        Ok(Ok(review)) => axum::Json(review).into_response(),
        Ok(Err(message)) => error(StatusCode::UNPROCESSABLE_ENTITY, message),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Review worker failed"),
    }
}

/// Reviews only the registered workspace, including sessions without a running Pi process.
async fn commit_review(
    State(state): State<WebState>,
    Path(session): Path<String>,
    request: Request<Body>,
) -> Response {
    fn error(status: StatusCode, message: &str) -> Response {
        (status, axum::Json(serde_json::json!({"error": message}))).into_response()
    }
    if !image_proof(&state, request.headers()) {
        return error(StatusCode::UNAUTHORIZED, "Capability required");
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .is_none_or(|v| v != "application/json")
    {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }
    let Ok(permit) = state.review_slots.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "Review workers are busy");
    };
    let body =
        match tokio::time::timeout(Duration::from_secs(2), to_bytes(request.into_body(), 2048))
            .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => {
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Review request exceeds 2 KiB",
                );
            }
            Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "Review request timed out"),
        };
    let Ok(input) = serde_json::from_slice::<crate::commit_review::Request>(&body) else {
        return error(StatusCode::BAD_REQUEST, "Invalid review request");
    };
    let Some(root) = state.runtime.workspace_directory(&session).await else {
        return error(StatusCode::NOT_FOUND, "Session workspace not found");
    };
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        // The task retains admission through child kill/reap even if the HTTP future is dropped.
        let _permit = permit;
        crate::commit_review::review(&root, input, cancelled).await
    });
    let result = worker.await;
    drop(cancel);
    match result {
        Ok(Ok(review)) => axum::Json(review).into_response(),
        Ok(Err(message)) => error(StatusCode::UNPROCESSABLE_ENTITY, message),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Review worker failed"),
    }
}

/// Lists branch choices from the registered workspace under shared review admission.
async fn branch_review(
    State(state): State<WebState>,
    Path(session): Path<String>,
    request: Request<Body>,
) -> Response {
    fn error(status: StatusCode, message: &str) -> Response {
        (status, axum::Json(serde_json::json!({"error": message}))).into_response()
    }
    if !image_proof(&state, request.headers()) {
        return error(StatusCode::UNAUTHORIZED, "Capability required");
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .is_none_or(|v| v != "application/json")
    {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }
    let Ok(permit) = state.review_slots.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "Review workers are busy");
    };
    let body =
        match tokio::time::timeout(Duration::from_secs(2), to_bytes(request.into_body(), 2048))
            .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => {
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Review request exceeds 2 KiB",
                );
            }
            Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "Review request timed out"),
        };
    let Ok(input) = serde_json::from_slice::<crate::branch_review::Request>(&body) else {
        return error(StatusCode::BAD_REQUEST, "Invalid review request");
    };
    let Some(root) = state.runtime.workspace_directory(&session).await else {
        return error(StatusCode::NOT_FOUND, "Session workspace not found");
    };
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        // The task retains admission through child kill/reap even if the HTTP future is dropped.
        let _permit = permit;
        crate::branch_review::review(&root, input, cancelled).await
    });
    let result = worker.await;
    drop(cancel);
    match result {
        Ok(Ok(review)) => axum::Json(review).into_response(),
        Ok(Err(message)) => error(StatusCode::UNPROCESSABLE_ENTITY, message),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Review worker failed"),
    }
}

/// Reviews only the registered workspace, including sessions without a running Pi process.
async fn structural_review(
    State(state): State<WebState>,
    Path(session): Path<String>,
    request: Request<Body>,
) -> Response {
    fn error(status: StatusCode, message: &str) -> Response {
        (status, axum::Json(serde_json::json!({"error": message}))).into_response()
    }
    if !image_proof(&state, request.headers()) {
        return error(StatusCode::UNAUTHORIZED, "Capability required");
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .is_none_or(|v| v != "application/json")
    {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }
    let Ok(permit) = state.structural_slots.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "Review workers are busy");
    };
    let body =
        match tokio::time::timeout(Duration::from_secs(2), to_bytes(request.into_body(), 2048))
            .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => {
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Review request exceeds 2 KiB",
                );
            }
            Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "Review request timed out"),
        };
    let Ok(input) = serde_json::from_slice::<crate::structural_review::Request>(&body) else {
        return error(StatusCode::BAD_REQUEST, "Invalid review request");
    };
    let Some(root) = state.runtime.workspace_directory(&session).await else {
        return error(StatusCode::NOT_FOUND, "Session workspace not found");
    };
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        // The task retains admission through child kill/reap even if the HTTP future is dropped.
        let _permit = permit;
        crate::structural_review::review(&root, input, cancelled, &state.structural_cache).await
    });
    let result = worker.await;
    drop(cancel);
    match result {
        Ok(Ok(review)) => axum::Json(review).into_response(),
        Ok(Err(message)) => error(StatusCode::UNPROCESSABLE_ENTITY, message),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Review worker failed"),
    }
}

/// Reviews only the registered workspace, including sessions without a running Pi process.
async fn context_review(
    State(state): State<WebState>,
    Path(session): Path<String>,
    request: Request<Body>,
) -> Response {
    fn error(status: StatusCode, message: &str) -> Response {
        (status, axum::Json(serde_json::json!({"error": message}))).into_response()
    }
    if !image_proof(&state, request.headers()) {
        return error(StatusCode::UNAUTHORIZED, "Capability required");
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .is_none_or(|v| v != "application/json")
    {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }
    let Ok(permit) = state.review_slots.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "Review workers are busy");
    };
    let body =
        match tokio::time::timeout(Duration::from_secs(2), to_bytes(request.into_body(), 2048))
            .await
        {
            Ok(Ok(body)) => body,
            Ok(Err(_)) => {
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Review request exceeds 2 KiB",
                );
            }
            Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "Review request timed out"),
        };
    let Ok(input) = serde_json::from_slice::<crate::context_review::Request>(&body) else {
        return error(StatusCode::BAD_REQUEST, "Invalid review request");
    };
    let Some(root) = state.runtime.workspace_directory(&session).await else {
        return error(StatusCode::NOT_FOUND, "Session workspace not found");
    };
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        // The task retains admission through child kill/reap even if the HTTP future is dropped.
        let _permit = permit;
        crate::context_review::review(&root, input, cancelled, &state.context_cache).await
    });
    let result = worker.await;
    drop(cancel);
    match result {
        Ok(Ok(review)) => axum::Json(review).into_response(),
        Ok(Err(message)) => error(StatusCode::UNPROCESSABLE_ENTITY, message),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Review worker failed"),
    }
}

/// Groups supplied diffs only after authenticated, bounded admission and a ready-session snapshot.
async fn group_review(
    State(state): State<WebState>,
    Path(session): Path<String>,
    request: Request<Body>,
) -> Response {
    fn error(status: StatusCode, message: &str) -> Response {
        (status, axum::Json(serde_json::json!({"error": message}))).into_response()
    }
    if !image_proof(&state, request.headers()) {
        return error(StatusCode::UNAUTHORIZED, "Capability required");
    }
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .is_none_or(|v| v != "application/json")
    {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Expected application/json",
        );
    }
    let Ok(permit) = state.group_slots.clone().try_acquire_owned() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "Grouping worker is busy");
    };
    let body = match tokio::time::timeout(
        Duration::from_secs(2),
        to_bytes(request.into_body(), 192 * 1024),
    )
    .await
    {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Grouping request exceeds 192 KiB",
            );
        }
        Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "Grouping request timed out"),
    };
    let Ok(input) = serde_json::from_slice::<crate::group_review::Request>(&body) else {
        return error(StatusCode::BAD_REQUEST, "Invalid grouping request");
    };
    if let Err(message) = input.validate() {
        return error(StatusCode::BAD_REQUEST, message);
    }
    if state.runtime.workspace_directory(&session).await.is_none() {
        return error(StatusCode::NOT_FOUND, "Session workspace not found");
    }
    let Some(runtime) = state.runtime.lookup(&session).await else {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Start the session before grouping",
        );
    };
    let config = match runtime.grouping_config().await {
        Ok(config) => config,
        Err(message) => return error(StatusCode::UNPROCESSABLE_ENTITY, message),
    };
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        let _permit = permit;
        crate::group_review::review(config, input, cancelled).await
    });
    let result = worker.await;
    drop(cancel);
    match result {
        Ok(Ok(groups)) => axum::Json(groups).into_response(),
        Ok(Err(message)) => error(StatusCode::UNPROCESSABLE_ENTITY, message),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Grouping worker failed"),
    }
}
