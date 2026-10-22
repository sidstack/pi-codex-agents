import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { nativePromptCancellation } from "../src/core/native-prompts.js";

function fixture(editorLayout: "field" | "stack" = "field") {
  let editorDone: ((value?: string) => void) | undefined;
  const ui = {
    select: vi.fn((_title, _choices, options) => new Promise((done) => {
      if (options.signal.aborted) done(undefined);
      else options.signal.addEventListener("abort", () => done(undefined), { once: true });
    })),
    confirm: vi.fn((_title, _message, options) => new Promise((done) => {
      if (options.signal.aborted) done(false);
      else options.signal.addEventListener("abort", () => done(false), { once: true });
    })),
    input: vi.fn((_title, _placeholder, options) => new Promise((done) => {
      if (options.signal.aborted) done(undefined);
      else options.signal.addEventListener("abort", () => done(undefined), { once: true });
    })),
    editor: vi.fn(() => new Promise<string | undefined>((done) => { editorDone = done; })),
    custom: vi.fn((factory) => new Promise((done, reject) => { Promise.resolve(factory({}, {}, {}, done)).catch(reject); })),
  };
  // Pi 1.3.x stores the one visible editor in its own field; Pi 1.4.x pushes every open
  // dialog on a stack and keeps each one answerable (earendil-works/pi#11166).
  interface Mode { createExtensionUIContext(): ExtensionUIContext; extensionEditor?: { onCancelCallback(): void }; extensionDialogs?: { component: unknown }[] }
  const mode: Mode = { createExtensionUIContext: () => ui as unknown as ExtensionUIContext };
  const stack: { cancel?: () => void } = {};
  if (editorLayout === "stack") {
    const dialogs: { component: unknown }[] = [{ component: { onCancelCallback: vi.fn() } }];
    mode.extensionDialogs = dialogs;
    ui.editor = vi.fn(() => new Promise<string | undefined>((done) => {
      editorDone = done;
      stack.cancel = vi.fn(() => done(undefined));
      dialogs.push({ component: { onCancelCallback: stack.cancel } });
    }));
  } else {
    mode.extensionEditor = { onCancelCallback: vi.fn(() => editorDone?.()) };
  }
  const cancel = nativePromptCancellation(mode as unknown as InteractiveMode);
  return { mode, ui, cancel, stack, context: mode.createExtensionUIContext() };
}

describe("owned native prompt cancellation", () => {
  it("cancels standard prompts without approving and resumes later dialogs", async () => {
    const f = fixture();
    const prompts = [f.context.confirm("Confirm", "Proceed?"), f.context.select("Select", ["Approve"]), f.context.input("Input")];
    const resume = f.cancel();
    await expect(Promise.all(prompts)).resolves.toEqual([false, undefined, undefined]);
    await expect(f.context.confirm("While cancelled", "Proceed?")).resolves.toBe(false);
    resume(); resume();
    const another = f.context.input("After resume");
    await Promise.resolve();
    expect(f.ui.input.mock.calls.at(-1)![2].signal.aborted).toBe(false);
    f.cancel()();
    await expect(another).resolves.toBeUndefined();
  });
  it("preserves the caller's cancellation signal", async () => {
    const f = fixture();
    const controller = new AbortController();
    const prompt = f.context.confirm("Confirm", "Proceed?", { signal: controller.signal });
    await Promise.resolve(); controller.abort();
    await expect(prompt).resolves.toBe(false);
  });
  it("cancels the captured native editor instance", async () => {
    const f = fixture();
    const prompt = f.context.editor("Editor");
    f.cancel()();
    await expect(prompt).resolves.toBeUndefined();
    expect(f.mode.extensionEditor!.onCancelCallback).toHaveBeenCalledOnce();
  });
  it("cancels the editor the Pi 1.4.x dialog stack put on top, not an older dialog", async () => {
    const f = fixture("stack");
    const older = vi.mocked(f.mode.extensionDialogs![0]!.component as { onCancelCallback: () => void }).onCancelCallback;
    const prompt = f.context.editor("Editor");
    f.cancel()();
    await expect(prompt).resolves.toBeUndefined();
    expect(f.stack.cancel).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
  });
  it("settles a custom prompt and disposes a late async component", async () => {
    const f = fixture();
    let ready!: (component: { render(): string[]; invalidate(): void; dispose(): void }) => void;
    const dispose = vi.fn();
    const prompt = f.context.custom(() => new Promise((done) => { ready = done; }));
    f.cancel()();
    await expect(prompt).resolves.toBeUndefined();
    ready({ render: () => [], invalidate() {}, dispose });
    await Promise.resolve(); await Promise.resolve();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("rejects unsupported private contracts explicitly", () => {
    expect(() => nativePromptCancellation({} as InteractiveMode)).toThrow("Unsupported Pi contract");
    // An editor that registers no answerable dialog in either layout is a changed contract.
    const mode = { createExtensionUIContext: () => ({
      select: () => Promise.resolve(undefined), confirm: () => Promise.resolve(false), input: () => Promise.resolve(undefined),
      editor: () => new Promise<string | undefined>(() => {}), custom: () => Promise.resolve(undefined),
    }) } as unknown as InteractiveMode;
    nativePromptCancellation(mode);
    const patched = mode as unknown as { createExtensionUIContext(): { editor(title: string): Promise<string | undefined> } };
    expect(() => patched.createExtensionUIContext().editor("Editor")).toThrow(/Unsupported Pi contract: extension editor cancellation/);
  });
});
