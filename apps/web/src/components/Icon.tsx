const paths = {
  panel: "M9 3v18M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z",
  plus: "M12 5v14M5 12h14",
  folder: "M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z",
  close: "m6 6 12 12M6 18 18 6",
  image: "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM3 16l5-5 5 5 3-3 5 5M16 7h.01",
  expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  reply: "m9 14-5-5 5-5M4 9h10a6 6 0 0 1 6 6v5",
  chevronDown: "m6 9 6 6 6-6",
  next: "m5 5 7 7-7 7m7-14 7 7-7 7",
  refresh: "M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 17.9 17",
  code: "m8 5-6 7 6 7m8-14 6 7-6 7",
  structure: "M9 3h6v5H9ZM3 16h6v5H3Zm12 0h6v5h-6ZM12 8v4M6 16v-4h12v4",
  stop: "M6 6h12v12H6Z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
} as const;

/** Decorative stroke icons; the containing control supplies its accessible name. */
export function Icon(props: { name: keyof typeof paths }) {
  return <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[props.name]} /></svg>;
}
