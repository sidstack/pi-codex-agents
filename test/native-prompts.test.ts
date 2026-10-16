import { describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { nativePromptCancellation } from "../src/core/native-prompts.js";

function fixture() {
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
  const mode = { createExtensionUIContext: () => ui as unknown as ExtensionUIContext,
    extensionEditor: { onCancelCallback: vi.fn(() => editorDone?.()) } };
  const cancel = nativePromptCancellation(mode as unknown as InteractiveMode);
  return { mode, ui, cancel, context: mode.createExtensionUIContext() };
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
    expect(f.mode.extensionEditor.onCancelCallback).toHaveBeenCalledOnce();
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
    expect(() => nativePromptCancellation({} as InteractiveMode)).toThrow("prompt context contract");
  });
});
