//! Bounded, read-only branch choices from refs already present in the workspace.
use crate::local_review::{Git, validate_repository};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use tokio::{sync::oneshot, time::Instant};

pub(crate) struct Request {
    query: String,
}

impl<'de> Deserialize<'de> for Request {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut fields = std::collections::BTreeMap::<String, String>::deserialize(deserializer)?;
        let query = fields.remove("query").unwrap_or_default();
        if !fields.is_empty() || query.len() > 256 || query.chars().any(char::is_control) {
            return Err(serde::de::Error::custom("Expected a branch query of up to 256 bytes"));
        }
        Ok(Self { query })
    }
}

#[derive(Serialize)]
pub(crate) struct Branch {
    #[serde(rename = "ref")]
    reference: String,
    name: String,
    kind: &'static str,
}

#[derive(Serialize)]
pub(crate) struct Review {
    branches: Vec<Branch>,
    truncated: bool,
}

/// Lists up to 100 local and remote-tracking branches in refname order.
/// A trimmed, case-insensitive literal ref substring filters all refs before the limit.
/// Symbolic aliases are excluded; refs incompatible with branch review are omitted
/// with `truncated` set. Repositories without branch refs return an empty list.
/// JSON is capped at 64 KiB, with Git output capped at 1 MiB within ten seconds.
/// Cancellation kills and reaps
/// Git before the caller releases admission. Repository and Git failures return errors.
pub(crate) async fn review(
    root: &Path,
    request: Request,
    mut cancelled: oneshot::Receiver<()>,
) -> Result<Review, &'static str> {
    let mut git = Git {
        root,
        deadline: Instant::now() + Duration::from_secs(10),
        cancelled: &mut cancelled,
    };
    validate_repository(&mut git).await?;
    let bytes = git
        .run(
            &[
                "for-each-ref",
                "--sort=refname",
                "--format=%(refname)%00%(symref)",
                "--",
                "refs/heads/",
                "refs/remotes/",
            ],
            1024 * 1024,
        )
        .await?;
    let query = request.query.trim().to_lowercase();
    let mut result = Review {
        branches: Vec::new(),
        truncated: false,
    };
    let mut total = 64; // JSON envelope and separators.
    for record in bytes.split(|b| *b == b'\n').filter(|r| !r.is_empty()) {
        let separator = record
            .iter()
            .position(|b| *b == 0)
            .ok_or("Invalid Git branch listing")?;
        if !record[separator + 1..].is_empty() {
            continue;
        }
        let Ok(reference) = std::str::from_utf8(&record[..separator]) else {
            result.truncated = true;
            continue;
        };
        if !reference.to_lowercase().contains(&query) {
            continue;
        }
        // Existing Git refs already satisfy check-ref-format; these are the
        // additional restrictions imposed by the branch review base contract.
        if reference.len() > 256
            || reference.contains('@')
            || reference.chars().any(char::is_whitespace)
        {
            result.truncated = true;
            continue;
        }
        let (name, kind) = if let Some(name) = reference.strip_prefix("refs/heads/") {
            (name, "local")
        } else if let Some(name) = reference.strip_prefix("refs/remotes/") {
            (name, "remote")
        } else {
            return Err("Invalid Git branch ref");
        };
        if result.branches.len() == 100 {
            result.truncated = true;
            break;
        }
        let branch = Branch {
            reference: reference.into(),
            name: name.into(),
            kind,
        };
        let size = serde_json::to_vec(&branch)
            .map_err(|_| "Cannot encode branch listing")?
            .len()
            + 1;
        if total + size > 64 * 1024 {
            result.truncated = true;
            break;
        }
        total += size;
        result.branches.push(branch);
    }
    Ok(result)
}
