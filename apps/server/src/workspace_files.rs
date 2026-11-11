//! Bounded filename discovery rooted in a registered workspace directory.
use std::{
    ffi::{CStr, CString},
    fs::File,
    io::{self, Read},
    os::{
        fd::{AsRawFd, FromRawFd, IntoRawFd},
        unix::ffi::OsStrExt,
    },
    path::{Component, Path},
    time::{Duration, Instant},
};

const MAX_ENTRIES: usize = 20_000;
const MAX_DEPTH: usize = 32;
const MAX_RESULTS: usize = 50;
const MAX_PATH: usize = 1024;

#[derive(serde::Serialize)]
pub(crate) struct Matches {
    paths: Vec<String>,
    truncated: bool,
}

/// Searches case-insensitive relative UTF-8 names, ranked by basename prefix,
/// path prefix, then substring (lexical within each rank). Work is bounded by
/// 20,000 entries, 32 directory levels and a 200ms cooperative deadline.
/// Directory descriptors pin each traversal step; symlinks are never followed.
pub(crate) fn search(root: &Path, query: &str) -> io::Result<Matches> {
    crate::workspaces::require_available_folder(root)?;
    let root = open_root(root)?;
    let mut scan = Scan {
        query: query.to_lowercase(),
        deadline: Instant::now() + Duration::from_millis(200),
        entries: 0,
        matches: Matches {
            paths: Vec::new(),
            truncated: false,
        },
    };
    scan.directory(root, "", 0)?;
    scan.matches.paths.sort_by_cached_key(|path| {
        let lower = path.to_lowercase();
        let basename = lower.rsplit('/').next().unwrap_or(&lower);
        let rank = if basename.starts_with(&scan.query) {
            0
        } else if lower.starts_with(&scan.query) {
            1
        } else {
            2
        };
        (rank, path.clone())
    });
    if scan.matches.paths.len() >= MAX_RESULTS {
        scan.matches.truncated = true;
        scan.matches.paths.truncate(MAX_RESULTS);
    }
    Ok(scan.matches)
}

/// Opens every canonical root component relative to its pinned parent, so an
/// ancestor replaced with a symlink between validation and open is rejected.
fn open_root(path: &Path) -> io::Result<File> {
    let mut directory = File::open("/")?;
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(name) => {
                let name = CString::new(name.as_bytes())?;
                directory = open_directory(&directory, &name)?;
            }
            _ => return Err(io::Error::other("non-canonical workspace")),
        }
    }
    Ok(directory)
}

fn open_directory(parent: &File, name: &CStr) -> io::Result<File> {
    // SAFETY: name is NUL-terminated and parent remains open for this call.
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned a new descriptor whose ownership is transferred.
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// Reads one bounded regular file through pinned directories. Symlinks and special
/// files are rejected, including ancestors replaced during traversal.
pub(crate) fn read(root: &Path, path: &str, limit: usize) -> io::Result<Vec<u8>> {
    crate::local_review::validate_path(path).map_err(io::Error::other)?;
    let mut directory = open_root(root)?;
    let mut parts = path.split('/').peekable();
    while let Some(part) = parts.next() {
        let name = CString::new(part)?;
        if parts.peek().is_some() {
            directory = open_directory(&directory, &name)?;
            continue;
        }
        // SAFETY: directory and the NUL-terminated name remain valid throughout openat.
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the successful openat transfers a fresh owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        if !file.metadata()?.is_file() {
            return Err(io::Error::other("Not a regular source file"));
        }
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(io::Error::other("Source file exceeds preview limit"));
        }
        return Ok(bytes);
    }
    Err(io::Error::other("Missing source path"))
}

struct Directory(*mut libc::DIR);
impl Drop for Directory {
    fn drop(&mut self) {
        // SAFETY: fdopendir gave this instance exclusive ownership of the stream.
        unsafe {
            libc::closedir(self.0);
        }
    }
}
struct Scan {
    query: String,
    deadline: Instant,
    entries: usize,
    matches: Matches,
}
impl Scan {
    fn exhausted(&mut self) -> bool {
        if self.entries >= MAX_ENTRIES || Instant::now() >= self.deadline {
            self.matches.truncated = true;
            true
        } else {
            false
        }
    }

    fn directory(&mut self, directory: File, prefix: &str, depth: usize) -> io::Result<()> {
        // Keep a descriptor for openat/fstatat while fdopendir owns the duplicate.
        let fd = directory.try_clone()?.into_raw_fd();
        // SAFETY: fd is a newly owned directory descriptor.
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            // SAFETY: failed fdopendir leaves fd owned by the caller.
            unsafe {
                libc::close(fd);
            }
            return Err(io::Error::last_os_error());
        }
        let stream = Directory(stream);
        while !self.exhausted() {
            // SAFETY: stream is valid; the returned entry is consumed before readdir again.
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                break;
            }
            // SAFETY: readdir provides a NUL-terminated d_name for this entry.
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            self.entries += 1;
            let Ok(text) = name.to_str() else {
                continue;
            };
            if text.starts_with('.') || text.chars().any(char::is_control) {
                continue;
            }
            let relative = format!("{prefix}{text}");
            if relative.len() > MAX_PATH {
                self.matches.truncated = true;
                continue;
            }
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            // SAFETY: parent and name are valid and stat points to writable storage.
            if unsafe {
                libc::fstatat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                self.matches.truncated = true;
                continue;
            }
            // SAFETY: successful fstatat initialized stat.
            let kind = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
            if kind == libc::S_IFDIR {
                if matches!(
                    text,
                    "node_modules" | "target" | "dist" | "build" | "vendor" | "__pycache__"
                ) {
                    continue;
                }
                if depth >= MAX_DEPTH {
                    self.matches.truncated = true;
                } else {
                    match open_directory(&directory, name) {
                        Ok(child) => {
                            if self
                                .directory(child, &format!("{relative}/"), depth + 1)
                                .is_err()
                            {
                                self.matches.truncated = true;
                            }
                        }
                        Err(_) => self.matches.truncated = true,
                    }
                }
            } else if kind == libc::S_IFREG && relative.to_lowercase().contains(&self.query) {
                self.matches.paths.push(relative);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use std::os::unix::ffi::OsStringExt;
    use std::{fs, os::unix::fs::symlink};

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "pi-web-files-{}",
                crate::config::identity().unwrap()
            ));
            fs::create_dir(&path).unwrap();
            Self(path.canonicalize().unwrap())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn scan() -> Scan {
        Scan {
            query: String::new(),
            deadline: Instant::now() + Duration::from_secs(5),
            entries: 0,
            matches: Matches {
                paths: vec![],
                truncated: false,
            },
        }
    }

    #[test]
    fn scan_entry_and_deadline_bounds_report_truncation() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("file"), "").unwrap();
        let mut bounded = scan();
        bounded.entries = MAX_ENTRIES;
        bounded
            .directory(open_root(&fixture.0).unwrap(), "", 0)
            .unwrap();
        assert!(bounded.matches.truncated);
        assert!(bounded.matches.paths.is_empty());
        let mut expired = scan();
        expired.deadline = Instant::now();
        expired
            .directory(open_root(&fixture.0).unwrap(), "", 0)
            .unwrap();
        assert!(expired.matches.truncated);
        assert!(expired.matches.paths.is_empty());
    }

    #[test]
    fn scan_depth_path_and_utf8_bounds() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("visible"), "").unwrap();
        // macOS filesystems reject non-UTF-8 filenames at creation time.
        #[cfg(target_os = "linux")]
        fs::write(fixture.0.join(std::ffi::OsString::from_vec(vec![0xff])), "").unwrap();
        let mut nested = fixture.0.clone();
        for _ in 0..=MAX_DEPTH {
            nested = nested.join("d");
            fs::create_dir(&nested).unwrap();
        }
        fs::write(nested.join("too-deep"), "").unwrap();
        let result = search(&fixture.0, "").unwrap();
        assert_eq!(result.paths, ["visible"]);
        assert!(result.truncated);
        let mut long = scan();
        long.directory(open_root(&fixture.0).unwrap(), &"a".repeat(MAX_PATH), 0)
            .unwrap();
        assert!(long.matches.truncated);
        assert!(long.matches.paths.is_empty());
    }

    #[test]
    fn directory_replacement_cannot_redirect_pinned_traversal() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        fs::create_dir(fixture.0.join("child")).unwrap();
        fs::write(fixture.0.join("child/inside"), "").unwrap();
        fs::write(outside.0.join("secret"), "").unwrap();
        let parent = open_root(&fixture.0).unwrap();
        let name = CString::new("child").unwrap();
        let pinned = open_directory(&parent, &name).unwrap();
        fs::rename(fixture.0.join("child"), fixture.0.join("old")).unwrap();
        symlink(&outside.0, fixture.0.join("child")).unwrap();
        assert!(open_directory(&parent, &name).is_err());
        assert!(open_root(&fixture.0.join("child")).is_err());
        let mut bounded = scan();
        bounded.directory(pinned, "child/", 0).unwrap();
        assert_eq!(bounded.matches.paths, ["child/inside"]);
    }
}
