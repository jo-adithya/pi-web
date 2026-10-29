import { afterEach, expect, it, vi } from "vitest";
import { cleanup, screen, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { SessionView } from "../src/SessionView";
import { flush } from "solid-js";
import { createSessionModel } from "../src/session-model";
import { initialState, decodeServer } from "../src/client-state";
import { MessageList } from "../src/Conversation";
import * as images from "../src/images";
import type { BrowserMessage, ServerBody, ServerMessage } from "../src/generated/protocol";
const id = "a".repeat(64);
const frame = (body: ServerBody): ServerMessage => ({ v: 1, sessionId: "session", epoch: "epoch", body });
function setup() {
  const sent: BrowserMessage[] = [];
  const model = createSessionModel("session", message => { sent.push(message); return true; }, () => true, undefined, () => "b".repeat(64));
  model.receive(frame({ type: "hello", project: "fixture", process: "ready" }));
  model.receive(frame({ type: "snapshot", throughSeq: 0, messages: [], dialogs: [], olderHistory: false, status: { ...initialState().status, process: "ready" } }));
  model.receive(frame({ type: "settings", settings: { ...initialState().settings, model: { id: "model", name: "Model", provider: "fixture", images: true } } }));
  vi.spyOn(images, "prepareImage").mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ id }))));
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:preview"); static revokeObjectURL = vi.fn(); });
  flush(); return { model, sent };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("image-only sends refs, rejection and uncertain delivery retain attachments without replay", async () => {
  const { model, sent } = setup();
  await model.addImages([new File(["image"], "picture.png")]); flush();
  expect(model.canSend()).toBe(true);
  expect(fetch).toHaveBeenCalledWith("/images/session", expect.objectContaining({ method: "POST", credentials: "omit", headers: { "x-pi-capability": "b".repeat(64) } }));
  model.submit();
  expect(sent[0].action).toEqual({ type: "prompt", text: "", images: [id] });
  model.receive(frame({ type: "result", result: { requestId: sent[0].requestId, ok: false, code: "busy", recoveredDraft: null, disposition: null } }));
  expect(model.attachments()).toHaveLength(1);
  flush(); model.submit(); model.disconnected(); flush();
  expect(model.attachments()).toHaveLength(1); expect(model.notice()).toContain("uncertain"); expect(sent).toHaveLength(2);
  expect(JSON.stringify(model.attachments())).not.toContain("base64");
});
it("successful mixed prompts clear only submitted attachments and text; unsupported models gate sends", async () => {
  const { model, sent } = setup();
  await model.addImages([new File(["image"], "picture.png")]); flush(); model.setDraft("describe"); flush(); model.submit();
  model.receive(frame({ type: "result", result: { requestId: sent[0].requestId, ok: true, code: "accepted", recoveredDraft: null, disposition: null } }));
  flush(); expect(model.attachments()).toHaveLength(0); expect(model.draft()).toBe(""); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  model.receive(frame({ type: "settings", settings: initialState().settings })); flush();
  await model.addImages([new File(["image"], "picture.png")]); flush(); expect(model.attachments()).toHaveLength(0); expect(model.notice()).toContain("does not support");
});
it("does not load conversation images until requested and releases the blob on hide", async () => {
  vi.stubGlobal("URL", class extends URL { static createObjectURL = vi.fn(() => "blob:display"); static revokeObjectURL = vi.fn(); });
  const load = vi.fn().mockResolvedValue(new Blob(["image"], { type: "image/png" }));
  const state = initialState(); state.order = ["message"]; state.messages.message = { id: "message", role: "custom", complete: true, truncated: false, error: null, blocks: [{ kind: "image", text: id }] };
  const view = render(() => <MessageList state={state} loadImage={load} />); flush();
  const placeholder = view.getByRole("button", { name: "Load image" });
  expect(placeholder.classList.contains("image-placeholder")).toBe(true);
  expect(placeholder.querySelector("svg")).not.toBeNull();
  expect(load).not.toHaveBeenCalled(); fireEvent.click(placeholder); await Promise.resolve(); flush();
  expect(load).toHaveBeenCalledWith(id); expect(view.getByAltText("Conversation image").getAttribute("src")).toBe("blob:display");
  expect(screen.queryByRole("dialog")).toBeNull();
  const thumbnail = view.getByRole("button", { name: "Expand image" });
  expect(thumbnail.classList.contains("image-thumbnail")).toBe(true);
  fireEvent.click(thumbnail); flush();
  const popup = screen.getByRole("dialog", { name: "Image preview" });
  expect(popup.querySelector("img")?.getAttribute("src")).toBe("blob:display");
  expect(load).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Close image preview" })); flush();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(thumbnail); flush();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); flush();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(thumbnail); flush(); fireEvent.click(document.querySelector(".action-overlay")!); flush();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Hide image" })); flush(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:display");

});
it("shows previews above the textbox with an icon-only remove control and no picker", async () => {
  const { model } = setup();
  await model.addImages([new File(["image"], "picture.png")]); flush();
  const view = render(() => <SessionView model={model} />); flush();
  expect(view.container.querySelector('input[type="file"]')).toBeNull();
  expect(view.queryByText("Attach image")).toBeNull();
  const preview = view.getByAltText("picture.png");
  expect(preview.closest("form")).toBeNull();
  const textbox = view.getByRole("combobox", { name: "Message Pi" });
  expect(preview.compareDocumentPosition(textbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const remove = view.getByRole("button", { name: "Remove picture.png" });
  expect(remove.textContent).toBe("");
  expect(remove.querySelector("svg")).not.toBeNull();
  fireEvent.click(remove); flush();
  expect(model.attachments()).toHaveLength(0);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
});
it.each(["drop", "paste"])("attaches images by %s without a picker", async method => {
  const { model } = setup();
  const view = render(() => <SessionView model={model} />); flush();
  const textbox = view.getByRole("combobox", { name: "Message Pi" });
  const files = [new File(["image"], "picture.png")];
  if (method === "drop") {
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(over, "dataTransfer", { value: { types: ["Files"] } });
    fireEvent(textbox, over); expect(over.defaultPrevented).toBe(true);
    fireEvent.drop(textbox, { dataTransfer: { files } });
  } else fireEvent.paste(textbox, { clipboardData: { files } });
  await waitFor(() => { flush(); expect(view.getByAltText("picture.png")).toBeTruthy(); });
  expect(model.attachments()).toHaveLength(1);
});
it("validates image refs at the browser boundary", () => {
  const state = initialState();
  const snapshot = frame({ type: "snapshot", throughSeq: 0, messages: [{ id: "m", role: "user", complete: true, truncated: false, error: null, blocks: [{ kind: "image", text: "data:image/png;base64,private" }] }], dialogs: [], olderHistory: false, status: state.status });
  expect(() => decodeServer(JSON.stringify(snapshot))).toThrow();
});
it("passes small suitable images unchanged and rejects huge declared dimensions before decoding", async () => {
  const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII="), char => char.charCodeAt(0));
  const file = Object.assign(new File([bytes], "small.png"), { arrayBuffer: async () => bytes.buffer });
  const close = vi.fn(); const decode = vi.fn().mockResolvedValue({ width: 1, height: 1, close }); vi.stubGlobal("createImageBitmap", decode);
  const prepared = await images.prepareImage(file); expect(prepared.size).toBe(file.size); expect(prepared.type).toBe("image/png"); expect(close).toHaveBeenCalled();
  new DataView(bytes.buffer).setUint32(16, 100_000);
  await expect(images.prepareImage(file)).rejects.toThrow("32 million"); expect(decode).toHaveBeenCalledTimes(1);
});
