import { TextField } from "@kobalte/core/text-field";
import { SelectField } from "./components/SelectField";
import { ProgressBar } from "./components/ProgressBar";
import { Button } from "@kobalte/core/button";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { Collapsible } from "@kobalte/core/collapsible";
import { reviewLineKey } from "./review-history";
import { formatReply } from "./reply-quote";
import type { EvidenceCitation, ExplanationEvidence } from "./review-explanations";
import type { ReviewQuestion } from "./local-review";
import { createEffect, createMemo, createSignal, flush, For, onSettled, Show } from "solid-js";
import { Checkbox } from "@kobalte/core/checkbox";
import { hasPatch, reviewDraft, reviewScopeDraft, reviewQuestionPresets, reviewQuestionSkill, type ReviewScope } from "./local-review";
import { ReviewRows } from "./ReviewRows";
import { ReviewOverview } from "./ReviewOverview";
import { groupingUsageLabel } from "./review-costs";
import { Icon } from "./components/Icon";
import { ActionDialog } from "./components/ActionDialog";
import { highlightDiff, type HighlightedLine } from "./review-highlight";
import type { ContextGap } from "./context-review";
import type { SessionModel } from "./session-model";
import "./local-review.css";

const scopeHelp = {
  unstaged: "Working tree edits that aren’t staged yet. Untracked files show names only.",
  staged: "Changes in the Git index, ready for the next commit.",
  branch: "Compare your current checkout with a base: committed changes since the branches diverged, not a tip-to-tip diff. Uncommitted edits are excluded.",
  commit: "The selected commit against its first parent; root commits against an empty tree. Uncommitted edits are excluded.",
};

/** Read-only workspace snapshot browser. Ask Pi only appends to the session draft. */
export function LocalReview(props: { model: SessionModel; conversation: () => void }) {
  const review = props.model.review;
  const structural = review.structural, context = review.context;
  const [notice, setNotice] = createSignal("");
  const [filter, setFilter] = createSignal("");
  const [needsReview, setNeedsReview] = createSignal(false);
  const [groupKey, setGroupKey] = createSignal("");
  const activeGroup = createMemo(() => review.grouping.mode() === "intent" ? review.grouping.value()?.find(group => JSON.stringify(group.paths) === groupKey()) : undefined);
  const [evidence, setEvidence] = createSignal<{ path: string; fingerprint: string; keys: Set<string>; headers: Set<string> }>();
  const [filesOpen, setFilesOpen] = createSignal(false);
  const [view, setView] = createSignal<"overview" | "files">("files");
  const [questionsOpen, setQuestionsOpen] = createSignal(false);
  const [questionScope, setQuestionScope] = createSignal<"all" | "file" | "selection">("file");
  const [commitQuery, setCommitQuery] = createSignal("");
  const matchingBranches = createMemo(() => {
    const query = review.branches.query().trim().toLowerCase();
    return (review.branches.value()?.branches ?? []).filter(branch => branch.ref.toLowerCase().includes(query));
  });
  const matchingCommits = createMemo(() => {
    const query = commitQuery().trim().toLowerCase();
    return (review.history.value()?.commits ?? []).filter(commit => `${commit.subject} ${commit.id}`.toLowerCase().includes(query));
  });
  const selectedCommit = () => review.history.value()?.commits.find(commit => commit.id === review.commit());
  let detail: HTMLElement | undefined;
  let jumpFrame: number | undefined;
  const file = () => review.snapshot()?.files.find(file => file.path === review.selected());
  const loadedFile = () => { const selected = file(); return selected && hasPatch(selected) ? selected : undefined; };
  type Row = { kind: "line"; line: HighlightedLine } | { kind: "gap"; gap: ContextGap; header?: string };
  let previousRows = new Map<string, Row>(), previousFile = "";
  const diff = createMemo(() => {
    const selected = loadedFile(), view = selected ? context.view(selected) : { patch: "", gaps: [] };
    const highlighted = highlightDiff(selected?.path ?? "", view.patch);
    const gaps = new Map(view.gaps.map(gap => [gap.index, gap]));
    const rows: Row[] = [];
    for (let i = 0; i <= highlighted.lines.length; i++) {
      const gap = gaps.get(i), line = highlighted.lines[i];
      // The following hunk's range labels the gap; render it once beside its controls.
      if (gap) {
        const header = line?.kind === "header" && line.text.startsWith("@@") ? line.text : undefined;
        rows.push({ kind: "gap", gap, header });
        if (header) continue;
      }
      if (line) rows.push({ kind: "line", line });
    }
    const identity = JSON.stringify([selected?.path, selected?.fingerprint, review.target()]);
    if (identity !== previousFile) { previousRows.clear(); previousFile = identity; }
    const nextRows = new Map<string, Row>();
    const stable = rows.map((row, index) => {
      // Source coordinates retain mounted rows when surrounding context grows.
      const key = row.kind === "gap" ? `gap:${row.gap.id}` : JSON.stringify([row.line.kind, row.line.old, row.line.next, row.line.text, row.line.kind === "header" ? index : null]);
      const previous = previousRows.get(key);
      const value = previous && JSON.stringify(previous) === JSON.stringify(row) ? previous : row;
      nextRows.set(key, value); return value;
    });
    previousRows = nextRows;
    return { ...highlighted, rows: stable };
  });
  const [range, setRange] = createSignal<{ lines: HighlightedLine[]; anchor: number; end: number }>();
  const [extending, setExtending] = createSignal(false);
  const [dragging, setDragging] = createSignal(false);
  const [dismissedRange, setDismissedRange] = createSignal<ReturnType<typeof range>>();
  let drag: { pointerId: number; anchor: number; start: number; moved: boolean } | undefined;
  let suppressClick = false;
  const textLines = createMemo(() => diff().rows.flatMap(row => row.kind === "line" ? [row.line] : []));
  const lineIndices = createMemo(() => new Map(textLines().map((line, index) => [line, index])));
  const selection = () => {
    const value = range();
    return value?.lines === textLines() && !structural.result() && !review.busy() ? value : undefined;
  };
  const selectedLines = createMemo(() => {
    const value = selection();
    return value ? value.lines.slice(Math.min(value.anchor, value.end), Math.max(value.anchor, value.end) + 1).filter(line => line.kind !== "header") : [];
  });
  // A new line selection focuses questions on that excerpt; clearing it restores file scope.
  createEffect(() => selectedLines(), lines => {
    if (lines.length) setQuestionScope("selection");
    else if (questionScope() === "selection") setQuestionScope("file");
  });
  const isSelected = (line: HighlightedLine) => {
    const value = selection(), index = lineIndices().get(line)!;
    return Boolean(value && index >= Math.min(value.anchor, value.end) && index <= Math.max(value.anchor, value.end));
  };
  // Anchor in the row so the action follows document scrolling without layout measurements.
  const floatingLine = createMemo(() => {
    const value = selection();
    return value && !dragging() && value !== dismissedRange() ? value.lines[value.end] : undefined;
  });
  /** Retain the excerpt and focus; return focus to the gutter when dismissing its floating controls. */
  function dismissFloating(event: KeyboardEvent | MouseEvent) {
    if (("key" in event && event.key !== "Escape") || !floatingLine()) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.target;
    if (target instanceof Element && target.closest(".review-floating-actions")) {
      target.closest(".diff-line")?.querySelector<HTMLButtonElement>(".diff-select")?.focus({ preventScroll: true });
    }
    setDismissedRange(selection());
  }
  function clearSelection() { setRange(undefined); setExtending(false); setDragging(false); setDismissedRange(undefined); drag = undefined; }
  // Expanded context and refreshed snapshots must never reuse stale row coordinates.
  createEffect(() => [textLines(), structural.mode(), structural.result(), review.busy()], clearSelection);
  function selectLine(line: HighlightedLine, extend: boolean) {
    const index = lineIndices().get(line)!;
    setRange({ lines: textLines(), anchor: extend ? selection()?.anchor ?? index : index, end: index });
    setExtending(false);
  }
  function startDrag(event: PointerEvent & { currentTarget: HTMLButtonElement }, line: HighlightedLine) {
    suppressClick = false;
    if (event.pointerType !== "mouse" || event.button !== 0 || review.busy()) return;
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); setDragging(true);
    const index = lineIndices().get(line)!;
    drag = { pointerId: event.pointerId, anchor: event.shiftKey || extending() ? selection()?.anchor ?? index : index, start: index, moved: false };
  }
  function dragOver(event: PointerEvent, line: HighlightedLine) {
    if (!drag || drag.pointerId !== event.pointerId || event.buttons !== 1 || line.kind === "header") return;
    const index = lineIndices().get(line)!;
    if (index === drag.start && !drag.moved) return;
    drag.moved = true;
    setRange({ lines: textLines(), anchor: drag.anchor, end: index }); setExtending(false);
  }
  function finishDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressClick = drag.moved; drag = undefined; setDragging(false);
  }
  function cancelDrag(event: PointerEvent) {
    // Native touch scrolling cancels its pointer without cancelling a chosen range.
    if (drag && drag.pointerId === event.pointerId) clearSelection();
  }
  onSettled(() => {
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", cancelDrag);
    return () => { window.removeEventListener("pointerup", finishDrag); window.removeEventListener("pointercancel", cancelDrag); };
  });
  const structuralLines = createMemo(() => (structural.result()?.lines ?? []).map(line => line.segments.length <= 256 ? line : {
    ...line, segments: [{ text: line.segments.map(segment => segment.text).join(""), changed: false }],
  }));
  const fragmented = () => structural.result()?.lines.some(line => line.segments.length > 256);
  const counts = createMemo(() => ({ added: diff().lines.filter(line => line.kind === "add").length, removed: diff().lines.filter(line => line.kind === "remove").length }));
  const incremental = createMemo(() => { const selected = loadedFile(); return selected ? review.historyReview.comparison(selected) : undefined; });
  const evidenceMatches = (row: Row) => {
    const value = evidence(), selected = loadedFile();
    return !!value && value.path === selected?.path && value.fingerprint === selected.fingerprint && (row.kind === "line" ? value.keys.has(reviewLineKey(row.line)) : !!row.header && value.headers.has(row.header));
  };
  const evidenceFocus = createMemo(() => { const index = diff().rows.findIndex(evidenceMatches), token = evidence(); return index >= 0 && token ? { index, token } : undefined; });
  // The picker and Next share the group's supplied order, independently of text/review filters.
  const orderedFiles = createMemo(() => {
    const files = review.snapshot()?.files ?? [], byPath = new Map(files.map(file => [file.path, file]));
    const paths = activeGroup()?.paths ?? (review.grouping.mode() === "intent" ? review.grouping.value()?.flatMap(group => group.paths) : undefined);
    return paths ? paths.flatMap(path => byPath.has(path) ? [byPath.get(path)!] : []) : files;
  });
  const visibleFiles = createMemo(() => orderedFiles().filter(file => (!needsReview() || !review.isReviewed(file)) && file.path.toLowerCase().includes(filter().trim().toLowerCase())));
  const groups = createMemo(() => {
    const intents = review.grouping.value();
    if (review.grouping.mode() === "intent" && intents) {
      const visible = new Map(visibleFiles().map(file => [file.path, file]));
      return intents.map(group => ({ title: group.title, reason: group.reason, files: group.paths.flatMap(path => visible.has(path) ? [visible.get(path)!] : []) })).filter(group => group.files.length);
    }
    const groups = new Map<string, ReturnType<typeof visibleFiles>>();
    for (const file of visibleFiles()) {
      const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
      if (!groups.has(directory)) groups.set(directory, []);
      groups.get(directory)!.push(file);
    }
    return [...groups].map(([directory, files]) => ({ title: directory === "." ? "Repository root" : directory, reason: "", files }));
  });
  const nextUnreviewed = createMemo(() => {
    const files = orderedFiles();
    const index = files.findIndex(file => file.path === review.selected());
    return [...files.slice(index + 1), ...files.slice(0, index)].find(file => !review.isReviewed(file));
  });
  onSettled(() => {
    loadScope(review.scope());
    return () => {
      review.cancel();
      if (jumpFrame !== undefined) cancelAnimationFrame(jumpFrame);
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    };
  });
  /** Resume the selected scope without treating an unchosen base as an error. */
  function loadScope(scope: ReviewScope) {
    if (scope === "branch" && !review.base().trim()) review.cancel();
    else void review.refresh(scope);
    if (scope === "branch" && !review.branches.value()) void review.branches.refresh();
  }
  function changeScope(scope: ReviewScope) {
    setNotice(""); setFilter(""); setGroupKey(""); setEvidence(undefined); review.setScope(scope); loadScope(scope);
  }
  /** Apply a picked branch immediately. */
  function selectBase(value: string) {
    review.setBase(value); setNotice(""); setFilter(""); flush();
    void review.refresh("branch");
  }
  function selectCommit(id: string) { review.setCommit(id); setNotice(""); setFilter(""); void review.refresh("commit", id); }
  async function reloadCommits() {
    const list = await review.history.refresh();
    if (review.scope() === "commit" && !review.commit() && list?.commits[0]) selectCommit(list.commits[0].id);
  }
  /** Focus a group's picker and navigation on its first remaining file; clear conflicting filters. */
  function startGroup(paths: string[]) {
    review.grouping.setMode("intent"); setGroupKey(JSON.stringify(paths)); setFilter(""); setNeedsReview(false);
    const unreviewed = new Set((review.snapshot()?.files ?? []).filter(file => !review.isReviewed(file)).map(file => file.path));
    const first = paths.find(path => unreviewed.has(path)) ?? paths[0];
    if (first) select(first);
  }
  /** Jump after layout settles; the document's CSS respects reduced motion. */
  function jumpTo(target: () => HTMLElement | undefined) {
    if (jumpFrame !== undefined) cancelAnimationFrame(jumpFrame);
    jumpFrame = requestAnimationFrame(() => {
      jumpFrame = undefined; const element = target();
      element?.focus({ preventScroll: true }); element?.scrollIntoView({ block: "start", behavior: "auto" });
    });
  }
  function select(path: string) {
    setEvidence(undefined); setView("files"); review.setSelected(path); setNotice(""); setFilesOpen(false); jumpTo(() => detail);
  }
  /** Verify the captured fingerprint before navigating to supplied evidence, including paginated rows. */
  async function openEvidence(citation: EvidenceCitation, captured: ExplanationEvidence) {
    if (review.busy()) return;
    setEvidence(undefined); setGroupKey(""); setFilter(""); setNeedsReview(false); setView("files"); setFilesOpen(false); setNotice(""); structural.reset();
    await review.setSelected(citation.path);
    const selected = loadedFile();
    if (!selected || selected.path !== citation.path || selected.fingerprint !== captured.fingerprint) { setNotice("This evidence no longer matches the loaded diff. Refresh and explain the group again."); return; }
    const rows = captured.rows.slice(citation.startLine - 1, citation.endLine);
    setEvidence({ path: citation.path, fingerprint: captured.fingerprint, keys: new Set(rows.map(reviewLineKey)), headers: new Set(rows.filter(row => row.kind === "header").map(row => row.text)) });
    jumpTo(() => detail?.querySelector<HTMLElement>("[data-review-evidence]") ?? detail);
  }
  /** Shared searchable file list for the desktop sidebar and mobile modal. */
  function FilePicker() {
    return <nav id={`review-files-${props.model.id}`} class="review-files" tabindex={-1} aria-label="Changed files">
            <Show when={review.grouping.mode() === "intent" && review.grouping.value()}>
              <SelectField class="review-group-picker" label="Review group" visibleLabel value={activeGroup() ? String(review.grouping.value()!.indexOf(activeGroup()!)) : ""} options={[{ value: "", label: "All groups" }, ...(review.grouping.value() ?? []).map((group, index) => ({ value: String(index), label: `${group.title} (${group.paths.length})` }))]} change={key => { const group = key === "" ? undefined : review.grouping.value()?.[Number(key)]; if (group) startGroup(group.paths); else setGroupKey(""); }} />
              <Show when={activeGroup()}><Button type="button" onClick={() => { setGroupKey(""); setFilter(""); setNeedsReview(false); }}>Show all files</Button></Show>
            </Show>
            <div class="review-filter"><TextField value={filter()} onChange={value => { setFilter(value); flush(); }}><TextField.Input type="search" aria-label="Filter files" placeholder="Filter files…" /></TextField><Show when={filter()}><Button type="button" onClick={() => setFilter("")} aria-label="Clear filter">×</Button></Show></div>
            <div class="review-needs-filter" role="group" aria-label="Filter by review status">
        <Button type="button" aria-pressed={!needsReview() ? "true" : "false"} onClick={() => setNeedsReview(false)}>All files</Button>
        <Button type="button" aria-pressed={needsReview() ? "true" : "false"} onClick={() => setNeedsReview(true)}>Unreviewed</Button>
      </div>
            <Show when={needsReview()}><p class="review-group-status">Unloaded files stay visible until their fingerprints are checked.</p></Show>
            <Show when={visibleFiles().length} fallback={<p class="review-filter-empty">No files match your filter.</p>}>
              <For each={groups()}>{group => <section>
                <div class="review-group-heading"><h3>{group.title}</h3><span title="Reviewed / visible files in this group">{group.files.filter(review.isReviewed).length}/{group.files.length}</span></div>
                <Show when={group.reason}><p class="review-group-reason">{group.reason}</p></Show>
                <For each={group.files}>{item => <Button type="button" aria-label={`${item.path} — ${item.status}${item.lineStats ? ` — ${item.lineStats.added} added, ${item.lineStats.removed} deleted` : ""}${review.isReviewed(item) ? " — reviewed" : ""}`} aria-pressed={review.selected() === item.path ? "true" : "false"} onClick={() => select(item.path)} title={item.path}>
                  <span class={`review-file-status status-${item.status}`} aria-hidden="true">{review.isReviewed(item) ? "✓" : item.status === "untracked" ? "?" : item.status[0].toUpperCase()}</span>
                  <span class="review-file-name">{review.grouping.mode() === "intent" ? item.path : item.path.slice(item.path.lastIndexOf("/") + 1)}</span>
                  <Show when={item.lineStats}>{stats => <span class="review-file-counts" aria-hidden="true"><span class="review-added">+{stats().added}</span><span class="review-removed">−{stats().removed}</span></span>}</Show>
                </Button>}</For>
              </section>}</For>
            </Show>
          </nav>;
  }
  function compareStructure() {
    const selected = loadedFile(), target = review.target();
    if (selected && target && !review.busy()) void structural.show({ ...target, path: selected.path, fingerprint: selected.fingerprint });
  }
  function expandContext(id: number, direction: "above" | "below") {
    const selected = loadedFile(), target = review.target();
    if (selected && target && !review.busy()) void context.expand(selected, target, id, direction);
  }
  // Reply quotes precede the draft at submission, so they require a plain question rather than a skill command.
  const questionCommands = () => props.model.quote() ? [] : props.model.state.commands;
  function ask(onlySelection = false, question?: ReviewQuestion) {
    const selected = loadedFile(), target = review.target();
    if (!selected || !target || (onlySelection && !selectedLines().length)) return;
    try {
      const draft = reviewDraft(props.model.draft(), selected, target, onlySelection ? selectedLines() : undefined, question, questionCommands());
      if (new TextEncoder().encode(formatReply(draft, props.model.quote())).length > 32768) throw new Error("This patch, quote and your draft exceed the message limit. Select fewer lines or shorten your draft or quote.");
      props.model.setDraft(draft); props.conversation();
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not add review context."); }
  }
  /** Prepare a question for the complete snapshot, regardless of file filters or selection. */
  function askOverall(question: ReviewQuestion) {
    const snapshot = review.snapshot(), target = review.target();
    if (!snapshot || !target || review.busy()) return;
    try {
      const draft = reviewScopeDraft(props.model.draft(), snapshot, target, question, questionCommands());
      if (new TextEncoder().encode(formatReply(draft, props.model.quote())).length > 32768) throw new Error("This review context, quote and your draft exceed the message limit. Shorten your draft or quote.");
      props.model.setDraft(draft); props.conversation();
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not add review context."); }
  }
  /** Question cards state their target and prepare editable drafts without sending messages. */
  function QuestionPanel() {
    return <section id={`review-questions-${props.model.id}`} class="review-questions" aria-label="Ask">
      <div class="review-questions-heading"><strong><Icon name="chat" />Ask</strong><span class="review-question-scope">{questionScope() === "all" ? `${review.snapshot()?.files.length ?? 0} files · ${review.target()?.scope ?? ""} scope` : questionScope() === "selection" ? `${selectedLines().length} selected ${selectedLines().length === 1 ? "line" : "lines"} · ${file()?.path ?? ""}` : `Whole file · ${file()?.path ?? "No file selected"}`}</span></div>
      <div class="review-question-scopes review-engines" role="group" aria-label="Question scope">
        <Button type="button" aria-pressed={questionScope() === "all" ? "true" : "false"} onClick={() => setQuestionScope("all")}>All changes</Button>
        <Button type="button" aria-pressed={questionScope() === "file" ? "true" : "false"} disabled={!loadedFile()} onClick={() => setQuestionScope("file")}>This file</Button>
        <Button type="button" aria-pressed={questionScope() === "selection" ? "true" : "false"} disabled={!loadedFile() || !selectedLines().length} onClick={() => setQuestionScope("selection")}>Selected lines</Button>
      </div>
      <p class="review-question-intro">Choose a starting point. You can edit the question in chat before sending.</p>
      <p class="review-question-context">{questionScope() === "all" ? "Includes the file list and comparison scope, not patches. Pi will inspect the diffs when you send." : questionScope() === "selection" ? "Only the selected lines will be included." : loadedFile() ? "The current file’s diff will be included. Select lines to ask a more focused question." : "Choose a file with an available diff, or ask about all changes."}</p>
      <div class="review-question-buttons"><For each={reviewQuestionPresets}>{preset => {
        const skill = () => reviewQuestionSkill(preset.question, questionCommands(), props.model.draft());
        return <Button type="button" aria-label={preset.label} title={skill() ? `Use /${skill()} — prepares a review-only draft` : "Prepare a review-only question without adding a skill command"} disabled={review.busy() || (questionScope() !== "all" && !loadedFile()) || (questionScope() === "selection" && !selectedLines().length)} onClick={() => questionScope() === "all" ? askOverall(preset.question) : ask(questionScope() === "selection", preset.question)}><span class="review-question-label">{preset.label}<span aria-hidden="true">↗</span></span><span class="review-question-description">{preset.description}</span></Button>;
      }}</For></div>
      <p class="review-question-note">Nothing is sent automatically. Your existing draft is kept.</p>
      <Show when={props.model.quote()}><p class="review-question-note">Your chat quote is kept; questions use plain prompts instead of skill commands.</p></Show>
      <Show when={props.model.draft().trimStart().startsWith("/")}><p class="review-question-note">Your existing slash command will be kept; no skill command is added.</p></Show>
    </section>;
  }
  return <section class="local-review" aria-label="Local changes" aria-busy={review.busy() ? "true" : "false"}>
    <form class="review-toolbar" onSubmit={event => { event.preventDefault(); setNotice(""); void review.refresh(); }}>
      <div class="review-scopes" role="group" aria-label="Change scope">
        <For each={[["unstaged", "Unstaged"], ["staged", "Staged"], ["branch", "Branch"], ["commit", "Commit"]] as const}>{([scope, label]) =>
          <Button type="button" aria-pressed={review.scope() === scope ? "true" : "false"} title={scopeHelp[scope]} onClick={() => changeScope(scope)}>{label}</Button>
        }</For>
      </div>
      <Show when={review.scope() === "branch"}>
        <SelectField class="review-base" label="Compare against" value={review.base()} change={selectBase}
          placeholder={review.branches.busy() ? "Loading branches…" : "Choose a base branch"}
          search={{ value: review.branches.query(), change: value => { void review.branches.refresh(value); flush(); }, label: "Find a branch", placeholder: "Search local or remote branches", empty: matchingBranches().length ? undefined : review.branches.busy() ? "Searching branches…" : review.branches.query().trim() && !review.branches.error() ? "No matching branches." : undefined }}
          options={[
            ...(review.base() && !matchingBranches().some(branch => branch.ref === review.base()) ? [{ value: review.base(), label: `Selected: ${review.base()}` }] : []),
            ...matchingBranches().map(branch => ({ value: branch.ref, label: `${branch.name} · ${branch.kind === "local" ? "Local" : "Remote (stored locally)"}` })),
          ]} />
        <Button type="button" disabled={review.branches.busy()} onClick={() => void review.branches.refresh()}>Reload branches</Button>
      </Show>
      <Show when={review.scope() === "commit"}>
        <SelectField class="review-commit" label="Commit" value={review.commit()} change={selectCommit} disabled={review.history.busy()}
          placeholder={review.history.busy() ? "Loading commits…" : "Choose a commit"}
          search={{ value: commitQuery(), change: value => { setCommitQuery(value); flush(); }, label: "Find a commit", placeholder: "Search message or hash", empty: commitQuery().trim() && !matchingCommits().length ? "No matching commits." : undefined }}
          options={[
            ...(review.commit() && !matchingCommits().some(commit => commit.id === review.commit()) ? [{ value: review.commit(), label: `Selected: ${selectedCommit()?.subject || review.commit().slice(0, 10)}` }] : []),
            ...matchingCommits().map(commit => ({ value: commit.id, label: `${commit.subject || "(no subject)"} · ${commit.id.slice(0, 10)}` })),
          ]} />
        <Button type="button" disabled={review.busy() || review.history.busy()} onClick={() => void reloadCommits()}>Reload commits</Button>
      </Show>
      <Button class={review.scope() === "branch" ? "review-refresh" : "review-refresh review-refresh-icon"} type="submit" aria-label={review.busy() ? "Loading…" : review.scope() === "branch" ? "Compare" : "Refresh"} title={review.busy() ? "Loading…" : review.scope() === "branch" ? "Compare" : "Refresh"} disabled={review.busy() || (review.scope() === "branch" && !review.base().trim())}><Show when={review.scope() === "branch"} fallback={<Icon name="refresh" />}>{review.busy() ? "Loading…" : "Compare"}</Show></Button>
      <span class="review-readonly">Read-only</span>
    </form>
    <Show when={review.scope() === "branch"}>
      <Show when={review.snapshot() && (review.target()?.scope !== "branch" || review.target()?.base !== review.base().trim())}><p class="review-help" role="status">Comparison not applied. The files below still show the previous snapshot.</p></Show>
      <Show when={review.branches.error()}><p class="review-warning" role="alert">{review.branches.error()} Reload branches to try again.</p></Show>
      <Show when={review.branches.value()?.truncated}><p class="review-help">Some branches are omitted (up to 100 shown). Search to narrow the list.</p></Show>
      <Show when={review.branches.value()?.branches.length === 0 && !review.branches.query().trim() && !review.branches.busy()}><p class="review-help">No local or stored remote branches found.</p></Show>
    </Show>
    <Show when={review.scope() === "commit"}>
      <Show when={review.history.error()}><p class="review-warning" role="alert">{review.history.error()}</p></Show>
      <Show when={review.history.value()?.truncated}><p class="review-help">Showing the 100 most recent commits.</p></Show>
      <Show when={review.history.value()?.commits.length === 0 && !review.history.busy()}><p class="review-empty" role="status">No commits in local HEAD history. Reload commits after creating a commit.</p></Show>
    </Show>
    <Show when={review.error()}><p class="review-warning" role="alert">{review.error()}<Show when={review.snapshot()}> Showing the previous snapshot.</Show></p></Show>
    <Show when={notice()}><p class="review-warning" role="alert">{notice()}</p></Show>
    <Show when={review.grouping.error()}><p class="review-warning" role="alert">{review.grouping.error()} Folder grouping remains available.</p></Show>
    <Show when={review.busy() && !review.snapshot()}><p class="review-empty" role="status">Loading local changes…</p></Show>
    <Show when={review.snapshot()}>{snapshot => <>
      <div class="review-summary" role="status">
        <span class="review-progress"><Show when={snapshot().files.length}><ProgressBar label="Review progress" max={snapshot().files.length} value={snapshot().files.filter(review.isReviewed).length} /></Show><span>{snapshot().files.filter(review.isReviewed).length} / {snapshot().files.length} files reviewed</span></span>
        <Show when={snapshot().lineStats} fallback={<span>Line totals unavailable</span>}>{stats => <span class="review-line-stats" role="group" aria-label="Line changes" title="Totals for this scope, including files omitted by display limits. Refresh after edits.">
          <span class="review-added">+{stats().added.toLocaleString()} added</span>
          <span class="review-removed">−{stats().removed.toLocaleString()} deleted</span>
        </span>}</Show>
      </div>
      <Show when={snapshot().truncated}><p class="review-warning">{snapshot().note ?? "Some changes were omitted by review limits."}</p></Show>
      <Show when={snapshot().files.length} fallback={<p class="review-empty">No changes in this scope.</p>}>
        <div class="review-view-toolbar">
          <div class="review-view-switch" role="group" aria-label="Review view">
            <Button type="button" aria-pressed={view() === "overview" ? "true" : "false"} onClick={() => setView("overview")}><Icon name="structure" />Overview</Button>
            <Button type="button" aria-pressed={view() === "files" ? "true" : "false"} onClick={() => setView("files")}><Icon name="folder" />Files</Button>
          </div>
          <div class="review-view-actions">
            <Button type="button" class="review-icon-action" aria-expanded={questionsOpen() ? "true" : "false"} aria-controls={`review-questions-${props.model.id}`} onClick={() => { if (!questionsOpen() && view() === "overview" && questionScope() === "file") setQuestionScope("all"); setQuestionsOpen(!questionsOpen()); }}><Icon name="chat" />Ask<Icon name="chevronDown" /></Button>
            <Button class="review-group-action" type="button" disabled={review.busy() || review.grouping.busy()} onClick={() => void review.groupWithAI()}>{review.grouping.busy() ? "Grouping…" : review.grouping.stale() ? "Update groups with AI" : review.grouping.value() ? "Check saved groups" : "Group with AI"}</Button>
          </div>
        </div>
        <Show when={questionsOpen()}><QuestionPanel /></Show>
        <Show when={review.grouping.value() || review.grouping.busy() || review.grouping.usage().calls || review.grouping.usage().reused || review.grouping.progress() || review.grouping.notice()}>
        <section class="review-organize" aria-label="Organize changed files">
          <div class="review-organize-heading">
            <div class="review-group-controls">
              <Show when={review.grouping.value()}><div class="review-engines" role="group" aria-label="File grouping">
                <Button type="button" aria-pressed={review.grouping.mode() === "folders" ? "true" : "false"} onClick={() => review.grouping.setMode("folders")}>Folders</Button>
                <Button type="button" aria-pressed={review.grouping.mode() === "intent" ? "true" : "false"} onClick={() => review.grouping.setMode("intent")}>By purpose</Button>
              </div></Show>
              <Show when={review.grouping.value()}><Button type="button" title="Ignore the saved result and make a new AI request" disabled={review.busy() || review.grouping.busy()} onClick={() => void review.groupWithAI(true)}>Regenerate groups</Button></Show>
              <Show when={review.grouping.busy()}><Button type="button" onClick={review.grouping.cancel}>Cancel grouping</Button></Show>
            </div>
          </div>
          <Show when={review.grouping.usage().calls || review.grouping.usage().reused}>
            <p class="review-group-status" aria-label="Grouping usage">{groupingUsageLabel(review.grouping.usage())}</p>
          </Show>
          <div role="status" aria-live="polite"><Show when={review.grouping.progress() || review.grouping.notice()}><p class="review-group-status">{review.grouping.progress() || review.grouping.notice()}</p></Show></div>
        </section>
        </Show>
        <Show when={view() === "overview"}>
          <ReviewOverview files={snapshot().files} groups={review.grouping.value()} explanations={review.explanations} openEvidence={openEvidence} explanationDisabled={review.busy() || review.grouping.busy() || review.grouping.stale()} reviewed={review.isReviewed} open={path => { setGroupKey(""); setFilter(""); setNeedsReview(false); select(path); }} startGroup={startGroup} />
        </Show>
        <Show when={view() === "files"}>
        <div class="review-layout">
          <Show when={!filesOpen()} fallback={
            <ActionDialog title="Changed files" description="Choose a file to review." class="review-files-modal" hideHeading close={() => setFilesOpen(false)}>
              <div class="review-picker-header"><h2 aria-hidden="true">Changed files</h2><Button type="button" aria-label="Close file picker" onClick={() => setFilesOpen(false)}>Close</Button></div>
              <FilePicker />
            </ActionDialog>
          }><div class="review-desktop-files"><FilePicker /></div></Show>
          <Show when={file()}>{selected => <article ref={detail} class="review-detail" tabindex={-1} aria-label={`Diff for ${selected().path}`}>
            <header class="review-file-header">
              <div class="review-file-title"><div class="review-file-heading"><h2 aria-label={selected().path} title={selected().path}><span class="review-path-directory">{selected().path.slice(0, selected().path.lastIndexOf("/") + 1)}</span><span class="review-path-basename">{selected().path.slice(selected().path.lastIndexOf("/") + 1)}</span></h2><Checkbox disabled={!loadedFile() || review.busy()} class="review-reviewed" title={review.isReviewed(selected()) ? "Mark file as unreviewed" : "Mark file as reviewed"} checked={review.isReviewed(selected())} onChange={checked => review.mark(selected(), checked)}>
                  <Checkbox.Input /><Checkbox.Control class="checkbox-control"><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control><Checkbox.Label class="review-action-label">Reviewed</Checkbox.Label>
                </Checkbox></div><Show when={selected().previousPath}><p>Renamed from {selected().previousPath}</p></Show>
                <div class="review-file-meta"><span>{selected().status}</span><span title="Syntax colors use available hunk context">{diff().label}</span><Show when={counts().added || counts().removed}><span class="review-added" aria-label={`${counts().added} added lines`}>+{counts().added}</span><span class="review-removed" aria-label={`${counts().removed} removed lines`}>−{counts().removed}</span></Show></div>
              </div>
              <div class="review-file-actions">
                <div class="review-engines" role="group" aria-label="Diff mode">
                  <Button class="review-icon-action" type="button" title="Text diff — compare changed lines" aria-pressed={structural.mode() === "text" ? "true" : "false"} onClick={structural.reset}><Icon name="code" /><span class="review-action-label">Text</span></Button>
                  <Button class="review-icon-action" type="button" aria-pressed={structural.mode() === "structural" ? "true" : "false"} disabled={!loadedFile() || review.busy() || structural.busy()} title="Structural diff — compare syntax. Requires Difftastic 0.72.0." onClick={compareStructure}><Icon name="structure" /><span class="review-action-label">Structural</span></Button>
                </div>
                <Button class="review-files-toggle review-icon-action" type="button" aria-expanded={filesOpen() ? "true" : "false"} aria-controls={`review-files-${props.model.id}`} aria-haspopup="dialog" title={`Choose file (${snapshot().files.length} changed)`} onClick={() => setFilesOpen(true)}><Icon name="folder" /><span class="review-action-label">Files ({snapshot().files.length})</span></Button>
                <Button class="review-icon-action" type="button" title="Next unreviewed" aria-label="Next unreviewed" disabled={!nextUnreviewed()} onClick={() => { const next = nextUnreviewed(); if (next) { setFilter(""); select(next.path); } }}><Icon name="next" /><span class="review-action-label">Next</span></Button>
                <Button class="review-ask review-icon-action" type="button" disabled={!loadedFile() || review.busy()} aria-label="Ask Pi about file" title="Ask Pi about file — add this diff to your draft. Nothing is sent automatically." onClick={() => ask()}><Icon name="chat" /><span class="review-action-label">Ask Pi</span></Button>
              </div>
            </header>
            <Show when={loadedFile() && review.historyReview.status(selected()) === "changed"}><section class="review-since" aria-label="Changes since last review">
              <strong>Changed since you marked this file reviewed</strong>
              <Show when={incremental()} fallback={<p>The earlier diff is no longer retained. Review the full current diff.</p>}>{changes => <>
                <p>{changes().changed.size ? "Highlighted rows differ within the edited region. Unchanged edges are not emphasized." : "No changed source rows in the captured patch; metadata or coordinates may have changed."} This is a conservative comparison with your last manual mark, not a new Git diff.</p>
                <Show when={structural.result()}><p>Switch to Text to see incremental highlights.</p></Show>
                <Show when={changes().previous.length}><Collapsible><Collapsible.Trigger>Previously reviewed rows replaced or removed</Collapsible.Trigger><Collapsible.Content><pre>{changes().previous.join("\n")}</pre><Show when={changes().limited}><p>Earlier rows truncated to 200.</p></Show></Collapsible.Content></Collapsible></Show>
              </>}</Show>
            </section></Show>
            <Show when={review.patchBusy()}><p class="review-empty" role="status">Loading patch…</p></Show>
            <Show when={review.patchError()}><p class="review-warning" role="alert">{review.patchError()} <Button type="button" onClick={() => void review.loadPatch()}>Retry patch</Button></p></Show>
            <Show when={loadedFile()}>
            <Show when={structural.busy()}><p class="review-structural-note" role="status">Comparing syntax… Text diff remains available.</p></Show>
            <Show when={structural.reason()}><p class="review-warning" role="status">{structural.reason()} Showing text diff.</p></Show>
            <Show when={!structural.result() && context.error()}><p class="review-warning" role="alert">{context.error()}</p></Show>
            <Show when={structural.result()} fallback={<div class="review-diff" tabindex={0} role="region" aria-label="Unified diff" aria-busy={context.busy() ? "true" : "false"} onKeyDown={dismissFloating}>
              <ReviewRows rows={diff().rows} focus={evidenceFocus()} identity={`${review.target()?.scope}:${selected().path}:${selected().fingerprint}`} jump={() => jumpTo(() => detail)}>{row => row.kind === "gap" ? <div class={`diff-line diff-hunk review-context${evidenceMatches(row) ? " diff-evidence" : ""}`} data-review-evidence={evidenceMatches(row) ? "true" : undefined} tabindex={evidenceMatches(row) ? -1 : undefined}>
                <div class="review-context-gutter">
                  <For each={(["below", "above"] as const).filter(direction => row.gap[direction])}>{direction => <Button type="button" class={`review-expand review-expand-${direction}`} aria-label={`Expand ${Math.min(20, row.gap.remaining ?? 20)} lines ${direction}`} title={`Expand ${Math.min(20, row.gap.remaining ?? 20)} lines ${direction}`} disabled={context.busy() || review.busy()} onClick={() => expandContext(row.gap.id, direction)}>
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 2h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray=".1 3" /><path d="M7 5h2v5h3l-4 4-4-4h3z" fill="currentColor" /></svg>
                  </Button>}</For>
                </div>
                <Show when={row.header} fallback={<span class="review-context-label">More context</span>}>{header => <code>{header()}</code>}</Show>
              </div> : <div class={`diff-line diff-${row.line.kind}${row.line.kind === "header" && row.line.text.startsWith("@@") ? " diff-hunk" : ""}${row.line.kind !== "header" && isSelected(row.line) ? " diff-selected" : ""}${incremental()?.changed.has(reviewLineKey(row.line)) ? " diff-since-review" : ""}${evidenceMatches(row) ? " diff-evidence" : ""}`} data-review-evidence={evidenceMatches(row) ? "true" : undefined} tabindex={evidenceMatches(row) ? -1 : undefined} onPointerEnter={event => dragOver(event, row.line)}>
                <Show when={row.line.kind !== "header"} fallback={<><span class="diff-number" /><span class="diff-number" /></>}>
                  <Button type="button" class="diff-select" disabled={review.busy()} title={extending() ? "Choose the end of your selection" : "Select a line; drag or Shift-click for a range"} aria-label={`Select ${[row.line.old !== undefined ? `old line ${row.line.old}` : "", row.line.next !== undefined ? `new line ${row.line.next}` : ""].filter(Boolean).join(", ")}`} aria-pressed={isSelected(row.line) ? "true" : "false"}
                    onPointerDown={event => startDrag(event, row.line)} onClick={event => { if (!suppressClick || event.detail === 0) selectLine(row.line, event.shiftKey || extending()); suppressClick = false; }}>
                    <span class="diff-number" aria-hidden="true">{row.line.old ?? ""}</span><span class="diff-number" aria-hidden="true">{row.line.next ?? ""}</span>
                  </Button>
                </Show><code><Show when={row.line.tokens} fallback={(row.line.kind === "header" ? row.line.text : row.line.text.slice(1)) || " "}>{tokens => <For each={tokens()} fallback={" "}>{token => <span class={token.className}>{token.text}</span>}</For>}</Show></code>
                <Show when={floatingLine() === row.line}><div class="review-floating-actions" role="group" aria-label="Selected lines actions">
                  <Button class="review-floating-ask" type="button" aria-label="Ask Pi about selected lines" title="Add selected lines to your draft." onClick={() => ask(true)}><Icon name="reply" />Ask Pi <span aria-hidden="true">· {selectedLines().length} {selectedLines().length === 1 ? "line" : "lines"}</span></Button>
                  <DropdownMenu placement="bottom-end" modal={false}><DropdownMenu.Trigger aria-label="Focused questions" title="Prepare a question about these lines; nothing is sent">Questions</DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content class="session-menu review-question-menu">
                    <For each={[["explain", "Explain this"], ["risks", "What could break?"], ["edges", "Check edge cases"], ["compare", "Compare with existing code"]] as const}>{([question, label]) => <DropdownMenu.Item onSelect={() => ask(true, question)}>{label}</DropdownMenu.Item>}</For>
                  </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu>
                  <Button type="button" aria-pressed={extending() ? "true" : "false"} onClick={() => setExtending(!extending())}>Choose end line</Button>
                  <Button type="button" onClick={clearSelection}>Clear selection</Button>
                  <Button class="review-floating-dismiss" type="button" aria-label="Dismiss selection actions" title="Dismiss (Escape)" onClick={dismissFloating}><Icon name="close" /></Button>
                </div></Show>
              </div>}</ReviewRows>
            </div>}>{comparison => <>
              <p class="review-structural-note">{comparison().engine} · {comparison().language}</p>
              <Show when={fragmented()}><p class="review-structural-note">Very fragmented lines are shown without syntax emphasis to keep rendering responsive.</p></Show>
              <div class="review-diff" tabindex={0} role="region" aria-label="Structural diff">
                <Show when={comparison().lines.length} fallback={<p class="review-empty">No structural changes detected. Check Text mode for formatting or metadata changes.</p>}>
                  <ReviewRows rows={structuralLines()} weight={line => line.segments.length + 3} identity={`${review.target()?.scope}:${selected().path}:${selected().fingerprint}:structural`} jump={() => jumpTo(() => detail)}>{line => <div class={`diff-line diff-${line.kind}`}><span class="diff-number" aria-hidden="true">{line.old ?? ""}</span><span class="diff-number" aria-hidden="true">{line.next ?? ""}</span><code><For each={line.segments}>{segment => <span class={segment.changed ? "structural-change" : undefined}>{segment.text}</span>}</For></code></div>}</ReviewRows>
                </Show>
              </div>
            </>}</Show>
            </Show>
          </article>}</Show>
        </div>
        </Show>
      </Show>
    </>}</Show>
  </section>;
}
