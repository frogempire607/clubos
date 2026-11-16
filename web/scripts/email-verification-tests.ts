/**
 * An email address only links an account to somebody else's record once the
 * person has proved they receive mail there.
 *
 *   npx tsx scripts/email-verification-tests.ts
 *
 * No database, no network. The rule and the signed link are pure
 * (lib/emailVerification.ts). The places that used to link on an unproven
 * address are checked in source, because the bug in each was a link made at
 * the wrong moment — an ordering no arithmetic test would see.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMAIL_VERIFICATION_REQUIRED_FROM, EMAIL_VERIFICATION_TTL_MS,
  emailFingerprint, isEmailVerified, readVerificationToken, signVerificationToken, verificationProblemMessage,
} from "../lib/emailVerification";
import { LOGIN_SECRET_FIELDS, withoutLoginSecrets } from "../lib/loginSecrets";

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

const SECRET = "test-secret-not-a-real-one";
// Relative to the rule's own start, and to "now" — never a calendar date.
const now = new Date(Date.now());
const after = new Date(EMAIL_VERIFICATION_REQUIRED_FROM.getTime() + 60_000);
const before = new Date(EMAIL_VERIFICATION_REQUIRED_FROM.getTime() - 60_000);

console.log("\n§1 who counts as having proved their address");
check("a new account that has not confirmed: NOT verified", !isEmailVerified({ emailVerified: null, createdAt: after }));
check("a new account that confirmed: verified", isEmailVerified({ emailVerified: now, createdAt: after }));
check("an account from before the rule keeps working as it did", isEmailVerified({ emailVerified: null, createdAt: before }));
check("an account created exactly when the rule starts must confirm", !isEmailVerified({ emailVerified: null, createdAt: EMAIL_VERIFICATION_REQUIRED_FROM }));
check("undefined is treated like null", !isEmailVerified({ emailVerified: undefined, createdAt: after }));

console.log("\n§2 the emailed link");
{
  const t = signVerificationToken({ userId: "user_1", email: "Parent@Example.com", now }, SECRET);
  const r = readVerificationToken(t, SECRET, now);
  check("a fresh link reads back the user it was made for", r.ok && r.claim.userId === "user_1");
  check("…and is bound to the address, case-insensitively", r.ok && r.claim.emailFingerprint === emailFingerprint("parent@example.com"));
  check("a different address has a different fingerprint", emailFingerprint("parent@example.com") !== emailFingerprint("other@example.com"));
  check("the address itself is not readable in the link", !t.includes("parent") && !Buffer.from(t.split(".")[0], "base64").toString().includes("example.com"));

  const justInside = new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS - 1000);
  const justOutside = new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS + 1000);
  check("it still works just inside its lifetime", readVerificationToken(t, SECRET, justInside).ok);
  const expired = readVerificationToken(t, SECRET, justOutside);
  check("it stops working after its lifetime", !expired.ok && expired.reason === "EXPIRED");

  const wrongKey = readVerificationToken(t, "another-secret", now);
  check("a link signed with a different key is refused", !wrongKey.ok && wrongKey.reason === "BAD_SIGNATURE");

  // Forgery: keep the signature, swap the user id in the payload.
  const forgedPayload = Buffer.from(JSON.stringify({ u: "victim", e: emailFingerprint("parent@example.com"), x: now.getTime() + 60_000 })).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const forged = readVerificationToken(`${forgedPayload}.${t.split(".")[1]}`, SECRET, now);
  check("changing who the link is for breaks the signature", !forged.ok && forged.reason === "BAD_SIGNATURE");

  for (const bad of ["", "abc", "a.b.c", ".", "a.", ".b", null, undefined, "x".repeat(5000)]) {
    const r2 = readVerificationToken(bad as string, SECRET, now);
    check(`${JSON.stringify(typeof bad === "string" && bad.length > 20 ? "(very long)" : bad)} is refused, never thrown on`, !r2.ok);
  }
  const noSecret = readVerificationToken(t, undefined, now);
  check("with no signing key configured, every link is refused (fails closed)", !noSecret.ok && noSecret.reason === "NOT_CONFIGURED");
  let threw = false;
  try { signVerificationToken({ userId: "u", email: "a@b.c", now }, undefined); } catch { threw = true; }
  check("with no signing key configured, no link is issued at all", threw);
  for (const r3 of ["MALFORMED", "BAD_SIGNATURE", "EXPIRED", "NOT_CONFIGURED", "ADDRESS_CHANGED", "NO_ACCOUNT"] as const) {
    check(`"${r3}" has a plain message`, verificationProblemMessage(r3).length > 20);
  }
}

console.log("\n§3 signup no longer links on an address nobody has proved");
{
  const src = code("app/api/member/signup/route.ts");
  check("an existing record with the same email is NOT connected at signup", !/memberProfile:\s*\{\s*connect:/.test(src));
  check("…and is not overwritten with what the person typed", !/prisma\.member\.update\(\{\s*where: \{ id: existingMember\.id \}/.test(src));
  check("the children-under-this-email sweep only counts; it links nobody", !/vouchedChildren/.test(src) && /const sweptChildren = 0;/.test(src));
  check("a vouched child named at signup waits for the confirmation", /isOwnerVouched\(childMember, data\.email\.toLowerCase\(\)\)\) \{\s*emailLinkPending = true;/.test(src));
  check("the one guardian request signup still makes is marked unproven", /emailVerified: false,/.test(src) && !/emailVerified: true/.test(src));
  check("a confirmation email is sent on every signup", /sendVerificationEmail\(/.test(src));
  check("the response says when something is waiting", /emailLinkPending,/.test(src));
  check("a child the parent CREATED at signup is still theirs straight away (nothing to claim)", /source: GUARDIAN_LINK_SOURCE\.CHILD_SIGNUP/.test(src));
}

console.log("\n§4 the shared linking helpers ask the question themselves");
{
  const g = code("lib/guardianLink.ts");
  check("requestGuardianLink requires `emailVerified` (no caller can forget it)", /emailVerified: boolean;/.test(g));
  check("an owner-vouched email only auto-links when it is proved", /if \(emailVerified && isOwnerVouched\(child, requestingUserEmail\)\)/.test(g));
  check("there is no other path to a CONFIRMED link in that function", (g.match(/status: "CONFIRMED"/g) ?? []).length === 1);
  const m = code("lib/memberLink.ts");
  const fn = m.slice(m.indexOf("export async function findOrAutoLinkMember"), m.indexOf("export async function deleteOrphanedMemberLogins"));
  check("findOrAutoLinkMember checks the proof BEFORE its email lookup", fn.indexOf("isEmailVerified(account)") > 0 && fn.indexOf("isEmailVerified(account)") < fn.indexOf("email: userEmail.toLowerCase()"));
  check("…and a login already linked by id is unaffected", fn.indexOf("if (byUserId) return byUserId;") < fn.indexOf("isEmailVerified(account)"));
  const lc = code("app/api/member/portal/link-child/route.ts");
  check("'link my child' passes the account's real proof, not a constant", /emailVerified: !!self && isEmailVerified\(self\)/.test(lc));
}

console.log("\n§5 confirming");
{
  const s = code("lib/emailLinkServer.ts");
  const confirm = s.slice(s.indexOf("export async function confirmEmailWithToken"));
  check("the address on the account must still be the one the link was sent to", /emailFingerprint\(user\.email\) !== read\.claim\.emailFingerprint/.test(confirm));
  check("a removed account cannot be confirmed", /deletedAt: null/.test(confirm));
  check("links are made only after the proof is recorded", confirm.indexOf("emailVerified: new Date()") < confirm.indexOf("completeEmailLinks(user)"));
  const links = s.slice(s.indexOf("export async function completeEmailLinks"), s.indexOf("export async function sendVerificationEmail"));
  check("claiming a record is conditional on it still being unclaimed", /updateMany\(\{ where: \{ id: ownRecord\.id, userId: null \}/.test(links));
  check("a minor's consent request goes to the guardian the CLUB has on file", /guardianEmail: ownRecord\.guardianEmail\.toLowerCase\(\)/.test(links));
  check("children are linked through the one gated helper, marked proved", /requestGuardianLink\(\{[\s\S]{0,260}emailVerified: true/.test(links));
  check("only minors the club listed under this email are swept", /isMinor: true/.test(s) && /isOwnerVouched\(c, email\)/.test(s));
  const route = code("app/api/auth/verify-email/route.ts");
  check("confirming is a POST (a mail scanner opening the link confirms nothing)", /export async function POST/.test(route) && !/export async function GET/.test(route));
  check("the page confirms on a button press, not on load", /onClick=\{confirm\}/.test(code("app/verify-email/page.tsx")) && !/useEffect/.test(code("app/verify-email/page.tsx")));
  const resend = code("app/api/member/email-verification/route.ts");
  check("resending is rate-limited and goes to the account's own address", /rateLimit\(/.test(resend) && !/body\.email|searchParams/.test(resend));
  check("the portal shows the banner", /<VerifyEmailBanner \/>/.test(code("app/member/layout.tsx")));
}

console.log("\n§6 links that already arrive by email count as proof");
check("setting a password from an emailed link stamps the proof", /emailVerified: user\.emailVerified \?\? new Date\(\)/.test(code("app/api/auth/reset-password/route.ts")));
{
  const act = code("app/api/members/migration/activate/[token]/route.ts");
  check("activation stamps it only for the address the link was sent to", (act.match(/provedByActivationLink\(member\.id, contactEmail\)/g) ?? []).length === 2);
  check("…checked against the delivery record, not the form", /memberInvitationDelivery\.findFirst/.test(code("lib/emailLinkServer.ts")));
}

console.log("\n§7 login secrets never leave the server");
{
  const row = { id: "u1", email: "a@b.c", passwordHash: "$2b$12$x", resetToken: "tok", resetExpires: now, memberProfile: { id: "m1" } };
  const safe = withoutLoginSecrets(row) as Record<string, unknown>;
  check("hash, reset token and its expiry are removed", LOGIN_SECRET_FIELDS.every((f) => !(f in safe)));
  check("everything else is kept", safe.id === "u1" && safe.email === "a@b.c" && (safe.memberProfile as { id: string }).id === "m1");
  check("the original object is not changed", row.passwordHash === "$2b$12$x");
  const portal = code("app/api/member/portal/route.ts");
  check("the portal payload goes through withoutLoginSecrets", /withoutLoginSecrets\(user\)/.test(portal) && !/NextResponse\.json\(\{ user, club, summaries \}\)/.test(portal));
}

console.log(`\n${"─".repeat(70)}`);
if (failed) {
  console.log(`✗ ${failed} email-verification check(s) failed\n`);
  process.exit(1);
}
console.log("✓ email-verification tests passed\n");
