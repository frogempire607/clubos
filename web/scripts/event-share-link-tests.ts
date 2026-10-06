// The private share link (/e/s-<token>) and the member / non-member price rule.
// PURE: no database.
//
//   npx tsx scripts/event-share-link-tests.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SHARE_PREFIX, SHARE_TOKEN_LENGTH, SHARE_TOKEN_ALPHABET, VIA_KEY, VIA_PRIVATE_LINK, VIA_LINK_ID_KEY,
  isShareToken, tokenFromBytes, parseLinkSegment, reserveSlug, sharePath, shareUrl, linkAccess,
  cameViaPrivateLink, viaLinkId, shareTokenForReturn, registerAgainPath, urlEventFor,
} from "../lib/eventShareLink";
import { registrationUrl, registrationReturnUrl } from "../lib/registrationUrl";
import { registrationListPrice, registrationPriceTiers } from "../lib/eventRepricing";
import { matchMemberForPublicSignup } from "../lib/registrationLink";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const TOKEN = "aB3dE6gH9jK2mN5pQ8rS"; // 20 base62
const base = "https://athletix-os.com";

console.log("\nToken:");
eq("token length", TOKEN.length, SHARE_TOKEN_LENGTH);
check("alphabet is 62 letters and digits", SHARE_TOKEN_ALPHABET.length === 62 && /^[A-Za-z0-9]+$/.test(SHARE_TOKEN_ALPHABET));
check("a 20-char base62 token is a token", isShareToken(TOKEN));
check("16 chars is the floor", isShareToken("a".repeat(16)) && !isShareToken("a".repeat(15)));
check("41 chars is too long", !isShareToken("a".repeat(41)));
check("a hyphen is never in a token", !isShareToken("abcdefgh-ijklmnopqrs"));
check("underscore refused", !isShareToken("abcdefgh_ijklmnopqrs"));
check("empty refused", !isShareToken(""));
{
  const bytes = new Uint8Array(64).map((_, i) => (i * 37 + 11) % 248);
  const t = tokenFromBytes(bytes);
  check("tokenFromBytes makes a full-length token", !!t && t.length === SHARE_TOKEN_LENGTH && isShareToken(t!));
  eq("bytes ≥ 248 are skipped, not folded (no modulo bias)", tokenFromBytes(new Uint8Array([255, 250, 248, 0, 61, 62]), 3), "A9A");
  eq("not enough usable bytes → null (caller asks for more)", tokenFromBytes(new Uint8Array([255, 255, 1]), 3), null);
  const seen = new Set<string>();
  for (let n = 0; n < 200; n++) {
    const b = new Uint8Array(48);
    for (let i = 0; i < b.length; i++) b[i] = (n * 131 + i * 17 + ((n * i) % 251)) % 248;
    seen.add(tokenFromBytes(b) ?? "");
  }
  check("different bytes → different tokens", seen.size > 190);
}

console.log("\nResolver — slug vs token:");
eq("plain slug", parseLinkSegment("fall-duals"), { kind: "slug", slug: "fall-duals" });
eq("s-<token> is a token", parseLinkSegment(`s-${TOKEN}`), { kind: "token", token: TOKEN, slug: `s-${TOKEN}` });
eq("a slug that merely starts with s- stays a slug", parseLinkSegment("s-curve-clinic"), { kind: "slug", slug: "s-curve-clinic" });
eq("s- with a short tail is a slug", parseLinkSegment("s-abc"), { kind: "slug", slug: "s-abc" });
eq("bare s- is a slug", parseLinkSegment("s-"), { kind: "slug", slug: "s-" });
eq("uppercase S- is not the prefix", parseLinkSegment(`S-${TOKEN}`).kind, "slug");
eq("token without the prefix is a slug", parseLinkSegment(TOKEN).kind, "slug");
eq("a token-shaped old slug keeps its slug for the fallback lookup", (parseLinkSegment("s-supercalifragilistic") as { slug: string }).slug, "s-supercalifragilistic");
eq("prefix", SHARE_PREFIX, "s-");

console.log("\nPrefix reservation:");
eq("ordinary slug untouched", reserveSlug("fall-duals"), "fall-duals");
eq("s-curve-clinic untouched (hyphen ⇒ never a token)", reserveSlug("s-curve-clinic"), "s-curve-clinic");
eq("token-shaped slug is moved out of the namespace", reserveSlug("s-supercalifragilistic"), "event-s-supercalifragilistic");
check("a reserved slug no longer parses as a token", parseLinkSegment(reserveSlug("s-supercalifragilistic")).kind === "slug");
check("reserving twice changes nothing more", reserveSlug(reserveSlug("s-supercalifragilistic")) === "event-s-supercalifragilistic");
{
  // Everything the slugifier can produce, pushed through reserveSlug, is a slug.
  const slugify = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "event";
  const names = ["S Supercalifragilistic", "s-AAAAAAAAAAAAAAAAAAAA", "S: 2026championshipsfinal", "S", "s-", "Fall Duals", "S-aB3dE6gH9jK2mN5pQ8rS"];
  check("no generated slug can be read as a private link", names.every((n) => parseLinkSegment(reserveSlug(slugify(n))).kind === "slug"));
}

console.log("\nURLs:");
eq("share path", sharePath(TOKEN), `/e/s-${TOKEN}`);
eq("share url", shareUrl(base, TOKEN), `${base}/e/s-${TOKEN}`);
check("the share path parses back to its token", (parseLinkSegment(sharePath(TOKEN).slice(3)) as { token?: string }).token === TOKEN);

console.log("\nAccess — token vs slug:");
const now = new Date("2026-10-06T12:00:00Z");
const past = new Date("2026-10-01T00:00:00Z");
const future = new Date("2026-10-20T00:00:00Z");
const open = (e: Parameters<typeof linkAccess>[1], via: "slug" | "token") => linkAccess(via, e, now);
const pub = { signupAccess: "PUBLIC_LINK", publicRegistration: true, visibility: "PUBLIC" };
const membersOnly = { signupAccess: "MEMBERS", publicRegistration: false, visibility: "MEMBERS_ONLY" };
const staffOnly = { signupAccess: "STAFF_ONLY", publicRegistration: false, visibility: "STAFF_ONLY" };

eq("slug · public event → view + register", open(pub, "slug"), { ok: true, canRegister: true });
eq("token · public event → view + register", open(pub, "token"), { ok: true, canRegister: true });
eq("slug · members-only → viewable, cannot register", open(membersOnly, "slug"), { ok: true, canRegister: false });
eq("token · members-only → register", open(membersOnly, "token"), { ok: true, canRegister: true });
eq("slug · staff-only → cannot register", open(staffOnly, "slug"), { ok: true, canRegister: false });
eq("token · staff-only (hidden) → register", open(staffOnly, "token"), { ok: true, canRegister: true });
eq("slug · STAFF_ONLY beats the legacy flag", open({ signupAccess: "STAFF_ONLY", publicRegistration: true }, "slug"), { ok: true, canRegister: false });
eq("slug · STAFF_ONLY beats a hosted tournament", open({ signupAccess: "STAFF_ONLY", tournamentMode: "HOST" }, "slug"), { ok: true, canRegister: false });
eq("slug · hosted tournament opens the public link", open({ signupAccess: "MEMBERS", tournamentMode: "HOST" }, "slug"), { ok: true, canRegister: true });
eq("slug · legacy publicRegistration flag opens it", open({ signupAccess: "MEMBERS", publicRegistration: true }, "slug"), { ok: true, canRegister: true });
eq("token · publicRegistration false → register", open({ publicRegistration: false }, "token"), { ok: true, canRegister: true });

eq("slug · deleted → 404", open({ ...pub, deletedAt: past }, "slug"), { ok: false, status: 404, error: "Event not found" });
eq("token · deleted → 404", open({ ...staffOnly, deletedAt: past }, "token"), { ok: false, status: 404, error: "Event not found" });
eq("slug · no event → 404", open(null, "slug"), { ok: false, status: 404, error: "Event not found" });
eq("token · no event → 404", open(null, "token"), { ok: false, status: 404, error: "Event not found" });

eq("slug · not published yet → 403", open({ ...pub, publishAt: future }, "slug"), { ok: false, status: 403, error: "Registration is not open yet" });
eq("token · not published yet → works", open({ ...pub, publishAt: future }, "token"), { ok: true, canRegister: true });
eq("slug · published in the past → open", open({ ...pub, publishAt: past }, "slug"), { ok: true, canRegister: true });
eq("slug · unpublished → closed", open({ ...pub, unpublishAt: past }, "slug"), { ok: false, status: 403, error: "Registration has closed" });
eq("token · unpublished → closed", open({ ...staffOnly, unpublishAt: past }, "token"), { ok: false, status: 403, error: "Registration has closed" });
eq("slug · deadline passed → closed", open({ ...pub, registrationDeadline: past }, "slug"), { ok: false, status: 403, error: "The registration deadline has passed" });
eq("token · deadline passed → closed", open({ ...membersOnly, registrationDeadline: past }, "token"), { ok: false, status: 403, error: "The registration deadline has passed" });
eq("token · deadline in the future → open", open({ ...membersOnly, registrationDeadline: future }, "token"), { ok: true, canRegister: true });
eq("token · dates as ISO strings", open({ registrationDeadline: past.toISOString() }, "token"), { ok: false, status: 403, error: "The registration deadline has passed" });
eq("deleted wins over everything", open({ deletedAt: past, publishAt: future, unpublishAt: past }, "token"), { ok: false, status: 404, error: "Event not found" });

console.log("\nWhere the registrant is sent:");
eq("public signup, event has a slug → readable address", registrationUrl(base, urlEventFor("slug", { publicSlug: "fall-duals" }), "reg_1"), `${base}/e/fall-duals/registered/reg_1`);
eq("public signup, no slug → /r/", registrationUrl(base, urlEventFor("slug", { publicSlug: null }), "reg_1"), `${base}/r/reg_1`);
eq("private signup, event has NO slug → /r/, never /e//", registrationUrl(base, urlEventFor("token", { publicSlug: null }), "reg_1"), `${base}/r/reg_1`);
eq("private signup, event HAS a slug → still /r/ (the slug is not given away)", registrationUrl(base, urlEventFor("token", { publicSlug: "fall-duals" }), "reg_1"), `${base}/r/reg_1`);
eq("Stripe return for a private signup", registrationReturnUrl(base, urlEventFor("token", { publicSlug: "fall-duals" }), "reg_1", "paid"), `${base}/r/reg_1?src=paid`);
eq("Stripe cancel for a private signup", registrationReturnUrl(base, urlEventFor("token", { publicSlug: null }), "reg_1", "canceled"), `${base}/r/reg_1?src=canceled`);
check("no private-signup address contains the public slug", !registrationUrl(base, urlEventFor("token", { publicSlug: "fall-duals" }), "reg_1").includes("fall-duals"));
check("an empty slug never builds /e//", !registrationUrl(base, urlEventFor("slug", { publicSlug: "" }), "reg_1").includes("/e//"));

const viaPrivate = { [VIA_KEY]: VIA_PRIVATE_LINK, [VIA_LINK_ID_KEY]: "abc123" };
check("a private signup is recognised", cameViaPrivateLink(viaPrivate));
check("a public signup is not", !cameViaPrivateLink({ shirt: "M" }) && !cameViaPrivateLink(null) && !cameViaPrivateLink([VIA_PRIVATE_LINK]));
eq("stored link id", viaLinkId(viaPrivate), "abc123");
eq("no link id on a public signup", viaLinkId({ [VIA_LINK_ID_KEY]: "abc123" }), null);
eq("same link still live → go back to it", shareTokenForReturn({ storedLinkId: "abc123", currentToken: TOKEN, currentLinkId: "abc123" }), TOKEN);
eq("link was replaced → the new one is NOT handed out", shareTokenForReturn({ storedLinkId: "abc123", currentToken: TOKEN, currentLinkId: "zzz999" }), null);
eq("link turned off → nothing", shareTokenForReturn({ storedLinkId: "abc123", currentToken: null, currentLinkId: null }), null);
eq("public signup → nothing", shareTokenForReturn({ storedLinkId: null, currentToken: TOKEN, currentLinkId: "abc123" }), null);

eq("register again · private signup, link live", registerAgainPath({ publicSlug: null, shareToken: TOKEN, viaPrivateLink: true }), `/e/s-${TOKEN}`);
eq("register again · private signup wins over the slug", registerAgainPath({ publicSlug: "fall-duals", shareToken: TOKEN, viaPrivateLink: true }), `/e/s-${TOKEN}`);
eq("register again · private signup, link gone, has slug", registerAgainPath({ publicSlug: "fall-duals", shareToken: null, viaPrivateLink: true }), "/e/fall-duals");
eq("register again · private signup, link gone, no slug", registerAgainPath({ publicSlug: null, shareToken: null, viaPrivateLink: true }), "/member/events");
eq("register again · public signup never gets the token", registerAgainPath({ publicSlug: "fall-duals", shareToken: TOKEN, viaPrivateLink: false }), "/e/fall-duals");
eq("register again · public signup, no slug", registerAgainPath({ publicSlug: null, shareToken: TOKEN }), "/member/events");
eq("register again · a malformed token is never linked", registerAgainPath({ publicSlug: null, shareToken: "../x", viaPrivateLink: true }), "/member/events");

console.log("\nPrice rule — one price / two prices × matched / unmatched:");
// The match the register route uses: email finds the household, name picks the athlete.
const household = [{ id: "m_eli", firstName: "Eli", lastName: "Fasulo" }, { id: "m_max", firstName: "Max", lastName: "Fasulo" }];
const matched = matchMemberForPublicSignup({ name: "Eli Fasulo", candidates: household });
const unmatchedName = matchMemberForPublicSignup({ name: "Sam Fasulo", candidates: household });
const unmatchedEmail = matchMemberForPublicSignup({ name: "Eli Fasulo", candidates: [] });
eq("email + name → the member", matched, "m_eli");
eq("email matches, name doesn't → not a member", unmatchedName, null);
eq("name matches, email doesn't → not a member", unmatchedEmail, null);

const price = (e: Parameters<typeof registrationListPrice>[0], memberId: string | null) => registrationListPrice(e, { memberId });
const both = { memberPrice: 85, nonMemberPrice: 100 };
const memberOnly = { memberPrice: 85, nonMemberPrice: null };
const nonMemberOnly = { memberPrice: null, nonMemberPrice: 100 };

eq("two prices · matched → member price", price(both, matched), 85);
eq("two prices · unmatched (wrong name) → non-member price", price(both, unmatchedName), 100);
eq("two prices · unmatched (wrong email) → non-member price", price(both, unmatchedEmail), 100);
eq("one price (member only) · matched → it", price(memberOnly, matched), 85);
eq("one price (member only) · unmatched → the member price, never $0", price(memberOnly, null), 85);
eq("one price (member only, empty string non-member) · unmatched → member price", price({ memberPrice: "85.00", nonMemberPrice: "" }, null), 85);
eq("one price (member only, non-member 0) · unmatched → member price", price({ memberPrice: 85, nonMemberPrice: 0 }, null), 85);
eq("one price (non-member only) · matched → it", price(nonMemberOnly, matched), 100);
eq("one price (non-member only) · unmatched → it", price(nonMemberOnly, null), 100);
eq("same price twice · matched", price({ memberPrice: 90, nonMemberPrice: 90 }, matched), 90);
eq("same price twice · unmatched", price({ memberPrice: 90, nonMemberPrice: 90 }, null), 90);
eq("no price at all → free", price({}, null), 0);
eq("Decimal-ish strings", price({ memberPrice: "85.00", nonMemberPrice: "100.00" }, null), 100);
eq("called with no registration → the unmatched price", registrationListPrice(both), 100);

console.log("\nPrice rule — publicPricingOption:");
eq("unset · unmatched → non-member", price({ ...both, publicPricingOption: null }, null), 100);
eq("NON_MEMBER · unmatched → non-member", price({ ...both, publicPricingOption: "NON_MEMBER" }, null), 100);
eq("NON_MEMBER · matched → member", price({ ...both, publicPricingOption: "NON_MEMBER" }, matched), 85);
eq("NON_MEMBER but none set · unmatched → member", price({ ...memberOnly, publicPricingOption: "NON_MEMBER" }, null), 85);
eq("MEMBER (owner's choice) · unmatched → member price", price({ ...both, publicPricingOption: "MEMBER" }, null), 85);
eq("MEMBER · matched → member price", price({ ...both, publicPricingOption: "MEMBER" }, matched), 85);
eq("DROP_IN (owner's choice) · unmatched → drop-in", price({ ...both, dropInFee: 25, publicPricingOption: "DROP_IN" }, null), 25);
eq("DROP_IN · matched → member price", price({ ...both, dropInFee: 25, publicPricingOption: "DROP_IN" }, matched), 85);
eq("DROP_IN but no drop-in fee · unmatched → non-member", price({ ...both, publicPricingOption: "DROP_IN" }, null), 100);
eq("a drop-in fee alone is never picked by default", price({ ...both, dropInFee: 25 }, null), 100);

console.log("\nWhat the form says before they submit:");
eq("two prices → both shown", registrationPriceTiers(both), { member: 85, other: 100, differ: true });
eq("member only → one price, nothing to explain", registrationPriceTiers(memberOnly), { member: 85, other: 85, differ: false });
eq("non-member only → one price", registrationPriceTiers(nonMemberOnly), { member: 100, other: 100, differ: false });
eq("same price twice → one price", registrationPriceTiers({ memberPrice: 90, nonMemberPrice: 90 }), { member: 90, other: 90, differ: false });
eq("owner pointed the link at the member price → one price", registrationPriceTiers({ ...both, publicPricingOption: "MEMBER" }), { member: 85, other: 85, differ: false });
eq("drop-in link → member vs drop-in", registrationPriceTiers({ ...both, dropInFee: 25, publicPricingOption: "DROP_IN" }), { member: 85, other: 25, differ: true });
eq("free → no tiers", registrationPriceTiers({}), { member: 0, other: 0, differ: false });
check("the tiers are the prices the register route charges", registrationPriceTiers(both).member === price(both, matched) && registrationPriceTiers(both).other === price(both, null));

console.log("\nWiring (source checks):");
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const pubGet = src("app/api/public/events/[slug]/route.ts");
const pubReg = src("app/api/public/events/[slug]/register/route.ts");
const pubDisc = src("app/api/public/events/[slug]/validate-discount/route.ts");
const pubQuote = src("app/api/public/events/[slug]/quote/route.ts");
for (const [n, s] of [["page API", pubGet], ["register", pubReg], ["discount check", pubDisc], ["quote", pubQuote]] as const) {
  check(`${n} resolves through resolveEventLink`, s.includes("resolveEventLink(params.slug)") && !s.includes("where: { publicSlug: params.slug }"));
  check(`${n} decides access through linkAccess`, s.includes("linkAccess(link.via"));
}
check("page API never returns the slug or the token", !/publicSlug\s*:/.test(pubGet) && !/shareToken|token\s*:/.test(pubGet));
check("register builds every return address from urlEvent", !/registration(Return)?Url\([^)]*\bevent,/.test(pubReg) && pubReg.includes("urlEventFor(link.via, event)"));
check("register records the source", pubReg.includes("[VIA_KEY]: VIA_PRIVATE_LINK"));
check("register and quote share one member match", pubReg.includes("findMemberForPublicSignup(") && pubQuote.includes("findMemberForPublicSignup("));
const dup = src("app/api/events/[id]/duplicate/route.ts");
check("duplicate does not copy the private link", !/shareLink|eventShareLink|shareToken/.test(dup));
const staff = src("app/api/events/[id]/share-link/route.ts");
check("staff route is gated on events:edit, live", staff.includes('requirePermissionLive(session, "events", "edit")'));
check("staff route scopes the event to the caller's club", staff.includes("clubId: session.user.clubId"));
const layout = src("app/e/[slug]/layout.tsx");
check("private link pages are noindex", layout.includes("index: false") && layout.includes('kind !== "token"'));
const schema = src("prisma/schema.prisma");
check("the token is not a column on Event", !/^\s*shareToken\s/m.test(schema) && schema.includes("model EventShareLink"));
const sitemap = src("app/sitemap.ts");
check("sitemap is static — it never reads events", sitemap.includes("export default function sitemap()") && !/findMany\(|await /.test(sitemap.replace(/\/\*[\s\S]*?\*\//g, "")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
