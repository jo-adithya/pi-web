//! Process-local transcript reservations. Cleanup failure deliberately retains ownership.
use std::{
    collections::BTreeMap,
    io,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
pub(crate) struct Ownership(Arc<Mutex<BTreeMap<String, FileKey>>>);
#[derive(Clone)]
struct FileKey {
    path: PathBuf,
    inode: Option<(u64, u64)>,
}
impl Ownership {
    /// Atomically replaces one runtime's reservation after checking canonical and hard-link aliases.
    pub fn claim(&self, id: &str, path: Option<&Path>) -> io::Result<()> {
        let key = path
            .map(|path| -> io::Result<FileKey> {
                let canonical = match path.canonicalize() {
                    Ok(path) => path,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => path
                        .parent()
                        .ok_or_else(|| io::Error::other("missing session parent"))?
                        .canonicalize()?
                        .join(
                            path.file_name()
                                .ok_or_else(|| io::Error::other("missing session name"))?,
                        ),
                    Err(error) => return Err(error),
                };
                let inode = match std::fs::metadata(&canonical) {
                    Ok(meta) => Some((meta.dev(), meta.ino())),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                    Err(error) => return Err(error),
                };
                Ok(FileKey {
                    path: canonical,
                    inode,
                })
            })
            .transpose()?;
        let mut owners = self
            .0
            .lock()
            .map_err(|_| io::Error::other("ownership unavailable"))?;
        if let Some(key) = &key {
            for (_, held) in owners.iter().filter(|(owner, _)| owner.as_str() != id) {
                let current_inode = match std::fs::metadata(&held.path) {
                    Ok(meta) => Some((meta.dev(), meta.ino())),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                    Err(error) => return Err(error),
                };
                if held.path == key.path
                    || key.inode.is_some()
                        && (held.inode == key.inode || current_inode == key.inode)
                {
                    return Err(io::Error::other(
                        "transcript is already owned by another runtime",
                    ));
                }
            }
            owners.insert(id.into(), key.clone());
        } else {
            owners.remove(id);
        }
        Ok(())
    }
    pub fn release(&self, id: &str) {
        if let Ok(mut owners) = self.0.lock() {
            owners.remove(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delayed_file_creation_cannot_bypass_hard_link_ownership() {
        let root = std::env::temp_dir().join(format!(
            "pi-web-late-owner-{}",
            crate::config::identity().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        let owners = Ownership::default();
        owners.claim("a", Some(&root.join("one"))).unwrap();
        std::fs::write(root.join("one"), "fixture").unwrap();
        std::fs::hard_link(root.join("one"), root.join("two")).unwrap();
        let rejected = owners.claim("b", Some(&root.join("two"))).is_err();
        std::fs::remove_dir_all(root).unwrap();
        assert!(rejected, "late-created hard link has an active owner");
    }
    #[test]
    fn aliases_cannot_be_claimed_by_two_runtimes() {
        let root = std::env::temp_dir().join(format!(
            "pi-web-ownership-{}",
            crate::config::identity().unwrap()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("one"), "fixture").unwrap();
        std::fs::hard_link(root.join("one"), root.join("two")).unwrap();
        let owners = Ownership::default();
        owners.claim("a", Some(&root.join("one"))).unwrap();
        assert!(owners.claim("b", Some(&root.join("two"))).is_err());
        owners.release("a");
        owners.claim("b", Some(&root.join("two"))).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
