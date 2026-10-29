//! Private application metadata and canonical Pi-session validation.
//! Pi remains the only writer of transcript files. These checks protect the HTTP
//! boundary, not against another process already running as the same OS user.

use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
const MAX_METADATA: u64 = 64 * 1024;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// Restart information only; transcripts and browser capabilities are never stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SessionMetadata {
    pub version: u8,
    pub app_id: String,
    pub cwd: PathBuf,
    pub pi_session_id: Option<String>,
    pub pi_session_path: Option<PathBuf>,
    /// Once observed on disk, a missing transcript is an error rather than a new session.
    #[serde(default)]
    pub persisted: bool,
}

/// One process owns each private metadata directory for its lifetime.
pub struct MetadataStore {
    root: PathBuf,
    _lock: File,
}
impl MetadataStore {
    /// Creates private directories, rejects shared permissions, and takes a
    /// nonblocking exclusive lock. Drop releases ownership without deleting data.
    pub fn open(root: &Path) -> io::Result<Self> {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700).create(root)?;
        let metadata = fs::symlink_metadata(root)?;
        if !metadata.is_dir() {
            return Err(invalid("metadata root must be a directory, not a symlink"));
        }
        check_private(&metadata)?;
        let root = root.canonicalize()?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(root.join("lock"))?;
        check_private(&lock.metadata()?)?;
        if !lock.metadata()?.is_file() {
            return Err(invalid("metadata lock must be a regular file"));
        }
        // SAFETY: the descriptor remains owned by this store for the lock's lifetime.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { root, _lock: lock })
    }

    /// Reads bounded restart metadata. Missing data means a new application;
    /// corruption, incompatible schemas and insecure files are explicit errors.
    pub fn load(&self) -> io::Result<Option<SessionMetadata>> {
        let value: Option<SessionMetadata> = self.load_record("state.json")?;
        if let Some(value) = &value {
            validate_metadata(value)?;
        }
        Ok(value)
    }

    /// Reads one bounded private application record; names are internal constants.
    pub(crate) fn load_record<T: serde::de::DeserializeOwned>(
        &self,
        name: &str,
    ) -> io::Result<Option<T>> {
        let file = match read_regular(&self.root.join(name)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        check_private(&file.metadata()?)?;
        let bytes = bounded_bytes(file)?;
        let value = serde_json::from_slice(&bytes).map_err(invalid)?;
        Ok(Some(value))
    }

    /// Atomically replaces restart metadata with a private, flushed file. On
    /// failure an owned temporary file is removed; existing metadata is retained.
    pub fn save(&self, metadata: &SessionMetadata) -> io::Result<()> {
        validate_metadata(metadata)?;
        self.save_record("state.json", metadata)
    }

    /// Atomically persists a bounded application record while retaining the directory lock.
    pub(crate) fn save_record<T: Serialize>(&self, name: &str, value: &T) -> io::Result<()> {
        let bytes = serde_json::to_vec(value).map_err(invalid)?;
        if bytes.len() as u64 > MAX_METADATA {
            return Err(invalid("metadata exceeds size limit"));
        }
        let destination = self.root.join(name);
        match fs::symlink_metadata(&destination) {
            Ok(meta) => {
                if !meta.is_file() {
                    return Err(invalid("metadata must be a regular file"));
                }
                check_private(&meta)?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let temporary = self.root.join(format!(
            ".state.{}.{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&temporary)?;
        let result = (|| {
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temporary, &destination)?;
            File::open(&self.root)?.sync_all()
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

/// Validates an existing regular Pi session inside a canonical allowed root.
/// Only its bounded first-line header is read; the project must match exactly.
/// Pi performs any supported format migration after this read-only validation.
pub fn validate_session(path: &Path, roots: &[PathBuf], project: &Path) -> io::Result<PathBuf> {
    validate_session_identity(path, roots, project, None)
}

/// Validates a transcript header, optionally requiring its saved Pi identity.
pub(crate) fn validate_session_identity(
    path: &Path,
    roots: &[PathBuf],
    project: &Path,
    expected_id: Option<&str>,
) -> io::Result<PathBuf> {
    let path = path.canonicalize()?;
    let mut permitted = false;
    for root in roots {
        if let Ok(root) = root.canonicalize() {
            permitted |= path.starts_with(root);
        }
    }
    if !permitted {
        return Err(invalid("session is outside configured roots"));
    }
    let file = read_regular(&path)?;
    let mut line = Vec::new();
    BufReader::new(file.take(MAX_METADATA + 1)).read_until(b'\n', &mut line)?;
    if line.len() as u64 > MAX_METADATA || !line.ends_with(b"\n") {
        return Err(invalid("session header is oversized or incomplete"));
    }
    #[derive(Deserialize)]
    struct Header {
        #[serde(rename = "type")]
        kind: String,
        version: u8,
        id: String,
        cwd: PathBuf,
    }
    let header: Header = serde_json::from_slice(&line).map_err(invalid)?;
    if header.kind != "session"
        || !(1..=3).contains(&header.version)
        || header.id.is_empty()
        || header.id.len() > 1024
    {
        return Err(invalid("unsupported Pi session header"));
    }
    if expected_id.is_some_and(|id| id != header.id) {
        return Err(invalid("session identity does not match saved metadata"));
    }
    if !header.cwd.is_absolute() || header.cwd.canonicalize()? != project.canonicalize()? {
        return Err(invalid("session belongs to a different project"));
    }
    Ok(path)
}

fn read_regular(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(invalid("expected a regular file"));
    }
    Ok(file)
}
fn bounded_bytes(file: File) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(MAX_METADATA + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_METADATA {
        return Err(invalid("metadata exceeds size limit"));
    }
    Ok(bytes)
}
fn check_private(metadata: &fs::Metadata) -> io::Result<()> {
    // SAFETY: geteuid has no preconditions and does not mutate process state.
    if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
        return Err(invalid(
            "application metadata must be private to the current user",
        ));
    }
    Ok(())
}
fn validate_metadata(value: &SessionMetadata) -> io::Result<()> {
    let id = value.app_id.as_bytes();
    let valid_id = id.len() == 36
        && id.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        });
    if value.version != 1
        || !valid_id
        || !value.cwd.is_absolute()
        || value.cwd.as_os_str().len() > 4096
    {
        return Err(invalid("invalid application metadata"));
    }
    if value.persisted && (value.pi_session_path.is_none() || value.pi_session_id.is_none()) {
        return Err(invalid("persisted session requires an identity and path"));
    }
    if value
        .pi_session_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 1024)
        || value.pi_session_path.as_ref().is_some_and(|path| {
            !path.is_absolute() || path.as_os_str().len() > 4096 || value.pi_session_id.is_none()
        })
    {
        return Err(invalid("invalid Pi identity metadata"));
    }
    Ok(())
}
fn invalid(message: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}
