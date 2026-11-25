import { Show, createMemo } from "solid-js";
import highlight from "../syntax";
import { CopyButton } from "./CopyButton";
import { ReviewCode } from "./ReviewDiffCard";
import { diffLines } from "../local-review";

/** Displays literal source with exact copying. Known short snippets use the shared
 * highlighter; large snippets and unknown languages remain complete plain text. */
export function CodeSnippet(props: { title: string; code: string; language?: string; snippetDiff?: boolean }) {
  const language = () => props.language?.trim() || "Plain text";
  const rows = createMemo(() => props.snippetDiff ? diffLines(`@@ -1 +1 @@\n${props.code}`).slice(1) : []);
  const markup = createMemo(() => {
    // Match Markdown's highlighting budget without truncating displayed or copied source.
    if (props.code.length > 8192 || !highlight.getLanguage(language())) return undefined;
    return highlight.highlight(props.code, { language: language(), ignoreIllegals: true }).value.replace(/\r/g, "&#13;");
  });
  return <div class="markdown code-snippet"><div class="code-block">
    <div class="code-snippet-header"><span>{props.snippetDiff ? "Before / after · snippet line numbers" : language()}</span><CopyButton label="Copy code" text={() => props.code} /></div>
    <Show when={props.snippetDiff} fallback={<pre tabindex={0} role="region" aria-label={`Code snippet: ${props.title}`}><Show when={markup()} fallback={<code>{props.code}</code>}>
      {html => <code innerHTML={html()} />}
    </Show></pre>}>
      <div class="snippet-diff"><ReviewCode path="" label={`Snippet diff: ${props.title}`} lines={rows()} /></div>
    </Show>
  </div></div>;
}
