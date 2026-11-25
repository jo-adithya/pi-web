//! Normalize incomplete planner output before it crosses the cache/browser boundary.
use super::*;

// This input shape deliberately has no `recorded` field. Only the server can bind observations.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Draft {
    summary: Option<String>,
    #[serde(rename = "summarySource")]
    summary_source: Option<String>,
    blocks: Option<Vec<Value>>,
    canvas: Option<Value>,
}

/// Bind source quotations and Before/After snippets to the assistant's answer.
/// A bad citation must not hide the claim.
pub(super) fn parse_grounded(answer: &str, text: &str) -> Result<SimpleResponse, String> {
    let mut reply = parse(text)?;
    let lines: std::collections::HashSet<_> = answer.lines().map(str::trim)
        .filter(|line| !line.is_empty() && line.len() <= 600).collect();
    let verify = |source: &mut Option<String>| {
        if source.as_deref().is_some_and(|quote| !lines.contains(quote)) { *source = None; }
    };
    verify(&mut reply.summary_source);
    for card in &mut reply.blocks {
        if let Some(diff) = super::snippet_diff::from_comparison(card, answer) { *card = diff; }
        if let ResponseCard::Checks { items, .. } = card {
            for item in items { verify(&mut item.source); }
        }
    }
    Ok(reply)
}

/// Adds a literal patch from the final answer when the planner chose a prose-only reply.
pub(super) fn preserve_diff_in_prose_reply(reply: &mut SimpleResponse, code: &str) {
    if reply.blocks.is_empty() && !super::snippet_diff::single_fenced_diff(&reply.summary).is_some_and(|shown|
        shown.trim_end_matches(['\r', '\n']) == code.trim_end_matches(['\r', '\n']))
    {
        reply.blocks.push(ResponseCard::Code {
            title: "Diff from Original".into(), language: Some("diff".into()), code: code.into(), snippet_diff: None,
        });
    }
}

pub(super) const UNTRUSTED_SNIPPET_DIFF: &str = "A code diff must be derived from the original reply, not marked by the formatter.";
const INVALID_ACTION: &str = "A step or conditional action could not be shown reliably. Read the original reply before acting.";

/// Recognizes legacy If/Then drafts even when one header is missing.
/// Returns None for an ordinary table and Some(false) for incomplete headers.
fn conditional_headers<'a>(mut columns: impl Iterator<Item = Option<&'a str>>) -> Option<bool> {
    let first = columns.next().flatten().map(str::trim).unwrap_or("");
    let second = columns.next();
    let then = second.flatten().is_some_and(|label| label.trim().eq_ignore_ascii_case("then"));
    let condition = first.eq_ignore_ascii_case("if");
    (condition || then && first.is_empty() || second.is_none() && first.eq_ignore_ascii_case("then"))
        .then(|| condition && then && columns.next().is_none())
}

pub(super) fn parse(text: &str) -> Result<SimpleResponse, String> {
    let error = match SimpleResponse::parse(text) {
        Ok(reply) => {
            // A one-column table can be structurally valid but is not a usable If/Then table.
            if reply.blocks.iter().any(|card| matches!(card, ResponseCard::Table { columns, purpose: None, .. }
                if conditional_headers(columns.iter().map(|label| Some(label.as_str()))) == Some(false))) {
                return Err(INVALID_ACTION.into());
            }
            return Ok(reply);
        }
        Err(error) => error,
    };
    let Ok(draft) = serde_json::from_str::<Draft>(text) else { return Err(error) };
    let raw = draft.blocks.unwrap_or_default();
    let count = raw.len();
    let mut blocks = Vec::with_capacity(count);
    for value in raw {
        let kind = value["type"].as_str();
        if kind == Some("code") && value.get("snippetDiff").is_some() { return Err(UNTRUSTED_SNIPPET_DIFF.into()); }
        let decision = matches!(kind, Some("warning" | "checks" | "findings"));
        let conditional = if kind == Some("table") {
            match value["purpose"].as_str() {
                Some("conditional") => Some(true), // Required even if the headings and rows cannot be parsed.
                Some("data" | "decision") => None,
                _ => value["columns"].as_array().and_then(|columns| conditional_headers(columns.iter().map(Value::as_str))),
            }
        } else { None };
        let path = kind == Some("path");
        let action = kind == Some("steps") || conditional.is_some();
        if conditional == Some(false) { return Err(INVALID_ACTION.into()); }
        if let Some(block) = card(value) { blocks.push(block); }
        else if path { return Err("A path could not be shown reliably. View the original reply for the complete explanation.".into()); }
        else if action { return Err(INVALID_ACTION.into()); }
        else if decision { return Err("A warning, check, or finding could not be shown reliably. Read the original reply before acting.".into()); }
    }
    let paired = draft.canvas.as_ref().is_some_and(|v| contains_panels(&v["composition"]));
    let mut canvas = draft.canvas.and_then(|v| serde_json::from_value::<CanvasPlan>(v).ok());
    // A flattened comparison would detach claims from their Current/Proposed labels.
    if paired && (blocks.len() != count || !canvas.as_ref().is_some_and(|plan| plan.valid(&blocks))) {
        return Err("Comparison panels could not be shown reliably. View the original reply to compare the two sides.".into());
    }
    let mut summary = draft.summary.unwrap_or_default();
    if blocks.is_empty() && !filled(&summary) {
        summary = canvas.as_mut().and_then(|plan| plan.headline.take()).filter(|s| filled(s)).ok_or(error)?;
    }
    let omitted = blocks.len() != count;
    if let Some(plan) = &mut canvas {
        // Removing a block can change the meaning of even an in-range index.
        if omitted || !plan.valid(&blocks) { plan.focus = None; plan.composition = None; }
    }
    if omitted {
        blocks.push(ResponseCard::Note { title: "Partial view".into(), text: "Some sections could not be displayed. View the original reply for the full answer.".into() });
    }
    Ok(SimpleResponse { summary, summary_source: draft.summary_source, blocks, canvas, recorded: None })
}

fn contains_panels(node: &Value) -> bool {
    node["type"] == "comparison_panels" || node["children"].as_array().is_some_and(|children| children.iter().any(contains_panels))
}

fn card(mut value: Value) -> Option<ResponseCard> {
    let kind = value.get("type")?.as_str()?;
    if !value.get("title").and_then(Value::as_str).is_some_and(filled) {
        let mut label = kind.to_owned();
        if let Some(first) = label.get_mut(..1) { first.make_ascii_uppercase(); }
        value["title"] = label.into();
    }
    serde_json::from_value(value).ok().filter(|card: &ResponseCard| !card.incomplete())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_cards_do_not_hide_usable_content_or_shift_layout_references() {
        let reply = parse(r#"{"blocks":[{"type":"chart","unit":"s"},{"type":"warning","text":"Do not restart."}],"canvas":{"layout":"result","focus":0}}"#).unwrap();
        assert!(matches!(&reply.blocks[0], ResponseCard::Warning { title, text } if title == "Warning" && text == "Do not restart."));
        assert!(matches!(&reply.blocks[1], ResponseCard::Note { title, .. } if title == "Partial view"));
        assert_eq!(reply.canvas.as_ref().unwrap().focus, None);
        assert_eq!(SimpleResponse::parse_saved(&serde_json::to_string(&reply).unwrap()).unwrap(), reply);
    }
    #[test]
    fn cites_only_complete_original_lines_without_dropping_uncited_claims() {
        let parsed = parse_grounded("Résultat: one test failed.\r\nDo not restart.", r#"{"summary":"One test failed.","summarySource":"Résultat: one test failed.","blocks":[{"type":"checks","title":"Checks","items":[{"status":"failed","text":"One failure.","source":"Résultat: one test failed."},{"status":"unverified","text":"Mobile untested.","source":"No mobile device available."},{"status":"skipped","text":"Restart skipped.","source":"restart."}]}]}"#).unwrap();
        assert_eq!(parsed.summary_source.as_deref(), Some("Résultat: one test failed."));
        let ResponseCard::Checks { items, .. } = &parsed.blocks[0] else { panic!() };
        assert_eq!(items.iter().map(|item| item.source.as_deref()).collect::<Vec<_>>(), [Some("Résultat: one test failed."), None, None]);
        assert_eq!(SimpleResponse::parse_saved(&serde_json::to_string(&parsed).unwrap()).unwrap(), parsed);
    }
    #[test]
    fn rebuild_keeps_a_verbatim_diff_when_the_planner_returns_only_prose() {
        let code = "- <TabsContent key={kindFilter} value={kindFilter}>\n+ <TabsContent value={kindFilter}>\n";
        let original = format!("Remove only the panel key.\n\n```diff\n{code}```\n\nFiltered-out cards still unmount.");
        let mut reply = parse_grounded(&original, r#"{"summary":"Remove only the panel key. Filtered-out cards still unmount.","blocks":[]}"#).unwrap();
        let context = FormatContext::for_live_reply(RecordedEvidence::default(), None, Some(&original));
        preserve_diff_in_prose_reply(&mut reply, context.original_diff.as_deref().unwrap());
        assert!(matches!(&reply.blocks[..], [ResponseCard::Code { code: kept, language: Some(language), snippet_diff: None, .. }] if kept == code && language == "diff"));
        assert!(reply.summary.contains("Filtered-out cards still unmount."));
        let mut already_visible = parse_grounded(&original, &serde_json::json!({"summary": original, "blocks": []}).to_string()).unwrap();
        preserve_diff_in_prose_reply(&mut already_visible, code);
        assert!(already_visible.blocks.is_empty(), "don't show the same diff twice");
    }
    #[test]
    fn exact_code_pairs_become_line_diffs_but_invented_pairs_do_not() {
        let old = "```js\nstart();\n  one();\nkeep();\n  two();\n```";
        let new = "```js\nstart();\n  uno();\nkeep();\n  dos();\n```";
        let raw = serde_json::json!({"summary":"Proposed change", "blocks":[{"type":"comparison", "mode":"change", "title":"Proposed edit",
            "left":{"title":"Current","text":old}, "right":{"title":"Proposed","text":new}}]}).to_string();
        let original = format!("Before:\n{old}\nAfter:\n{new}");
        let grounded = parse_grounded(&original, &raw).unwrap();
        assert!(matches!(&grounded.blocks[0], ResponseCard::Code { code, language: Some(lang), snippet_diff: Some(true), .. } if lang == "diff" && code == " start();\n-  one();\n+  uno();\n keep();\n-  two();\n+  dos();"));
        let ungrounded = parse_grounded(old, &raw).unwrap();
        assert!(matches!(&ungrounded.blocks[0], ResponseCard::Note { .. }));

        let alternatives = raw.replace("\"mode\":\"change\"", "\"mode\":\"alternatives\"")
            .replace("\"Current\"", "\"Before\"").replace("\"Proposed\"", "\"After\"");
        let side_by_side = parse_grounded(&original, &alternatives).unwrap();
        assert!(matches!(&side_by_side.blocks[0], ResponseCard::Comparison { .. }), "titles alone must not trigger a diff");
    }
    #[test]
    fn comparison_modes_round_trip_with_custom_titles() {
        let fixture: Value = serde_json::from_str(include_str!("../../../shared/fixtures/response-components.json")).unwrap();
        let comparisons = &fixture["comparisons"];
        let parsed = parse(&comparisons.to_string()).unwrap();
        assert_eq!(serde_json::to_value(&parsed.blocks).unwrap(), comparisons["blocks"]);
        assert_eq!(SimpleResponse::parse_saved(&serde_json::to_string(&parsed).unwrap()).unwrap(), parsed);
    }
    #[test]
    fn composed_comparisons_keep_panel_membership_or_reject_ambiguous_drafts() {
        let fixtures: Value = serde_json::from_str(include_str!("../../../shared/fixtures/response-components.json")).unwrap();
        let raw = &fixtures["composedComparison"];
        let parsed = parse(&raw.to_string()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), *raw);
        assert_eq!(SimpleResponse::parse_saved(&raw.to_string()).unwrap(), parsed);
        for refs in [serde_json::json!([]), serde_json::json!([1, 2]), serde_json::json!([1]), serde_json::json!([1, 8]), serde_json::json!("invalid")] {
            let mut invalid = raw.clone();
            invalid["canvas"]["composition"]["children"][0]["left"]["blocks"] = refs;
            assert!(parse(&invalid.to_string()).is_err(), "do not detach content from its side");
        }
        let mut missing = raw.clone();
        missing["blocks"][0]["code"] = Value::Null;
        assert!(parse(&missing.to_string()).is_err());
    }
    #[test]
    fn annotated_paths_survive_storage_and_do_not_silently_drop_a_broken_path() {
        let fixture: Value = serde_json::from_str(include_str!("../../../shared/fixtures/response-components.json")).unwrap();
        let mut raw = fixture["paths"].clone();
        // Strict provider drafts use null for absent fields; the wire shape omits them.
        raw["blocks"][0]["status"] = Value::Null;
        raw["blocks"][1]["groups"][0]["steps"][0]["annotation"] = Value::Null;
        let parsed = parse(&raw.to_string()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), fixture["paths"]);
        assert_eq!(SimpleResponse::parse_saved(&serde_json::to_string(&parsed).unwrap()).unwrap(), parsed);
        raw["blocks"][1]["groups"][0]["steps"] = serde_json::json!([]);
        assert!(parse(&raw.to_string()).is_err(), "don't discard one side of the explanation");
    }
    #[test]
    fn named_comparisons_keep_both_examples_and_their_titles() {
        let left = "```sql\nSELECT id FROM work_orders;\n```";
        let right = "```text\nmaximo_query\n```";
        let answer = format!("Two ways to read work orders.\nPostgres:\n{left}\nMaximo:\n{right}");
        let raw = serde_json::json!({"summary": "Two ways to read work orders.", "blocks": [{
            "type": "comparison", "title": "Read work orders",
            "left": {"title": "Postgres", "text": left}, "right": {"title": "Maximo", "text": right}
        }]});
        let reply = parse_grounded(&answer, &raw.to_string()).unwrap();
        let stored = serde_json::to_value(&reply).unwrap();
        assert_eq!(stored["blocks"], raw["blocks"], "parallel examples are not a code change");
        assert_eq!(SimpleResponse::parse_saved(&stored.to_string()).unwrap(), reply);
    }
    #[test]
    fn only_the_app_can_mark_a_snippet_diff() {
        let raw = r#"{"summary":"Proposed edit","blocks":[{"type":"code","title":"Snippet","language":"diff","code":"-old\n+new","snippetDiff":true}]}"#;
        assert_eq!(parse(raw).unwrap_err(), UNTRUSTED_SNIPPET_DIFF);
        assert!(SimpleResponse::parse_saved(raw).is_ok());
        assert!(SimpleResponse::parse_saved(&raw.replace("-old", "old")).is_err());
        let old_cache = raw.replace(",\"snippetDiff\":true", "");
        assert!(SimpleResponse::parse_saved(&old_cache).is_ok());
    }
    #[test]
    fn malformed_decision_cards_cannot_leave_a_success_summary() {
        for card in [serde_json::json!({"type":"warning","text":null}), serde_json::json!({"type":"checks","items":[{"status":"failed"}]}), serde_json::json!({"type":"findings","items":[]})] {
            let draft = serde_json::json!({"summary":"Build succeeded.","blocks":[card]});
            assert!(parse(&draft.to_string()).is_err(), "a missing qualification must send the reader to Original");
        }
    }
    #[test]
    fn malformed_actions_cannot_leave_an_incomplete_summary() {
        for card in [
            serde_json::json!({"type":"steps","items":["Save settings.",""]}),
            serde_json::json!({"type":"table","columns":["If","Then"],"rows":[["Migration finished","Restart"],["Otherwise"]]}),
            serde_json::json!({"type":"table","title":"Restart rules","columns":[" if "],"rows":[["Migration finished"]]}),
            serde_json::json!({"type":"table","columns":[null,"THEN"],"rows":[["Migration finished","Restart"]]}),
        ] {
            let draft = serde_json::json!({"summary":"The build passed.","blocks":[card]});
            assert!(parse(&draft.to_string()).is_err(), "lost part of an action: {draft}");
        }
    }
    #[test]
    fn table_purpose_preserves_actions_under_custom_headings() {
        let fixture: Value = serde_json::from_str(include_str!("../../../shared/fixtures/response-components.json")).unwrap();
        let tables = &fixture["tables"];
        let parsed = parse(&tables.to_string()).unwrap();
        assert_eq!(serde_json::to_value(&parsed.blocks).unwrap(), tables["blocks"]);
        assert_eq!(SimpleResponse::parse_saved(&serde_json::to_string(&parsed).unwrap()).unwrap(), parsed);

        let mut malformed = tables.clone();
        malformed["blocks"][0]["rows"][1] = serde_json::json!(["Otherwise"]);
        assert_eq!(parse(&malformed.to_string()).unwrap_err(), INVALID_ACTION);
        malformed["blocks"][0]["columns"] = serde_json::json!(["Condition"]);
        malformed["blocks"][0]["rows"] = serde_json::json!([["Migration finished"]]);
        assert_eq!(parse(&malformed.to_string()).unwrap_err(), INVALID_ACTION);

        let ordinary = r#"{"summary":"Keywords","blocks":[{"type":"table","purpose":"data","title":"Keyword","columns":["If"],"rows":[["Branch"]]}]}"#;
        let parsed = parse(ordinary).unwrap();
        assert!(matches!(&parsed.blocks[..], [ResponseCard::Table { .. }]));
    }
    #[test]
    fn preserves_both_branches_in_order_and_keeps_old_tables_readable() {
        let raw = r#"{"summary":"The build passed.","blocks":[{"type":"table","title":"Restart rules","columns":["If","Then"],"rows":[["Migration finished","Restart"],["Otherwise","Leave the service running"]]}]}"#;
        let reply = parse(raw).unwrap();
        assert!(matches!(&reply.blocks[0], ResponseCard::Table { rows, .. } if rows[1] == ["Otherwise", "Leave the service running"]));
        assert_eq!(SimpleResponse::parse_saved(raw).unwrap(), reply);
        let historic = r#"{"summary":"Migration status","blocks":[{"type":"table","title":"Conditions","columns":["If"],"rows":[["Migration finished"]]}]}"#;
        assert!(SimpleResponse::parse_saved(historic).is_ok());
        let comparison = raw.replace("\"If\"", "\"Now\"");
        assert!(parse(&comparison).is_ok(), "an ordinary Now/Then table is not a conditional");
    }
    #[test]
    fn ambiguous_or_reversed_snippets_are_not_presented_as_changes() {
        let old = "```rs\nold();\n```";
        let new = "```rs\nnew();\n```";
        let raw = serde_json::json!({"summary":"Two examples.","blocks":[{"type":"comparison","title":"Change",
            "left":{"title":"Before","text":old}, "right":{"title":"After","text":new}}]}).to_string();
        for answer in [format!("Before:\n{new}\nAfter:\n{old}"), format!("Option A:\n{old}\nOption B:\n{new}"), format!("Before:\n{old}\nAfter:\n{new}\nBefore:\n{old}\nAfter:\n{new}"), format!("````md\nBefore:\n{old}\nAfter:\n{new}\n````")] {
            let reply = parse_grounded(&answer, &raw).unwrap();
            assert!(matches!(reply.blocks[0], ResponseCard::Note { .. }));
        }
    }
    #[test]
    fn invalid_layout_falls_back_to_all_blocks() {
        let reply = parse(r#"{"summary":"Result","blocks":[{"type":"note","title":"Next","text":"Read on."}],"canvas":{"layout":"plan","composition":{"type":"block","index":8}}}"#).unwrap();
        assert!(reply.canvas.unwrap().composition.is_none());
        assert_eq!(reply.blocks.len(), 1);
    }
    #[test]
    fn partial_input_still_needs_content_and_cannot_supply_recorded_observations() {
        assert!(parse(r#"{"summary":"Done"}"#).is_ok());
        assert!(parse(r#"{"summary":"Done","recorded":{},"blocks":[]}"#).is_err());
        assert!(parse(r#"{"blocks":[{"type":"steps"}]}"#).is_err());
    }
}
