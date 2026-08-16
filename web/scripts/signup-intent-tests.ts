// Pure tests for the signup-intent model (plan §7.5).
//
//   npx tsx scripts/signup-intent-tests.ts
//
// The regression these exist to pin, verbatim from the §7.0 audit:
//
//   A dad opened /member/signup, chose "Young Athlete", typed his son's name,
//   his own email, and THAT SAME ADDRESS as the guardian email. One User was
//   created — email dad's, name the son's — the son's Member nested under it,
//   and the consent link then resolved the guardian BY EMAIL and found that
//   same account. One row ended up being the athlete, the athlete's login and
//   the athlete's guardian at once. Parental controls inverted, and a second
//   Dorn child could never attach because Member.userId is unique.
//
// Shape A did not exist before 2026-07-17; three of the four appeared in the
// 24 days after. Every self-signup where a parent used one address for both
// fields produced it, so the rule below is the one that must never regress.

import {
  planSignup,
  guardianEmailConflictsWithAccount,
  trialTargetFor,
  trialBlockedBySelfGuardian,
  normalizeEmail,
  SIGNUP_INTENT_COPY,
  SIGNUP_INTENTS,
  GUARDIAN_EMAIL_IS_ACCOUNT_EMAIL,
  GUARDIAN_EMAIL_REQUIRED,
} from "../lib/signupIntent";

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

const DAD = "adamjdorn@gmail.com";

function base(over: Partial<Parameters<typeof planSignup>[0]> = {}) {
  return {
    intent: "ADULT_ATHLETE" as const,
    accountEmail: "someone@example.com",
    accountFirstName: "Some",
    accountLastName: "One",
    ...over,
  };
}

// ── THE AJ DORN REGRESSION ───────────────────────────────────────────────────
console.log("\nThe AJ Dorn regression — guardian email == account email");
{
  // The exact live submission, replayed.
  const aj = planSignup(
    base({
      intent: "MINOR_ATHLETE",
      accountEmail: DAD,
      accountFirstName: "Adam (AJ)",
      accountLastName: "Dorn",
      guardianEmail: DAD,
      guardianName: "Adam j Dorn, Sr",
    }),
  );
  check("AJ's exact submission is REJECTED", !aj.ok);
  check(
    "…with the guardian-email-is-account-email code",
    !aj.ok && aj.code === GUARDIAN_EMAIL_IS_ACCOUNT_EMAIL,
    !aj.ok ? aj.code : "it was accepted",
  );
  check(
    "…and the message tells the parent what to do instead",
    !aj.ok && /signing my child up/i.test(aj.error),
  );

  // Case and whitespace are not an escape hatch — the live lookup lowercases.
  const shouty = planSignup(
    base({ intent: "MINOR_ATHLETE", accountEmail: DAD, guardianEmail: "  ADAMJDORN@Gmail.com " }),
  );
  check("case + whitespace variants are still rejected", !shouty.ok);

  // …and neither is picking a different intent with the same two addresses.
  for (const intent of SIGNUP_INTENTS) {
    const r = planSignup(base({ intent, accountEmail: DAD, guardianEmail: DAD, childFirstName: null }));
    check(`${intent} with both addresses the same is rejected`, !r.ok);
  }

  // A genuine second family address is fine.
  const ok = planSignup(
    base({
      intent: "MINOR_ATHLETE",
      accountEmail: "aj.dorn@school.edu",
      guardianEmail: DAD,
      guardianName: "Adam j Dorn, Sr",
    }),
  );
  check("a DIFFERENT guardian address is accepted", ok.ok);
  check(
    "…and plans a separate guardian, not a self-link",
    ok.ok && ok.plan.kind === "MINOR_SELF_LEGACY" && ok.plan.guardian.email === DAD,
  );
}

// The structural invariant behind all of it: no accepted plan may BOTH make the
// account holder the athlete AND hand that same account a confirmed guardian
// link. That combination is shape A, and it must be unreachable by any input.
console.log("\nNo accepted plan can produce a self-guardian");
{
  const emails = ["a@b.com", "A@B.com", " a@b.com "];
  const names: (string | null)[] = [null, "", "Kid"];
  let checked = 0;
  let violations = 0;
  for (const intent of SIGNUP_INTENTS) {
    for (const guardianEmail of [...emails, "", null]) {
      for (const childFirstName of names) {
        for (const accountEmail of emails) {
          const r = planSignup(base({ intent, accountEmail, guardianEmail, childFirstName }));
          checked++;
          if (!r.ok) continue;
          // Widened on purpose. The union already makes this combination
          // unrepresentable — tsc narrows `guardianLink` to "none" |
          // "consent-email" whenever `accountIsAthlete` is true, so the strict
          // comparison is a compile error rather than a test. Keeping the
          // runtime assertion means a future variant that loosens the type
          // fails here instead of shipping.
          const link: string = r.plan.guardianLink;
          if (r.plan.accountIsAthlete && link === "confirmed") violations++;
        }
      }
    }
  }
  check(`${checked} input combinations produced 0 self-guardian plans`, violations === 0, `${violations} did`);
}

// ── Two User rows, zero self-guardian links ──────────────────────────────────
console.log("\nWhat each intent is allowed to create");
{
  const child = planSignup(
    base({
      intent: "MINOR_ATHLETE",
      accountEmail: "mom@example.com",
      accountFirstName: "Shannan",
      accountLastName: "Hall",
      childFirstName: "Titus",
      childLastName: "Hall",
    }),
  );
  check("child path is accepted", child.ok);
  check("…the account holder is NOT the athlete", child.ok && child.plan.accountIsAthlete === false);
  check("…a separate child Member is created", child.ok && child.plan.createsChildMember === true);
  check(
    "…joined by a CONFIRMED guardian link",
    child.ok && child.plan.guardianLink === "confirmed",
  );
  check(
    "…carrying the child's name, not the parent's",
    child.ok && child.plan.kind === "CHILD_BY_GUARDIAN" && child.plan.child.firstName === "Titus",
  );

  // The point of the whole redesign: on the child path the parent's address is
  // the account AND the guardian contact, and that is NOT a conflict — because
  // the child gets no login for it to collide with.
  const sameAddress = planSignup(
    base({
      intent: "MINOR_ATHLETE",
      accountEmail: DAD,
      guardianEmail: DAD,
      childFirstName: "AJ",
      childLastName: "Dorn",
    }),
  );
  check(
    "child path with the parent's address in both fields is ACCEPTED",
    sameAddress.ok,
    !sameAddress.ok ? sameAddress.code : undefined,
  );
  check(
    "…because the child holds no login to conflate with",
    sameAddress.ok && sameAddress.plan.accountIsAthlete === false,
  );

  const adult = planSignup(base({ intent: "ADULT_ATHLETE" }));
  check("adult path makes the signer the athlete", adult.ok && adult.plan.accountIsAthlete === true);
  check("…with no guardian", adult.ok && adult.plan.guardianLink === "none");

  const guardian = planSignup(base({ intent: "PARENT" }));
  check("parent-only path creates no athlete", guardian.ok && guardian.plan.createsChildMember === false);
  check("…and sweeps for existing children", guardian.ok && guardian.plan.guardianLink === "sweep");
}

// ── Legacy shape still needs a guardian ──────────────────────────────────────
console.log("\nLegacy minor shape (a cached client, or a teen with their own email)");
{
  const noGuardian = planSignup(base({ intent: "MINOR_ATHLETE", accountEmail: "kid@example.com" }));
  check("a minor with no guardian email is rejected", !noGuardian.ok);
  check(
    "…with the guardian-required code",
    !noGuardian.ok && noGuardian.code === GUARDIAN_EMAIL_REQUIRED,
  );
  check(
    "an empty-string guardian email is not a guardian",
    !planSignup(base({ intent: "MINOR_ATHLETE", accountEmail: "kid@example.com", guardianEmail: "   " })).ok,
  );
  // Presence of a child NAME is what distinguishes the two minor shapes.
  const modern = planSignup(
    base({ intent: "MINOR_ATHLETE", accountEmail: "mom@example.com", childFirstName: "Max" }),
  );
  check("a child name switches to the guardian-account shape", modern.ok && modern.plan.kind === "CHILD_BY_GUARDIAN");
}

// ── The conflict predicate on its own ────────────────────────────────────────
console.log("\nguardianEmailConflictsWithAccount");
{
  check("same address conflicts", guardianEmailConflictsWithAccount("a@b.com", "a@b.com"));
  check("different addresses do not", !guardianEmailConflictsWithAccount("a@b.com", "c@d.com"));
  check("missing guardian email is not a conflict", !guardianEmailConflictsWithAccount("a@b.com", ""));
  check("missing account email is not a conflict", !guardianEmailConflictsWithAccount("", "a@b.com"));
  check("null-safe on both sides", !guardianEmailConflictsWithAccount(null, undefined));
  check("normalizes case", guardianEmailConflictsWithAccount("A@B.com", "a@b.COM"));
  check("normalizes surrounding whitespace", guardianEmailConflictsWithAccount(" a@b.com", "a@b.com "));
  // Not a normalization we do — and shouldn't silently: gmail dot/plus
  // aliasing is a mail-provider behaviour, not an identity rule we own.
  check(
    "does NOT treat plus-addressing as the same address",
    !guardianEmailConflictsWithAccount("a@b.com", "a+kid@b.com"),
  );
  check("normalizeEmail trims and lowercases", normalizeEmail("  Foo@Bar.COM ") === "foo@bar.com");
  check("normalizeEmail is null-safe", normalizeEmail(null) === "");
}

// ── §7.3 the trial attaches to the athlete ───────────────────────────────────
console.log("\nFree trial attaches to the athlete, never to whoever filled in the form");
{
  const child = planSignup(
    base({ intent: "MINOR_ATHLETE", accountEmail: "mom@example.com", childFirstName: "Max" }),
  );
  check(
    "child signup → the trial goes to the CHILD",
    child.ok && trialTargetFor(child.plan).target === "child",
  );

  const adult = planSignup(base({ intent: "ADULT_ATHLETE" }));
  check(
    "adult signup → the trial goes to the signer's own athlete profile",
    adult.ok && trialTargetFor(adult.plan).target === "account-athlete",
  );

  const legacyMinor = planSignup(
    base({ intent: "MINOR_ATHLETE", accountEmail: "kid@example.com", guardianEmail: "mom@example.com" }),
  );
  check(
    "legacy minor signup → the trial goes to the young athlete, not the parent",
    legacyMinor.ok && trialTargetFor(legacyMinor.plan).target === "account-athlete",
  );

  const guardian = planSignup(base({ intent: "PARENT" }));
  const gt = guardian.ok ? trialTargetFor(guardian.plan) : null;
  check("guardian-only signup grants NO trial", gt?.target === "none");
  // The old code just skipped the block when memberProfile was null. Silence is
  // the bug: the parent clicked a trial link and was told nothing.
  check(
    "…and says why, rather than failing silently",
    !!gt && gt.target === "none" && gt.reason.length > 20,
  );
  check(
    "…in words that name the next step",
    !!gt && gt.target === "none" && /add your athlete/i.test(gt.reason),
  );
}

// ── §7.3 the shape-A trial guard ─────────────────────────────────────────────
console.log("\nA trial never lands on a self-guardian record");
{
  check(
    "member whose userId is also their own guardian link → blocked",
    trialBlockedBySelfGuardian({ userId: "u1", guardianUserIds: ["u1"] }),
  );
  check(
    "…still blocked when a real co-guardian is also linked",
    trialBlockedBySelfGuardian({ userId: "u1", guardianUserIds: ["u2", "u1"] }),
  );
  check(
    "normal child (guardian is someone else) → allowed",
    !trialBlockedBySelfGuardian({ userId: "child", guardianUserIds: ["parent"] }),
  );
  check(
    "child with no login of their own → allowed",
    !trialBlockedBySelfGuardian({ userId: null, guardianUserIds: ["parent"] }),
  );
  check(
    "adult athlete with no guardians → allowed",
    !trialBlockedBySelfGuardian({ userId: "u1", guardianUserIds: [] }),
  );
}

// ── The copy is part of the fix ──────────────────────────────────────────────
console.log("\nEvery intent states whose account is being created");
{
  for (const intent of SIGNUP_INTENTS) {
    const copy = SIGNUP_INTENT_COPY[intent];
    check(`${intent} has a label`, !!copy?.label);
    check(`${intent} names the account holder on the form`, /account/i.test(copy?.accountLine ?? ""));
  }
  check(
    "the child option is phrased as the parent doing it",
    /my child/i.test(SIGNUP_INTENT_COPY.MINOR_ATHLETE.label),
  );
  check(
    "…and promises the account is the PARENT's",
    /YOUR account/i.test(SIGNUP_INTENT_COPY.MINOR_ATHLETE.accountLine),
  );
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
