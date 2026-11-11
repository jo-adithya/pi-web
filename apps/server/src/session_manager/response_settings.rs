//! Server-wide response model preference; missing records use the startup default.
use crate::{config::ResponseModel, metadata::MetadataStore};
use serde::{Deserialize, Serialize};
use std::io;

const RECORD: &str = "response-settings.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    model: ResponseModel,
}

impl ResponseModel {
    /// Accepts bounded provider/model identifiers suitable for Pi's argument values.
    pub(super) fn valid(&self) -> bool {
        [&self.provider, &self.id].into_iter().all(|value| {
            !value.is_empty()
                && value.len() <= 256
                && !value.starts_with('-')
                && !value.chars().any(|c| c.is_control() || c.is_whitespace())
        })
    }

    /// Reads a validated private record. A missing file uses the operator's startup default.
    pub(super) fn load(store: &MetadataStore, fallback: &Self) -> io::Result<Self> {
        let Some(saved) = store.load_record::<Saved>(RECORD)? else {
            return Ok(fallback.clone());
        };
        if saved.version != 1 || !saved.model.valid() {
            return Err(io::Error::other("invalid response model settings"));
        }
        Ok(saved.model)
    }

    /// Saves before publishing to connected clients or active session workers.
    pub(super) fn save(&self, store: &MetadataStore) -> io::Result<()> {
        store.save_record(
            RECORD,
            &Saved {
                version: 1,
                model: self.clone(),
            },
        )
    }
}
