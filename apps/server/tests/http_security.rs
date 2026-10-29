//! HTTP boundary checks use a deliberately missing Pi executable, never a live provider.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use pi_web::{
    config::{self, Config},
    http::{self, WebState},
    session_manager::SessionManager,
};
use std::{fs, path::PathBuf};
use tower::ServiceExt;
struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
async fn setup() -> (Fixture, Router, SessionManager) {
    let root = std::env::temp_dir().join(format!("pi-web-http-{}", config::identity().unwrap()));
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("assets")).unwrap();
    fs::write(root.join("index.html"), "<h1>fixture</h1>").unwrap();
    let config = Config::parse([
        "--cwd".into(),
        root.to_string_lossy().into(),
        "--state-dir".into(),
        root.join("state").to_string_lossy().into(),
        "--pi".into(),
        "/does-not-exist/pi".into(),
    ])
    .unwrap()
    .unwrap();
    let runtime = SessionManager::start(config).unwrap();
    let (_, stopping) = tokio::sync::watch::channel(false);
    let state = WebState::new(
        runtime.clone(),
        9876,
        "a".repeat(64),
        root.clone(),
        stopping,
    );
    (Fixture(root), http::router(state), runtime)
}
fn request(path: &str) -> axum::http::request::Builder {
    Request::builder()
        .uri(path)
        .header("host", "127.0.0.1:9876")
}
#[tokio::test]
async fn rejects_untrusted_host_origin_and_missing_authentication() {
    let (_fixture, router, runtime) = setup().await;
    for (host, origin, expected) in [
        ("evil.test:9876", None, StatusCode::FORBIDDEN),
        ("127.0.0.1:9876", Some("null"), StatusCode::FORBIDDEN),
        (
            "127.0.0.1:9876",
            Some("https://evil.test"),
            StatusCode::FORBIDDEN,
        ),
        ("127.0.0.1:9876", None, StatusCode::FORBIDDEN),
        (
            "127.0.0.1:9876",
            Some("http://127.0.0.1:9876"),
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        let mut request = Request::builder().uri("/ws").header("host", host);
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        assert_eq!(
            router
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            expected
        );
    }
    runtime.shutdown().await;
}
#[tokio::test]
async fn bootstrap_requires_json_same_origin_secret_without_issuing_an_ambient_credential() {
    let (_fixture, router, runtime) = setup().await;
    for secret in ["bad".to_owned(), "a".repeat(64)] {
        let response = router
            .clone()
            .oneshot(
                request("/auth")
                    .method("POST")
                    .header("origin", "http://127.0.0.1:9876")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({"capability": secret}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        if secret == "bad" {
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        } else {
            assert_eq!(response.status(), StatusCode::NO_CONTENT);
            assert!(
                !response.headers().contains_key("set-cookie"),
                "capabilities must not be issued as host-wide cookies"
            );
            assert!(
                !response
                    .headers()
                    .contains_key("access-control-allow-origin")
            );
        }
    }
    assert_eq!(
        router
            .clone()
            .oneshot(
                request("/auth")
                    .method("POST")
                    .header("origin", "http://127.0.0.1:9876")
                    .header("content-type", "application/json")
                    .body(Body::from("x".repeat(257)))
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    runtime.shutdown().await;
}
#[tokio::test]
async fn rejects_missing_wrong_malformed_and_duplicate_socket_proofs() {
    let (_fixture, router, runtime) = setup().await;
    let proof = format!("pi-web.cap.{}", "a".repeat(64));
    for protocols in [
        vec![],
        vec!["pi-web.v1".into()],
        vec![proof.clone()],
        vec![format!("pi-web.v1, pi-web.cap.{}", "b".repeat(64))],
        vec!["pi-web.v1, pi-web.cap.short".into()],
        vec![format!("pi-web.v1, {proof}, {proof}")],
        vec![format!("pi-web.v1, {proof}"), proof.clone()],
        vec![format!("pi-web.v1, pi-web.v1, {proof}")],
        vec![format!("pi-web.v1, {proof}, unknown")],
        vec![format!("pi-web.v1, {proof},")],
    ] {
        let mut request = request("/ws").header("origin", "http://127.0.0.1:9876");
        for protocol in protocols {
            request = request.header("sec-websocket-protocol", protocol);
        }
        let response = router
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    runtime.shutdown().await;
}

/// A native client can forge Host/Origin after another loopback port receives a
/// browser cookie. That ambient credential must never pass socket admission.
#[tokio::test]
async fn replayed_loopback_cookie_cannot_authenticate_a_socket() {
    let (_fixture, router, runtime) = setup().await;
    let response = router
        .oneshot(
            request("/ws")
                .header("origin", "http://127.0.0.1:9876")
                .header("cookie", format!("pi_web_9876={}", "a".repeat(64)))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    runtime.shutdown().await;
    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "cookie replay crossed the socket authentication boundary"
    );
}

#[tokio::test]
async fn incomplete_bootstrap_body_has_an_absolute_deadline() {
    let (_fixture, router, runtime) = setup().await;
    let body = Body::from_stream(futures_util::stream::pending::<
        Result<axum::body::Bytes, std::io::Error>,
    >());
    let request = request("/auth")
        .method("POST")
        .header("origin", "http://127.0.0.1:9876")
        .header("content-type", "application/json")
        .body(body)
        .unwrap();
    let response =
        tokio::time::timeout(std::time::Duration::from_secs(3), router.oneshot(request)).await;
    runtime.shutdown().await;
    assert_eq!(
        response
            .expect("auth body read must time out")
            .unwrap()
            .status(),
        StatusCode::REQUEST_TIMEOUT
    );
}

#[tokio::test]
async fn static_assets_are_local_bounded_and_have_strict_browser_headers() {
    let (fixture, router, runtime) = setup().await;
    let response = router
        .clone()
        .oneshot(request("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    assert_eq!(response.headers()["referrer-policy"], "no-referrer");
    // A link/bookmark or extension-owned tab can navigate from another site. The
    // public bootstrap document is harmless; authentication remains same-origin.
    assert_eq!(
        router
            .clone()
            .oneshot(
                request("/")
                    .header("sec-fetch-site", "cross-site")
                    .header("sec-fetch-mode", "navigate")
                    .header("sec-fetch-dest", "document")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    std::os::unix::fs::symlink("/etc/passwd", fixture.0.join("assets/escape.js")).unwrap();
    for path in [
        "/assets/escape.js",
        "/assets/../state/session.json",
        "/assets/%2e%2e%2findex.html",
        "/session.json",
        "/api/rpc",
    ] {
        assert_eq!(
            router
                .clone()
                .oneshot(request(path).body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    runtime.shutdown().await;
}
