//! Loopback-only browser boundary. Host, Origin and a per-launch capability guard
//! every stateful route. The server exposes neither arbitrary RPC nor filesystem paths.
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
    pub authority: String,
    pub capability: String,
    pub web_dir: PathBuf,
    pub stopping: watch::Receiver<bool>,
    slots: Arc<Semaphore>,
    assets: Arc<Semaphore>,
}
impl WebState {
    /// Constructs an HTTP boundary for the actual bound ephemeral/fixed port.
    pub fn new(
        runtime: SessionManager,
        port: u16,
        capability: String,
        web_dir: PathBuf,
        stopping: watch::Receiver<bool>,
    ) -> Self {
        Self {
            runtime,
            authority: format!("127.0.0.1:{port}"),
            capability,
            web_dir,
            stopping,
            slots: Arc::new(Semaphore::new(8)),
            assets: Arc::new(Semaphore::new(8)),
        }
    }
    /// Validates an explicit origin-scoped proof before upgrading or admitting a controller.
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
    let expected_origin = format!("http://{}", state.authority);
    let valid_origin = origins.iter().count() <= 1
        && origins
            .iter()
            .all(|origin| origin == expected_origin.as_str());
    let stateful = matches!(request.uri().path(), "/auth" | "/ws");
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
        StatusCode::FORBIDDEN.into_response()
    } else if request.uri().path() == "/ws" && !state.authenticated(request.headers()) {
        StatusCode::UNAUTHORIZED.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_str(&format!("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ws://{}; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", state.authority)).unwrap());
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
