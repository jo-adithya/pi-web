# Checking the meaning of a simplified reply

Use these synthetic source answers when comparing formatter prompts or models. Review the rendered answer alongside the source. Accept different wording and layouts. Fail a case if a reader who sees only the simplified answer would take a different action or believe a different outcome. A structurally valid response is not enough.

| Source answer | Must survive simplification | Reject |
| --- | --- | --- |
| “The build passed. I did not deploy it.” | Build passed; not deployed. | “The fix is live.” |
| “The first run timed out. The retry passed. Mobile was not tested.” | Initial failure, successful retry, and the mobile coverage gap. | “All checks passed.” |
| “We skipped the Linux run. I couldn’t confirm whether Windows passed.” | Linux skipped; Windows outcome unknown. | “Both were skipped.” |
| “Restart only if the migration finished. Otherwise leave the service running.” | Both branches, including the condition on restart. | An unconditional restart instruction. |
| Earlier: “I think the worker dropped the event.” Later: “Correction: the worker received it. The UI filtered it out.” | The correction replaces the earlier hypothesis. | Blaming the worker or presenting both claims as established. |
| “Option A uses `read()`. Option B uses `peek()`. Neither has been applied.” | Alternatives, not an applied change. If shown side by side, title the sides “Option A” and “Option B.” | Calling the options Before/After or showing removed and added lines as an edit. |
| “The account is already active.” | One sentence; no new instruction. | A separate status panel, redundant headline, or “Next step: activate the account.” |
| “I’d hold the change: in `src/queue.ts:8-10`, a failed retry clears a pending entry. Move the removal after confirmation. Renaming the helper is optional. Unit tests passed; I didn’t run CI.” | Lead with the recommendation. Keep the trigger, impact, exact range, and proposed fix together. Keep the rename optional and distinguish the passing tests from CI. | Burying the risk under optional polish, mentioning a different line, implying the fix was applied, or saying all checks passed. |
| “No issues found in the two sampled invoices. I did not check the rest.” | A short conclusion limited to the sample. | Claiming the full set was verified or filling empty sections. |
| “**Quieter replies.** Short answers stay as prose. **Safer simplification.** Malformed steps open Original. Changes are **not deployed**.” | Short bold lead-ins still distinguish the items if they move into a list. Bold includes the negation. | All emphasis disappears, entire items become bold, or “not **deployed**” makes the caveat harder to scan. |

## Check the lead and the breakdown

Use this longer source reply:

> I looked through the build output, then reran the web type check and tests. Both passed. I ran the full suite separately; `history_keeps_cursor` failed because the cursor was missing after reconnect. I did not run the mobile checks. The app was rebuilt, but I did not restart it.

A good lead is “The app was rebuilt, not restarted. **The full suite failed.**” A verification list can keep the failed test and its symptom, the passing web checks, and the skipped mobile checks. Each item should be a short takeaway, not a paragraph. Reject results that repeat those items in the lead, say the app is live, or call skipped checks passed. Do not add a restart instruction. For contrast, “The build passed. I did not deploy it.” needs no block.

For the directional case, use this original verbatim:

````text
Proposed change (not applied).
Before:
```js
read();
```
After:
```js
peek();
```
````

If shown as a diff, `read();` must be removed and `peek();` added; the proposal must not be described as shipped. Also try a fresh prompt asking to see the exact change when Pi returns one short fenced `diff`. Even if the formatter chooses only prose, Simple should include that exact patch and retain any caveat from the answer. Renaming the comparison panels must not alter direction. Swap the formatter's snippets or remove the Before/After labels from the original: the reply should point to Original instead of drawing a diff.

The [shared component fixtures](../apps/shared/fixtures/response-components.json) cover explicit table purpose, comparison mode with custom headings, and paired annotated paths. For the paths example, “2 queries” belongs to the read step, the disagreement risk belongs to the separate list path, and the shared decision must remain “Design only” even when the panels stack. In `composedComparison`, the current call site belongs with the separate decisions, the exact rule quotation belongs with the proposed path, and the skipped tests apply to both. Try a review with comparable timings as well: a shared chart should keep the same unit and scale, not imply that a proposal was measured. A simple contrast should still work as prose. The formatter, server and browser checks reuse the fixtures; they do not replace a live meaning check.

## Baseline for the clearer-replies plan

Before the prompt edit, `cargo test --offline --locked -p pi-web --lib response_format`
passed 56 offline tests. The new malformed-action fixture reproduced a lost step:
a draft with a blank step showed a partial summary instead of Original. The prior
prompt already asked for prose on plain replies and for warnings to stay visible,
but chose a block first and encouraged a table even when prose was clearer.

For an opt-in model comparison, use the same source replies and model with the old
and new prompt. Record which meaning cases pass and compare the rendered answer
for unnecessary headings, repeated breakdowns, and scan order. No live model was
run for the offline baseline; a passing schema test does not establish wording
quality.
