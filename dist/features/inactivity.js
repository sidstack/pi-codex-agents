export const inactivityFeature = {
    id: "inactivity",
    start(host) {
        const timeout = host.config.idleTimeoutMs;
        if (!timeout)
            return;
        const timer = setInterval(() => {
            void host.deactivateIdle(Date.now(), timeout).catch((error) => console.error(error));
        }, Math.min(30_000, timeout));
        timer.unref();
        return () => clearInterval(timer);
    },
};
//# sourceMappingURL=inactivity.js.map