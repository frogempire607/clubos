// One action at a time per key — the cure for "I tapped twice and it happened
// twice".
//
// A button that sets `busy` state and renders `disabled` is not enough on its
// own: the second tap can land before React has re-rendered, and on a phone a
// double tap is the normal way a slow button gets pressed. The in-flight set
// here is updated synchronously, so the second call is dropped no matter what
// has or has not been drawn yet.
//
// `createSingleFlight` is the plain core (tested without React);
// `useSingleFlight` in lib/useSingleFlight.ts wraps it for components.

export type SingleFlight = {
  /**
   * Run `fn` unless a call with the same key is still running, in which case
   * the new call is dropped and resolves to `undefined`. Errors from `fn`
   * propagate; the key is always released.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined>;
  isBusy(key: string): boolean;
  /** Keys currently in flight (a copy). */
  busyKeys(): string[];
};

export function createSingleFlight(onChange?: (busy: string[]) => void): SingleFlight {
  const inFlight = new Set<string>();
  const changed = () => onChange?.(Array.from(inFlight));
  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
      if (inFlight.has(key)) return undefined;
      inFlight.add(key);
      changed();
      try {
        return await fn();
      } finally {
        inFlight.delete(key);
        changed();
      }
    },
    isBusy: (key) => inFlight.has(key),
    busyKeys: () => Array.from(inFlight),
  };
}
