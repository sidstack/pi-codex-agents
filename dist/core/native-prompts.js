/** Pi 1.3.0 has cancellation signals for standard dialogs but not editor/custom.
 * Adapt only this owned mode instance, before its extension contexts are bound. */
export function nativePromptCancellation(mode) {
    const native = mode;
    if (typeof native.createExtensionUIContext !== "function")
        throw new Error("Unsupported Pi 1.3.0 prompt context contract");
    const create = native.createExtensionUIContext.bind(native);
    const pending = new Set();
    let cancelling = 0;
    function signalPrompt(run) {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        pending.add(cancel);
        if (cancelling)
            cancel();
        return Promise.resolve().then(() => run(controller.signal)).finally(() => pending.delete(cancel));
    }
    native.createExtensionUIContext = () => {
        const ui = create();
        for (const key of ["select", "confirm", "input", "editor", "custom"]) {
            if (typeof ui[key] !== "function")
                throw new Error(`Unsupported Pi 1.3.0 prompt method: ${key}`);
        }
        return {
            ...ui,
            select: (title, options, opts) => signalPrompt((signal) => ui.select(title, options, { ...opts, signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal })),
            confirm: (title, message, opts) => signalPrompt((signal) => ui.confirm(title, message, { ...opts, signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal })),
            input: (title, placeholder, opts) => signalPrompt((signal) => ui.input(title, placeholder, { ...opts, signal: opts?.signal ? AbortSignal.any([signal, opts.signal]) : signal })),
            editor: (title, prefill) => {
                if (cancelling)
                    return Promise.resolve(undefined);
                const result = ui.editor(title, prefill);
                const editor = native.extensionEditor;
                if (!editor || typeof editor.onCancelCallback !== "function")
                    throw new Error("Unsupported Pi 1.3.0 extension editor cancellation contract");
                const cancel = () => editor.onCancelCallback();
                pending.add(cancel);
                return result.finally(() => pending.delete(cancel));
            },
            custom: (factory, options) => {
                // Undefined is cancellation, never an approval or synthetic user answer.
                if (cancelling)
                    return Promise.resolve(undefined);
                let cancel = () => { };
                const result = ui.custom((tui, theme, keys, done) => {
                    let cancelled = false;
                    cancel = () => { cancelled = true; done(undefined); };
                    pending.add(cancel);
                    return Promise.resolve(factory(tui, theme, keys, done)).then((component) => {
                        // A late async factory result is not mounted by Pi after done().
                        if (cancelled)
                            component.dispose?.();
                        return component;
                    });
                }, options);
                return result.finally(() => pending.delete(cancel));
            },
        };
    };
    return () => {
        cancelling++;
        for (const cancel of [...pending])
            cancel();
        let resumed = false;
        return () => { if (!resumed) {
            resumed = true;
            cancelling--;
        } };
    };
}
//# sourceMappingURL=native-prompts.js.map