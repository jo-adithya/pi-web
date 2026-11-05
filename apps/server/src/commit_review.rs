//! Bounded, read-only commit choices reachable from the registered workspace's HEAD.
use crate::local_review::{Git, validate_repository};
use serde::{Deserialize, Serialize};
use std::{path::Path, time::Duration};
use tokio::{sync::oneshot, time::Instant};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {}

#[derive(Serialize)]
pub(crate) struct Commit {
    id: String,
    subject: String,
}

#[derive(Serialize)]
pub(crate) struct Review {
    commits: Vec<Commit>,
    truncated: bool,
}

/// Lists at most 100 recent reachable commits within ten seconds and 256 KiB JSON.
/// Unborn HEAD returns an empty list; missing history and oversized Git output fail.
/// Cancellation kills and reaps Git before the caller releases review admission.
pub(crate) async fn review(
    root: &Path,
    _request: Request,
    mut cancelled: oneshot::Receiver<()>,
) -> Result<Review, &'static str> {
    let mut git = Git {
        root,
        deadline: Instant::now() + Duration::from_secs(10),
        cancelled: &mut cancelled,
    };
    validate_repository(&mut git).await?;
    let mut result = Review {
        commits: Vec::new(),
        truncated: false,
    };
    let head = match git.run(&["rev-parse", "--verify", "HEAD"], 1024).await {
        Ok(head) => head,
        Err(_) => {
            // A symbolic HEAD with no matching ref is unborn, unlike corrupt history.
            let reference = git.run(&["symbolic-ref", "-q", "HEAD"], 1024).await?;
            let reference = std::str::from_utf8(&reference)
                .map_err(|_| "Invalid HEAD ref")?
                .trim();
            let refs = git
                .run(
                    &["for-each-ref", "--format=%(refname)", "--", reference],
                    8192,
                )
                .await?;
            if refs.is_empty() {
                return Ok(result);
            }
            return Err("HEAD commit is unavailable locally");
        }
    };
    let head = std::str::from_utf8(&head)
        .map_err(|_| "Invalid HEAD commit")?
        .trim();
    let bytes = git
        .run(
            &[
                "log",
                "--no-show-signature",
                "--no-decorate",
                "--no-notes",
                "--max-count=101",
                "--format=%H%x00%s",
                "-z",
                head,
                "--",
            ],
            1024 * 1024,
        )
        .await?;
    let mut fields = bytes
        .strip_suffix(&[0])
        .unwrap_or(&bytes)
        .split(|b| *b == 0);
    let mut total = 64;
    while let Some(id) = fields.next() {
        let subject = fields.next().ok_or("Invalid Git commit listing")?;
        if result.commits.len() == 100 {
            result.truncated = true;
            break;
        }
        let id = std::str::from_utf8(id).map_err(|_| "Invalid Git commit ID")?;
        if !matches!(id.len(), 40 | 64)
            || !id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Invalid Git commit ID");
        }
        let commit = Commit {
            id: id.into(),
            subject: String::from_utf8_lossy(subject)
                .chars()
                .take(512)
                .map(|c| {
                    if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') {
                        ' '
                    } else {
                        c
                    }
                })
                .collect(),
        };
        let size = serde_json::to_vec(&commit)
            .map_err(|_| "Cannot encode commit listing")?
            .len()
            + 1;
        if total + size > 256 * 1024 {
            result.truncated = true;
            break;
        }
        total += size;
        result.commits.push(commit);
    }
    Ok(result)
}
