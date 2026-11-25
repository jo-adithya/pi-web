# Pi Web: clearer simple responses

**Status: implemented in order.** Offline evidence is below. Live model quality
and real-browser layout have not been checked. Make Pi’s answer easier to
understand before adding more UI.
A reader should be able to tell what happened, what is still uncertain, and what
(if anything) they need to do without opening the original reply.

Conversation search and per-claim source controls are out of scope. Use
**View original** to read the full reply when you need more detail.

## 1. Keep the reading flow quiet

- Start with the answer, not a label like “Summary.” A short answer stays as prose:
  “The build passed. **It’s not deployed.**” No separate status card or repeated
  breakdown. Keep the main result in the strongest visual position.
- Put **View original**, **Copy**, and timing in the reply footer. Use the same
  control to switch **Back to simple**.
- When Pi finishes and formatting is still pending, show one status: “Pi finished.
  Simplifying…” Don’t repeat it in both the reply and the composer. Offer Original
  as soon as the completed source is available. A formatting retry can simply say
  “Simplifying…”
- Keep the chosen view when formatting finishes. Anchor the exchange when switching
  views and keep keyboard focus on the switch. Don’t pull someone away from an
  older exchange. Keep Original on demand, with no model call to open it.

Start in [`SimpleResponse.tsx`](../apps/web/src/components/SimpleResponse.tsx) and
[`SessionView.tsx`](../apps/web/src/SessionView.tsx). Reuse the current theme and
reading column. On phones and in narrow panes, the reply should still read in one
column, with the answer taking precedence over controls.

## 2. Preserve the meaning before polishing the layout

1. Record a baseline with the [simplification quality cases](simplification-quality.md)
   before changing the [formatter prompt](../apps/server/src/response_format/planner.txt).
   Use the same synthetic replies for each prompt or model. Review the rendered
   result, not just the JSON: would the reader understand the same outcome and take
   the same action? Keep offline parser and renderer tests separate from opt-in
   model comparisons.
2. Lead with the takeaway and any exception that changes it. Keep failed or
   unverified checks, warnings, and required actions visible. Explain necessary
   jargon once. Put one condition and its action in the same sentence; use an If/Then
   block only when comparing several branches helps. Use **Next step** only when Pi
   actually asks the reader to do something. Collapse optional context, never a
   caveat or action.
3. In [`draft.rs`](../apps/server/src/response_format/draft.rs), extend the existing
   Original fallback to malformed steps and recognizable If/Then tables. A missing
   action cell must not disappear behind an otherwise confident summary. Keep
   partial display for nonessential blocks. Schema checks can catch malformed
   blocks, not a valid-looking reply that omits an entire branch; cover that in the
   meaning cases.

Require cases for corrections, negation, both branches of a conditional, skipped
versus unverified checks, and build versus deployment. Also check that ordinary
answers don’t gain a redundant heading, card, or next step. Keep at most one
formatter call per completed Pi run in the normal flow. Preserve saved replies
without bulk reformatting or changing Pi’s transcript.

## 3. Measure the wait and remove repeated work

- Extend the [existing timing breakdown](../apps/web/src/components/SimpleResponse.tsx)
  to cover save time, server-side WebSocket queue and send time, and the browser’s
  time from receipt to rendering the reply. Measure each interval on one clock.
  Keep measurements local and out of the reading flow. Distinguish opening a
  cached reply from the historical cost of creating it.
- In [`ResponseGraphics.tsx`](../apps/web/src/components/ResponseGraphics.tsx),
  compute diagram geometry once per graph and width bucket. Index nodes by ID
  for edge drawing and descriptions. Preserve every connection, including loops
  and hypotheses, and keep the text equivalent.
- Compare a fresh reply, a saved reply, a large canvas, and several concurrent
  sessions before and after the change. Report where the time goes; don’t claim a
  speedup without measurements. Leave worker counts and warm processes alone
  unless queue or startup measurements justify a separate change.

## 4. Add layouts only when they make a task easier

| Layout | Use it when | Keep it simple |
| --- | --- | --- |
| **Decision brief** | The reader needs to pick between options. | Lead with the recommendation and when it applies. Reuse the summary, table, and warning blocks. On narrow panes, stack options with their comparison labels intact. No new card type. |
| **Review split view** | The reader chooses to inspect a cited hunk while reading the answer. | Open the existing Changes preview beside the answer on desktop and in a dismissible sheet on phones. Leave it closed by default. Restore scroll and focus on close. Label current code separately from captured evidence; never substitute it silently. |
| **Native edit preview** | Pi supplied a unique, exact Before/After code pair. | Extend the [existing snippet diff](../apps/server/src/response_format/snippet_diff.rs) with snippet-relative line numbers and a unified view that fits narrow panes. Retain literal code for copying and the current fallback for large or ambiguous pairs. Label proposals as proposals; a snippet diff does not establish that an edit happened. |

Prefer existing blocks and app-owned rendering. Keep reading and copy order
consistent. Add a new response type only if a representative reply is harder to
read with the existing blocks; if the wire shape changes, update both validators,
regenerate protocol types, and check saved replies still open.

## Ship order and acceptance

Ship the quiet reading flow and meaning safeguards first. Use the timing baseline
before changing performance-sensitive code. Try each optional layout separately;
keep it only if it makes the underlying answer easier to scan or act on.

- A plain answer needs no card. A reader can see the result, the caveat, and any
  required action at a glance. The same information remains visible in a narrow
  pane; it does not depend on color or opening a disclosure.
- Original opens before formatting finishes when available. Completion never
  switches a reader back to Simple or steals their place. Unsafe partial output
  opens Original instead of hiding an instruction.
- Cover malformed-action recovery, saved-reply compatibility, and copy order with
  offline fixtures. Follow the project’s UI verification policy: run UI-only checks
  only when requested. For those checks, exercise keyboard focus, scroll position,
  and narrow layouts.

## Local verification

The [quality checklist](simplification-quality.md) records the offline formatter
baseline. The malformed-action test failed before the fix and now passes. Saved
replies remain readable without a model call. The reply switch, decision table,
code reference, and code-copy fixtures exercise the updated data paths. TypeScript
and protocol generation checks passed, as did 161 focused web tests. The serial
Rust suite passed 433 tests with six normally ignored; the unrelated Git command
count test `lazy_listing_and_context_cache_skip_expanded_git_work` was excluded
after reproducing its failure against the pre-change tree.

A loopback smoke used the repository's mock Pi child and a six-diagram reply.
Every fresh run made one mock formatter call. Reopening the saved reply after
server restart made none. These are single fixture runs, in milliseconds; `0`
means below the timer's millisecond resolution.

| Scenario | Before geometry change | After (final smoke) |
| --- | --- | --- |
| Fresh reply | 183 formatting, 1 save, 0 WebSocket queue/write | 182 formatting, 1 save, 0 WebSocket queue/write |
| Reopen saved reply | 183 historical formatting, 0 WebSocket queue/write | 182 historical formatting, 0 WebSocket queue/write |
| Three simultaneous replies | 183–366 formatting; one waited 183 for a slot | 181–362 formatting; one waited 181 for a slot |
| Geometry only, dense canvas | 185.55 | 1.01 |

The geometry figures are Node medians of seven runs, routing six graphs of 24
nodes and 144 edges each at two widths. The before and after coordinates and paths
hashed identically. The geometry probe does not measure DOM rendering, mobile
layout, network transit, or live inference. The timing popover shows current
browser DOM-commit time separately when the reply is rendered in the active view.
No worker limits changed.
