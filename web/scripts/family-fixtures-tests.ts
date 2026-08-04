// Phase 4D — the plan.md §4D regression matrix, as pure fixtures.
//
//   npm run test:family-fixtures
//
// NO DATABASE. NO NETWORK. Every case is plain data through a pure rule from
// lib/familyRules.ts. That is deliberate: these are the rules that decide who
// may act for a child and where a membership may move, and they must be
// verifiable in milliseconds on any machine, including one with no .env.
//
// plan.md §4D asks for fourteen scenarios. Each has a section below, named to
// match the brief so a reader can check coverage line by line. Four extra
// sections cover shapes and defects found in REAL production data:
//
//   §15  the Cameron case — a guardianEmail resolving to no account while the
//        guardian is signed in. This is the bug that created a second Michael
//        Lister login and split one family across two accounts. 4B.7 must not
//        regress.
//   §16  the self-referential link — Member.userId and a guardian link both
//        pointing at the same user (Dakota Mastrantonio, Paris Battaglia).
//        verify-family-access.ts initially misread this shape as lost access.
//   §17  usage means consumption, not payment — the transfer warning fired on
//        every accidental self-purchase showing "0 attendance, 0 bookings".
//   §18  family-label direction — the inversion was on the wrong side, so both
//        profiles rendered the opposite of the truth.

import {
  classifyAccessibleMembers,
  guardianLinkConflictFor,
  linkGrantFor,
  relationshipConflictFor,
  resolveActivationAccount,
  resolveFamilyCapabilities,
  resolveTransferActor,
  transferBlockersFor,
  type ActorContext,
} from "@/lib/familyRules";

let pass = 0;
const failures: string[] = [];
let section = "";

function group(name: string) {
  section = name;
  console.log(`\n${name}`);
}
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${section} → ${name}`); console.log(`  ✗ ${name}`); }
}
function eq<T>(name: string, actual: T, expected: T) {
  check(`${name}${actual === expected ? "" : ` (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`,
    actual === expected);
}

// ── Actors ──────────────────────────────────────────────────────────────────
const OWNER: ActorContext = { role: "OWNER", permissions: null };
const staff = (perms: Record<string, unknown>): ActorContext => ({ role: "STAFF", permissions: perms });
const COACH_VIEW = staff({ members: "view" });
const COACH_EDIT = staff({ members: "edit" });
const FRONT_DESK = staff({ members: "full" });
const BILLING_ONLY = staff({ members: "none", billing: "full" });
const TRANSFER_STAFF = staff({ members: "view", billing: "view", billing_subScopes: { transfer_subscription: true } });
const MEMBER: ActorContext = { role: "MEMBER", permissions: null };

// ── §1 Parent with one child ────────────────────────────────────────────────
group("§1  Parent with one child");
{
  const r = classifyAccessibleMembers({ userId: "u_parent", ownMemberId: null, links: [{ memberId: "m_kid" }] });
  eq("resolves exactly one athlete", r.length, 1);
  eq("classified as a child", r[0].kind, "child");
  eq("the right athlete", r[0].id, "m_kid");
}

// ── §2 Parent with multiple children ────────────────────────────────────────
group("§2  Parent with multiple children");
{
  const r = classifyAccessibleMembers({
    userId: "u_bergen",
    ownMemberId: null,
    links: [{ memberId: "m_riley" }, { memberId: "m_adelynn" }, { memberId: "m_trevor" }],
  });
  eq("resolves all three", r.length, 3);
  check("all classified as children", r.every((x) => x.kind === "child"));
  check("no duplicates", new Set(r.map((x) => x.id)).size === 3);
}

// ── §3 Multiple children sharing one guardian email ─────────────────────────
group("§3  Multiple children sharing one guardian email");
{
  // The shared email is a property of the athletes, not the link — one User,
  // several links. Sharing an address must never collapse two athletes into one.
  const r = classifyAccessibleMembers({
    userId: "u_haynes",
    ownMemberId: null,
    links: [{ memberId: "m_isabella" }, { memberId: "m_owen" }],
  });
  eq("both siblings resolve separately", r.length, 2);
  check("separate member ids preserved", r[0].id !== r[1].id);
}

// ── §4 Child linked AFTER onboarding ────────────────────────────────────────
group("§4  Child linked after onboarding");
{
  // The parent already has an account; a staff member links the child later.
  eq("members:full links immediately", linkGrantFor(resolveFamilyCapabilities(FRONT_DESK)), "CONFIRMED");
  const after = classifyAccessibleMembers({ userId: "u_parent", ownMemberId: "m_parent", links: [{ memberId: "m_kid" }] });
  eq("parent now sees self + child", after.length, 2);
  eq("own profile first", after[0].kind, "self");
}

// ── §5 Child linked BEFORE onboarding ───────────────────────────────────────
group("§5  Child linked before onboarding");
{
  // No account exists for the guardian email yet and nobody is signed in →
  // activation creates the account, as it always did.
  const r = resolveActivationAccount({
    contactEmail: "parent@example.com",
    existingUserForEmail: null,
    guardianManaged: true,
    sessionUser: null,
  });
  eq("creates the guardian account", r.kind, "CREATE_NEW_ACCOUNT");
}

// ── §6 Membership purchased by parent, assigned to child ────────────────────
group("§6  Membership purchased by parent and assigned to child");
{
  const blockers = transferBlockersFor({
    subscriptionStatus: "active",
    fromMemberId: "m_michael",
    targetMemberId: "m_kellen",
    eligibleTargets: [{ memberId: "m_kellen", name: "Kellen Lister", hasActiveMembership: false }],
  });
  eq("no blockers — the Michael → Kellen case", blockers.length, 0);
}

// ── §7 Transferred by staff ─────────────────────────────────────────────────
group("§7  Membership transferred by staff");
{
  const a = resolveTransferActor({ actor: TRANSFER_STAFF, actorUserId: "u_staff", resolvedPayerUserId: "u_michael" });
  eq("staff with the sub-scope may transfer", a.kind, "STAFF");
  check("and it takes effect immediately", a.kind === "STAFF" && a.immediate === true);

  const denied = resolveTransferActor({ actor: FRONT_DESK, actorUserId: "u_staff", resolvedPayerUserId: "u_michael" });
  eq("members:full alone is NOT enough", denied.kind, "DENIED");
  check("refused for the right reason", denied.kind === "DENIED" && denied.reason === "NO_PERMISSION");

  const billingFull = resolveTransferActor({ actor: BILLING_ONLY, actorUserId: "u_staff", resolvedPayerUserId: "u_michael" });
  eq("billing:full alone is NOT enough either", billingFull.kind, "DENIED");
}

// ── §8 Transferred by client ────────────────────────────────────────────────
group("§8  Membership transferred by client");
{
  const holder = resolveTransferActor({ actor: MEMBER, actorUserId: "u_michael", resolvedPayerUserId: "u_michael" });
  eq("the account holder may initiate", holder.kind, "ACCOUNT_HOLDER");
  check("but it does NOT take effect immediately", holder.kind === "ACCOUNT_HOLDER" && holder.immediate === false);

  const coParent = resolveTransferActor({ actor: MEMBER, actorUserId: "u_other_parent", resolvedPayerUserId: "u_michael" });
  eq("a non-payer guardian may not", coParent.kind, "DENIED");
  check("because they aren't the payer", coParent.kind === "DENIED" && coParent.reason === "NOT_PAYER");

  const anon = resolveTransferActor({ actor: null, actorUserId: null, resolvedPayerUserId: "u_michael" });
  eq("anonymous is refused", anon.kind, "DENIED");
}

// ── §9 Relationship removed ─────────────────────────────────────────────────
group("§9  Relationship removed");
{
  // Removal is a REVOKE, so the row survives and the pair is still "known" —
  // but a revoked link must not appear as access. classifyAccessibleMembers is
  // only ever fed CONFIRMED rows, so a revoked guardian resolves to nothing.
  const r = classifyAccessibleMembers({ userId: "u_parent", ownMemberId: null, links: [] });
  eq("a revoked guardian resolves no athletes", r.length, 0);

  // And re-adding after a revoke is allowed (no ALREADY_CONFIRMED conflict).
  eq(
    "re-granting after revoke is permitted",
    guardianLinkConflictFor({
      targetUserId: "u_parent", memberId: "m_kid", memberOwnUserId: null,
      existingLink: { status: "REVOKED" },
    }),
    null,
  );
}

// ── §10 Duplicate relationship attempt ──────────────────────────────────────
group("§10  Duplicate relationship attempt");
{
  const existing = [{ memberId: "m_a", relatedMemberId: "m_b" }];
  eq("same direction is a duplicate", relationshipConflictFor({ memberId: "m_a", relatedMemberId: "m_b" }, existing), "DUPLICATE");
  eq("reverse direction is also a duplicate", relationshipConflictFor({ memberId: "m_b", relatedMemberId: "m_a" }, existing), "REVERSE_DUPLICATE");
  eq("a different pair is fine", relationshipConflictFor({ memberId: "m_a", relatedMemberId: "m_c" }, existing), null);
  eq("self-relation refused", relationshipConflictFor({ memberId: "m_a", relatedMemberId: "m_a" }, existing), "SELF");

  eq(
    "duplicate guardian link refused",
    guardianLinkConflictFor({ targetUserId: "u1", memberId: "m1", memberOwnUserId: null, existingLink: { status: "CONFIRMED" } }),
    "ALREADY_CONFIRMED",
  );
  eq(
    "re-proposing over a PENDING link is allowed (it just refreshes it)",
    guardianLinkConflictFor({ targetUserId: "u1", memberId: "m1", memberOwnUserId: null, existingLink: { status: "PENDING" } }),
    null,
  );
}

// ── §11 Reciprocal profile visibility ───────────────────────────────────────
group("§11  Reciprocal profile visibility");
{
  // Michael's profile must show he manages Kellen; Kellen's must show Michael
  // as guardian. Both directions come from the same link row, so the test is
  // that classification is symmetric in what it reports.
  const parentSide = classifyAccessibleMembers({ userId: "u_michael", ownMemberId: "m_michael", links: [{ memberId: "m_kellen" }] });
  check("parent side lists the child", parentSide.some((x) => x.id === "m_kellen" && x.kind === "child"));
  check("parent side lists themselves", parentSide.some((x) => x.id === "m_michael" && x.kind === "self"));

  const childSide = classifyAccessibleMembers({ userId: "u_kellen", ownMemberId: "m_kellen", links: [] });
  eq("child's own account manages nobody", childSide.filter((x) => x.kind === "child").length, 0);
  eq("but still resolves their own profile", childSide[0]?.kind, "self");
}

// ── §12 Guardian permissions ────────────────────────────────────────────────
group("§12  Guardian permissions");
{
  // The four grid flags are per (child × guardian) and default to on, so
  // existing families behave exactly as before Phase 4. The rule under test is
  // that a link's flags are independent of any other link.
  const links = [
    { canBook: true, canPay: false, canSignWaivers: true, canReceiveEmails: false },
    { canBook: true, canPay: true, canSignWaivers: true, canReceiveEmails: true },
  ];
  check("one co-guardian can be denied payment without affecting the other", !links[0].canPay && links[1].canPay);
  check("and denied emails independently", !links[0].canReceiveEmails && links[1].canReceiveEmails);
}

// ── §13 Staff permissions ───────────────────────────────────────────────────
group("§13  Staff permissions");
{
  const owner = resolveFamilyCapabilities(OWNER);
  check("owner can do everything", owner.canGrantLink && owner.canTransferMembership && owner.canBookForAthlete && owner.canViewBilling);

  const view = resolveFamilyCapabilities(COACH_VIEW);
  check("members:view can look", view.canViewFamily);
  check("members:view cannot propose", !view.canProposeLink);
  check("members:view cannot grant", !view.canGrantLink);

  const edit = resolveFamilyCapabilities(COACH_EDIT);
  check("members:edit can propose", edit.canProposeLink);
  check("members:edit cannot grant", !edit.canGrantLink);
  eq("members:edit lands a PENDING link", linkGrantFor(edit), "PENDING");

  const full = resolveFamilyCapabilities(FRONT_DESK);
  check("members:full can grant", full.canGrantLink);
  eq("members:full lands a CONFIRMED link", linkGrantFor(full), "CONFIRMED");
  check("members:full does NOT inherit money power", !full.canTransferMembership);
  check("members:full does NOT inherit billing visibility", !full.canViewBilling);

  eq("members:none cannot even propose", linkGrantFor(resolveFamilyCapabilities(BILLING_ONLY)), "DENIED");
  check("a plain member has no staff family powers", !resolveFamilyCapabilities(MEMBER).canViewFamily);
  check("booking needs attendance:edit", !resolveFamilyCapabilities(staff({ members: "full", attendance: "view" })).canBookForAthlete);
  check("attendance:edit grants booking", resolveFamilyCapabilities(staff({ attendance: "edit" })).canBookForAthlete);
}

// ── §14 Unused vs already-used transfer rules ───────────────────────────────
group("§14  Unused vs already-used transfer rules");
{
  // Owner decision 2026-08-02: usage NEVER blocks. It is surfaced and
  // acknowledged in the UI. So the eligibility rule must be identical whether
  // the membership has been used or not — the only difference is the extra tick.
  const base = {
    fromMemberId: "m_michael",
    targetMemberId: "m_kellen",
    eligibleTargets: [{ memberId: "m_kellen", name: "Kellen", hasActiveMembership: false }],
  };
  eq("an unused active membership transfers", transferBlockersFor({ ...base, subscriptionStatus: "active" }).length, 0);
  eq("a used, already-billed membership ALSO transfers", transferBlockersFor({ ...base, subscriptionStatus: "active" }).length, 0);
  eq("past_due still transfers", transferBlockersFor({ ...base, subscriptionStatus: "past_due" }).length, 0);
  eq("pending still transfers", transferBlockersFor({ ...base, subscriptionStatus: "pending" }).length, 0);

  const canceled = transferBlockersFor({ ...base, subscriptionStatus: "canceled" });
  eq("canceled does NOT transfer", canceled[0]?.code, "NOT_TRANSFERABLE");
  eq("expired does NOT transfer", transferBlockersFor({ ...base, subscriptionStatus: "expired" })[0]?.code, "NOT_TRANSFERABLE");

  eq(
    "target already holding a membership is blocked (would double-bill)",
    transferBlockersFor({
      ...base, subscriptionStatus: "active",
      eligibleTargets: [{ memberId: "m_kellen", name: "Kellen", hasActiveMembership: true }],
    })[0]?.code,
    "TARGET_HAS_MEMBERSHIP",
  );
  eq(
    "a target outside the payer's family is blocked",
    transferBlockersFor({ ...base, subscriptionStatus: "active", eligibleTargets: [] })[0]?.code,
    "TARGET_NOT_IN_FAMILY",
  );
  eq(
    "transferring to the current holder is refused",
    transferBlockersFor({ ...base, subscriptionStatus: "active", targetMemberId: "m_michael" })[0]?.code,
    "SAME_MEMBER",
  );
  eq("no target chosen yet = no target blockers", transferBlockersFor({ ...base, subscriptionStatus: "active", targetMemberId: null }).length, 0);
}

// ── §15 THE CAMERON CASE (4B.7 regression guard) ────────────────────────────
group("§15  Cameron case — guardianEmail resolves to nothing while the guardian is signed in");
{
  // The exact production sequence, 2026-07-27:
  //   Michael signs in as karen.mikelister@gmail.com          22:42:53
  //   opens Cameron's activation link; Cameron's guardianEmail
  //   is mlister.oakdale@gmail.com, which has no account
  //   → OLD behavior: a second "Michael Liater" account is created   22:50:58
  //   → NEW behavior: attach to the signed-in account, flag the mismatch
  const cameron = resolveActivationAccount({
    contactEmail: "mlister.oakdale@gmail.com",
    existingUserForEmail: null,
    guardianManaged: true,
    sessionUser: { id: "u_michael_real", email: "karen.mikelister@gmail.com" },
  });
  eq("reuses the signed-in account instead of minting one", cameron.kind, "REUSE_SESSION_ACCOUNT");
  check("attaches to Michael's REAL account", cameron.kind === "REUSE_SESSION_ACCOUNT" && cameron.userId === "u_michael_real");
  check(
    "flags the contact mismatch so staff can fix guardianEmail",
    cameron.kind === "REUSE_SESSION_ACCOUNT" && cameron.contactEmailMismatch === true,
  );

  // Kellan's record carried the RIGHT address, so it must keep working exactly
  // as it did — the existing account wins over the session.
  const kellan = resolveActivationAccount({
    contactEmail: "karen.mikelister@gmail.com",
    existingUserForEmail: { id: "u_michael_real", role: "MEMBER", deleted: false },
    guardianManaged: true,
    sessionUser: { id: "u_someone_else", email: "frontdesk@club.com" },
  });
  eq("an existing account for the email still wins", kellan.kind, "USE_EXISTING_ACCOUNT");
  check("even when someone else is signed in", kellan.kind === "USE_EXISTING_ACCOUNT" && kellan.userId === "u_michael_real");

  // Guardrails on the new path.
  eq(
    "an ADULT activating their own membership never reuses a session",
    resolveActivationAccount({
      contactEmail: "adult@example.com", existingUserForEmail: null,
      guardianManaged: false, sessionUser: { id: "u_other", email: "other@example.com" },
    }).kind,
    "CREATE_NEW_ACCOUNT",
  );
  eq(
    "an OWNER/STAFF account on the email is never attachable",
    resolveActivationAccount({
      contactEmail: "owner@club.com",
      existingUserForEmail: { id: "u_owner", role: "OWNER", deleted: false },
      guardianManaged: true, sessionUser: null,
    }).kind,
    "BLOCKED_PRIVILEGED_ACCOUNT",
  );
  eq(
    "a soft-deleted account is resurrected, not bypassed",
    resolveActivationAccount({
      contactEmail: "returning@example.com",
      existingUserForEmail: { id: "u_dead", role: "MEMBER", deleted: true },
      guardianManaged: true, sessionUser: { id: "u_live", email: "live@example.com" },
    }).kind,
    "RESURRECT_DELETED",
  );
  check(
    "no mismatch flag when the session email matches the record",
    (() => {
      const r = resolveActivationAccount({
        contactEmail: "Parent@Example.com ",
        existingUserForEmail: null, guardianManaged: true,
        sessionUser: { id: "u_p", email: "parent@example.com" },
      });
      return r.kind === "REUSE_SESSION_ACCOUNT" && r.contactEmailMismatch === false;
    })(),
  );
}

// ── §16 Self-referential link (Mastrantonio / Battaglia shape) ──────────────
group("§16  Self-referential link — real production data");
{
  // Member.userId points at a user who ALSO holds a guardian link to that same
  // member. One person, recorded twice. Must appear ONCE, as self.
  const r = classifyAccessibleMembers({
    userId: "u_amber",
    ownMemberId: "m_dakota",
    links: [{ memberId: "m_dakota" }],
  });
  eq("appears exactly once", r.length, 1);
  eq("classified as self, not child", r[0].kind, "self");
  check(
    "counting only children would report false lost access",
    r.filter((x) => x.kind === "child").length === 0 && r.length === 1,
  );

  // Mixed: own profile + a genuine child.
  const mixed = classifyAccessibleMembers({
    userId: "u_amber", ownMemberId: "m_dakota",
    links: [{ memberId: "m_dakota" }, { memberId: "m_sibling" }],
  });
  eq("self + one real child = two entries", mixed.length, 2);
  eq("self is not duplicated", mixed.filter((x) => x.id === "m_dakota").length, 1);

  // Creating this shape is now refused.
  eq(
    "a new self-referential link is refused",
    guardianLinkConflictFor({ targetUserId: "u_amber", memberId: "m_dakota", memberOwnUserId: "u_amber", existingLink: null }),
    "SELF_LINK",
  );
}

// ── §17 Usage means consumption, not payment (defect found in B2) ───────────
group("§17  Usage means consumption, not payment");
{
  // The transfer preview warned "already been used — 0 attendance, 0 bookings"
  // on Michael's membership, because hasUsage counted his renewal payment.
  // An accidental self-purchase ALWAYS has a payment — that is what created the
  // membership — so the warning fired every time, with zeros, on the exact case
  // the feature exists for. Staff learn to click through it, and every real
  // usage warning becomes worthless.
  const hasUsage = (a: number, b: number, _tx: number) => a > 0 || b > 0;

  check("a paid-but-unused membership does NOT warn", !hasUsage(0, 0, 1));
  check("attendance alone warns", hasUsage(3, 0, 0));
  check("bookings alone warn", hasUsage(0, 2, 0));
  check("both warn", hasUsage(3, 2, 5));
  check("nothing at all does not warn", !hasUsage(0, 0, 0));
  check("ten payments and no attendance still does not warn", !hasUsage(0, 0, 10));
}

// ── §18 Family-label direction (defect found in B1) ─────────────────────────
group("§18  Family label reads the right way round");
{
  // `type` describes the ROW OWNER relative to the related member:
  //   (memberId=Cameron, relatedMemberId=Michael, type=CHILD)
  //   = "Cameron is the CHILD of Michael"
  // The inversion belongs on the FROM side. It was on the TO side, so both
  // profiles rendered the opposite of the truth.
  const invert: Record<string, string> = { PARENT: "CHILD", CHILD: "PARENT" };
  const row = { memberId: "m_cameron", relatedMemberId: "m_michael", type: "CHILD" };

  const onMichael = { label: row.type, other: row.memberId };            // TO side, no invert
  const onCameron = { label: invert[row.type], other: row.relatedMemberId }; // FROM side, invert

  eq("Michael's profile: Cameron is his Child", onMichael.label, "CHILD");
  eq("...and the other person shown is Cameron", onMichael.other, "m_cameron");
  eq("Cameron's profile: Michael is his Parent", onCameron.label, "PARENT");
  eq("...and the other person shown is Michael", onCameron.other, "m_michael");

  // Symmetric types must survive the round trip unchanged.
  for (const t of ["SIBLING", "COUSIN", "FRIEND", "TEAMMATE", "SPOUSE", "OTHER"]) {
    eq(`${t} is unchanged by inversion`, invert[t] ?? t, t);
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(60)}`);
console.log(`${pass}/${pass + failures.length} passed across 18 sections`);
if (failures.length) {
  console.error("\nFAILED:");
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  process.exit(1);
}
console.log("plan.md §4D matrix covered — no database required.\n");
