//! Source lookup is limited to small, cited or turn-changed workspace files. Only the app
//! resolves paths. The model's tools operate on a private copy, never on the workspace.
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

pub(super) const ADAPTER: &str = include_str!("../../pi/source-lookups.ts");
pub(super) const TOOLS: &str = "search_source,read_source";
const MAX_FILES: usize = 8;
const FILE_BYTES: usize = 192 * 1024;

fn source_path(token: &str) -> Option<&str> {
    let token = token.trim_end_matches(['.', ',', ';']);
    let (path, suffix) = token.split_once([':', '#']).unwrap_or((token, ""));
    if !suffix
        .bytes()
        .all(|c| c.is_ascii_digit() || matches!(c, b'L' | b'-' | b':'))
    {
        return None;
    }
    let path = path.strip_prefix("./").unwrap_or(path);
    if path.len() > 512
        || !path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/._-".contains(&c))
        || path.split('/').any(|part| {
            part.is_empty()
                || part.starts_with('.')
                || matches!(
                    part,
                    "node_modules" | "vendor" | "target" | "dist" | "build"
                )
        })
    {
        return None;
    }
    let (_, ext) = path.rsplit_once('.')?;
    matches!(
        ext,
        "rs" | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "py"
            | "go"
            | "java"
            | "kt"
            | "swift"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "cs"
            | "rb"
            | "php"
            | "scala"
            | "css"
            | "html"
            | "vue"
            | "svelte"
            | "sql"
            | "sh"
    )
    .then_some(path)
}

/// Captures up to eight referenced UTF-8 code files after admission, before launching
/// the formatter. Missing, oversized and symlinked paths supply no lookup capability.
pub(super) async fn snapshot(
    root: &Path,
    answer: &str,
    recorded: &super::RecordedEvidence,
) -> BTreeMap<String, String> {
    let mut seen = BTreeSet::new();
    let cited = answer
        .split(|c: char| c.is_whitespace() || "`\"'()[]<>".contains(c))
        .filter_map(source_path);
    let changed = recorded
        .files
        .iter()
        .filter(|f| f.change != super::FileChangeKind::Deleted)
        .map(|f| f.path.as_str())
        .filter(|p| source_path(p) == Some(*p));
    let candidates: Vec<_> = cited
        .chain(changed)
        .filter(|path| seen.insert(*path))
        .take(24)
        .map(str::to_owned)
        .collect();
    if candidates.is_empty() {
        return BTreeMap::new();
    }
    let root = root.to_owned();
    tokio::task::spawn_blocking(move || {
        candidates
            .into_iter()
            .filter_map(|path| {
                let bytes = crate::workspace_files::read(&root, &path, FILE_BYTES).ok()?;
                if bytes.contains(&0) {
                    return None;
                }
                Some((path, String::from_utf8(bytes).ok()?))
            })
            .take(MAX_FILES)
            .collect()
    })
    .await
    .unwrap_or_default()
}

pub(super) fn allowed(enabled: bool, name: &Value) -> bool {
    enabled
        && name
            .as_str()
            .is_some_and(|name| TOOLS.split(',').any(|tool| tool == name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, os::unix::fs::symlink};

    #[tokio::test]
    async fn only_named_small_workspace_code_reaches_snapshot() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(crate::config::identity().unwrap());
        fs::create_dir(&root).unwrap();
        let fixture = super::super::PrivateDirectory(root);
        let root = &fixture.0;
        fs::create_dir(root.join("src")).unwrap();
        for name in [
            "src/good.rs",
            "changed.rs",
            "unmentioned.rs",
            ".private.rs",
            "secrets.env",
        ] {
            fs::write(root.join(name), "contents\n").unwrap();
        }
        fs::write(root.join("large.rs"), vec![b'x'; FILE_BYTES + 1]).unwrap();
        fs::write(root.join("binary.rs"), b"x\0y").unwrap();
        symlink(root.join("src/good.rs"), root.join("linked.rs")).unwrap();
        symlink(root.join("src"), root.join("alias")).unwrap();
        let mut recorded = super::super::RecordedEvidence::default();
        recorded.files.push(super::super::RecordedFile {
            id: "file:0".into(),
            path: "changed.rs".into(),
            change: super::super::FileChangeKind::Modified,
            added: None,
            removed: None,
        });
        let files = snapshot(root, "See [code](src/good.rs#L1), `./src/good.rs:1`. .private.rs secrets.env ../outside.rs /absolute.rs linked.rs alias/good.rs binary.rs large.rs", &recorded).await;
        assert_eq!(
            files,
            BTreeMap::from([
                ("src/good.rs".into(), "contents\n".into()),
                ("changed.rs".into(), "contents\n".into())
            ])
        );
    }
}
