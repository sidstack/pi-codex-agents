import type { ExtensionUIContext, InteractiveMode } from "@earendil-works/pi-coding-agent";

interface NativePromptMode {
  createExtensionUIContext(): ExtensionUIContext;
  extensionEditor?: { onCancelCallback(): void };
}
type CustomArguments = Parameters<Parameters<ExtensionUIContext["custom"]>[0]>;
type CustomFactory<T> = (tui: CustomArguments[0], theme: CustomArguments[1], keys: CustomArguments[2], done: (value: T) => void) => ReturnType<Parameters<ExtensionUIContext["custom"]>[0]>;

/** Pi 1.3.0 has cancellation signals for standard dialogs but not editor/custom.
 * Adapt only this owned mode instance, before its extension contexts are bound. */
export function nativePromptCancellation(mode: InteractiveMode): () => () => void {
  const native = mode as unknown as NativePromptMode;
  if (typeof native.createExtensionUIContext !== "function") throw new Error("Unsupported Pi 1.3.0 prompt context contract");
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
      if (typeof ui[key] !== "function") throw new Error(`Unsupported Pi 1.3.0 prompt method: ${key}`);
    }
    return {
      ...ui,
      select: (title, options, opts) => signalPrompt((signal) => ui.select(title, options, { ...opts, signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal })),
      confirm: (title, message, opts) => signalPrompt((signal) => ui.confirm(title, message, { ...opts, signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal })),
      input: (title, placeholder, opts) => signalPrompt((signal) => ui.input(title, placeholder, { ...opts, signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal })),
      editor: (title, prefill) => {
        if (cancelling) return Promise.resolve(undefined);
        const result = ui.editor(title, prefill);
        const editor = native.extensionEditor;
        if (!editor || typeof editor.onCancelCallback !== "function") throw new Error("Unsupported Pi 1.3.0 extension editor cancellation contract");
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
