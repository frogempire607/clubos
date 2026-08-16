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
  DOB_REQUIRED,
} from "../lib/signupIntent";
import {
  MEMBER_ORIGIN,
  originForSignupPlan,
  isMemberOrigin,
  memberOriginLabel,
} from "../lib/memberOrigin";

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

// A DOB is REQUIRED on every athlete-creating path now, so the shared base
// supplies an adult one. Cases that care about age override it explicitly.
const ADULT_DOB = "1990-04-01";
const MINOR_DOB = "2009-05-04"; // 17 as of 2026-08-16

function base(over: Partial<Parameters<typeof planSignup>[0]> = {}) {
  return {
    intent: "ADULT_ATHLETE" as const,
    accountEmail: "someone@example.com",
    accountFirstName: "Some",
    accountLastName: "One",
    dateOfBirth: ADULT_DOB,
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

  // A genuine second family address is fine — this is the real 17-year-old
  // with a school address and a parent at home.
  const ok = planSignup(
    base({
      intent: "MINOR_SELF",
      dateOfBirth: MINOR_DOB,
      accountEmail: "aj.dorn@school.edu",
      guardianEmail: DAD,
      guardianName: "Adam j Dorn, Sr",
    }),
  );
  check("a DIFFERENT guardian address is accepted", ok.ok);
  check(
    "…and plans a separate guardian, not a self-link",
    ok.ok && ok.plan.kind === "MINOR_SELF" && ok.plan.guardian.email === DAD,
  );
}

// ── The self-signing minor — juniors and seniors, a real population ──────────
// They sign up here with their own email. `Member.userId` and a guardian link
// are DIFFERENT things and a member may hold both; removing their form path
// would have pushed them onto "I train here myself", where they'd be stored as
// adults with no guardian and no consent at all.
console.log("\nA junior or senior signing themselves up");
{
  const teen = planSignup(
    base({
      intent: "MINOR_SELF",
      dateOfBirth: MINOR_DOB,
      accountEmail: "kayla@school.test",
      guardianEmail: "mom@home.test",
      guardianName: "Renee Reyes",
    }),
  );
  check("is accepted", teen.ok, !teen.ok ? teen.code : undefined);
  check("…the athlete IS the account holder", teen.ok && teen.plan.accountIsAthlete === true);
  check("…so they keep their own login", teen.ok && teen.plan.kind === "MINOR_SELF");
  check("…no separate child Member is invented", teen.ok && teen.plan.createsChildMember === false);
  check(
    "…and a SEPARATE guardian is named",
    teen.ok && teen.plan.kind === "MINOR_SELF" && teen.plan.guardian.email === "mom@home.test",
  );
  check(
    "…reached through the consent link, not an instant link",
    teen.ok && teen.plan.guardianLink === "consent-email",
  );

  const noGuardian = planSignup(
    base({ intent: "MINOR_SELF", dateOfBirth: MINOR_DOB, accountEmail: "kayla@school.test" }),
  );
  check("a minor with no guardian email is rejected", !noGuardian.ok);
  check(
    "…with the guardian-required code",
    !noGuardian.ok && noGuardian.code === GUARDIAN_EMAIL_REQUIRED,
  );

  // The AJ rule still bites here, and this is exactly where it should: one
  // address cannot be both the athlete's login and the athlete's guardian.
  const sameAddress = planSignup(
    base({
      intent: "MINOR_SELF",
      dateOfBirth: MINOR_DOB,
      accountEmail: "kayla@school.test",
      guardianEmail: "kayla@school.test",
    }),
  );
  check("their own address as the guardian is rejected", !sameAddress.ok);
  check(
    "…with the AJ code",
    !sameAddress.ok && sameAddress.code === GUARDIAN_EMAIL_IS_ACCOUNT_EMAIL,
  );
}

// ── THE DOB BACKSTOP ─────────────────────────────────────────────────────────
// The radio button does not decide this. The date of birth does — the same
// derivation `resolveIsMinor` uses at the login gate. Signup was the one place
// that trusted the click, and it produced a live 4-year-old holding his own
// login flagged as an adult with no guardian on record.
console.log("\nThe DOB backstop — the birthday decides, not the button");
{
  // A 17-year-old who picks "I train here myself".
  const mispick = planSignup(
    base({
      intent: "ADULT_ATHLETE",
      dateOfBirth: MINOR_DOB,
      accountEmail: "nia@school.test",
      guardianEmail: "parent@home.test",
    }),
  );
  check("a minor DOB on the ADULT path routes to the minor plan", mispick.ok && mispick.plan.kind === "MINOR_SELF");
  check("…they still keep their own login", mispick.ok && mispick.plan.accountIsAthlete === true);
  check(
    "…and a guardian is now on record",
    mispick.ok && mispick.plan.kind === "MINOR_SELF" && mispick.plan.guardian.email === "parent@home.test",
  );

  // …and the same mis-pick with no guardian email is REFUSED rather than
  // quietly stored as an adult. This is the Nia row, made impossible.
  const mispickNoGuardian = planSignup(
    base({ intent: "ADULT_ATHLETE", dateOfBirth: MINOR_DOB, accountEmail: "nia@school.test" }),
  );
  check("a minor DOB on the ADULT path with no guardian is REFUSED", !mispickNoGuardian.ok);
  check(
    "…rather than silently creating a guardian-less adult",
    !mispickNoGuardian.ok && mispickNoGuardian.code === GUARDIAN_EMAIL_REQUIRED,
  );
  check(
    "…and the message says how old the DOB makes them",
    !mispickNoGuardian.ok && /makes you 1[6-7]/.test(mispickNoGuardian.error),
    !mispickNoGuardian.ok ? mispickNoGuardian.error : undefined,
  );

  // The inverse: an adult who picks "I'm under 18" is routed OUT of the minor
  // path, so nobody is saddled with a guardian they don't need.
  const inverse = planSignup(
    base({ intent: "MINOR_SELF", dateOfBirth: ADULT_DOB, accountEmail: "grownup@example.com" }),
  );
  check("an adult DOB on the MINOR path routes to the adult plan", inverse.ok && inverse.plan.kind === "ADULT_SELF");
  check("…with no guardian required", inverse.ok && inverse.plan.guardianLink === "none");

  // A 4-year-old — the live Zachary Lawell row — cannot be stored as an adult.
  const toddler = planSignup(
    base({ intent: "ADULT_ATHLETE", dateOfBirth: "2021-12-06", accountEmail: "parent@home.test" }),
  );
  check("a 4-year-old cannot be created as an adult athlete", !toddler.ok || toddler.plan.kind === "MINOR_SELF");

  // DOB is REQUIRED on every path that creates an athlete.
  for (const intent of ["ADULT_ATHLETE", "MINOR_SELF"] as const) {
    const noDob = planSignup(base({ intent, dateOfBirth: null }));
    check(`${intent} without a DOB is refused`, !noDob.ok);
    check(`…with the DOB-required code`, !noDob.ok && noDob.code === DOB_REQUIRED);
  }
  const childNoDob = planSignup(
    base({ intent: "MINOR_ATHLETE", dateOfBirth: null, childFirstName: "Max", accountEmail: "mom@example.com" }),
  );
  check("the guardian path without the CHILD's DOB is refused", !childNoDob.ok);
  check(
    "…naming whose birthday is missing",
    !childNoDob.ok && /your child's date of birth/i.test(childNoDob.error),
  );

  // A guardian-only account creates no athlete, so it needs no DOB.
  check("a guardian-only signup needs no DOB", planSignup(base({ intent: "PARENT", dateOfBirth: null })).ok);

  // Garbage in the field is treated as absent, never as an adult.
  check(
    "an unparseable DOB is refused, not read as adult",
    !planSignup(base({ intent: "ADULT_ATHLETE", dateOfBirth: "not-a-date" })).ok,
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
// MINOR_ATHLETE means "I'm signing my child up", and the child's NAME is what
// says so. A stale cached client that sends the intent WITHOUT a child name is
// describing a self-signup, and falls through to the same DOB routing as
// everything else rather than to a special legacy branch.
console.log("\nBack-compat: MINOR_ATHLETE with no child name falls through to DOB routing");
{
  // A cached client sending the old teen-with-own-email shape.
  const teenLegacy = planSignup(
    base({
      intent: "MINOR_ATHLETE",
      dateOfBirth: MINOR_DOB,
      accountEmail: "kid@example.com",
      guardianEmail: "mom@example.com",
    }),
  );
  check("a minor DOB + a separate guardian still works", teenLegacy.ok && teenLegacy.plan.kind === "MINOR_SELF");

  const noGuardian = planSignup(
    base({ intent: "MINOR_ATHLETE", dateOfBirth: MINOR_DOB, accountEmail: "kid@example.com" }),
  );
  check("a minor with no guardian email is rejected", !noGuardian.ok);
  check(
    "…with the guardian-required code",
    !noGuardian.ok && noGuardian.code === GUARDIAN_EMAIL_REQUIRED,
  );
  check(
    "an empty-string guardian email is not a guardian",
    !planSignup(
      base({ intent: "MINOR_ATHLETE", dateOfBirth: MINOR_DOB, accountEmail: "kid@example.com", guardianEmail: "   " }),
    ).ok,
  );
  // Presence of a child NAME is what distinguishes the guardian shape.
  const modern = planSignup(
    base({ intent: "MINOR_ATHLETE", accountEmail: "mom@example.com", childFirstName: "Max", dateOfBirth: MINOR_DOB }),
  );
  check("a child name switches to the guardian-account shape", modern.ok && modern.plan.kind === "CHILD_BY_GUARDIAN");
  // A guardian may legitimately manage an adult child's account — the plan is
  // the same, and the route derives `isMinor` from the DOB rather than assuming.
  const adultChild = planSignup(
    base({ intent: "MINOR_ATHLETE", accountEmail: "mom@example.com", childFirstName: "Max", dateOfBirth: ADULT_DOB }),
  );
  check("a guardian may manage an ADULT child", adultChild.ok && adultChild.plan.kind === "CHILD_BY_GUARDIAN");
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

// ── Member.createdVia — the origin recorded for each planned signup ──────────
//
// The column exists so the next audit is a SELECT instead of inference from
// migrationStatus and timestamps. That only holds if the recorded value is the
// PLANNER's decision — which came from the date of birth — rather than a second
// derivation from a different input.
console.log("\nEvery signup plan records an honest origin");
{
  const adult = planSignup({
    intent: "ADULT_ATHLETE", accountEmail: "adult@x.test",
    accountFirstName: "A", accountLastName: "Adult", dateOfBirth: "1990-01-01",
  });
  const minorSelf = planSignup({
    intent: "MINOR_SELF", accountEmail: "teen@x.test",
    accountFirstName: "T", accountLastName: "Teen", dateOfBirth: "2010-05-05",
    guardianEmail: "parent@x.test", guardianName: "P Parent",
  });
  const child = planSignup({
    intent: "MINOR_ATHLETE", accountEmail: "parent@x.test",
    accountFirstName: "P", accountLastName: "Parent",
    childFirstName: "Kid", childLastName: "Parent",
    // Required by the planner — the DOB is what decides minor status, so a
    // child signup cannot be planned without it.
    dateOfBirth: "2014-03-02",
  });

  check("an adult self-signup is ADULT_SELF",
    adult.ok && originForSignupPlan(adult.plan.kind as never) === MEMBER_ORIGIN.ADULT_SELF);

  // The cohort the column is most useful for. Collapsing this into ADULT_SELF
  // would erase exactly the shape the four-year-old audit needed to find.
  check("a MINOR signing themselves up is MINOR_SELF, not ADULT_SELF",
    minorSelf.ok && originForSignupPlan(minorSelf.plan.kind as never) === MEMBER_ORIGIN.MINOR_SELF,
    minorSelf.ok ? minorSelf.plan.kind : "plan rejected");
  check("…and every origin value is distinct",
    new Set(Object.values(MEMBER_ORIGIN)).size === Object.values(MEMBER_ORIGIN).length);

  check("a guardian adding their child is CHILD_BY_GUARDIAN",
    child.ok && originForSignupPlan(child.plan.kind as never) === MEMBER_ORIGIN.CHILD_BY_GUARDIAN);

  // GUARDIAN_ONLY creates no Member row, so it has no origin to record. The
  // route never reaches originForSignupPlan on that path — the nested create
  // sits inside the `accountIsAthlete` branch — and the narrow parameter type
  // is what makes that a compile error rather than a silent mislabel.
  const guardianOnly = planSignup({
    intent: "PARENT", accountEmail: "solo@x.test",
    accountFirstName: "S", accountLastName: "Solo",
  });
  check("a guardian-only signup plans NO athlete record",
    guardianOnly.ok && guardianOnly.plan.accountIsAthlete === false && guardianOnly.plan.createsChildMember === false);

  check("every writable origin is recognised by the validator",
    Object.values(MEMBER_ORIGIN).every((v) => isMemberOrigin(v)));
  check("NULL is not an origin — it means 'created before this was recorded'",
    !isMemberOrigin(null) && !isMemberOrigin(undefined) && !isMemberOrigin(""));
  check("ACTIVATION is deliberately NOT writable — activation updates, never creates",
    !isMemberOrigin("ACTIVATION"));
  check("every origin has a distinct human label",
    new Set(Object.values(MEMBER_ORIGIN).map(memberOriginLabel)).size === Object.values(MEMBER_ORIGIN).length);
  check("an unknown value still renders a sentence, not a crash",
    /unknown/i.test(memberOriginLabel(null)));
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
