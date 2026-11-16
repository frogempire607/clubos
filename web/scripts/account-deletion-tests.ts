/**
 * Deleting your own account: who may, what goes, what stays, what is said.
 *
 *   npx tsx scripts/account-deletion-tests.ts
 *
 * No database, no network. The rules are pure (lib/accountDeletion.ts); the
 * ordering guarantees of the database half are checked in source.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  planAccountDeletion, deletionConfirmed, nameList, tombstoneEmail, isTombstoneEmail,
  type AccountDeletionFacts,
} from "../lib/accountDeletion";

const ROOT = join(__dirname, "..");
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1);

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}
const base: AccountDeletionFacts = { role: "MEMBER", otherOwners: 0, hasOwnMemberProfile: false, children: [], liveCardMemberships: [] };
const facts = (o: Partial<AccountDeletionFacts>): AccountDeletionFacts => ({ ...base, ...o });
const all = (p: { removed: string[]; kept: string[]; consequences: string[] }) => [...p.removed, ...p.kept, ...p.consequences].join(" | ");

console.log("\n§1 every kind of account can delete itself");
for (const role of ["MEMBER", "STAFF"] as const) {
  check(`${role}: allowed`, planAccountDeletion(facts({ role })).allowed);
}
check("OWNER with another owner: allowed", planAccountDeletion(facts({ role: "OWNER", otherOwners: 1 })).allowed);
{
  const p = planAccountDeletion(facts({ role: "OWNER", otherOwners: 0 }));
  check("the ONLY owner is refused", !p.allowed);
  check("…and is told the two ways forward", /another owner/i.test(p.blockedReason ?? "") && /close the club/i.test(p.blockedReason ?? ""));
  check("…with nothing listed as removed (nothing will be)", p.removed.length === 0 && p.kept.length === 0);
}
check("a member is never asked about owners", planAccountDeletion(facts({ role: "MEMBER", otherOwners: 0 })).allowed);
check("a membership still being charged does NOT block deletion", planAccountDeletion(facts({ liveCardMemberships: [{ athleteName: "Avery Stone", planName: "Youth" }] })).allowed);
check("being a child's only guardian does NOT block deletion", planAccountDeletion(facts({ children: [{ name: "Sam Reed", otherGuardians: 0 }] })).allowed);

console.log("\n§2 it is a deletion, and it says what is kept");
{
  const p = planAccountDeletion(facts({ role: "MEMBER", hasOwnMemberProfile: true }));
  check("the sign-in (email, password) is removed", /email address, password/i.test(p.removed.join(" ")));
  check("signed out everywhere, straight away", /signed out everywhere/i.test(p.removed.join(" ")));
  check("the athlete profile leaves the active roster", /athlete profile/i.test(p.removed.join(" ")));
  check("payment records are named as kept, with the reason", /payment records/i.test(p.kept.join(" ")) && /books|tax/i.test(p.kept.join(" ")));
  check("signed documents and attendance are named as kept", /waivers/i.test(p.kept.join(" ")) && /attendance/i.test(p.kept.join(" ")));
  check("it says it cannot be undone", /cannot be undone/i.test(p.consequences.join(" ")));
  check("it never offers a pause or deactivation instead", !/deactivat|pause|suspend|disable/i.test(all(p)));
}
{
  const staff = planAccountDeletion(facts({ role: "STAFF" }));
  check("staff: schedule and calendar link are removed", /schedule/i.test(staff.removed.join(" ")) && /calendar link/i.test(staff.removed.join(" ")));
  check("staff: their name stays on records they created, and it says so", /your name on records/i.test(staff.kept.join(" ")));
  const member = planAccountDeletion(facts({ role: "MEMBER" }));
  check("member: no claim that their name is kept on staff records", !/payroll/i.test(member.kept.join(" ")));
}

console.log("\n§3 children");
{
  const shared = planAccountDeletion(facts({ children: [{ name: "Sam Reed", otherGuardians: 1 }] }));
  check("another guardian keeps access — and it says so by name", /Sam Reed stays with the club/.test(shared.consequences.join(" ")) && /keeps full access/.test(shared.consequences.join(" ")));
  const alone = planAccountDeletion(facts({ children: [{ name: "Sam Reed", otherGuardians: 0 }, { name: "Jo Reed", otherGuardians: 0 }] }));
  const t = alone.consequences.join(" ");
  check("the only guardian is warned, naming each child", /only parent or guardian/.test(t) && /Sam Reed and Jo Reed/.test(t));
  check("…that the records stay with the club", /stay with the club/.test(t));
  check("…and how to ask for a child's information to be removed", /ask the club/.test(t));
  const mixed = planAccountDeletion(facts({ children: [{ name: "A B", otherGuardians: 2 }, { name: "C D", otherGuardians: 0 }] }));
  check("a mixed family gets both messages", mixed.consequences.filter((c) => /A B|C D/.test(c)).length === 2);
  check("no children, no child wording", !/guardian/i.test(planAccountDeletion(base).consequences.join(" ")));
}

console.log("\n§4 a membership whose card is still being charged");
{
  const p = planAccountDeletion(facts({ liveCardMemberships: [{ athleteName: "Avery Stone", planName: "Youth 2x" }] }));
  const t = p.consequences.join(" ");
  check("it says deleting does not cancel the membership", /does not cancel a membership/i.test(t));
  check("it names the athlete and the plan", /Avery Stone — Youth 2x/.test(t));
  check("it says a cancellation request goes to the club", /cancellation request/i.test(t));
  check("the athlete profile is NOT listed as removed while a card is running", !/athlete profile/i.test(planAccountDeletion(facts({ hasOwnMemberProfile: true, liveCardMemberships: [{ athleteName: "Me", planName: "Adult" }] })).removed.join(" ")));
  check("no dollar amount is quoted (the club's terms decide)", !/\$\d/.test(t));
}

console.log("\n§5 confirmation and the released email");
check('"delete" confirms', deletionConfirmed("delete"));
check("case and stray spaces are forgiven", deletionConfirmed("  DELETE ") && deletionConfirmed("Delete"));
for (const bad of ["", " ", "delet", "delete it", "yes", null, undefined]) check(`${JSON.stringify(bad)} does not confirm`, !deletionConfirmed(bad as string));
check("nameList: one / two / three", nameList(["A"]) === "A" && nameList(["A", "B"]) === "A and B" && nameList(["A", "B", "C"]) === "A, B and C" && nameList([]) === "");
{
  const t = tombstoneEmail("user_123");
  check("the tombstone address can never receive mail (.invalid)", t.endsWith(".invalid") && isTombstoneEmail(t));
  check("it is unique per account (so the unique index holds)", tombstoneEmail("a") !== tombstoneEmail("b"));
  check("a real address is not mistaken for one", !isTombstoneEmail("parent@example.com") && !isTombstoneEmail(null));
}

console.log("\n§6 the database half does things in a safe order");
{
  const src = code("lib/accountDeletionServer.ts");
  const fn = src.slice(src.indexOf("export async function deleteOwnAccount"));
  const before = (a: string, b: string) => fn.indexOf(a) >= 0 && fn.indexOf(b) >= 0 && fn.indexOf(a) < fn.indexOf(b);
  check("a refused plan stops before anything is written", before("if (!plan.allowed) return", "prisma.pendingApproval.create"));
  check("the club is told about live memberships BEFORE the login is removed", before("kind: MEMBERSHIP_CANCEL_KIND", "await prisma.$transaction("));
  check("a cancellation request is not filed twice for one membership", /if \(already\) continue;/.test(fn));
  check("it never cancels a Stripe subscription itself", !/stripe\./.test(src) && !/from "@\/lib\/stripe"/.test(src));
  check("guardian links are REVOKED (kept for the record), not deleted", /status: GUARDIAN_LINK_STATUS\.REVOKED/.test(fn) && !/memberGuardianUser\.delete/.test(fn));
  check("the members_userId slot is always released", /\{ userId: null \}/.test(fn) && /deletedAt: now, userId: null/.test(fn));
  check("a member whose card is still charged is NOT archived", /ownMemberKeepsBilling \? \{ userId: null \}/.test(fn));
  check("the email is released and the password made unusable", /email: tombstoneEmail\(userId\)/.test(fn) && /passwordHash: `deleted:/.test(fn));
  check("reset links die with the account", /resetToken: null/.test(fn));
  check("it acts only on the caller's own user id", !/params\.id|body\.userId|targetUserId/.test(src));
  check("live sessions are revoked", /invalidatePermissionCache\(userId\)/.test(fn));
}
{
  const route = code("app/api/account/deletion/route.ts");
  check("DELETE requires the typed confirmation", /deletionConfirmed\(body\?\.confirm\)/.test(route));
  check("the user id comes from the session, never the request", /userId: session\.user\.id/.test(route) && !/body\?\.userId|searchParams/.test(route));
  const legacy = code("app/api/member/me/route.ts");
  check("the member portal's delete goes through the same implementation", /deleteOwnAccount\(/.test(legacy) && !/tx\.user\.update\(\{ where: \{ id: session\.user\.id \}, data: \{ deletedAt: now \} \}\)/.test(legacy));
}

console.log("\n§7 it is reachable where the stores require");
check("public /delete-account page exists (Google's web link)", existsSync(join(ROOT, "app/delete-account/page.tsx")));
{
  const page = code("app/delete-account/page.tsx");
  check("the public page names the app and the company", /AthletixOS/.test(page) && /MC Technologies Group LLC/.test(page));
  check("the public page is built from the same rules as the app", /planAccountDeletion\(/.test(page));
  check("member portal: delete + privacy + terms", /DeleteAccountDialog/.test(code("app/member/profile/page.tsx")) && /href="\/privacy"/.test(code("app/member/profile/page.tsx")) && /href="\/terms"/.test(code("app/member/profile/page.tsx")));
  check("staff and owners: delete + privacy + terms", /DeleteAccountDialog/.test(code("app/dashboard/my-account/page.tsx")) && /href="\/privacy"/.test(code("app/dashboard/my-account/page.tsx")) && /href="\/terms"/.test(code("app/dashboard/my-account/page.tsx")));
  const mw = code("middleware.ts");
  check("middleware does not guard /delete-account", !/delete-account/.test(mw) && /matcher: \["\/dashboard\/:path\*", "\/admin\/:path\*", "\/member\/:path\*"\]/.test(mw));
}

console.log(`\n${"─".repeat(70)}`);
if (failed) {
  console.log(`✗ ${failed} account-deletion check(s) failed\n`);
  process.exit(1);
}
console.log("✓ account-deletion tests passed\n");
