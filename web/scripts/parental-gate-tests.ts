/**
 * Phase 6 — the parental gate resolves minor status from the DATE OF BIRTH.
 *
 *   npm run test:parental-gate
 *
 * `applyParentalControls` was the last gate in the app where `Member.isMinor`
 * was the final word. Its select did not even fetch `dateOfBirth`, so nothing
 * could outrank the stored flag — while the document, consent and login gates
 * had all moved to `resolveIsMinor` some time ago.
 *
 * The consequence was an ABSENCE rather than a leak: a minor whose row said
 * `isMinor: false` had NO parental controls available at all. Every payment
 * approval, spend limit and messaging restriction short-circuited to "allow"
 * before the controls JSON was read. Two live members were in that state on
 * 2026-09-08 — ages 4 and 16.
 *
 * These cases use PACKAGE_BUY with `allowPackagePurchase: false`, which is the
 * one branch that returns without touching the database, so the whole file runs
 * offline.
 */
import { applyParentalControls, type GateInput } from "../lib/parentalControls";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(detail ? `${label} — ${detail}` : label);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

const yearsAgo = (n: number) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d;
};
const BLOCK_PACKAGES = { allowPackagePurchase: false };

/** The minor is acting on their own login, so the guardian short-circuit is off. */
function gate(member: Partial<GateInput["member"]>, bookerIsSelf = true) {
  const m: GateInput["member"] = {
    id: "m1", clubId: "club_1", userId: "u_child",
    isMinor: false, dateOfBirth: null, parentControls: BLOCK_PACKAGES,
    ...member,
  };
  return applyParentalControls({
    member: m,
    bookerUserId: bookerIsSelf ? "u_child" : "u_guardian",
    kind: "PACKAGE_BUY",
    amount: 100,
    payload: {},
  });
}

async function main() {
  console.log("\nPARENTAL GATE — date of birth outranks the stored flag\n");

  // Zachary Lawell's shape: four years old, row says adult.
  {
    const r = await gate({ isMinor: false, dateOfBirth: yearsAgo(4) });
    check("a 4-year-old flagged isMinor=false is GATED (was silently allowed)",
      r.kind === "block", JSON.stringify(r));
  }
  {
    const r = await gate({ isMinor: false, dateOfBirth: yearsAgo(16) });
    check("a 16-year-old flagged isMinor=false is GATED", r.kind === "block", JSON.stringify(r));
  }
  {
    const r = await gate({ isMinor: true, dateOfBirth: yearsAgo(17) });
    check("a 17-year-old flagged correctly is still GATED", r.kind === "block", JSON.stringify(r));
  }

  // The other direction: nothing recomputes isMinor on a birthday, and 20 live
  // members are flagged minor while past 18. A stale flag must not keep an
  // adult under parental controls.
  {
    const r = await gate({ isMinor: true, dateOfBirth: yearsAgo(25) });
    check("an adult still flagged isMinor=true is NOT gated — the DOB frees them",
      r.kind === "allow", JSON.stringify(r));
  }
  {
    const r = await gate({ isMinor: true, dateOfBirth: yearsAgo(18) });
    check("exactly 18 is an adult", r.kind === "allow", JSON.stringify(r));
  }

  // 32 live members have NO date of birth and are flagged minor. For them the
  // stored flag is the only answer there is, so the fallback has to hold —
  // this is precisely why the column cannot simply be dropped.
  {
    const r = await gate({ isMinor: true, dateOfBirth: null });
    check("with no DOB the stored flag still governs — 32 members depend on this",
      r.kind === "block", JSON.stringify(r));
  }
  {
    const r = await gate({ isMinor: false, dateOfBirth: null });
    check("no DOB and not flagged = not a minor (absence of evidence is not evidence)",
      r.kind === "allow", JSON.stringify(r));
  }

  // Guardrails that must survive the change.
  {
    const r = await gate({ isMinor: false, dateOfBirth: yearsAgo(4) }, false);
    check("a GUARDIAN acting for the child is never gated — they are the oversight",
      r.kind === "allow", JSON.stringify(r));
  }
  {
    const r = await gate({ isMinor: false, dateOfBirth: yearsAgo(4), parentControls: null });
    check("a minor with NO controls configured is not gated",
      r.kind === "allow", JSON.stringify(r));
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error("\nFailures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
