//! Preserve literal diffs and derive snippet-relative changes from exact Before/After pairs.
use super::{AFTER, BEFORE, ComparisonMode, ResponseCard};

const MAX_ROWS: usize = 240;

/// Finds a single short standalone diff with real changed lines. The body is borrowed
/// verbatim, including its final line break. Multiple or unfinished fences are ambiguous.
pub(super) fn single_fenced_diff(answer: &str) -> Option<&str> {
    let mut open = None;
    let mut found = None;
    let mut end = 0;
    for raw in answer.split_inclusive('\n') {
        let start = end;
        end += raw.len();
        let line = raw.trim_start_matches(' ');
        let indent = raw.len() - line.len();
        if indent > 3 { continue; }
        let Some(marker @ (b'`' | b'~')) = line.bytes().next() else { continue; };
        let width = line.bytes().take_while(|&byte| byte == marker).count();
        if width < 3 { continue; }
        let info = line[width..].trim_matches([' ', '\t', '\r', '\n']);
        match open {
            Some((ch, min, body, diff)) if ch == marker && width >= min && info.is_empty() => {
                if diff && found.replace(&answer[body..start]).is_some() { return None; }
                open = None;
            }
            None if marker != b'`' || !info.contains('`') => {
                open = Some((marker, width, end, indent == 0 && info.eq_ignore_ascii_case("diff")));
            }
            _ => {},
        }
    }
    if open.is_some() { return None; }
    found.filter(|code| code.len() <= 4 * 1024 && code.lines().count() <= 48 && code.lines().any(|line|
        line.starts_with(['+', '-']) && !line.starts_with("+++ ") && !line.starts_with("--- ")))
}

#[cfg(test)]
mod tests {
    use super::single_fenced_diff;

    #[test]
    fn only_unambiguous_closed_short_patches_are_preserved() {
        let patch = "- old  \r\n+ new\r\n";
        assert_eq!(single_fenced_diff(&format!("Try this:\r\n\r\n~~~diff\r\n{patch}~~~")), Some(patch));
        for text in [
            "```diff\n-old\n+new\n".into(),
            "````markdown\n```diff\n-old\n+new\n```\n````".into(),
            "> ```diff\n> -old\n> +new\n> ```".into(),
            "```diff\n--- a/file\n+++ b/file\n```".into(),
            "```diff\n-old\n+a\n```\n\n```diff\n-old\n+b\n```".into(),
            format!("```diff\n{}```", "+ a\n".repeat(49)),
        ] {
            assert!(single_fenced_diff(&text).is_none());
        }
    }
}

/// Accepts only the bounded, prefix-per-line form used by app-computed snippets.
pub(super) fn valid_rows(code: &str) -> bool {
    if code.len() > 8192 + MAX_ROWS { return false; }
    let mut changed = false;
    for (index, row) in code.split('\n').enumerate() {
        if index >= MAX_ROWS { return false; }
        match row.as_bytes().first() {
            Some(b'+' | b'-') => changed = true,
            Some(b' ') => (),
            _ => return false,
        }
    }
    changed
}

fn fenced(text: &str) -> Option<&str> {
    let (opening, rest) = text.trim().split_once('\n')?;
    let fence = opening.as_bytes().first().copied()?;
    if !matches!(fence, b'`' | b'~') { return None; }
    let n = opening.bytes().take_while(|b| *b == fence).count();
    if n < 3 { return None; }
    let marker = &opening[..n];
    let body = rest.strip_suffix(marker)?.strip_suffix('\n')?;
    // Do not mistake several adjacent fences or prose for a single snippet.
    if body.lines().any(|line| line.trim_start().starts_with(marker)) { return None; }
    Some(body.strip_suffix('\r').unwrap_or(body))
}

/// Accept only a unique, adjacent pair under standalone Before / After labels.
/// Labels inside an enclosing example fence are not evidence of a change.
fn directed_pair(answer: &str, before: &str, after: &str) -> bool {
    fn unique(text: &str, snippet: &str) -> Option<usize> {
        let mut hits = text.match_indices(snippet);
        let (pos, _) = hits.next()?;
        hits.next().is_none().then_some(pos)
    }
    fn label(line: &str, name: &str) -> bool {
        line.trim().trim_start_matches('#').trim().trim_end_matches(':').trim_matches('*').trim_end_matches(':').eq_ignore_ascii_case(name)
    }
    let (Some(a), Some(b)) = (unique(answer, before), unique(answer, after)) else { return false; };
    let Some(between) = answer.get(a + before.len()..b) else { return false; };
    let prefix = &answer[..a];
    let suffix = &answer[b + after.len()..];
    if !prefix.ends_with('\n') || !between.starts_with(['\r', '\n']) || !between.ends_with('\n')
        || !label(between, AFTER) || !prefix.trim_end().lines().last().is_some_and(|line| label(line, BEFORE))
        || !(suffix.is_empty() || suffix.starts_with(['\r', '\n'])) { return false; }
    let mut fence = None;
    for line in prefix.lines() {
        let line = line.trim_start_matches(' ');
        let Some(marker @ (b'`' | b'~')) = line.bytes().next() else { continue; };
        let width = line.bytes().take_while(|byte| *byte == marker).count();
        match fence {
            None if width >= 3 => fence = Some((marker, width)),
            Some((ch, n)) if ch == marker && width >= n && line[width..].trim().is_empty() => fence = None,
            _ => {},
        }
    }
    fence.is_none()
}

/// Resolves fenced Before/After pairs against the original answer before drawing a diff.
pub(super) fn from_comparison(card: &ResponseCard, answer: &str) -> Option<ResponseCard> {
    let ResponseCard::Comparison { title, mode, left, right } = card else { return None };
    match mode {
        Some(ComparisonMode::Change) => (),
        None if left.title == BEFORE && right.title == AFTER => (),
        _ => return None,
    }
    let (old, new) = (fenced(&left.text)?, fenced(&right.text)?);
    if !directed_pair(answer, left.text.trim(), right.text.trim()) {
        return Some(ResponseCard::Note { title: "Code examples".into(), text: "The original reply does not establish a unique Before/After pair for these snippets. View the original to compare them.".into() });
    }
    // Keep the existing Before/After view for large examples. Bound both output
    // and the longest-common-subsequence matrix before allocating it.
    if old == new || old.len() + new.len() > 8192 { return None; }
    let a: Vec<_> = old.split('\n').collect();
    let b: Vec<_> = new.split('\n').collect();
    let width = b.len() + 1;
    let size = (a.len() + 1) * width;
    if size > 65536 { return None; }
    let mut lengths = vec![0u16; size];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            let k = i * width + j;
            lengths[k] = if a[i] == b[j] { 1 + lengths[k + width + 1] } else { lengths[k + 1].max(lengths[k + width]) };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut rows = Vec::new();
    while i < a.len() || j < b.len() {
        let k = i * width + j;
        if i < a.len() && j < b.len() && a[i] == b[j] {
            rows.push(format!(" {}", a[i])); i += 1; j += 1;
        } else if j == b.len() || (i < a.len() && lengths[k + width] >= lengths[k + 1]) {
            rows.push(format!("-{}", a[i])); i += 1;
        } else {
            rows.push(format!("+{}", b[j])); j += 1;
        }
    }
    let code = rows.join("\n");
    valid_rows(&code).then(|| ResponseCard::Code {
        title: title.clone(), language: Some("diff".into()), code, snippet_diff: Some(true),
    })
}
