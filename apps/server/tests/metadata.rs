//! Filesystem contracts exercised entirely in disposable directories.
#[path = "../src/metadata.rs"]
mod metadata;
use metadata::{MetadataStore, SessionMetadata, validate_session};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pi-web-metadata-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn project(&self) -> PathBuf {
        let p = self.0.join("project");
        fs::create_dir_all(&p).unwrap();
        p.canonicalize().unwrap()
    }
    fn session(&self, cwd: &std::path::Path) -> PathBuf {
        let root = self.0.join("sessions");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("fixture.jsonl");
        fs::write(
            &path,
            format!(
                "{}\n",
                serde_json::json!({"type":"session", "version":3,"id":"pi-fixture","cwd":cwd})
            ),
        )
        .unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn record(cwd: PathBuf) -> SessionMetadata {
    SessionMetadata {
        version: 1,
        app_id: "12345678-1234-4234-8234-123456789abc".into(),
        cwd,
        pi_session_id: None,
        pi_session_path: None,
        persisted: false,
    }
}
#[test]
fn private_atomic_roundtrip_and_exclusive_ownership() {
    let fixture = Fixture::new();
    let root = fixture.0.join("state");
    let store = MetadataStore::open(&root).unwrap();
    assert!(store.load().unwrap().is_none());
    let value = record(fixture.project());
    store.save(&value).unwrap();
    assert_eq!(store.load().unwrap(), Some(value.clone()));
    let mut invalid = value.clone();
    invalid.version = 9;
    assert!(store.save(&invalid).is_err());
    assert_eq!(store.load().unwrap(), Some(value));
    assert!(MetadataStore::open(&root).is_err());
    assert_eq!(
        fs::metadata(&root).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(root.join("state.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    drop(store);
    assert!(MetadataStore::open(&root).is_ok());
}
#[test]
fn rejects_corrupt_oversized_unknown_and_invalid_metadata() {
    let f = Fixture::new();
    let root = f.0.join("state");
    let store = MetadataStore::open(&root).unwrap();
    let mut unknown = serde_json::to_value(record(f.project())).unwrap();
    unknown["unknown"] = serde_json::json!(true);
    let mut wrong_version = serde_json::to_value(record(f.project())).unwrap();
    wrong_version["version"] = serde_json::json!(2);
    for data in [
        "{broken".to_owned(),
        " ".repeat(65_537),
        unknown.to_string(),
        wrong_version.to_string(),
    ] {
        fs::write(root.join("state.json"), data).unwrap();
        fs::set_permissions(root.join("state.json"), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(store.load().is_err());
    }
    let mut value = record(f.project());
    value.app_id = "../escape".into();
    assert!(store.save(&value).is_err());
    value.app_id = "12345678-1234-4234-8234-123456789abc".into();
    value.cwd = "relative".into();
    assert!(store.save(&value).is_err());
}
#[test]
fn rejects_symlink_metadata_and_shared_permissions() {
    let f = Fixture::new();
    let target = f.0.join("target");
    fs::create_dir(&target).unwrap();
    symlink(&target, f.0.join("link")).unwrap();
    assert!(MetadataStore::open(&f.0.join("link")).is_err());
    let root = f.0.join("state");
    let store = MetadataStore::open(&root).unwrap();
    fs::write(f.0.join("outside"), "{}").unwrap();
    symlink(f.0.join("outside"), root.join("state.json")).unwrap();
    assert!(store.load().is_err());
    drop(store);
    fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(MetadataStore::open(&root).is_err());
}
#[test]
fn canonical_session_must_match_root_and_project() {
    let f = Fixture::new();
    let project = f.project();
    let path = f.session(&project);
    let roots = vec![f.0.join("sessions")];
    assert_eq!(
        validate_session(&path, &roots, &project).unwrap(),
        path.canonicalize().unwrap()
    );
    assert!(validate_session(&path, &[f.0.join("other")], &project).is_err());
    let wrong = f.0.join("wrong");
    fs::create_dir(&wrong).unwrap();
    assert!(validate_session(&path, &roots, &wrong).is_err());
    let outside = f.0.join("outside.jsonl");
    fs::copy(&path, &outside).unwrap();
    let link = roots[0].join("escaped.jsonl");
    symlink(&outside, &link).unwrap();
    assert!(validate_session(&link, &roots, &project).is_err());
    assert!(validate_session(&roots[0], &roots, &project).is_err());
}
#[test]
fn invalid_truncated_and_oversized_headers_fail_without_writing() {
    let f = Fixture::new();
    let project = f.project();
    let path = f.session(&project);
    for input in [
        "{}\n".to_owned(),
        "{broken\n".into(),
        "x".repeat(65_537),
        format!(
            "{}\n",
            serde_json::json!({"type":"session","version":99,"cwd":project,"id":"wrong-version"})
        ),
    ] {
        fs::write(&path, &input).unwrap();
        assert!(validate_session(&path, &[f.0.join("sessions")], &project).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), input);
    }
}
