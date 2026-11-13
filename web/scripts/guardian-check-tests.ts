/**
 * Portal routes that act on someone else's membership use ONE guardian check
 * (2026-11 security follow-up).
 *
 *   npx tsx scripts/guardian-check-tests.ts
 *
 * The autopay route looked the guardian link up bare — which also accepted a
 * link the club had not CONFIRMED yet. It now uses the same check as
 * /api/member/payment-method/setup.
 */
import { harness, src } from "./_followup-harness";

const { check, section, done } = harness();
const FIXED = [
  "app/api/member/subscriptions/[id]/autopay/route.ts",
  "app/api/member/subscriptions/request-cancel/route.ts",
  "app/api/member/memberships/change-request/route.ts",
];

section("the shared check");
{
  const ctx = src("lib/memberContext.ts");
  check("canManageMember goes through resolveFamilyContext", /export async function canManageMember[\s\S]*resolveFamilyContext\(userId, clubId, user\.email, memberId\)/.test(ctx));
  check("resolveFamilyContext only accepts ACTIVE (confirmed) links in this club", /where: \{ \.\.\.ACTIVE_GUARDIAN_LINK, userId, member: \{ clubId, deletedAt: null \} \}/.test(ctx));
  check("ACTIVE_GUARDIAN_LINK means CONFIRMED", /ACTIVE_GUARDIAN_LINK = \{\s*status: GUARDIAN_LINK_STATUS\.CONFIRMED/.test(src("lib/familyAccess.ts")));
  check("the reference route uses the same resolver", src("app/api/member/payment-method/setup/route.ts").includes("resolveFamilyContext(session.user.id, clubId, user.email"));
}

section("the routes");
for (const f of FIXED) {
  const s = src(f);
  check(`${f.split("/api/member/")[1]} uses canManageMember`, s.includes("canManageMember("));
  check("…and no longer looks the link up bare", !s.includes("memberGuardianUser.findUnique"));
}
done();
