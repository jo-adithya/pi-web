//! Read-only jj checkout context. Nearby bookmarks are ancestry hints, not an active branch.
use super::Git;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct JjContext {
    /// Stable short working-copy change ID; absent when jj metadata could not be read.
    pub(super) change_id: Option<String>,
    pub(super) bookmarks: Vec<String>,
    /// Zero for attached bookmarks, otherwise the nearest parent-hop distance, up to three.
    pub(super) distance: Option<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Revision {
    id: String,
    change_id: String,
    parents: Vec<String>,
    bookmarks: Vec<String>,
    working_copy: bool,
}

impl Git<'_> {
    /// Captures Git's checkout name or jj's nearest local bookmarks at the same ancestry depth.
    /// Failed optional jj reads produce an unavailable context; cancellation and deadlines propagate.
    pub(super) async fn checkout_context(&mut self) -> Result<(Option<String>, Option<JjContext>), &'static str> {
        if !self.root.join(".jj").is_dir() {
            return Ok((self.current_branch().await?, None));
        }
        // Explicit operation and ignored working copy prevent snapshotting or operation integration.
        let result = self.run_program("jj", &[
            "--ignore-working-copy", "--at-op=@", "--no-pager", "--color=never",
            // ancestors includes @: four levels cover three previous parent hops.
            "log", "--no-graph", "-r", "ancestors(@, 4)", "-T",
            r#"json({"id" => self.commit_id(), "changeId" => self.change_id().short(8), "parents" => self.parents().map(|p| p.commit_id()), "bookmarks" => self.local_bookmarks().filter(|b| !b.conflict()).map(|b| b.name()), "workingCopy" => self.current_working_copy()}) ++ "\n""#,
        ], 64 * 1024).await;
        let context = match result {
            Ok(bytes) => decode(&bytes).unwrap_or_default(),
            Err(error @ ("Git review cancelled" | "Git review timed out")) => return Err(error),
            Err(_) => JjContext::default(),
        };
        Ok((None, Some(context)))
    }
}

/// Prefers bookmarks on @, then the nearest parent layer through depth three, including merge parents.
fn decode(bytes: &[u8]) -> Option<JjContext> {
    let rows = serde_json::Deserializer::from_slice(bytes).into_iter::<Revision>()
        .collect::<Result<Vec<_>, _>>().ok()?;
    let working = rows.iter().find(|row| row.working_copy)?;
    if working.change_id.len() != 8 || !working.change_id.bytes().all(|byte| (b'k'..=b'z').contains(&byte)) { return None; }
    let mut context = JjContext { change_id: Some(working.change_id.clone()), ..Default::default() };
    let mut layer = BTreeSet::from([working.id.as_str()]);
    let rows: HashMap<_, _> = rows.iter().map(|row| (row.id.as_str(), row)).collect();
    for distance in 0..=3 {
        let revisions: Vec<_> = layer.iter().filter_map(|id| rows.get(id)).collect();
        let bookmarks: BTreeSet<_> = revisions.iter().flat_map(|row| &row.bookmarks).cloned().collect();
        if !bookmarks.is_empty() {
            if bookmarks.iter().any(|name| name.is_empty() || name.chars().any(char::is_control)) { return None; }
            context.bookmarks = bookmarks.into_iter().collect();
            context.distance = Some(distance);
            break;
        }
        layer = revisions.iter().flat_map(|row| row.parents.iter().map(String::as_str)).collect();
    }
    Some(context)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn revision(id: &str, parents: &[&str], bookmarks: &[&str], working: bool) -> String {
        serde_json::json!({"id":id,"changeId":"zzzzzzzz","parents":parents,"bookmarks":bookmarks,"workingCopy":working}).to_string()
    }

    #[test]
    fn bookmark_hints_stop_at_three_hops_and_do_not_choose_between_merge_parents() {
        for depth in 0..=4 {
            let rows: Vec<_> = (0..=4).map(|index| revision(&index.to_string(), &[&(index + 1).to_string()], if index == depth { &["nearby"] } else { &[] }, index == 0)).collect();
            let context = decode(rows.join("\n").as_bytes()).unwrap();
            assert_eq!(context.distance, (depth <= 3).then_some(depth));
            assert_eq!(context.bookmarks, if depth <= 3 { vec!["nearby"] } else { vec![] });
        }
        let rows = [revision("work", &["left", "right"], &[], true), revision("left", &[], &["z", "same"], false), revision("right", &[], &["a", "same"], false)];
        let context = decode(rows.join("\n").as_bytes()).unwrap();
        assert_eq!(context.distance, Some(1));
        assert_eq!(context.bookmarks, ["a", "same", "z"]);
    }

    #[test]
    fn malformed_or_unavailable_metadata_is_not_a_bookmark_match() {
        assert!(decode(b"").is_none());
        assert!(decode(b"not JSON").is_none());
        assert!(decode(revision("other", &[], &["main"], false).as_bytes()).is_none());
        assert!(decode(revision("work", &[], &["bad\nname"], true).as_bytes()).is_none());
    }
}
