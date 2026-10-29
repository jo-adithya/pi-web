//! Private folder registry, independent of the legacy per-project catalogs.
use crate::{catalog::valid_id, metadata::MetadataStore};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io,
    path::{Path, PathBuf},
};
pub(crate) const MAX_WORKSPACES: usize = 16;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkspaceRecord {
    pub id: String,
    pub cwd: PathBuf,
    pub state_dir: PathBuf,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Registry {
    pub version: u8,
    pub selected: String,
    pub entries: Vec<WorkspaceRecord>,
}
/// Accepts only bounded absolute existing UTF-8 directories, resolving symlinks once.
pub(crate) fn canonical_folder(path: &Path) -> io::Result<PathBuf> {
    let valid = |p: &Path| {
        p.is_absolute()
            && p.to_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 1024 && !s.contains('\0'))
    };
    if !valid(path) {
        return Err(io::Error::other("invalid workspace path"));
    }
    let canonical = path.canonicalize()?;
    if !valid(&canonical) || !canonical.is_dir() {
        return Err(io::Error::other("invalid workspace directory"));
    }
    Ok(canonical)
}
/// Checks the persisted canonical path shape without requiring the folder to be mounted.
fn valid_stored_folder(path: &Path) -> bool {
    path.is_absolute()
        && path.to_str().is_some_and(|s| {
            s.len() <= 1024
                && !s.contains('\0')
                && !s
                    .split('/')
                    .any(|component| matches!(component, "." | ".."))
        })
}

/// Verifies that runtime admission still resolves to the registered project directory.
pub(crate) fn require_available_folder(path: &Path) -> io::Result<()> {
    if canonical_folder(path)? != path {
        return Err(io::Error::other("workspace directory changed"));
    }
    Ok(())
}

impl Registry {
    pub fn load(store: &MetadataStore) -> io::Result<Self> {
        let registry: Option<Self> = store.load_record("registry.json")?;
        match registry {
            Some(value) => {
                value.validate()?;
                Ok(value)
            }
            None => Ok(Self {
                version: 1,
                selected: String::new(),
                entries: vec![],
            }),
        }
    }
    pub fn save(&self, store: &MetadataStore) -> io::Result<()> {
        self.validate()?;
        store.save_record("registry.json", self)
    }
    fn validate(&self) -> io::Result<()> {
        let mut ids = HashSet::new();
        let mut paths = HashSet::new();
        let mut stores = HashSet::new();
        if self.version != 1 || self.entries.is_empty() || self.entries.len() > MAX_WORKSPACES {
            return Err(io::Error::other("invalid workspace registry"));
        }
        for entry in &self.entries {
            if !valid_id(&entry.id)
                || !ids.insert(&entry.id)
                || !valid_stored_folder(&entry.cwd)
                || !paths.insert(&entry.cwd)
                || !entry.state_dir.is_absolute()
                || !stores.insert(&entry.state_dir)
            {
                return Err(io::Error::other("invalid workspace registry"));
            }
        }
        if !ids.contains(&self.selected) {
            return Err(io::Error::other("invalid workspace selection"));
        }
        Ok(())
    }
}
