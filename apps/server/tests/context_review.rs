//! Local review uses temporary Git repositories and a missing Pi executable.
use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use pi_web::{
    config::{self, Config},
    http::{self, WebState},
    session_manager::SessionManager,
};
use std::{fs, path::PathBuf, process::Command};
use tower::ServiceExt;

struct Fixture {
    root: PathBuf,
    router: Router,
    runtime: SessionManager,
    session: String,
}
impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!("pi-context-{}", config::identity().unwrap()));
        fs::create_dir(&root).unwrap();
        let options = Config::parse([
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
        let session = runtime.snapshot().await.selected;
        let (_, stopping) = tokio::sync::watch::channel(false);
        let router = http::router(WebState::new(
            runtime.clone(),
            9876,
            None,
            "a".repeat(64),
            root.clone(),
            stopping,
        ));
        Self {
            root,
            router,
            runtime,
            session,
        }
    }
    fn git(&self, args: &[&str]) {
        let output = Command::new("git")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .current_dir(&self.root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn init(&self) {
        self.git(&["init", "-q", "-b", "main"]);
        self.git(&["config", "user.email", "test@example.invalid"]);
        self.git(&["config", "user.name", "Test"]);
        fs::write(self.root.join(".gitignore"), "state/\n").unwrap();
        fs::write(self.root.join("file.txt"), "before\n").unwrap();
        self.git(&["add", "."]);
        self.git(&["commit", "-qm", "initial"]);
    }
    async fn request(
        &self,
        body: &str,
        proof: bool,
        origin: bool,
    ) -> (StatusCode, serde_json::Value) {
        self.request_at(body, proof, origin, false).await
    }
    async fn request_at(
        &self,
        body: &str,
        proof: bool,
        origin: bool,
        structural: bool,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder()
            .method("POST")
            .uri(format!(
                "/review/{}{}",
                self.session,
                if structural { "/context" } else { "" }
            ))
            .header("host", "127.0.0.1:9876")
            .header("content-type", "application/json");
        if proof {
            request = request.header("x-pi-capability", "a".repeat(64));
        }
        if origin {
            request = request.header("origin", "http://127.0.0.1:9876");
        }
        let response = self
            .router
            .clone()
            .oneshot(request.body(Body::from(body.to_owned())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn expands_prefix_gap_suffix_and_eof() {
    let f = Fixture::new().await;
    f.init();
    let original = (1..=80)
        .map(|n| format!("line {n}\n"))
        .collect::<String>()
        .trim_end_matches('\n')
        .to_owned();
    fs::write(f.root.join("file.txt"), &original).unwrap();
    f.git(&["add", "."]);
    f.git(&["commit", "-qm", "lines"]);
    fs::write(
        f.root.join("file.txt"),
        original
            .replace("line 25\n", "changed 25\n")
            .replace("line 55\n", "changed 55\n"),
    )
    .unwrap();
    let (_, snapshot) = f
        .request(r#"{"scope":"unstaged","path":"file.txt"}"#, true, true)
        .await;
    let file = &snapshot["files"][0];
    for (start, count, length, more) in [
        (1, 20, 20, true),
        (21, 20, 4, false),
        (26, 20, 20, true),
        (56, 20, 20, true),
        (76, 20, 5, false),
        (81, 20, 0, false),
    ] {
        let body = serde_json::json!({"scope":"unstaged","path":"file.txt","fingerprint":file["fingerprint"],"oldStart":start,"newStart":start,"count":count});
        let (status, result) = f.request_at(&body.to_string(), true, true, true).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["lines"].as_array().unwrap().len(), length);
        assert_eq!(result["hasMore"], more);
        assert_eq!(result["noNewline"], length > 0 && start + length - 1 == 80);
        if length > 0 {
            assert_eq!(result["lines"][0], format!("line {start}"));
        }
    }
    f.runtime.shutdown().await;
}

impl Fixture {
    async fn context_input(
        &self,
        scope: &str,
        base: Option<&str>,
        path: &str,
    ) -> serde_json::Value {
        let mut input = serde_json::json!({"scope":scope,"path":path});
        if let Some(base) = base {
            input["base"] = base.into();
        }
        let (status, snapshot) = self.request(&input.to_string(), true, true).await;
        assert_eq!(status, StatusCode::OK, "{snapshot}");
        let file = snapshot["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == path)
            .unwrap();
        input["path"] = path.into();
        input["fingerprint"] = file["fingerprint"].clone();
        input["oldStart"] = 1.into();
        input["newStart"] = 1.into();
        input["count"] = 20.into();
        input
    }
    async fn context(&self, input: &serde_json::Value) -> (StatusCode, serde_json::Value) {
        self.request_at(&input.to_string(), true, true, true).await
    }
}

#[tokio::test]
async fn staged_branch_and_renamed_edits_preserve_text_bytes() {
    let f = Fixture::new().await;
    f.init();
    let old =
        "\tprefix\r\nindex content\r\n--- content\r\n+++ content\r\n@@ content\r\nold\r\nsuffix";
    fs::write(f.root.join("file.txt"), old).unwrap();
    f.git(&["add", "."]);
    f.git(&["commit", "-qm", "bytes"]);
    f.git(&["branch", "base"]);
    f.git(&["mv", "file.txt", ":(glob)*.txt"]);
    fs::write(f.root.join(":(glob)*.txt"), old.replace("old\r", "new\r")).unwrap();
    f.git(&["add", "."]);
    for scope in ["staged", "branch"] {
        if scope == "branch" {
            f.git(&["commit", "-qm", "edited rename"]);
        }
        let mut input = f
            .context_input(scope, (scope == "branch").then_some("base"), ":(glob)*.txt")
            .await;
        let (status, result) = f.context(&input).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(
            result["lines"],
            serde_json::json!([
                "\tprefix\r",
                "index content\r",
                "--- content\r",
                "+++ content\r",
                "@@ content\r"
            ])
        );
        assert_eq!(result["hasMore"], false);
        input["oldStart"] = 7.into();
        input["newStart"] = 7.into();
        let (status, result) = f.context(&input).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["lines"], serde_json::json!(["suffix"]));
        assert_eq!(result["hasMore"], false);
        assert_eq!(result["noNewline"], true);
    }
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn insertion_deletion_coordinates_and_zero_counts() {
    let f = Fixture::new().await;
    f.init();
    fs::write(f.root.join("file.txt"), "a\nb\nc\n").unwrap();
    f.git(&["add", "."]);
    f.git(&["commit", "-qm", "lines"]);
    for (text, old, new, expected) in [
        ("insert\na\nb\nc\n", 1, 2, vec!["a", "b", "c"]),
        ("a\nc\n", 3, 2, vec!["c"]),
        ("", 4, 1, vec![]),
    ] {
        fs::write(f.root.join("file.txt"), text).unwrap();
        let mut input = f.context_input("unstaged", None, "file.txt").await;
        input["oldStart"] = old.into();
        input["newStart"] = new.into();
        let (status, result) = f.context(&input).await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["lines"], serde_json::json!(expected));
        assert_eq!(result["hasMore"], false);
    }
    fs::write(f.root.join("file.txt"), "").unwrap();
    f.git(&["add", "."]);
    f.git(&["commit", "-qm", "empty"]);
    fs::write(f.root.join("file.txt"), "insert\n").unwrap();
    let mut input = f.context_input("unstaged", None, "file.txt").await;
    input["newStart"] = 2.into();
    assert_eq!(f.context(&input).await.0, StatusCode::OK);
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn rejects_stale_ranges_paths_and_unavailable_files() {
    let f = Fixture::new().await;
    f.init();
    let text = (1..=80).map(|n| format!("line {n}\n")).collect::<String>();
    fs::write(f.root.join("file.txt"), &text).unwrap();
    f.git(&["add", "."]);
    f.git(&["commit", "-qm", "lines"]);
    fs::write(
        f.root.join("file.txt"),
        text.replace("line 40\n", "changed\n"),
    )
    .unwrap();
    let input = f.context_input("unstaged", None, "file.txt").await;
    for (key, value) in [
        ("oldStart", serde_json::json!(0)),
        ("newStart", serde_json::json!(-1)),
        ("oldStart", serde_json::json!(1_000_001)),
        ("count", serde_json::json!(0)),
        ("count", serde_json::json!(21)),
        ("oldStart", serde_json::json!(82)),
        ("newStart", serde_json::json!(2)),
    ] {
        let mut bad = input.clone();
        bad[key] = value;
        assert_eq!(
            f.context(&bad).await.0,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{bad}"
        );
    }
    let mut bad = input.clone();
    bad["oldStart"] = 40.into();
    bad["newStart"] = 40.into();
    assert_eq!(f.context(&bad).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    for path in [
        "../file.txt",
        "/etc/passwd",
        ".git/config",
        "a//b",
        "a/./b",
        "missing",
        "file.txt\0",
        ":(glob)*",
    ] {
        let mut bad = input.clone();
        bad["path"] = path.into();
        assert_eq!(
            f.context(&bad).await.0,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{path}"
        );
    }
    fs::write(
        f.root.join("file.txt"),
        text.replace("line 40\n", "changed\n")
            .replace("line 1\n", "distant edit\n"),
    )
    .unwrap();
    let (status, result) = f.context(&input).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(result["error"], "File snapshot changed; refresh review");
    for (path, bytes) in [
        ("binary", b"a\0b".as_slice()),
        ("added", b"new\n".as_slice()),
    ] {
        fs::write(f.root.join(path), bytes).unwrap();
        f.git(&["add", path]);
        let input = f.context_input("staged", None, path).await;
        assert_eq!(f.context(&input).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    }
    fs::write(f.root.join("untracked"), "private").unwrap();
    let input = f.context_input("unstaged", None, "untracked").await;
    assert_eq!(f.context(&input).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    std::os::unix::fs::symlink("file.txt", f.root.join("link")).unwrap();
    f.git(&["add", "link"]);
    f.git(&["commit", "-qm", "special"]);
    fs::remove_file(f.root.join("link")).unwrap();
    std::os::unix::fs::symlink("added", f.root.join("link")).unwrap();
    let input = f.context_input("unstaged", None, "link").await;
    assert_eq!(f.context(&input).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    fs::write(f.root.join("binary"), b"c\0d").unwrap();
    let input = f.context_input("unstaged", None, "binary").await;
    assert_eq!(f.context(&input).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn bounds_expanded_output_and_serialized_response() {
    let f = Fixture::new().await;
    f.init();
    for (name, line) in [("large", "x".repeat(2000)), ("escaped", "\t".repeat(4000))] {
        let text = format!("{}old\n", format!("{line}\n").repeat(600));
        fs::write(f.root.join(name), &text).unwrap();
        f.git(&["add", name]);
        f.git(&["commit", "-qm", name]);
        fs::write(f.root.join(name), text.replace("old\n", "new\n")).unwrap();
        let input = f.context_input("unstaged", None, name).await;
        assert_eq!(f.context(&input).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    }
    // Expanded patch fits 1 MiB, but escaping 20 long unchanged rows exceeds 64 KiB.
    let text = format!("{}old\n", format!("{}\n", "\t".repeat(2000)).repeat(100));
    fs::write(f.root.join("json"), &text).unwrap();
    f.git(&["add", "json"]);
    f.git(&["commit", "-qm", "json"]);
    fs::write(f.root.join("json"), text.replace("old\n", "new\n")).unwrap();
    let input = f.context_input("unstaged", None, "json").await;
    let (status, result) = f.context(&input).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(result["error"], "Text context exceeds response limit");
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn enforces_http_boundary_without_launching_runtime() {
    let f = Fixture::new().await;
    f.init();
    fs::write(f.root.join("file.txt"), "after\n").unwrap();
    let input = f.context_input("unstaged", None, "file.txt").await;
    assert_eq!(
        f.request_at(&input.to_string(), false, true, true).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.request_at(&input.to_string(), true, false, true).await.0,
        StatusCode::FORBIDDEN
    );
    for (session, origin, content_type, body, expected) in [
        (
            f.session.as_str(),
            "http://evil.invalid",
            "application/json",
            input.to_string(),
            StatusCode::FORBIDDEN,
        ),
        (
            f.session.as_str(),
            "http://127.0.0.1:9876",
            "text/plain",
            input.to_string(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
        ),
        (
            "missing",
            "http://127.0.0.1:9876",
            "application/json",
            input.to_string(),
            StatusCode::NOT_FOUND,
        ),
        (
            f.session.as_str(),
            "http://127.0.0.1:9876",
            "application/json",
            " ".repeat(2049),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
        (
            f.session.as_str(),
            "http://127.0.0.1:9876",
            "application/json",
            "{}".into(),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/review/{session}/context"))
            .header("host", "127.0.0.1:9876")
            .header("origin", origin)
            .header("content-type", content_type)
            .header("x-pi-capability", "a".repeat(64))
            .body(Body::from(body))
            .unwrap();
        let response = f.router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), expected);
    }
    let mut unknown = input;
    unknown["extra"] = true.into();
    assert_eq!(f.context(&unknown).await.0, StatusCode::BAD_REQUEST);
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn refuses_deleted_and_distant_non_utf8_content() {
    let f = Fixture::new().await;
    f.init();
    let mut bytes = vec![0xff, b'\n'];
    bytes.extend(
        (1..=100)
            .map(|n| format!("line {n}\n"))
            .collect::<String>()
            .bytes(),
    );
    fs::write(f.root.join("nonutf8"), &bytes).unwrap();
    f.git(&["add", "nonutf8"]);
    f.git(&["commit", "-qm", "nonutf8"]);
    bytes.extend_from_slice(b"new tail\n");
    fs::write(f.root.join("nonutf8"), &bytes).unwrap();
    let input = f.context_input("unstaged", None, "nonutf8").await;
    let (status, result) = f.context(&input).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(result["error"], "Text context unavailable");
    fs::remove_file(f.root.join("file.txt")).unwrap();
    let input = f.context_input("unstaged", None, "file.txt").await;
    assert_eq!(f.context(&input).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    f.runtime.shutdown().await;
}

/// Process-local Git wrapper measures real commands without changing other tests' PATH.
#[tokio::test]
async fn lazy_listing_and_context_cache_skip_expanded_git_work() {
    const ENV: &str = "PI_CONTEXT_PROCESS_LOG";
    if let Some(log) = std::env::var_os(ENV) {
        let f = Fixture::new().await;
        f.init();
        let text = (1..=80).map(|n| format!("line {n}\n")).collect::<String>();
        fs::write(f.root.join("file.txt"), &text).unwrap();
        for i in 0..12 {
            fs::write(f.root.join(format!("{i}.txt")), "old\n").unwrap();
        }
        f.git(&["add", "."]);
        f.git(&["commit", "-qm", "lines"]);
        fs::write(
            f.root.join("file.txt"),
            text.replace("line 40\n", "changed\n"),
        )
        .unwrap();
        for i in 0..12 {
            fs::write(f.root.join(format!("{i}.txt")), "new\n").unwrap();
        }
        fs::write(&log, "").unwrap();
        let (_, list) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
        assert_eq!(list["files"].as_array().unwrap().len(), 13);
        assert!(
            list["files"]
                .as_array()
                .unwrap()
                .iter()
                .all(|f| f["patch"].is_null())
        );
        let commands = fs::read_to_string(&log).unwrap();
        assert_eq!(commands.lines().count(), 5, "{commands}");
        assert!(!commands.contains("--patch"));
        let input = f.context_input("unstaged", None, "file.txt").await;
        fs::write(&log, "").unwrap();
        let (status, first) = f.context(&input).await;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(
            fs::read_to_string(&log)
                .unwrap()
                .matches("--unified=1000000")
                .count(),
            1
        );
        fs::write(&log, "").unwrap();
        assert_eq!(f.context(&input).await.1, first);
        let commands = fs::read_to_string(&log).unwrap();
        assert_eq!(commands.lines().count(), 6, "{commands}");
        assert_eq!(commands.matches("--patch").count(), 2);
        assert!(!commands.contains("--unified=1000000"));
        // A warmed cache must still reject a changed full content identity.
        fs::write(
            f.root.join("file.txt"),
            text.replace("line 40\n", "changed\n")
                .replace("line 1\n", "distant\n"),
        )
        .unwrap();
        assert_eq!(f.context(&input).await.0, StatusCode::UNPROCESSABLE_ENTITY);
        f.git(&["config", "filter.blocked.clean", "false"]);
        assert_eq!(f.context(&input).await.0, StatusCode::UNPROCESSABLE_ENTITY);
        f.runtime.shutdown().await;
        return;
    }
    let git = Command::new("/bin/sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    let git = String::from_utf8(git.stdout).unwrap();
    let root =
        std::env::temp_dir().join(format!("pi-context-count-{}", config::identity().unwrap()));
    fs::create_dir(&root).unwrap();
    let log = root.join("commands");
    fs::write(
        root.join("git"),
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nexec '{}' \"$@\"\n",
            log.display(),
            git.trim()
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(root.join("git"), fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "lazy_listing_and_context_cache_skip_expanded_git_work",
            "--nocapture",
        ])
        .env("PATH", &root)
        .env(ENV, &log)
        .output()
        .unwrap();
    fs::remove_dir_all(root).unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn commit_context_uses_selected_snapshot_after_head_and_worktree_change() {
    let f = Fixture::new().await;
    f.init();
    let original = (1..=50).map(|n| format!("line {n}\n")).collect::<String>();
    fs::write(f.root.join("file.txt"), &original).unwrap();
    f.git(&["commit", "-qam", "lines"]);
    fs::write(
        f.root.join("file.txt"),
        original.replace("line 25\n", "selected\n"),
    )
    .unwrap();
    f.git(&["commit", "-qam", "selected"]);
    let out = Command::new("git")
        .current_dir(&f.root)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    let oid = String::from_utf8(out.stdout).unwrap().trim().to_owned();
    let input = serde_json::json!({"scope":"commit","commit":oid,"path":"file.txt"});
    let (status, snapshot) = f.request(&input.to_string(), true, true).await;
    assert_eq!(status, StatusCode::OK, "{snapshot}");
    fs::write(f.root.join("file.txt"), "later\n").unwrap();
    f.git(&["commit", "-qam", "later"]);
    fs::write(f.root.join("file.txt"), "dirty\n").unwrap();
    let mut input = serde_json::json!({"scope":"commit","commit":oid,"path":"file.txt","fingerprint":snapshot["files"][0]["fingerprint"],"oldStart":1,"newStart":1,"count":20});
    let (status, result) = f.request_at(&input.to_string(), true, true, true).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["lines"],
        serde_json::json!((1..=20).map(|n| format!("line {n}")).collect::<Vec<_>>())
    );
    input["fingerprint"] = "stale".into();
    assert_eq!(
        f.request_at(&input.to_string(), true, true, true).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        fs::read_to_string(f.root.join("file.txt")).unwrap(),
        "dirty\n"
    );
    f.runtime.shutdown().await;
}
