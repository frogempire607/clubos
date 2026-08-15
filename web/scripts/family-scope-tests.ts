// Pure tests for the family-scope selection rule in lib/activeProfile.ts.
//   npx tsx scripts/family-scope-tests.ts
//
// The bug these pin (live, 2026-08-17): Shannan Hall booked Titus and Max into
// the same MS/HS class. BOTH bookings landed — 38 seconds apart, confirmed in
// production — and she reported that only one went through, because every
// booking surface was scoped to one athlete and showed her one at a time.
// Family scope is the fix, so its resolution rules are worth pinning:
// a guardian with siblings must LAND there, and nobody else may be moved.

// lib/activeProfile reads window.localStorage. Stub it before importing so the
// module sees a browser-shaped global.
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};
(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = class {
  detail: unknown;
  constructor(_t: string, o?: { detail?: unknown }) {
    this.detail = o?.detail;
  }
};

import {
  FAMILY_SCOPE,
  isFamilyScope,
  familyEligible,
  resolveActiveProfileId,
  setActiveProfileId,
} from "../lib/activeProfile";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

const SELF = { kind: "self" as const };
const KID = { kind: "child" as const };

// ── Who gets the family scope at all ─────────────────────────────────────────
{
  check("two children → eligible (the Hall shape)", familyEligible([KID, KID]));
  check("parent who also trains + two children → eligible", familyEligible([SELF, KID, KID]));
  check("ONE child → not eligible", !familyEligible([SELF, KID]));
  check("one child, no self profile → not eligible", !familyEligible([KID]));
  check("solo adult athlete → not eligible", !familyEligible([SELF]));
  check("no profiles → not eligible", !familyEligible([]));
}

// ── The sentinel can never be mistaken for a member id ────────────────────────
{
  check("sentinel identifies itself", isFamilyScope(FAMILY_SCOPE));
  check("a real id is not family scope", !isFamilyScope("cmr7b603d0000abc"));
  check("null is not family scope", !isFamilyScope(null));
  check("undefined is not family scope", !isFamilyScope(undefined));
  check(
    "a stored sentinel never resolves to a real athlete by accident",
    !["m_titus", "m_max"].includes(FAMILY_SCOPE),
  );
}

// ── Defaults: siblings land on family, everyone else is untouched ────────────
{
  setActiveProfileId(null);
  check(
    "nothing stored + eligible → starts in family scope",
    resolveActiveProfileId(["m_titus", "m_max"], { allowFamily: true, defaultFamily: true }) ===
      FAMILY_SCOPE,
  );

  setActiveProfileId(null);
  check(
    "nothing stored + NOT eligible → first athlete, exactly as before",
    resolveActiveProfileId(["m_solo"], { allowFamily: false, defaultFamily: false }) === "m_solo",
  );

  setActiveProfileId(null);
  check(
    "no options at all → first athlete (pre-7.1 call sites are unchanged)",
    resolveActiveProfileId(["m_a", "m_b"]) === "m_a",
  );

  setActiveProfileId(null);
  check(
    "no accessible athletes → null, not the sentinel",
    resolveActiveProfileId([], { allowFamily: false, defaultFamily: false }) === null,
  );
}

// ── An explicit choice always wins over the default ──────────────────────────
{
  setActiveProfileId("m_max");
  check(
    "a chosen child survives the family default",
    resolveActiveProfileId(["m_titus", "m_max"], { allowFamily: true, defaultFamily: true }) ===
      "m_max",
  );

  setActiveProfileId(FAMILY_SCOPE);
  check(
    "a chosen family scope is honored where allowed",
    resolveActiveProfileId(["m_titus", "m_max"], { allowFamily: true }) === FAMILY_SCOPE,
  );
}

// ── Per-child surfaces (documents, controls, billing) never go family ────────
{
  setActiveProfileId(FAMILY_SCOPE);
  check(
    "a per-child surface falls back to a real athlete",
    resolveActiveProfileId(["m_titus", "m_max"]) === "m_titus",
  );
  check(
    "...and the family selection is NOT clobbered for other surfaces",
    // resolve is a pure read: visiting Documents must not reset the choice.
    resolveActiveProfileId(["m_titus", "m_max"], { allowFamily: true }) === FAMILY_SCOPE,
  );
}

// ── Stale selections degrade instead of blanking the portal ──────────────────
{
  setActiveProfileId("m_departed"); // child unlinked since the choice was made
  check(
    "a stale child id falls back to the first athlete",
    resolveActiveProfileId(["m_titus", "m_max"], { allowFamily: true }) === "m_titus",
  );

  setActiveProfileId(FAMILY_SCOPE);
  check(
    "family scope stored, but the account is down to one athlete → that athlete",
    resolveActiveProfileId(["m_titus"], { allowFamily: false, defaultFamily: false }) === "m_titus",
  );
}

console.log(`\n${"─".repeat(58)}`);
if (failures.length) {
  console.log(`✗ ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.log(`   ${f}`));
  process.exit(1);
}
console.log(`✓ ${pass}/${pass} passed`);
