/** Side-effect-free standard-dialog fixture; no tools, files or provider requests. */
interface DialogUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder: string): Promise<string | undefined>;
  editor(title: string, prefill: string): Promise<string | undefined>;
  notify(message: string, level: "info"): void;
}

/** Register one command whose validated argument chooses a harmless standard dialog. */
export default function dialogs(pi: {
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, ctx: { ui: DialogUi }): Promise<void>;
  }): void;
}): void {
  pi.registerCommand("pi-web-test-dialog", {
    description: "Exercise a standard RPC dialog without other side effects",
    handler: async (method, ctx) => {
      let value: string | boolean | undefined;
      switch (method) {
        case "select": value = await ctx.ui.select("Fixture choice", ["First", "Second"]); break;
        case "confirm": value = await ctx.ui.confirm("Fixture confirmation", "No action will be taken"); break;
        case "input": value = await ctx.ui.input("Fixture input", "Text"); break;
        case "editor": value = await ctx.ui.editor("Fixture editor", "Before"); break;
        default: throw new Error("Unknown fixture dialog");
      }
      ctx.ui.notify("pi-web:test-dialog:" + JSON.stringify({ method, value: value ?? null }), "info");
    },
  });
}
