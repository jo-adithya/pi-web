import { createMemo, createSignal, For, Show, type Element } from "solid-js";

const PAGE_SIZE = 500;

/** Bounds mounted diff rows without introducing a nested scroller or estimated row heights.
 * Pagination is explicit so wrapped lines and keyboard navigation retain natural document flow.
 */
export function ReviewRows<T>(props: { rows: T[]; identity: string; jump: () => void; weight?: (row: T) => number; children: (row: T) => Element }) {
  const [selection, setSelection] = createSignal({ identity: "", page: 0 });
  const ranges = createMemo(() => {
    const result: { start: number; end: number }[] = [];
    let start = 0, weight = 0;
    props.rows.forEach((row, index) => {
      const cost = props.weight?.(row) ?? 1;
      if (index > start && (index - start >= PAGE_SIZE || weight + cost > 4000)) {
        result.push({ start, end: index }); start = index; weight = 0;
      }
      weight += cost;
    });
    result.push({ start, end: props.rows.length }); return result;
  });
  const pages = () => ranges().length;
  const page = () => selection().identity === props.identity ? Math.min(selection().page, pages() - 1) : 0;
  const range = () => ranges()[page()];
  const visible = createMemo(() => props.rows.slice(range().start, range().end));
  const move = (delta: number) => { setSelection({ identity: props.identity, page: page() + delta }); props.jump(); };
  const controls = () => <Show when={pages() > 1}><div class="review-pages" role="group" aria-label="Diff pages">
    <button type="button" disabled={page() === 0} onClick={() => move(-1)}>Previous rows</button>
    <span>Rows {range().start + 1}–{range().end} of {props.rows.length}</span>
    <button type="button" disabled={page() + 1 >= pages()} onClick={() => move(1)}>Next rows</button>
  </div></Show>;
  return <>{controls()}<For each={visible()}>{props.children}</For>{controls()}</>;
}
