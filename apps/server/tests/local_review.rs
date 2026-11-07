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
        let root = std::env::temp_dir().join(format!("pi-review-{}", config::identity().unwrap()));
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
    async fn loaded(&self, body: &str) -> (StatusCode, serde_json::Value) {
        let (status, mut list) = self.request(body, true, true).await;
        if status == StatusCode::OK {
            for file in list["files"].as_array_mut().unwrap() {
                let mut input: serde_json::Value = serde_json::from_str(body).unwrap();
                input["path"] = file["path"].clone();
                let (status, selected) = self.request(&input.to_string(), true, true).await;
                if status != StatusCode::OK {
                    return (status, selected);
                }
                *file = selected["files"][0].clone();
            }
        }
        (status, list)
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
                if structural { "/structural" } else { "" }
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
async fn line_totals_cover_the_scope_without_loading_patches() {
    let f = Fixture::new().await;
    f.init();
    fs::write(f.root.join("binary"), b"old\0binary").unwrap();
    f.git(&["add", "binary"]);
    f.git(&["commit", "-qm", "binary"]);
    fs::write(f.root.join("binary"), b"new\0binary").unwrap();
    fs::write(f.root.join("file.txt"), "after\nextra\n").unwrap();
    fs::write(f.root.join("untracked"), "not counted\n").unwrap();
    let (status, body) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["lineStats"], serde_json::json!({"added":2,"removed":1,"unavailableFiles":2}));
    assert!(body["files"].as_array().unwrap().iter().all(|file| file["patch"].is_null()));
    for file in body["files"].as_array().unwrap() {
        if file["path"] == "file.txt" {
            assert_eq!(file["lineStats"], serde_json::json!({"added":2,"removed":1}));
        } else {
            assert!(file.get("lineStats").is_none());
        }
    }
    let (_, staged) = f.request(r#"{"scope":"staged"}"#, true, true).await;
    assert_eq!(staged["lineStats"], serde_json::json!({"added":0,"removed":0,"unavailableFiles":0}));
    let (_, selected) = f.request(r#"{"scope":"unstaged","path":"file.txt"}"#, true, true).await;
    assert!(selected.get("lineStats").is_none());
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn line_totals_include_renames_large_patches_and_files_beyond_display_limits() {
    let f = Fixture::new().await;
    f.init();
    f.git(&["branch", "base"]);
    f.git(&["mv", "file.txt", "renamed\tfile\n.txt"]);
    for index in 0..105 {
        let name = if index == 0 { "tab\tline\n0".into() } else { format!("new-{index}") };
        fs::write(f.root.join(name), "new\n").unwrap();
    }
    fs::write(f.root.join("large"), "line\n".repeat(40_000)).unwrap();
    f.git(&["add", "."]);
    let (status, staged) = f.request(r#"{"scope":"staged"}"#, true, true).await;
    assert_eq!(status, StatusCode::OK, "{staged}");
    assert_eq!(staged["files"].as_array().unwrap().len(), 100);
    assert_eq!(staged["truncated"], false);
    assert!(staged["nextCursor"].is_string());
    let expected = serde_json::json!({"added":40105,"removed":0,"unavailableFiles":0});
    assert_eq!(staged["lineStats"], expected);
    let (_, next) = f.request(&serde_json::json!({"scope":"staged","cursor":staged["nextCursor"]}).to_string(), true, true).await;
    let renamed = next["files"].as_array().unwrap().iter().find(|file| file["path"] == "renamed\tfile\n.txt").unwrap();
    assert_eq!(renamed["lineStats"], serde_json::json!({"added":0,"removed":0}));
    let (_, selected) = f.request(r#"{"scope":"staged","path":"large"}"#, true, true).await;
    assert_eq!(selected["files"][0]["patch"], "Patch exceeds 64 KiB; content omitted.\n");
    f.git(&["commit", "-qm", "changes"]);
    let (_, branch) = f.request(r#"{"scope":"branch","base":"base"}"#, true, true).await;
    assert_eq!(branch["lineStats"], expected);
    assert_eq!(branch["files"][0]["lineStats"], serde_json::json!({"added":40000,"removed":0}));
    let (_, commit) = f.request(&format!(r#"{{"scope":"commit","commit":"{}"}}"#, f.oid("HEAD")), true, true).await;
    assert_eq!(commit["lineStats"], expected);
    assert_eq!(commit["files"][0]["lineStats"], serde_json::json!({"added":40000,"removed":0}));
    let (_, root) = f.request(&format!(r#"{{"scope":"commit","commit":"{}"}}"#, f.oid("base")), true, true).await;
    assert_eq!(root["lineStats"], serde_json::json!({"added":2,"removed":0,"unavailableFiles":0}));
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn line_totals_support_long_thousand_file_listings() {
    let f = Fixture::new().await;
    f.init();
    // Both listings and statistics can exceed the former 256 KiB budget.
    for index in 0..1100 {
        fs::write(f.root.join(format!("n{index:04}-{}", "x".repeat(229))), "new\n").unwrap();
    }
    let (status, untracked) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_eq!(status, StatusCode::OK, "{untracked}");
    assert_eq!(untracked["lineStats"], serde_json::json!({"added":0,"removed":0,"unavailableFiles":1100}));
    let (status, next) = f.request(
        &serde_json::json!({"scope":"unstaged","cursor":untracked["nextCursor"]}).to_string(),
        true,
        true,
    ).await;
    assert_eq!(status, StatusCode::OK, "{next}");
    assert_eq!(next["files"].as_array().unwrap().len(), 100);
    assert_eq!(next["truncated"], true);
    assert!(next.get("lineStats").is_none());
    assert!(next.get("snapshotKey").is_none());
    f.git(&["add", "."]);
    let (status, staged) = f.request(r#"{"scope":"staged"}"#, true, true).await;
    assert_eq!(status, StatusCode::OK, "{staged}");
    assert_eq!(staged["files"].as_array().unwrap().len(), 100);
    assert_eq!(staged["lineStats"], serde_json::json!({"added":1100,"removed":0,"unavailableFiles":0}));
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn reviews_stopped_session_workspace() {
    let f = Fixture::new().await;
    f.init();
    fs::write(f.root.join("file.txt"), "after\n").unwrap();
    let (status, body) = f.loaded(r#"{"scope":"unstaged"}"#).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["files"][0]["path"], "file.txt");
    assert!(
        body["files"][0]["patch"]
            .as_str()
            .unwrap()
            .contains("+after")
    );
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn staged_renames_literal_paths_and_branch_merge_base() {
    let f = Fixture::new().await;
    f.init();
    f.git(&["branch", "base"]);
    f.git(&["mv", "file.txt", ":(glob)*.txt"]);
    let (status, body) = f.loaded(r#"{"scope":"staged"}"#).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["files"][0]["status"], "renamed");
    assert_eq!(body["files"][0]["previousPath"], "file.txt");
    assert!(
        body["files"][0]["patch"]
            .as_str()
            .unwrap()
            .contains("rename to :(glob)*.txt")
    );
    f.git(&["commit", "-qm", "rename"]);
    let (status, body) = f.loaded(r#"{"scope":"branch","base":"base"}"#).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["files"][0]["status"], "renamed");
    fs::write(f.root.join(":(glob)*.txt"), "changed\n").unwrap();
    fs::write(f.root.join("other.txt"), "untracked\n").unwrap();
    let (_, body) = f.loaded(r#"{"scope":"unstaged"}"#).await;
    assert_eq!(body["files"][0]["path"], ":(glob)*.txt");
    assert!(
        !body["files"][0]["patch"]
            .as_str()
            .unwrap()
            .contains("other.txt")
    );
    assert_eq!(body["files"][1]["status"], "untracked");
    assert_eq!(body["truncated"], true);
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn rejects_invalid_requests_and_enforces_browser_boundary() {
    let f = Fixture::new().await;
    f.init();
    for body in [
        r#"{"scope":"unstaged","extra":true}"#,
        r#"{"scope":"remote"}"#,
        r#"{}"#,
    ] {
        let (status, value) = f.request(body, true, true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(value["error"].is_string());
    }
    for base in [
        "https://github.com/a/b",
        "-HEAD",
        "HEAD~1",
        "HEAD^{commit}",
        "missing",
        "../main",
        "main:foo",
        "a b",
    ] {
        let (status, value) = f
            .request(
                &serde_json::json!({"scope":"branch", "base":base}).to_string(),
                true,
                true,
            )
            .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{base}: {value}");
        assert!(value["error"].is_string());
    }
    assert_eq!(
        f.request(r#"{"scope":"branch"}"#, true, true).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        f.request(r#"{"scope":"unstaged"}"#, false, true).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.request(r#"{"scope":"unstaged"}"#, true, false).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request(&"x".repeat(2049), true, true).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn nonrepositories_and_jj_only_workspaces_are_rejected() {
    let f = Fixture::new().await;
    let (status, value) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(value["error"].is_string());
    fs::create_dir(f.root.join(".jj")).unwrap();
    assert_eq!(
        f.request(r#"{"scope":"unstaged"}"#, true, true).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn binary_large_patches_and_external_helpers_are_safe() {
    let f = Fixture::new().await;
    f.init();
    fs::write(f.root.join("binary"), b"before\0binary").unwrap();
    f.git(&["add", "binary"]);
    f.git(&["commit", "-qm", "binary"]);
    fs::write(f.root.join("binary"), b"after\0binary").unwrap();
    fs::write(f.root.join("file.txt"), "huge\n".repeat(20000)).unwrap();
    let helper = f.root.join("helper");
    fs::write(
        &helper,
        format!("#!/bin/sh\ntouch '{}'\n", f.root.join("executed").display()),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    f.git(&["config", "diff.external", helper.to_str().unwrap()]);
    f.git(&["config", "diff.custom.textconv", helper.to_str().unwrap()]);
    fs::write(f.root.join(".gitattributes"), "file.txt diff=custom\n").unwrap();
    let (status, body) = f.loaded(r#"{"scope":"unstaged"}"#).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let files = body["files"].as_array().unwrap();
    assert!(
        files.iter().find(|f| f["path"] == "binary").unwrap()["patch"]
            .as_str()
            .unwrap()
            .contains("Binary files")
    );
    assert!(
        files.iter().find(|f| f["path"] == "file.txt").unwrap()["patch"]
            .as_str()
            .unwrap()
            .contains("exceeds 64 KiB")
    );
    assert_eq!(body["truncated"], true);
    assert!(!f.root.join("executed").exists());
    f.runtime.shutdown().await;
}

/// A filter helper may write or contact a remote even during a nominally read-only diff.
async fn assert_filter_rejected(kind: &str) {
    let f = Fixture::new().await;
    f.init();
    fs::write(f.root.join(".gitattributes"), "file.txt filter=custom\n").unwrap();
    fs::write(f.root.join("file.txt"), "after\n").unwrap();
    let helper = f.root.join("filter-helper");
    fs::write(&helper, "#!/bin/sh\ntouch filter-executed\ncat\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    f.git(&[
        "config",
        &format!("filter.custom.{kind}"),
        helper.to_str().unwrap(),
    ]);
    let (status, body) = f.loaded(r#"{"scope":"unstaged"}"#).await;
    assert!(
        !f.root.join("filter-executed").exists(),
        "{kind} helper executed"
    );
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(body["error"].as_str().unwrap().contains("filters"));
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn clean_filters_are_rejected_without_execution() {
    assert_filter_rejected("clean").await;
}

#[tokio::test]
async fn process_filters_are_rejected_without_execution() {
    assert_filter_rejected("process").await;
}

#[tokio::test]
async fn missing_promised_blob_never_fetches_or_runs_transport_helper() {
    let f = Fixture::new().await;
    f.init();
    let output = Command::new("git")
        .current_dir(&f.root)
        .args(["rev-parse", "HEAD:file.txt"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let oid = String::from_utf8(output.stdout).unwrap();
    let oid = oid.trim();
    let object = f.root.join(".git/objects").join(&oid[..2]).join(&oid[2..]);
    fs::remove_file(&object).unwrap();
    let helper = f.root.join("fetch-helper");
    fs::write(&helper, "#!/bin/sh\ntouch fetch-executed\nexit 1\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    f.git(&[
        "config",
        "remote.origin.url",
        &format!("ext::{}", helper.display()),
    ]);
    f.git(&["config", "remote.origin.promisor", "true"]);
    f.git(&["config", "remote.origin.partialclonefilter", "blob:none"]);
    // Repository protocol permission must not override the review runner's deny list.
    f.git(&["config", "protocol.ext.allow", "always"]);
    fs::write(f.root.join("file.txt"), "after\n").unwrap();
    let (status, body) = f.loaded(r#"{"scope":"unstaged"}"#).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(!f.root.join("fetch-executed").exists());
    assert!(!object.exists(), "review populated the object store");
    // Positive control: ordinary Git attempts the harmless transport helper for
    // this same missing blob, so the no-fetch assertion exercises a real promisor.
    let control = Command::new("git")
        .current_dir(&f.root)
        .env_remove("GIT_NO_LAZY_FETCH")
        .env_remove("GIT_ALLOW_PROTOCOL")
        .args(["cat-file", "-p", oid])
        .output()
        .unwrap();
    assert!(!control.status.success());
    assert!(f.root.join("fetch-executed").exists());
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn unsupported_git_fails_closed() {
    // Change PATH only in a subprocess; other tests must keep using real Git.
    if std::env::var_os("PI_WEB_REVIEW_OLD_GIT_TEST").is_some() {
        let f = Fixture::new().await;
        fs::create_dir(f.root.join(".git")).unwrap();
        let (status, body) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert!(body["error"].as_str().unwrap().contains("--no-lazy-fetch"));
        f.runtime.shutdown().await;
        return;
    }
    let root = std::env::temp_dir().join(format!("pi-old-git-{}", config::identity().unwrap()));
    fs::create_dir(&root).unwrap();
    let git = root.join("git");
    fs::write(&git, "#!/bin/sh\ncase \" $* \" in\n*\" --no-lazy-fetch \"*) exit 129;;\n*) echo bypass > \"$PI_WEB_REVIEW_OLD_GIT_TEST/bypass\"; exit 1;;\nesac\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&git, fs::Permissions::from_mode(0o700)).unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "unsupported_git_fails_closed", "--nocapture"])
        .env("PATH", &root)
        .env("PI_WEB_REVIEW_OLD_GIT_TEST", &root)
        .output()
        .unwrap();
    let bypass = root.join("bypass").exists();
    fs::remove_dir_all(root).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!bypass, "Git ran without a fail-closed no-fetch flag");
}

#[tokio::test]
async fn file_count_limit_and_untracked_symlink_are_explicit() {
    let f = Fixture::new().await;
    f.init();
    std::os::unix::fs::symlink("/dev/zero", f.root.join("link")).unwrap();
    let (_, body) = f
        .request(r#"{"scope":"unstaged","path":"link"}"#, true, true)
        .await;
    assert_eq!(body["files"][0]["path"], "link");
    assert!(
        body["files"][0]["patch"]
            .as_str()
            .unwrap()
            .contains("has not been read")
    );
    for index in 0..101 {
        fs::write(f.root.join(format!("new-{index}")), "new\n").unwrap();
    }
    f.git(&["add", "."]);
    let (status, body) = f.request(r#"{"scope":"staged"}"#, true, true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["files"].as_array().unwrap().len(), 100);
    assert_eq!(body["truncated"], false);
    assert!(body["note"].is_null());
    assert!(body["nextCursor"].is_string());
    let (status, selected) = f
        .request(r#"{"scope":"staged","path":"new-99"}"#, true, true)
        .await;
    assert_eq!(status, StatusCode::OK, "{selected}");
    assert_eq!(selected["files"].as_array().unwrap().len(), 1);
    assert_eq!(selected["files"][0]["path"], "new-99");
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn branch_uses_merge_base_not_base_tip() {
    let f = Fixture::new().await;
    f.init();
    f.git(&["checkout", "-qb", "base"]);
    fs::write(f.root.join("base-only"), "base\n").unwrap();
    f.git(&["add", "."]);
    f.git(&["commit", "-qm", "base advance"]);
    f.git(&["checkout", "-q", "main"]);
    fs::write(f.root.join("head-only"), "head\n").unwrap();
    f.git(&["add", "."]);
    f.git(&["commit", "-qm", "head advance"]);
    let (status, body) = f
        .request(r#"{"scope":"branch","base":"base"}"#, true, true)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["files"].as_array().unwrap().len(), 1);
    assert_eq!(body["files"][0]["path"], "head-only");
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn structural_endpoint_rejects_invalid_paths() {
    let f = Fixture::new().await;
    f.init();
    let (status, body) = f
        .request_at(
            r#"{"scope":"unstaged","path":"../secret","fingerprint":"stale"}"#,
            true,
            true,
            true,
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(body["error"].is_string());
    f.runtime.shutdown().await;
}

impl Fixture {
    async fn structural(
        &self,
        scope: &str,
        base: Option<&str>,
        path: &str,
    ) -> (StatusCode, serde_json::Value) {
        let (_, review) = self
            .request(
                &serde_json::json!({"scope":scope,"base":base,"path":path}).to_string(),
                true,
                true,
            )
            .await;
        let file = review["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == path)
            .unwrap();
        self.request_at(&serde_json::json!({"scope":scope,"base":base,"path":path,"fingerprint":file["fingerprint"]}).to_string(), true, true, true).await
    }
}

#[tokio::test]
async fn structural_browser_boundary_and_stale_snapshots() {
    let f = Fixture::new().await;
    f.init();
    fs::write(f.root.join("file.txt"), "changed\n").unwrap();
    let request = r#"{"scope":"unstaged","path":"file.txt","fingerprint":"stale"}"#;
    assert_eq!(
        f.request_at(request, false, true, true).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.request_at(request, true, false, true).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request_at(&"x".repeat(2049), true, true, true).await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        f.request_at(request, true, true, true).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    for path in [
        "/etc/passwd",
        ".git/config",
        "a/../file.txt",
        "a//b",
        ".",
        "",
    ] {
        let body = serde_json::json!({"scope":"unstaged", "path":path,"fingerprint":"stale"});
        assert_eq!(
            f.request_at(&body.to_string(), true, true, true).await.0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    fs::write(f.root.join("untracked.rs"), "fn main() {}\n").unwrap();
    let (status, body) = f.structural("unstaged", None, "untracked.rs").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["mode"], "text");
    f.runtime.shutdown().await;
}

/// Explicit integration check; portable tests below do not depend on an installed engine.
#[tokio::test]
#[ignore = "requires Difftastic 0.72.0 on PATH"]
async fn real_difftastic_selected_scopes_unicode_tabs_cr_and_cache() {
    let f = Fixture::new().await;
    f.init();
    let before = "fn main() {\n\tlet café = \"old\";\r\n}\n";
    let staged = "fn main() {\n\tlet café = \"staged\";\r\n}\n";
    let worktree = "fn main() {\n\tlet café = \"worktree\";\r\n}\n";
    fs::write(f.root.join("code.rs"), before).unwrap();
    f.git(&["add", "code.rs"]);
    f.git(&["commit", "-qm", "code"]);
    f.git(&["branch", "base"]);
    fs::write(f.root.join("code.rs"), staged).unwrap();
    f.git(&["add", "code.rs"]);
    fs::write(f.root.join("code.rs"), worktree).unwrap();
    let (status, body) = f.structural("staged", None, "code.rs").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mode"], "structural", "{body}");
    let encoded = body.to_string();
    assert!(encoded.contains("staged"));
    assert!(!encoded.contains("worktree"));
    let lines = body["lines"].as_array().unwrap();
    let added = lines.iter().find(|l| l["kind"] == "add").unwrap();
    let text: String = added["segments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["text"].as_str().unwrap())
        .collect();
    assert_eq!(text, "\tlet café = \"staged\";\r");
    assert_eq!(f.structural("staged", None, "code.rs").await.1, body);
    let (status, body) = f.structural("unstaged", None, "code.rs").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["mode"], "structural", "{body}");
    assert!(body.to_string().contains("worktree"));
    f.git(&["commit", "-qm", "staged"]);
    let (_, branch) = f.structural("branch", Some("base"), "code.rs").await;
    assert_eq!(branch["mode"], "structural", "{branch}");
    assert!(!branch.to_string().contains("worktree"));
    // A formatting-only edit is a successful empty structural result.
    fs::write(
        f.root.join("code.rs"),
        "fn main() { let café = \"staged\"; }\n",
    )
    .unwrap();
    let (_, body) = f.structural("unstaged", None, "code.rs").await;
    assert_eq!(body["mode"], "structural", "{body}");
    assert_eq!(body["lines"], serde_json::json!([]));
    let (_, body) = f.loaded(r#"{"scope":"unstaged"}"#).await;
    let fingerprint = &body["files"][0]["fingerprint"];
    fs::write(f.root.join("code.rs"), "fn main() {}\n").unwrap();
    let (status, _) = f
        .request_at(
            &serde_json::json!({"scope":"unstaged","path":"code.rs","fingerprint":fingerprint})
                .to_string(),
            true,
            true,
            true,
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    fs::write(f.root.join("file.txt"), "unsupported\n").unwrap();
    let (_, body) = f.structural("unstaged", None, "file.txt").await;
    assert_eq!(body["mode"], "text", "{body}");
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn structural_engine_fallbacks_cache_admission_and_cleanup() {
    const ENV: &str = "PI_WEB_STRUCTURAL_FIXTURE";
    if let Some(mode) = std::env::var_os(ENV) {
        let mode = mode.to_str().unwrap();
        let f = Fixture::new().await;
        f.init();
        fs::write(f.root.join("code.rs"), "fn main() { let x = 1; }\n").unwrap();
        f.git(&["add", "code.rs"]);
        f.git(&["commit", "-qm", "code"]);
        fs::write(f.root.join("code.rs"), "fn main() { let x = 2; }\n").unwrap();
        let marker = PathBuf::from(std::env::var_os("PI_WEB_STRUCTURAL_MARKER").unwrap());
        if mode == "hang" {
            let (_, review) = f.loaded(r#"{"scope":"unstaged"}"#).await;
            let body = serde_json::json!({"scope":"unstaged","path":"code.rs","fingerprint":review["files"][0]["fingerprint"]}).to_string();
            let router = f.router.clone();
            let uri = format!("/review/{}/structural", f.session);
            let request_body = body.clone();
            let task = tokio::spawn(async move {
                router
                    .oneshot(
                        Request::builder()
                            .method("POST")
                            .uri(uri)
                            .header("host", "127.0.0.1:9876")
                            .header("origin", "http://127.0.0.1:9876")
                            .header("content-type", "application/json")
                            .header("x-pi-capability", "a".repeat(64))
                            .body(Body::from(request_body))
                            .unwrap(),
                    )
                    .await
            });
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while !marker.exists() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(
                f.request_at(&body, true, true, true).await.0,
                StatusCode::TOO_MANY_REQUESTS
            );
            assert_eq!(f.loaded(r#"{"scope":"unstaged"}"#).await.0, StatusCode::OK);
            task.abort();
            let _ = task.await;
            let captured = fs::read_to_string(marker.with_extension("path")).unwrap();
            let captured = PathBuf::from(captured.trim());
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                while captured.exists() {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            let pid: i32 = fs::read_to_string(&marker).unwrap().trim().parse().unwrap();
            // SAFETY: signal zero only checks the known fixture engine PID.
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        } else {
            let (status, body) = f.structural("unstaged", None, "code.rs").await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(
                body["mode"],
                if mode == "valid" {
                    "structural"
                } else {
                    "text"
                },
                "{body}"
            );
            if mode == "valid" {
                assert_eq!(f.structural("unstaged", None, "code.rs").await.1, body);
                assert_eq!(
                    fs::read_to_string(&marker).unwrap(),
                    "x",
                    "cache should avoid second diff execution"
                );
                let captured = fs::read_to_string(marker.with_extension("path")).unwrap();
                assert!(
                    !PathBuf::from(captured.trim()).exists(),
                    "private inputs survived request"
                );
                let (_, review) = f.loaded(r#"{"scope":"unstaged"}"#).await;
                fs::write(f.root.join("code.rs"), "fn main() { let x = 3; }\n").unwrap();
                let stale = serde_json::json!({"scope":"unstaged","path":"code.rs","fingerprint":review["files"][0]["fingerprint"]});
                assert_eq!(
                    f.request_at(&stale.to_string(), true, true, true).await.0,
                    StatusCode::UNPROCESSABLE_ENTITY
                );
                assert_eq!(fs::read_to_string(&marker).unwrap(), "x");
            } else {
                if mode == "parser" || mode == "malformed" {
                    assert_eq!(f.structural("unstaged", None, "code.rs").await.1, body);
                    assert_eq!(
                        fs::read_to_string(&marker).unwrap(),
                        if mode == "parser" { "x" } else { "xx" }
                    );
                }
                assert!(body["reason"].is_string());
                assert!(!body.to_string().contains("pi-structural-"));
            }
        }
        f.runtime.shutdown().await;
        return;
    }
    let git = Command::new("/bin/sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    let git = String::from_utf8(git.stdout).unwrap();
    for mode in ["missing", "wrong", "valid", "hang", "malformed", "parser"] {
        let root =
            std::env::temp_dir().join(format!("pi-engine-fixture-{}", config::identity().unwrap()));
        fs::create_dir(&root).unwrap();
        std::os::unix::fs::symlink(git.trim(), root.join("git")).unwrap();
        let marker = root.join("marker");
        if mode != "missing" {
            let output = match mode {
                "valid" => {
                    r#"{"status":"changed","language":"Rust","aligned_lines":[[0,0],[1,1]],"chunks":[[{"lhs":{"line_number":0,"changes":[{"start":20,"end":21,"content":"1"}]},"rhs":{"line_number":0,"changes":[{"start":20,"end":21,"content":"2"}]}}]]}"#
                }
                "parser" => r#"{"status":"changed","language":"Text (parse error)"}"#,
                _ => "invalid json",
            };
            let script = format!(
                "#!/bin/sh\nif [ \"$1\" = --version ]; then printf '{}\\n'; exit 0; fi\nfor last; do :; done\nprintf '%s\\n' \"$last\" > '{}.path'\n{}\nprintf '%s\\n' '{}'\n",
                if mode == "wrong" {
                    "Difftastic 0.71.0"
                } else {
                    "Difftastic 0.72.0"
                },
                marker.display(),
                if mode == "hang" {
                    format!("echo $$ > '{}'; while :; do :; done", marker.display())
                } else {
                    format!("printf x >> '{}'", marker.display())
                },
                output
            );
            fs::write(root.join("difft"), script).unwrap();
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join("difft"), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "structural_engine_fallbacks_cache_admission_and_cleanup",
                "--nocapture",
            ])
            .env("PATH", &root)
            .env(ENV, mode)
            .env("PI_WEB_STRUCTURAL_MARKER", &marker)
            .output()
            .unwrap();
        fs::remove_dir_all(root).unwrap();
        assert!(
            output.status.success(),
            "{mode}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[tokio::test]
async fn structural_special_files_and_large_inputs_fall_back() {
    let f = Fixture::new().await;
    f.init();
    std::os::unix::fs::symlink("file.txt", f.root.join("link.rs")).unwrap();
    let large = format!("{}fn main() {{}}\n", "// context\n".repeat(14000));
    fs::write(f.root.join("large.rs"), &large).unwrap();
    f.git(&["add", "link.rs", "large.rs"]);
    f.git(&["commit", "-qm", "special and large"]);
    fs::remove_file(f.root.join("link.rs")).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", f.root.join("link.rs")).unwrap();
    fs::write(
        f.root.join("large.rs"),
        large.replace("fn main() {}", "fn main() { let x = 1; }"),
    )
    .unwrap();
    for path in ["link.rs", "large.rs"] {
        let (status, body) = f.structural("unstaged", None, path).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["mode"], "text", "{body}");
    }
    fs::write(f.root.join("added.rs"), "fn main() {}\n").unwrap();
    f.git(&["add", "added.rs"]);
    assert_eq!(
        f.structural("staged", None, "added.rs").await.1["mode"],
        "text"
    );
    fs::remove_file(f.root.join("file.txt")).unwrap();
    assert_eq!(
        f.structural("unstaged", None, "file.txt").await.1["mode"],
        "text"
    );
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn listing_is_metadata_only_and_selection_requires_fresh_membership() {
    let f = Fixture::new().await;
    f.init();
    fs::write(f.root.join("file.txt"), "after\n").unwrap();
    let (status, list) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_eq!(status, StatusCode::OK);
    assert!(list["files"][0]["patch"].is_null());
    assert!(list["files"][0]["fingerprint"].is_null());
    let (status, loaded) = f
        .request(r#"{"scope":"unstaged","path":"file.txt"}"#, true, true)
        .await;
    assert_eq!(status, StatusCode::OK, "{loaded}");
    assert_eq!(loaded["files"].as_array().unwrap().len(), 1);
    assert!(
        loaded["files"][0]["patch"]
            .as_str()
            .unwrap()
            .contains("+after")
    );
    fs::write(f.root.join("file.txt"), "before\n").unwrap();
    for path in ["file.txt", "../file.txt", ".git/config", ":(glob)*", "/tmp"] {
        assert_eq!(
            f.request(
                &serde_json::json!({"scope":"unstaged","path":path}).to_string(),
                true,
                true
            )
            .await
            .0,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn selected_commit_is_its_own_patch_not_head_or_worktree() {
    let f = Fixture::new().await;
    f.init();
    fs::write(f.root.join("file.txt"), "selected\n").unwrap();
    f.git(&["commit", "-qam", "selected"]);
    let output = Command::new("git")
        .current_dir(&f.root)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    let oid = String::from_utf8(output.stdout).unwrap().trim().to_owned();
    fs::write(f.root.join("file.txt"), "later\n").unwrap();
    f.git(&["commit", "-qam", "later"]);
    fs::write(f.root.join("file.txt"), "dirty\n").unwrap();
    let (status, result) = f
        .loaded(&serde_json::json!({"scope":"commit", "commit":oid}).to_string())
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let patch = result["files"][0]["patch"].as_str().unwrap();
    assert!(patch.contains("-before\n+selected\n"), "{patch}");
    let mut structural = serde_json::json!({"scope":"commit", "commit":oid, "path":"file.txt", "fingerprint":result["files"][0]["fingerprint"]});
    let (status, body) = f
        .request_at(&structural.to_string(), true, true, true)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["mode"] == "text" || body["mode"] == "structural");
    structural["fingerprint"] = "stale".into();
    assert_eq!(
        f.request_at(&structural.to_string(), true, true, true)
            .await
            .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        fs::read_to_string(f.root.join("file.txt")).unwrap(),
        "dirty\n"
    );
}

impl Fixture {
    fn oid(&self, revision: &str) -> String {
        let out = Command::new("git")
            .current_dir(&self.root)
            .args(["rev-parse", revision])
            .output()
            .unwrap();
        assert!(out.status.success());
        String::from_utf8(out.stdout).unwrap().trim().into()
    }
    async fn commits(
        &self,
        session: &str,
        body: &str,
        proof: bool,
        origin: &str,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder()
            .method("POST")
            .uri(format!("/review/{session}/commits"))
            .header("host", "127.0.0.1:9876")
            .header("origin", origin)
            .header("content-type", "application/json");
        if proof {
            request = request.header("x-pi-capability", "a".repeat(64));
        }
        let response = self
            .router
            .clone()
            .oneshot(request.body(Body::from(body.to_owned())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 256 * 1024).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }
}

#[tokio::test]
async fn commit_root_merge_and_missing_parent() {
    let f = Fixture::new().await;
    f.init();
    let root = f.oid("HEAD");
    let (status, result) = f
        .loaded(&serde_json::json!({"scope":"commit","commit":root}).to_string())
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert!(
        result["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|file| file["path"] == "file.txt"
                && file["patch"].as_str().unwrap().contains("+before"))
    );
    f.git(&["checkout", "-qb", "side"]);
    fs::write(f.root.join("side.txt"), "side\n").unwrap();
    f.git(&["add", "side.txt"]);
    f.git(&["commit", "-qm", "side"]);
    let side = f.oid("HEAD");
    f.git(&["checkout", "-q", "main"]);
    fs::write(f.root.join("main.txt"), "main\n").unwrap();
    f.git(&["add", "main.txt"]);
    f.git(&["commit", "-qm", "main"]);
    let parent = f.oid("HEAD");
    f.git(&["merge", "--no-ff", "-qm", "merge", "side"]);
    let merge = f.oid("HEAD");
    let (status, result) = f
        .loaded(&serde_json::json!({"scope":"commit","commit":merge}).to_string())
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["files"].as_array().unwrap().len(), 1);
    assert_eq!(result["files"][0]["path"], "side.txt");
    let (_, history) = f
        .commits(&f.session, "{}", true, "http://127.0.0.1:9876")
        .await;
    assert!(
        history["commits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == side)
    );
    // A shallow boundary is not a root: the raw parent header still requires its object.
    fs::write(f.root.join(".git/shallow"), format!("{merge}\n")).unwrap();
    fs::remove_file(
        f.root
            .join(format!(".git/objects/{}/{}", &parent[..2], &parent[2..])),
    )
    .unwrap();
    let (status, error) = f
        .request(
            &serde_json::json!({"scope":"commit","commit":merge}).to_string(),
            true,
            true,
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(error["error"].as_str().unwrap().contains("first parent"));
}

#[tokio::test]
async fn commit_inputs_require_actual_full_commit_objects() {
    let f = Fixture::new().await;
    f.init();
    let oid = f.oid("HEAD");
    for input in [
        serde_json::json!({"scope":"commit"}),
        serde_json::json!({"scope":"commit","commit":"HEAD"}),
        serde_json::json!({"scope":"commit","commit":&oid[..12]}),
        serde_json::json!({"scope":"commit","commit":oid.to_uppercase()}),
        serde_json::json!({"scope":"commit","commit":format!("{oid}^1")}),
        serde_json::json!({"scope":"commit","commit":"0".repeat(40)}),
        serde_json::json!({"scope":"commit","commit":"0".repeat(64)}),
        serde_json::json!({"scope":"commit","commit":f.oid("HEAD:file.txt")}),
        serde_json::json!({"scope":"commit","commit":oid,"base":"main"}),
        serde_json::json!({"scope":"unstaged","commit":oid}),
        serde_json::json!({"scope":"staged","commit":oid}),
        serde_json::json!({"scope":"branch","base":"main","commit":oid}),
    ] {
        assert_eq!(
            f.request(&input.to_string(), true, true).await.0,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{input}"
        );
    }
}

#[tokio::test]
async fn commits_endpoint_is_bounded_and_checks_browser_boundary() {
    let f = Fixture::new().await;
    f.git(&["init", "-q", "-b", "main"]);
    let origin = "http://127.0.0.1:9876";
    let (status, empty) = f.commits(&f.session, "{}", true, origin).await;
    assert_eq!(status, StatusCode::OK, "{empty}");
    assert_eq!(empty, serde_json::json!({"commits":[],"truncated":false}));
    f.git(&["config", "user.email", "test@example.invalid"]);
    f.git(&["config", "user.name", "Test"]);
    for i in 0..101 {
        f.git(&[
            "commit",
            "--allow-empty",
            "-qm",
            &format!("{i} {}", "界".repeat(600)),
        ]);
    }
    f.git(&["checkout", "--detach", "-q"]);
    let (status, result) = f.commits(&f.session, "{}", true, origin).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["commits"].as_array().unwrap().len(), 100);
    assert_eq!(result["truncated"], true);
    assert_eq!(result["commits"][0]["id"], f.oid("HEAD"));
    assert_eq!(
        result["commits"][0]["subject"]
            .as_str()
            .unwrap()
            .chars()
            .count(),
        512
    );
    assert_eq!(
        f.commits(&f.session, "{}", false, origin).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.commits(&f.session, "{}", true, "http://evil.invalid")
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.commits(&f.session, r#"{"unknown":1}"#, true, origin)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.commits(&f.session, &" ".repeat(2049), true, origin)
            .await
            .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        f.commits("missing", "{}", true, origin).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn commit_history_bounds_pathological_messages_and_accepts_sha256() {
    let f = Fixture::new().await;
    f.git(&["init", "-q", "-b", "main", "--object-format=sha256"]);
    f.init();
    let oid = f.oid("HEAD");
    assert_eq!(oid.len(), 64);
    assert_eq!(
        f.request(
            &serde_json::json!({"scope":"commit","commit":&oid[..40]}).to_string(),
            true,
            true
        )
        .await
        .0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        f.loaded(&serde_json::json!({"scope":"commit","commit":oid}).to_string())
            .await
            .0,
        StatusCode::OK
    );
    let (status, result) = f
        .commits(&f.session, "{}", true, "http://127.0.0.1:9876")
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(result["commits"][0]["id"], oid);
    fs::write(f.root.join("message"), "x".repeat(1024 * 1024 + 1)).unwrap();
    f.git(&["commit", "--allow-empty", "-q", "-F", "message"]);
    let (status, result) = f
        .commits(&f.session, "{}", true, "http://127.0.0.1:9876")
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(result["error"], "Git output exceeds review limit");
}

impl Fixture {
    async fn branches(
        &self,
        session: &str,
        body: &str,
        proof: bool,
        origin: &str,
        content_type: &str,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder()
            .method("POST")
            .uri(format!("/review/{session}/branches"))
            .header("host", "127.0.0.1:9876")
            .header("origin", origin)
            .header("content-type", content_type);
        if proof {
            request = request.header("x-pi-capability", "a".repeat(64));
        }
        let response = self
            .router
            .clone()
            .oneshot(request.body(Body::from(body.to_owned())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 256 * 1024).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }
}

#[tokio::test]
async fn branches_list_local_and_remote_refs_without_symbolic_aliases_or_tags() {
    let f = Fixture::new().await;
    f.init();
    f.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    f.git(&[
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
    ]);
    f.git(&["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
    f.git(&["tag", "release"]);
    let (status, result) = f
        .branches(
            &f.session,
            "{}",
            true,
            "http://127.0.0.1:9876",
            "application/json",
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result,
        serde_json::json!({"branches":[
        {"ref":"refs/heads/main", "name":"main", "kind":"local"},
        {"ref":"refs/remotes/origin/main", "name":"origin/main", "kind":"remote"}
    ],"truncated":false})
    );
    fs::write(f.root.join("file.txt"), "remote base change\n").unwrap();
    f.git(&["commit", "-qam", "advance"]);
    let (status, review) = f
        .loaded(
            &serde_json::json!({"scope":"branch", "base":result["branches"][1]["ref"]}).to_string(),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{review}");
    assert!(
        review["files"][0]["patch"]
            .as_str()
            .unwrap()
            .contains("+remote base change")
    );
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn branches_empty_unborn_and_entry_limit() {
    let f = Fixture::new().await;
    let origin = "http://127.0.0.1:9876";
    let json = "application/json";
    assert_eq!(
        f.branches(&f.session, "{}", true, origin, json).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    f.git(&["init", "-q", "-b", "main"]);
    let (status, empty) = f.branches(&f.session, "{}", true, origin, json).await;
    assert_eq!(status, StatusCode::OK, "{empty}");
    assert_eq!(empty, serde_json::json!({"branches":[],"truncated":false}));
    f.init();
    for n in 0..99 {
        f.git(&["branch", &format!("choice-{n:03}")]);
    }
    let (status, full) = f.branches(&f.session, "{}", true, origin, json).await;
    assert_eq!(status, StatusCode::OK, "{full}");
    assert_eq!(full["branches"].as_array().unwrap().len(), 100);
    assert_eq!(full["truncated"], false);
    f.git(&["symbolic-ref", "refs/heads/aaa-alias", "refs/heads/main"]);
    f.git(&["branch", "extra"]);
    let (status, limited) = f.branches(&f.session, "{}", true, origin, json).await;
    assert_eq!(status, StatusCode::OK, "{limited}");
    assert_eq!(limited["branches"].as_array().unwrap().len(), 100);
    assert_eq!(limited["truncated"], true);
    assert_eq!(limited["branches"][0]["name"], "choice-000");
    for query in ["x".repeat(257), "é".repeat(129)] {
        let body = serde_json::json!({ "query": query }).to_string();
        assert_eq!(f.branches(&f.session, &body, true, origin, json).await.0, StatusCode::BAD_REQUEST);
    }
    f.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
    let (status, searched) = f
        .branches(&f.session, r#"{"query":" ORIGIN/MAIN "}"#, true, origin, json)
        .await;
    assert_eq!(status, StatusCode::OK, "{searched}");
    assert_eq!(searched, serde_json::json!({"branches":[
        {"ref":"refs/remotes/origin/main","name":"origin/main","kind":"remote"}
    ],"truncated":false}));
    let (status, missing) = f
        .branches(&f.session, r#"{"query":"missing*"}"#, true, origin, json)
        .await;
    assert_eq!(status, StatusCode::OK, "{missing}");
    assert_eq!(missing, serde_json::json!({"branches":[],"truncated":false}));
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn branches_bound_json_bytes_for_escaped_names() {
    let f = Fixture::new().await;
    f.init();
    for n in 0..100 {
        f.git(&["branch", &format!("{}{:03}", "\"".repeat(242), n)]);
    }
    let (status, result) = f
        .branches(&f.session, "{}", true, "http://127.0.0.1:9876", "application/json")
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert!(serde_json::to_vec(&result).unwrap().len() <= 64 * 1024);
    assert_eq!(result["truncated"], true);
    assert!((2..100).contains(&result["branches"].as_array().unwrap().len()));
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn branches_enforce_browser_and_request_boundaries() {
    let f = Fixture::new().await;
    f.init();
    let origin = "http://127.0.0.1:9876";
    let json = "application/json";
    assert_eq!(
        f.branches(&f.session, "{}", false, origin, json).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.branches(&f.session, "{}", true, "http://evil.invalid", json)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.branches(&f.session, "{}", true, origin, "text/plain")
            .await
            .0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    for body in [r#"{"unknown":1}"#, r#"{"query":null}"#, r#"{"query":12}"#, r#"{"query":"a\nb"}"#, "null", "[]", ""] {
        assert_eq!(
            f.branches(&f.session, body, true, origin, json).await.0,
            StatusCode::BAD_REQUEST,
            "{body}"
        );
    }
    assert_eq!(
        f.branches(&f.session, &" ".repeat(2049), true, origin, json)
            .await
            .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        f.branches("missing", "{}", true, origin, json).await.0,
        StatusCode::NOT_FOUND
    );
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn branches_only_offer_refs_accepted_by_branch_review() {
    let f = Fixture::new().await;
    f.init();
    // Git accepts these names, while branch review intentionally rejects them.
    f.git(&["branch", "name@host"]);
    f.git(&["branch", "unicode\u{2003}space"]);
    f.git(&["branch", &format!("{}/{}", "a".repeat(200), "b".repeat(50))]);
    let (status, result) = f
        .branches(
            &f.session,
            "{}",
            true,
            "http://127.0.0.1:9876",
            "application/json",
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["branches"],
        serde_json::json!([
            {"ref":"refs/heads/main", "name":"main", "kind":"local"}
        ])
    );
    assert_eq!(result["truncated"], true);
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn thousand_file_review_pages_each_file_once_and_loads_last_patch() {
    let f = Fixture::new().await;
    f.init();
    for index in 0..1000 {
        fs::write(f.root.join(format!("page-{index:04}")), "new\n").unwrap();
    }
    f.git(&["add", "."]);
    let mut request = serde_json::json!({"scope":"staged"});
    let mut paths = std::collections::BTreeSet::new();
    let mut pages = 0;
    loop {
        let (status, body) = f.request(&request.to_string(), true, true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["truncated"], false);
        let files = body["files"].as_array().unwrap();
        assert_eq!(files.len(), 100);
        assert!(serde_json::to_vec(&body).unwrap().len() <= 1024 * 1024);
        for file in files {
            assert!(file["patch"].is_null());
            assert_eq!(file["lineStats"], serde_json::json!({"added":1,"removed":0}));
            assert!(paths.insert(file["path"].as_str().unwrap().to_owned()));
        }
        if pages == 0 {
            assert_eq!(body["lineStats"]["added"], 1000);
        } else {
            assert!(body.get("lineStats").is_none());
        }
        pages += 1;
        if let Some(cursor) = body.get("nextCursor") {
            request["cursor"] = cursor.clone();
        } else {
            break;
        }
        assert!(pages < 11);
    }
    assert_eq!(pages, 10);
    assert_eq!(paths.len(), 1000);
    let (status, selected) = f.request(r#"{"scope":"staged","path":"page-0999"}"#, true, true).await;
    assert_eq!(status, StatusCode::OK, "{selected}");
    assert!(selected["files"][0]["patch"].as_str().unwrap().contains("+new"));
    assert!(selected.get("nextCursor").is_none());
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn review_cursors_reject_invalid_changed_and_cross_scope_listings() {
    let f = Fixture::new().await;
    f.init();
    f.git(&["branch", "base"]);
    for index in 0..101 {
        fs::write(f.root.join(format!("page-{index:04}")), "old\n").unwrap();
    }
    f.git(&["add", "."]);
    let (_, first) = f.request(r#"{"scope":"staged"}"#, true, true).await;
    let cursor = first["nextCursor"].as_str().unwrap();
    for request in [
        serde_json::json!({"scope":"staged","cursor":"garbage"}),
        serde_json::json!({"scope":"staged","cursor":"0:0000000000000000"}),
        serde_json::json!({"scope":"staged","cursor":format!("101:{}", cursor.split_once(':').unwrap().1)}),
        serde_json::json!({"scope":"staged","cursor":cursor,"path":"page-0100"}),
        serde_json::json!({"scope":"unstaged","cursor":cursor}),
    ] {
        let (status, _) = f.request(&request.to_string(), true, true).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{request}");
    }
    fs::write(f.root.join("another"), "new\n").unwrap();
    f.git(&["add", "another"]);
    let (status, _) = f.request(&serde_json::json!({"scope":"staged","cursor":cursor}).to_string(), true, true).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    f.git(&["commit", "-qm", "changes"]);
    let commit = f.oid("HEAD");
    for mut request in [
        serde_json::json!({"scope":"branch","base":"base"}),
        serde_json::json!({"scope":"commit","commit":commit}),
    ] {
        let (status, first) = f.request(&request.to_string(), true, true).await;
        assert_eq!(status, StatusCode::OK, "{first}");
        request["cursor"] = first["nextCursor"].clone();
        let (status, second) = f.request(&request.to_string(), true, true).await;
        assert_eq!(status, StatusCode::OK, "{second}");
        assert_eq!(second["files"].as_array().unwrap().len(), 2);
        assert!(second.get("nextCursor").is_none());
        for file in second["files"].as_array().unwrap() {
            assert_eq!(file["lineStats"], serde_json::json!({"added":1,"removed":0}));
        }
        if request["scope"] == "branch" {
            // Empty commits preserve name-status output but change the resolved HEAD.
            f.git(&["commit", "--allow-empty", "-qm", "new tip"]);
            let (status, _) = f.request(&request.to_string(), true, true).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
            request.as_object_mut().unwrap().remove("cursor");
            let (_, first) = f.request(&request.to_string(), true, true).await;
            request["cursor"] = first["nextCursor"].clone();
            // Moving base on its own branch preserves the merge base and listing.
            f.git(&["checkout", "-q", "base"]);
            f.git(&["commit", "--allow-empty", "-qm", "new base tip"]);
            f.git(&["checkout", "-q", "main"]);
            let (status, _) = f.request(&request.to_string(), true, true).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        }
    }
    for index in 0..101 {
        fs::write(f.root.join(format!("page-{index:04}")), "new\n").unwrap();
    }
    let (_, first) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    let request = serde_json::json!({"scope":"unstaged","cursor":first["nextCursor"]});
    let (status, second) = f.request(&request.to_string(), true, true).await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(second["files"].as_array().unwrap().len(), 1);
    assert_eq!(second["truncated"], false);
    assert!(second.get("nextCursor").is_none());
    fs::write(f.root.join("untracked"), "omitted\n").unwrap();
    let (status, _) = f.request(&request.to_string(), true, true).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn snapshot_keys_track_content_not_names_or_line_counts() {
    let f = Fixture::new().await;
    f.init();
    fs::write(f.root.join("file.txt"), "first edit\n").unwrap();
    let (status, first) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let key = first["snapshotKey"].as_str().unwrap();
    assert_eq!(key.len(), 64);
    assert!(key.bytes().all(|b| b.is_ascii_hexdigit()));
    let (_, unchanged) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_eq!(first["snapshotKey"], unchanged["snapshotKey"]);
    fs::write(f.root.join("file.txt"), "other edit\n").unwrap();
    let (_, changed) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_eq!(first["files"], changed["files"]);
    assert_eq!(first["lineStats"], changed["lineStats"]);
    assert_ne!(first["snapshotKey"], changed["snapshotKey"]);
    let (_, selected) = f.request(r#"{"scope":"unstaged","path":"file.txt"}"#, true, true).await;
    assert!(selected.get("snapshotKey").is_none());
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn snapshot_keys_distinguish_binary_edits_and_omit_over_budget_diffs() {
    let f = Fixture::new().await;
    f.init();
    fs::write(f.root.join("binary"), b"before\0binary").unwrap();
    f.git(&["add", "binary"]);
    f.git(&["commit", "-qm", "binary"]);
    fs::write(f.root.join("binary"), b"first!\0binary").unwrap();
    let (_, first) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert!(first["snapshotKey"].is_string());
    fs::write(f.root.join("binary"), b"second\0binary").unwrap();
    let (_, second) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_eq!(first["files"], second["files"]);
    assert_eq!(first["lineStats"], second["lineStats"]);
    assert_ne!(first["snapshotKey"], second["snapshotKey"]);
    fs::write(f.root.join("file.txt"), "large line\n".repeat(450_000)).unwrap();
    let (status, large) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_eq!(status, StatusCode::OK, "{large}");
    assert!(large.get("snapshotKey").is_none());
    assert!(large["lineStats"].is_object());
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn snapshot_keys_bind_scope_root_and_resolved_base_identity() {
    let f = Fixture::new().await;
    f.init();
    let (_, unstaged) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    let (_, staged) = f.request(r#"{"scope":"staged"}"#, true, true).await;
    assert!(unstaged["snapshotKey"].is_string());
    assert_ne!(unstaged["snapshotKey"], staged["snapshotKey"]);
    let other = Fixture::new().await;
    other.init();
    let (_, other_root) = other.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_ne!(unstaged["snapshotKey"], other_root["snapshotKey"]);
    other.runtime.shutdown().await;
    f.git(&["branch", "base"]);
    let (_, first) = f.request(r#"{"scope":"branch","base":"base"}"#, true, true).await;
    assert!(first["snapshotKey"].is_string());
    f.git(&["checkout", "-q", "base"]);
    f.git(&["commit", "--allow-empty", "-qm", "new base identity"]);
    f.git(&["checkout", "-q", "main"]);
    let (_, moved) = f.request(r#"{"scope":"branch","base":"base"}"#, true, true).await;
    assert_eq!(first["files"], moved["files"]);
    assert_ne!(first["snapshotKey"], moved["snapshotKey"]);
    f.runtime.shutdown().await;
}

#[tokio::test]
async fn snapshot_keys_include_untracked_names_but_never_read_their_content() {
    let f = Fixture::new().await;
    f.init();
    // Reading this untracked pipe would block until the review deadline.
    let pipe = std::ffi::CString::new(f.root.join("pipe").as_os_str().as_encoded_bytes()).unwrap();
    // SAFETY: pipe is a live NUL-terminated path for this synchronous call.
    assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o600) }, 0);
    fs::write(f.root.join("untracked"), "private first\n").unwrap();
    let (status, first) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_eq!(status, StatusCode::OK, "{first}");
    assert!(first["snapshotKey"].is_string());
    fs::write(f.root.join("untracked"), "private second\n").unwrap();
    let (_, changed_content) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_eq!(first["snapshotKey"], changed_content["snapshotKey"]);
    assert!(!changed_content.to_string().contains("private"));
    fs::rename(f.root.join("untracked"), f.root.join("renamed")).unwrap();
    let (_, changed_name) = f.request(r#"{"scope":"unstaged"}"#, true, true).await;
    assert_ne!(first["snapshotKey"], changed_name["snapshotKey"]);
    f.runtime.shutdown().await;
}
