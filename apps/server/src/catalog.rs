//! Private catalog schema; storage locations are derived exclusively from validated app IDs.
use crate::metadata::MetadataStore;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, io, path::PathBuf};

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;

pub(crate) const MAX_SESSIONS: usize = 32;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CatalogEntry {
    pub id: String,
    pub title: String,
    pub legacy: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Catalog {
    pub version: u8,
    pub cwd: PathBuf,
    pub selected: String,
    pub entries: Vec<CatalogEntry>,
}

pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
impl Catalog {
    /// Corruption is an error; an existing catalog never falls back to legacy import.
    pub fn load(store: &MetadataStore, cwd: &std::path::Path) -> io::Result<Option<Self>> {
        let catalog: Option<Self> = store.load_record("catalog.json")?;
        if let Some(value) = &catalog {
            value.validate(cwd)?;
        }
        Ok(catalog)
    }
    pub fn save(&self, store: &MetadataStore) -> io::Result<()> {
        self.validate(&self.cwd)?;
        store.save_record("catalog.json", self)
    }
    fn validate(&self, cwd: &std::path::Path) -> io::Result<()> {
        let mut ids = HashSet::new();
        if self.version != 1
            || self.cwd != cwd
            || self.entries.is_empty()
            || self.entries.len() > MAX_SESSIONS
            || self.entries.iter().filter(|entry| entry.legacy).count() > 1
            || self.entries.iter().any(|entry| {
                !valid_id(&entry.id)
                    || !ids.insert(&entry.id)
                    || entry.title.is_empty()
                    || entry.title.len() > 64
            })
            || !ids.contains(&self.selected)
        {
            return Err(io::Error::other("invalid session catalog"));
        }
        Ok(())
    }
}
