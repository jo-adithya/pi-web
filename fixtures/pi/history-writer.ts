/** Test-only Pi-owned transcript mutation, loaded explicitly into disposable M0 sessions. */
export default function historyWriter(pi: {
  registerCommand(name: string, command: {
    description: string;
    handler(): Promise<void>;
  }): void;
  sendMessage(message: { customType: string; content: string; display: boolean }, options: { triggerTurn: boolean }): void;
  on(event: "session_start", handler: () => void): void;
  appendEntry(customType: string, data: Record<string, string>): void;
}): void {
  pi.on("session_start", () => {
    pi.appendEntry("pi-web-test-startup", { marker: "STARTUP_CONTROL" });
  });
  pi.registerCommand("pi-web-test-append", {
    description: "Append a visible fixture through Pi without invoking a model",
    handler: async () => {
      pi.sendMessage({ customType: "pi-web-test", content: "LATE_VISIBLE", display: true }, { triggerTurn: false });
    },
  });
}
