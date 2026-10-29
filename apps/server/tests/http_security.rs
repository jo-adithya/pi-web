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
    setup_origin(None).await
}
async fn setup_origin(origin: Option<&str>) -> (Fixture, Router, SessionManager) {
    setup_options(origin, false).await
}
async fn setup_options(origin: Option<&str>, images: bool) -> (Fixture, Router, SessionManager) {
    let root = std::env::temp_dir().join(format!("pi-web-http-{}", config::identity().unwrap()));
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("assets")).unwrap();
    fs::write(root.join("index.html"), "<h1>fixture</h1>").unwrap();
    fs::write(root.join("sw.js"), include_str!("../../web/public/sw.js")).unwrap();
    let executable = if images {
        use std::os::unix::fs::PermissionsExt;
        let path = root.join("pi-fixture");
        fs::write(&path, include_str!("fixtures/runtime_mock.py")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(root.join("supports-images"), "").unwrap();
        path.to_string_lossy().into_owned()
    } else { "/does-not-exist/pi".into() };
    let mut args = vec![
        "--cwd".into(),
        root.to_string_lossy().into(),
        "--state-dir".into(),
        root.join("state").to_string_lossy().into(),
        "--pi".into(),
        executable,
    ];
    if let Some(origin) = origin {
        args.extend(["--remote-origin".into(), origin.into()]);
    }
    let config = Config::parse(args).unwrap().unwrap();
    let remote_origin = config.remote_origin.clone();
    let runtime = SessionManager::start(config).unwrap();
    let (_, stopping) = tokio::sync::watch::channel(false);
    let state = WebState::new(
        runtime.clone(),
        9876,
        remote_origin,
        "a".repeat(64),
        root.clone(),
        stopping,
    );
    let push = pi_web::push::PushService::start(&root.join("push"), origin.unwrap_or("http://127.0.0.1:9876").into()).unwrap();
    (Fixture(root), http::router(state.with_push(push)), runtime)
}
#[tokio::test]
async fn private_https_origin_authenticates_with_capability() {
    let (_fixture, router, runtime) = setup_origin(Some("https://desktop.tail123.ts.net")).await;
    let response = router
        .oneshot(
            Request::builder()
                .uri("/auth")
                .method("POST")
                .header("host", "desktop.tail123.ts.net")
                .header("origin", "https://desktop.tail123.ts.net")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({"capability": "a".repeat(64)}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    runtime.shutdown().await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let csp = response.headers()["content-security-policy"]
        .to_str()
        .unwrap();
    assert!(csp.contains("connect-src 'self' wss://desktop.tail123.ts.net;"));
    assert!(!csp.contains("ws://127.0.0.1"));
}

#[tokio::test]
async fn remote_mode_rejects_other_origins_forwarded_spoofs_and_missing_proofs() {
    let (_fixture, router, runtime) = setup_origin(Some("https://desktop.tail123.ts.net")).await;
    for (host, origins, secret, expected) in [
        (
            "desktop.tail123.ts.net",
            vec!["https://evil.test"],
            true,
            StatusCode::FORBIDDEN,
        ),
        (
            "evil.test",
            vec!["https://desktop.tail123.ts.net"],
            true,
            StatusCode::FORBIDDEN,
        ),
        (
            "127.0.0.1:9876",
            vec!["http://127.0.0.1:9876"],
            true,
            StatusCode::FORBIDDEN,
        ),
        (
            "desktop.tail123.ts.net",
            vec!["http://desktop.tail123.ts.net"],
            true,
            StatusCode::FORBIDDEN,
        ),
        (
            "desktop.tail123.ts.net",
            vec!["null"],
            true,
            StatusCode::FORBIDDEN,
        ),
        (
            "desktop.tail123.ts.net",
            vec![],
            true,
            StatusCode::FORBIDDEN,
        ),
        (
            "desktop.tail123.ts.net",
            vec![
                "https://desktop.tail123.ts.net",
                "https://desktop.tail123.ts.net",
            ],
            true,
            StatusCode::FORBIDDEN,
        ),
        (
            "desktop.tail123.ts.net",
            vec!["https://desktop.tail123.ts.net"],
            false,
            StatusCode::UNAUTHORIZED,
        ),
    ] {
        let mut req = Request::builder()
            .uri("/ws")
            .header("host", host)
            .header("x-forwarded-host", "desktop.tail123.ts.net")
            .header("x-forwarded-proto", "https")
            .header("forwarded", "host=desktop.tail123.ts.net;proto=https");
        for origin in origins {
            req = req.header("origin", origin);
        }
        if secret {
            req = req.header(
                "sec-websocket-protocol",
                format!("pi-web.v1, pi-web.cap.{}", "a".repeat(64)),
            );
        }
        let response = router
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "host: {host}");
    }
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/")
                .header("host", "desktop.tail123.ts.net")
                .header("host", "desktop.tail123.ts.net")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = router
        .oneshot(
            Request::builder()
                .uri("/auth")
                .method("POST")
                .header("host", "desktop.tail123.ts.net")
                .header("origin", "https://desktop.tail123.ts.net")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"capability":"wrong"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    runtime.shutdown().await;
}

/// Exercises the proxy-to-backend handshake over a real loopback TCP connection.
#[tokio::test]
async fn remote_websocket_upgrade_preserves_capability_authentication() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let (_fixture, router, runtime) = setup_origin(Some("https://desktop.tail123.ts.net")).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
        stream.write_all(format!(
            "GET /ws HTTP/1.1\r\nHost: desktop.tail123.ts.net\r\nOrigin: https://desktop.tail123.ts.net\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: pi-web.v1, pi-web.cap.{}\r\n\r\n", "a".repeat(64)
        ).as_bytes()).await.unwrap();
        let mut reader = BufReader::new(stream);
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).await.unwrap() == 0 || line == "\r\n" { break; }
            headers.push_str(&line);
        }
        headers
    }).await;
    server.abort();
    let _ = server.await;
    runtime.shutdown().await;
    let headers = result.expect("WebSocket upgrade timed out");
    assert!(
        headers.starts_with("HTTP/1.1 101 Switching Protocols\r\n"),
        "{headers}"
    );
    assert!(headers.contains("sec-websocket-protocol: pi-web.v1\r\n"));
    assert!(
        !headers.contains(&"a".repeat(64)),
        "capability leaked in response"
    );
}

#[tokio::test]
async fn default_mode_rejects_remote_host_even_with_forwarded_headers() {
    let (_fixture, router, runtime) = setup().await;
    let response = router
        .oneshot(
            Request::builder()
                .uri("/")
                .header("host", "desktop.tail123.ts.net")
                .header("x-forwarded-host", "127.0.0.1:9876")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    runtime.shutdown().await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
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

#[tokio::test]
async fn phone_push_requires_exact_boundary_and_proof_and_bounded_json() {
    let (_fixture, router, runtime) = setup().await;
    for (host, origin, proof, body, expected) in [
        ("127.0.0.1:9876", Some("http://127.0.0.1:9876"), Some("a".repeat(64)), r#"{"operation":"setup"}"#.to_owned(), StatusCode::OK),
        ("127.0.0.1:9876", None, Some("a".repeat(64)), "{}".into(), StatusCode::FORBIDDEN),
        ("127.0.0.1:9876", Some("https://evil.test"), Some("a".repeat(64)), "{}".into(), StatusCode::FORBIDDEN),
        ("evil.test", Some("http://127.0.0.1:9876"), Some("a".repeat(64)), "{}".into(), StatusCode::FORBIDDEN),
        ("127.0.0.1:9876", Some("http://127.0.0.1:9876"), None, "{}".into(), StatusCode::UNAUTHORIZED),
        ("127.0.0.1:9876", Some("http://127.0.0.1:9876"), Some("b".repeat(64)), "{}".into(), StatusCode::UNAUTHORIZED),
        ("127.0.0.1:9876", Some("http://127.0.0.1:9876"), Some("a".repeat(64)), "x".repeat(4097), StatusCode::PAYLOAD_TOO_LARGE),
        ("127.0.0.1:9876", Some("http://127.0.0.1:9876"), Some("a".repeat(64)), r#"{"operation":"setup","unexpected":true}"#.into(), StatusCode::BAD_REQUEST),
    ] {
        let mut request = Request::builder().method("POST").uri("/push").header("host", host).header("content-type", "application/json");
        if let Some(origin) = origin { request = request.header("origin", origin); }
        if let Some(proof) = proof { request = request.header("x-pi-capability", proof); }
        let response = router.clone().oneshot(request.body(Body::from(body)).unwrap()).await.unwrap();
        assert_eq!(response.status(), expected); assert!(response.headers().get("access-control-allow-origin").is_none());
    }
    runtime.shutdown().await;
}
#[tokio::test]
async fn root_worker_is_javascript_uncached_and_allowed_by_csp() {
    let (_fixture, router, runtime) = setup().await;
    let response = router.oneshot(Request::builder().uri("/sw.js").header("host", "127.0.0.1:9876").body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response.headers()["content-type"].to_str().unwrap().contains("javascript"));
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(response.headers()["content-security-policy"].to_str().unwrap().contains("worker-src 'self'"));
    runtime.shutdown().await;
}

#[tokio::test]
async fn images_require_origin_proof_and_session_scope_and_bound_bodies() {
    use base64::Engine;
    use axum::body::to_bytes;
    let (_fixture, router, runtime) = setup().await;
    let session = runtime.snapshot().await.selected;
    let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=").unwrap();
    let path = format!("/images/{session}");
    for (origin, proof, bytes, expected) in [
        (None, Some("a".repeat(64)), png.clone(), StatusCode::FORBIDDEN),
        (Some("https://evil.invalid"), Some("a".repeat(64)), png.clone(), StatusCode::FORBIDDEN),
        (Some("http://127.0.0.1:9876"), None, png.clone(), StatusCode::UNAUTHORIZED),
        (Some("http://127.0.0.1:9876"), Some("b".repeat(64)), png.clone(), StatusCode::UNAUTHORIZED),
        (Some("http://127.0.0.1:9876"), Some("a".repeat(64)), vec![0; 512*1024+1], StatusCode::PAYLOAD_TOO_LARGE),
        (Some("http://127.0.0.1:9876"), Some("a".repeat(64)), b"<svg/>".to_vec(), StatusCode::UNPROCESSABLE_ENTITY),
    ] {
        let mut request = Request::builder().uri(&path).method("POST").header("host", "127.0.0.1:9876");
        if let Some(origin) = origin { request = request.header("origin", origin); }
        if let Some(proof) = proof { request = request.header("x-pi-capability", proof); }
        assert_eq!(router.clone().oneshot(request.body(Body::from(bytes)).unwrap()).await.unwrap().status(), expected);
    }
    let request = |path: String, body: Vec<u8>| Request::builder().uri(path).method("POST").header("host", "127.0.0.1:9876").header("origin", "http://127.0.0.1:9876").header("x-pi-capability", "a".repeat(64)).body(Body::from(body)).unwrap();
    let response = router.clone().oneshot(request(path.clone(), png.clone())).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(&to_bytes(response.into_body(), 256).await.unwrap()).unwrap();
    let id = body["id"].as_str().unwrap();
    assert_eq!(router.clone().oneshot(request(format!("/images/other/{id}"), vec![])).await.unwrap().status(), StatusCode::NOT_FOUND);
    let response = router.oneshot(request(format!("{path}/{id}"), vec![])).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap().as_ref(), png);
    runtime.shutdown().await;
}

#[tokio::test]
async fn uploaded_image_reaches_rpc_and_live_user_and_tool_previews_only_as_refs() {
    use axum::body::to_bytes;
    use base64::Engine;
    use pi_web::protocol::{BrowserAction, BrowserMessage, ServerBody, ServerMessage, ProcessStatus};
    let (fixture, router, runtime) = setup_options(None, true).await;
    let session = runtime.snapshot().await.selected;
    let handle = runtime.lookup(&session).await.unwrap();
    let mut connection = handle.connect("images".into()).await.unwrap();
    let identity = loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), connection.frames.recv()).await.unwrap().unwrap();
        let frame: ServerMessage = serde_json::from_str(&frame.text).unwrap();
        if matches!(&frame.body, ServerBody::Snapshot {status,..} | ServerBody::Event {status,..} if status.process == ProcessStatus::Ready && status.history_warning.is_none()) { break frame; }
    };
    let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=").unwrap();
    let response = router.oneshot(Request::builder().uri(format!("/images/{session}")).method("POST").header("host", "127.0.0.1:9876").header("origin", "http://127.0.0.1:9876").header("x-pi-capability", "a".repeat(64)).body(Body::from(png.clone())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value = serde_json::from_slice(&to_bytes(response.into_body(), 256).await.unwrap()).unwrap();
    let id = body["id"].as_str().unwrap();
    handle.dispatch("images".into(), BrowserMessage { v:1, session_id:session.clone(), epoch:identity.epoch, request_id:"image-only".into(), action:BrowserAction::Prompt { text:String::new(), images:vec![id.into()] } }).unwrap();
    let mut previews = 0;
    let mut accepted = false;
    for _ in 0..100 {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), connection.frames.recv()).await.unwrap().unwrap();
        assert!(!frame.text.contains("PRIVATE_TOOL_TEXT")); assert!(!frame.text.contains("iVBORw0KGgo"));
        let frame: ServerMessage = serde_json::from_str(&frame.text).unwrap();
        match frame.body {
            ServerBody::Result { result } if result.request_id == "image-only" => { assert!(result.ok, "{}", result.code); accepted = true; }
            ServerBody::Event { patches,.. } => for patch in patches { if let pi_web::view::ViewPatch::Message {message} = patch { previews += usize::from(message.blocks.iter().any(|block| matches!(block.kind, pi_web::view::BlockKind::Image))); } },
            _ => {}
        }
        if accepted && previews == 2 { break; }
    }
    assert!(accepted); assert_eq!(previews, 2);
    runtime.shutdown().await;
    let log = fs::read_to_string(fixture.0.join("state/sessions").join(&session).join("pi-sessions/commands.jsonl")).unwrap();
    let commands: Vec<serde_json::Value> = log.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    let command = commands.iter().find(|command| command["images"].is_array()).unwrap();
    assert_eq!(command["message"], ""); assert_eq!(command["images"][0]["mimeType"], "image/png");
    assert_eq!(command["images"][0]["data"], base64::engine::general_purpose::STANDARD.encode(png));
}
