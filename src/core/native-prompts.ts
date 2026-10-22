import type { ExtensionUIContext, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { unsupportedContract } from "../pi-version.js";

interface NativeEditorDialog { onCancelCallback(): void }
interface NativePromptMode {
  createExtensionUIContext(): ExtensionUIContext;
  /** Pi 1.3.x: the single visible extension editor. */
  extensionEditor?: NativeEditorDialog;
  /** Pi 1.4.x: every open dialog stays answerable in a stack; the last entry is visible. */
  extensionDialogs?: { component?: unknown }[];
}

/** Find the extension editor that is opening now. Pi 1.3.x stores it in its own field,
 * Pi 1.4.x pushes it on top of the dialog stack, so the newest answerable dialog wins. */
function ownedEditor(native: NativePromptMode): NativeEditorDialog | undefined {
  const dialogs = [native.extensionEditor, ...(native.extensionDialogs ?? []).map((entry) => entry?.component)];
  for (let index = dialogs.length - 1; index >= 0; index--) {
    const dialog = dialogs[index] as NativeEditorDialog | undefined;
    if (dialog && typeof dialog.onCancelCallback === "function") return dialog;
  }
  return undefined;
}
type CustomArguments = Parameters<Parameters<ExtensionUIContext["custom"]>[0]>;
type CustomFactory<T> = (tui: CustomArguments[0], theme: CustomArguments[1], keys: CustomArguments[2], done: (value: T) => void) => ReturnType<Parameters<ExtensionUIContext["custom"]>[0]>;

/** Supported Pi versions have cancellation signals for standard dialogs but not editor/custom.
 * Adapt only this owned mode instance, before its extension contexts are bound. */
export function nativePromptCancellation(mode: InteractiveMode): () => () => void {
  const native = mode as unknown as NativePromptMode;
  if (typeof native.createExtensionUIContext !== "function") throw new Error(unsupportedContract("extension prompt context"));
  const create = native.createExtensionUIContext.bind(native);
  const pending = new Set<() => void>();
  let cancelling = 0;
  function signalPrompt<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    pending.add(cancel);
    if (cancelling) cancel();
    return Promise.resolve().then(() => run(controller.signal)).finally(() => pending.delete(cancel));
  }
  native.createExtensionUIContext = () => {
    const ui = create();
    for (const key of ["select", "confirm", "input", "editor", "custom"] as const) {
      if (typeof ui[key] !== "function") throw new Error(unsupportedContract(`extension prompt method ${key}`));
    }
    return {
      ...ui,
      select: (title, options, opts) => signalPrompt((signal) => ui.select(title, options, { ...opts, signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal })),
      confirm: (title, message, opts) => signalPrompt((signal) => ui.confirm(title, message, { ...opts, signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal })),
      input: (title, placeholder, opts) => signalPrompt((signal) => ui.input(title, placeholder, { ...opts, signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal })),
      editor: (title, prefill) => {
        if (cancelling) return Promise.resolve(undefined);
        const result = ui.editor(title, prefill);
        const editor = ownedEditor(native);
        if (!editor) throw new Error(unsupportedContract("extension editor cancellation"));
        const cancel = () => editor.onCancelCallback();
        pending.add(cancel);
        return result.finally(() => pending.delete(cancel));
      },
      custom: <T>(factory: CustomFactory<T>, options?: Parameters<ExtensionUIContext["custom"]>[1]): Promise<T> => {
        // Undefined is cancellation, never an approval or synthetic user answer.
        if (cancelling) return Promise.resolve(undefined as never);
        let cancel = () => {};
        const result = ui.custom<T>((tui, theme, keys, done) => {
          let cancelled = false;
          cancel = () => { cancelled = true; done(undefined as never); };
          pending.add(cancel);
          return Promise.resolve(factory(tui, theme, keys, done)).then((component) => {
            // A late async factory result is not mounted by Pi after done().
            if (cancelled) component.dispose?.();
            return component;
          });
        }, options);
        return result.finally(() => pending.delete(cancel));
      },
    };
  };
  return () => {
    cancelling++;
    for (const cancel of [...pending]) cancel();
    let resumed = false;
    return () => { if (!resumed) { resumed = true; cancelling--; } };
  };
}
