// Shared by the 2026-11 follow-up tests. Not a test file itself.
import * as fs from "fs";
import * as path from "path";

export function harness() {
  let passed = 0, failed = 0;
  return {
    check(name: string, ok: boolean, detail?: unknown) {
      if (ok) { passed++; console.log(`  ✓ ${name}`); }
      else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
    },
    section(t: string) { console.log(`\n${t}:`); },
    done() {
      console.log(`\n${failed ? "✗" : "✓"} ${passed} passed, ${failed} failed`);
      if (failed) process.exit(1);
    },
  };
}
export const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
export const DAY = 86_400_000;
/** Midnight UTC, `days` from today — tests never name a calendar date. */
export const dayFromNow = (days: number) => { const d = new Date(Date.now() + days * DAY); d.setUTCHours(0, 0, 0, 0); return d; };
