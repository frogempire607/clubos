// Phase timing for long serverless handlers.
//
// The bulk email send died twice at Netlify's 60s ceiling with nothing in the
// logs to say WHICH part was slow. Rendering was later measured at
// 12.75ms/recipient — 3.75s for 294 — which ruled out the phase everybody
// assumed, and left the remaining suspects unmeasured. This exists so the next
// timeout arrives with numbers attached instead of a theory.
//
// Deliberately tiny: no deps, no sampling, no aggregation. One line per phase,
// one summary line, on stdout where Netlify's function log picks it up.
export type PhaseTimer = {
  /** Time an async phase and record it. */
  phase<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Record a phase measured elsewhere (e.g. inside a loop). */
  record(name: string, ms: number, count?: number): void;
  /** Milliseconds since the timer was created. */
  elapsed(): number;
  /** Emit the summary line. Safe to call more than once. */
  done(extra?: Record<string, unknown>): void;
};

export function startPhaseTimer(label: string, meta: Record<string, unknown> = {}): PhaseTimer {
  const t0 = Date.now();
  const phases: Array<{ name: string; ms: number; count?: number }> = [];

  const record = (name: string, ms: number, count?: number) => {
    phases.push({ name, ms, count });
    const per = count && count > 0 ? ` (${(ms / count).toFixed(1)}ms x ${count})` : "";
    console.log(`[${label}] ${name}: ${ms}ms${per}`);
  };

  return {
    async phase(name, fn) {
      const s = Date.now();
      try {
        return await fn();
      } finally {
        record(name, Date.now() - s);
      }
    },
    record,
    elapsed: () => Date.now() - t0,
    done(extra = {}) {
      const total = Date.now() - t0;
      const breakdown = phases.map((p) => `${p.name}=${p.ms}ms`).join(" ");
      console.log(
        `[${label}] TOTAL ${total}ms ${breakdown} ${JSON.stringify({ ...meta, ...extra })}`,
      );
    },
  };
}
