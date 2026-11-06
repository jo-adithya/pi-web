//! Versioned global grouping defaults stored separately from workspace and session records.
use crate::{metadata::MetadataStore, protocol::GroupingSettings};
use serde::{Deserialize, Serialize};
use std::io;

const RECORD: &str = "grouping-settings.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    settings: GroupingSettings,
}

impl Default for GroupingSettings {
    fn default() -> Self {
        Self {
            model: None,
            max_calls: 6,
            max_request_bytes: 524288,
            include_generated: false,
        }
    }
}

impl GroupingSettings {
    /// Checks inclusive job budgets and bounded, nonblank model identifiers.
    pub(super) fn valid(&self) -> bool {
        (1..=100).contains(&self.max_calls)
            && (1024..=16777216).contains(&self.max_request_bytes)
            && self.model.as_ref().is_none_or(|model| {
                [&model.provider, &model.id].into_iter().all(|value| {
                    !value.trim().is_empty()
                        && value.len() <= 256
                        && !value.starts_with('-')
                        && !value.chars().any(char::is_control)
                })
            })
    }

    /// Loads defaults only for a missing record; malformed or unsupported records are errors.
    pub(super) fn load(store: &MetadataStore) -> io::Result<Self> {
        let Some(saved) = store.load_record::<Saved>(RECORD)? else {
            return Ok(Self::default());
        };
        if saved.version != 1 || !saved.settings.valid() {
            return Err(io::Error::other("invalid grouping settings record"));
        }
        Ok(saved.settings)
    }

    /// Atomically saves a validated versioned record before the manager publishes it.
    pub(super) fn save(&self, store: &MetadataStore) -> io::Result<()> {
        store.save_record(
            RECORD,
            &Saved {
                version: 1,
                settings: self.clone(),
            },
        )
    }
}
