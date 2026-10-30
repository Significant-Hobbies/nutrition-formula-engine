// Ingestion libraries may ignore abort. Bound the wait and guard every UI commit.
export function createPreparationTasks({ timeoutMs = 60000 } = {}) {
  let active = null;
  function cancel() {
    if (!active) return;
    active.current = false;
    active.controller.abort();
    active.reject?.(new Error("A newer input replaced this preparation."));
    active = null;
  }
  return {
    cancel,
    start() {
      cancel();
      const state = { current: true, controller: new AbortController() };
      active = state;
      return {
        isCurrent: () => state.current,
        async run(work) {
          let timer;
          try {
            return await Promise.race([
              Promise.resolve().then(() => work(state.controller.signal)),
              new Promise((_, reject) => {
                state.reject = reject;
                timer = setTimeout(() => {
                  reject(new Error("Reading this file timed out. Your input is retained. Paste its formula text, or upload it again to retry."));
                  state.controller.abort();
                }, timeoutMs);
              }),
            ]);
          } finally {
            clearTimeout(timer);
            state.reject = null;
          }
        },
      };
    },
  };
}
