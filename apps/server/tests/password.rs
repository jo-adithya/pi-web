//! Password persistence exercised through real server restarts in disposable state.
use pi_web::config::persistent_capability;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pi-web-password-{}",
            pi_web::config::identity().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join("index.html"),
            "<!doctype html><title>test</title>",
        )
        .unwrap();
        Self(root)
    }

    /// Starts and cleanly stops a real server, returning its printed password.
    async fn password(&self) -> String {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pi-web"))
            .args(["--port", "0", "--cwd"])
            .arg(&self.0)
            .arg("--state-dir")
            .arg(self.0.join("state"))
            .arg("--web-dir")
            .arg(&self.0)
            .arg("--pi")
            .arg(self.0.join("missing-pi"))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let printed = tokio::time::timeout(Duration::from_secs(5), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .expect("server must print its login URL");
        let password = printed.split("/#cap=").nth(1).unwrap().to_owned();
        // A successful authentication also confirms that HTTP and signals are ready.
        let origin = printed
            .strip_prefix("Open ")
            .unwrap()
            .split("/#cap=")
            .next()
            .unwrap();
        let response = reqwest::Client::new()
            .post(format!("{origin}/auth"))
            .header("Origin", origin)
            .header("Content-Type", "application/json")
            .body(serde_json::to_vec(&serde_json::json!({"capability": password})).unwrap())
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NO_CONTENT);
        // SAFETY: this is the live child owned by the fixture.
        assert_eq!(
            unsafe { libc::kill(child.id().unwrap() as i32, libc::SIGTERM) },
            0
        );
        let status = tokio::time::timeout(Duration::from_secs(6), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
        password
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn server_password_survives_a_restart() {
    let fixture = Fixture::new();
    let first = fixture.password().await;
    assert_eq!(first.len(), 64);
    assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(fixture.password().await, first);
}

#[test]
fn password_storage_is_private_and_explicit_deletion_rotates_it() {
    let fixture = Fixture::new();
    let root = fixture.0.join("auth");
    let path = root.join("capability.json");
    let first = persistent_capability(&root).unwrap();
    assert_eq!(
        fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(persistent_capability(&root).unwrap(), first);
    assert_ne!(
        persistent_capability(&fixture.0.join("other-auth")).unwrap(),
        first
    );
    fs::remove_file(path).unwrap();
    assert_ne!(persistent_capability(&root).unwrap(), first);
}

#[test]
fn malformed_stored_passwords_fail_without_being_replaced() {
    let fixture = Fixture::new();
    let root = fixture.0.join("auth");
    let path = root.join("capability.json");
    persistent_capability(&root).unwrap();
    for bytes in [
        String::new(),
        "not json".to_owned(),
        "null".to_owned(),
        "123".to_owned(),
        serde_json::to_string("").unwrap(),
        serde_json::to_string(&"a".repeat(63)).unwrap(),
        serde_json::to_string(&"A".repeat(64)).unwrap(),
        serde_json::to_string(&"g".repeat(64)).unwrap(),
        serde_json::to_string(&"a".repeat(65)).unwrap(),
        " ".repeat(64 * 1024 + 1),
    ] {
        fs::write(&path, &bytes).unwrap();
        assert!(persistent_capability(&root).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
    }
}

#[test]
fn shared_files_and_symlinks_fail_without_exposing_or_replacing_credentials() {
    let fixture = Fixture::new();
    let root = fixture.0.join("auth");
    let path = root.join("capability.json");
    let token = persistent_capability(&root).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(persistent_capability(&root).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(persistent_capability(&root).is_err());
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let alias = fixture.0.join("alias");
    symlink(&root, &alias).unwrap();
    assert!(persistent_capability(&alias).is_err());
    let target = fixture.0.join("target.json");
    fs::rename(&path, &target).unwrap();
    symlink(&target, &path).unwrap();
    assert!(persistent_capability(&root).is_err());
    assert_eq!(
        fs::read_to_string(&target).unwrap(),
        serde_json::to_string(&token).unwrap()
    );
    assert!(
        fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
