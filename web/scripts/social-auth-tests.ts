// Sign in with Google / Apple (2026-11-17). The rules in lib/socialAuth, the
// token checks in lib/socialJwt, and source guards on the routes that use
// them. PURE: real keys are generated here; no network, no database.
// Every time is relative to `new Date()`.
//
//   npx tsx scripts/social-auth-tests.ts

import { generateKeyPairSync, createSign, createVerify, createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import {
  decideSocialSignIn,
  provesAccountEmail,
  profileFromClaims,
  signToken,
  readToken,
  challengeMatches,
  canRemoveMethod,
  passwordIsUsable,
  safeMemberNext,
  appReturnUrl,
  SOCIAL_PASSWORD_PREFIX,
} from "../lib/socialAuth";
import { verifyIdToken, appleClientSecret, normalizePem, type Jwk } from "../lib/socialJwt";
import { socialErrorText } from "../lib/socialErrors";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = join(__dirname, "..");
const code = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const now = new Date();
const SECRET = "test-secret-not-real";

console.log("\nWho gets signed in, linked, or asked to choose:");
{
  const verified = { email: "pat@example.com", emailVerified: true, emailIsRelay: false };
  const member = { userId: "u_member", role: "MEMBER" as const, deleted: false };
  const d = (f: Parameters<typeof decideSocialSignIn>[0]) => decideSocialSignIn(f);

  check("linked before → sign in", JSON.stringify(d({ profile: verified, linked: { userId: "u1", deleted: false }, emailMatch: null })) === JSON.stringify({ action: "SIGN_IN", userId: "u1" }));
  check("linked before wins over an email match", d({ profile: verified, linked: { userId: "u1", deleted: false }, emailMatch: member }).action === "SIGN_IN");
  check("verified email matching a member/parent login → link and sign in", JSON.stringify(d({ profile: verified, linked: null, emailMatch: member })) === JSON.stringify({ action: "LINK_AND_SIGN_IN", userId: "u_member" }));
  const unverified = d({ profile: { ...verified, emailVerified: false }, linked: null, emailMatch: member });
  check("UNVERIFIED email never links on a match", unverified.action === "CHOOSE" && unverified.reason === "UNVERIFIED_EMAIL");
  const relay = d({ profile: { email: "x1@privaterelay.appleid.com", emailVerified: true, emailIsRelay: true }, linked: null, emailMatch: member });
  check("Apple hidden email never links, never creates silently", relay.action === "CHOOSE" && relay.reason === "RELAY_EMAIL");
  const staff = d({ profile: verified, linked: null, emailMatch: { userId: "u_staff", role: "STAFF", deleted: false } });
  check("staff login is never linked by an email match", staff.action === "CHOOSE" && staff.reason === "STAFF_ACCOUNT");
  check("owner login is never linked by an email match", d({ profile: verified, linked: null, emailMatch: { userId: "u_owner", role: "OWNER", deleted: false } }).action === "CHOOSE");
  check("no account → choose (link or create), nothing created here", d({ profile: verified, linked: null, emailMatch: null }).action === "CHOOSE");
  check("a deleted login is not signed into", d({ profile: verified, linked: { userId: "gone", deleted: true }, emailMatch: null }).action === "CHOOSE");
  check("a deleted email match is not linked", d({ profile: verified, linked: null, emailMatch: { ...member, deleted: true } }).action === "CHOOSE");
  check("no email at all → choose", d({ profile: { email: null, emailVerified: false, emailIsRelay: false }, linked: null, emailMatch: member }).action === "CHOOSE");
}

console.log("\nWhen the provider proves the account's own address:");
{
  const p = { email: "pat@example.com", emailVerified: true, emailIsRelay: false };
  check("same verified address → proven", provesAccountEmail(p, "Pat@Example.com "));
  check("different address → not proven", !provesAccountEmail(p, "other@example.com"));
  check("unverified → not proven", !provesAccountEmail({ ...p, emailVerified: false }, "pat@example.com"));
  check("relay → not proven", !provesAccountEmail({ ...p, emailIsRelay: true }, "pat@example.com"));
}

console.log("\nReading what Google and Apple say:");
{
  const g = profileFromClaims("google", { sub: "g1", email: "A@B.com", email_verified: true, given_name: "Ann", family_name: "Bee" });
  check("Google: verified boolean, lower-cased email, names", !!g && g.emailVerified && g.email === "a@b.com" && g.firstName === "Ann" && !g.emailIsRelay);
  const a = profileFromClaims("apple", { sub: "a1", email: "x@privaterelay.appleid.com", email_verified: "true", is_private_email: "true" }, { firstName: "Cy" });
  check("Apple: string booleans understood, relay detected, name from first sign-in", !!a && a.emailVerified && a.emailIsRelay && a.firstName === "Cy");
  const a2 = profileFromClaims("apple", { sub: "a2", email: "x@privaterelay.appleid.com", email_verified: "true" });
  check("Apple relay detected by domain even without the flag", !!a2 && a2.emailIsRelay);
  check("Apple email_verified 'false' is not verified", !profileFromClaims("apple", { sub: "a3", email: "a@b.com", email_verified: "false" })?.emailVerified);
  check("no subject → nothing", profileFromClaims("google", { email: "a@b.com" }) === null);
}

console.log("\nSigned short-lived tokens:");
{
  const t = signToken("state", { p: "google", n: "nonce" }, 60_000, now, SECRET);
  check("round trip", readToken<{ p: string }>("state", t, now, SECRET)?.p === "google");
  check("a state token is not a pending token", readToken("pending", t, now, SECRET) === null);
  check("expired is refused", readToken("state", t, new Date(now.getTime() + 61_000), SECRET) === null);
  check("another secret is refused", readToken("state", t, now, "other") === null);
  const [body, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ p: "apple", n: "nonce", exp: now.getTime() + 60_000 })).toString("base64url");
  check("tampered body is refused", readToken("state", `${forged}.${sig}`, now, SECRET) === null && !!body);
  check("garbage is refused", readToken("state", "a.b.c", now, SECRET) === null && readToken("state", "", now, SECRET) === null);
  check("no secret configured → nothing is ever accepted", readToken("state", t, now, undefined) === null);
}

console.log("\nThe app's secret (only the app that started can finish):");
{
  const sha = (s: string) => createHash("sha256").update(s).digest("base64url");
  const verifier = "v".repeat(43);
  check("right secret → accepted", challengeMatches(sha(verifier), verifier, sha));
  check("wrong secret → refused", !challengeMatches(sha(verifier), "w".repeat(43), sha));
  check("missing or short secret → refused", !challengeMatches(sha(verifier), null, sha) && !challengeMatches(sha("short"), "short", sha));
  const u = appReturnUrl({ code: "abc" });
  check("the app return address is the app's own scheme", u.startsWith("com.athletixos.app://auth/social?") && u.includes("code=abc"));
}

console.log("\nSign-in methods on an account:");
{
  check("a bcrypt hash is a usable password", passwordIsUsable("$2a$12$abcdefghijklmnopqrstuuJ8ZfVd0rGm1r0x1b2c3d4e5f6g7h8i9j"));
  check("a Google/Apple account's marker is not", !passwordIsUsable(`${SOCIAL_PASSWORD_PREFIX}abc`));
  check("a deleted account's marker is not", !passwordIsUsable("deleted:abc"));
  check("password + one provider → the provider can go", canRemoveMethod({ hasPassword: true, identityCount: 1 }));
  check("no password + one provider → it stays (the last way in)", !canRemoveMethod({ hasPassword: false, identityCount: 1 }));
  check("no password + two providers → one can go", canRemoveMethod({ hasPassword: false, identityCount: 2 }));
  check("only /member paths are carried through sign-in", safeMemberNext("/member/checkin/abc") === "/member/checkin/abc" && safeMemberNext("//evil.com") === null && safeMemberNext("https://x") === null && safeMemberNext("/dashboard") === null);
  check("error codes become sentences", socialErrorText("taken").includes("already connected") && socialErrorText("NOPE") === socialErrorText("provider"));
}

console.log("\nChecking a provider's signed identity (real RSA keys):");
{
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: "jwk" }) as Jwk), kid: "k1", alg: "RS256", use: "sig" };
  const nowSec = Math.floor(now.getTime() / 1000);
  const make = (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }) => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const data = `${enc(header)}.${enc(claims)}`;
    const s = createSign("RSA-SHA256").update(data).sign(privateKey).toString("base64url");
    return `${data}.${s}`;
  };
  const good = { iss: "https://accounts.google.com", aud: "client-1", sub: "g1", exp: nowSec + 300, iat: nowSec - 5, nonce: "n1" };
  const chk = { issuers: ["https://accounts.google.com"], audience: "client-1", nonce: "n1", now };
  check("valid token → claims", verifyIdToken(make(good), [jwk], chk).ok);
  const r = (claims: Record<string, unknown>, header?: Record<string, unknown>) => {
    const v = verifyIdToken(make(claims, header), [jwk], chk);
    return v.ok ? "OK" : v.reason;
  };
  check("wrong audience → refused", r({ ...good, aud: "someone-else" }) === "AUDIENCE");
  check("wrong issuer → refused", r({ ...good, iss: "https://evil.example" }) === "ISSUER");
  check("expired → refused", r({ ...good, exp: nowSec - 3600 }) === "EXPIRED");
  check("wrong nonce (replayed from another attempt) → refused", r({ ...good, nonce: "n2" }) === "NONCE");
  check("missing nonce → refused", r({ ...good, nonce: undefined }) === "NONCE");
  check("alg none → refused", r(good, { alg: "none", kid: "k1" }) === "ALG");
  check("HS256 (key confusion) → refused", r(good, { alg: "HS256", kid: "k1" }) === "ALG");
  check("unknown key id → refused", r(good, { alg: "RS256", kid: "k9" }) === "NO_KEY");
  const t = make(good);
  const tampered = t.split(".");
  tampered[1] = Buffer.from(JSON.stringify({ ...good, sub: "someone-else" })).toString("base64url");
  check("tampered claims → refused", verifyIdToken(tampered.join("."), [jwk], chk).ok === false);
  check("signed by another key → refused", (() => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const ojwk = { ...(other.publicKey.export({ format: "jwk" }) as Jwk), kid: "k1" };
    return !verifyIdToken(t, [ojwk], chk).ok;
  })());
}

console.log("\nApple's client secret (real P-256 key):");
{
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const jwt = appleClientSecret({ teamId: "TEAM123456", keyId: "KEY1234567", servicesId: "com.example.signin", privateKeyPem: pem.replace(/\n/g, "\\n"), now });
  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  const ok = createVerify("sha256").update(`${h}.${p}`).verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  check("signature verifies (raw r||s, as JWT requires)", ok);
  check("header: ES256 + key id", header.alg === "ES256" && header.kid === "KEY1234567");
  check("claims: team, services id, Apple audience, short life", payload.iss === "TEAM123456" && payload.sub === "com.example.signin" && payload.aud === "https://appleid.apple.com" && payload.exp - payload.iat <= 15777000 && payload.exp > Math.floor(now.getTime() / 1000));
  check("a key pasted with \\n escapes is accepted", normalizePem("a\\nb") === "a\nb");
}

console.log("\nSource guards:");
{
  const cb = code("app/api/auth/social/callback/[provider]/route.ts");
  check("website answer must come back to the browser that asked", /if \(!inApp && !sameValue\(readCookie\(req, BROWSER_COOKIE\), state\.b\)\) return fail\("state"\)/.test(cb));
  check("the decision is the pure rule, not hand-rolled", cb.includes("decideSocialSignIn("));
  check("the app gets a one-time code, never a session cookie in the sheet", /k: "session", userId: gate\.user\.id, a: state\.a/.test(cb));
  check("same login checks as a password sign-in (removed, guardian consent)", cb.includes("signInGate("));
  check("linking runs the existing after-verification step only via provider proof", cb.includes("afterProviderProof(") && !cb.includes("completeEmailLinks("));
  const server = code("lib/socialAuthServer.ts");
  check("afterProviderProof calls completeEmailLinks only when the address is proven", /if \(!user \|\| !provesAccountEmail\(profile, user\.email\)\) return;[\s\S]*completeEmailLinks\(user\)/.test(server));
  check("a provider identity already on another login is refused", /existing\.userId !== userId && !existing\.user\.deletedAt\) return \{ ok: false, error: "taken" \}/.test(server));
  const start = code("app/api/auth/social/start/route.ts");
  check("connect mode names the signed-in account from the session", /mode === "connect"[\s\S]*getServerSession[\s\S]*userId = session\.user\.id/.test(start));
  const client = code("lib/socialClient.ts");
  check("the app sends only the hash of its secret to start", /app: secret\.challenge/.test(client) && !/app: secret\.verifier/.test(client));
  check("Google sign-in in the app uses the system browser sheet, not the web view", client.includes('nativeCall("Browser", "open"'));
  const link = code("app/api/auth/social/link/route.ts");
  check("link-with-password shares the password login's rate limit", link.includes("auth:login:"));
  check("link-with-password equalises timing on unknown emails", link.includes("DUMMY_HASH"));
  const pending = code("app/api/auth/social/pending/route.ts");
  check("the choice page never learns whether an account exists", !/reason|emailMatch|exists/.test(pending.replace(/\/\/.*$/gm, "")));
  check("password login refuses the social marker", code("lib/auth.ts").includes("passwordIsUsable(user.passwordHash)"));
  const signup = code("app/api/member/signup/route.ts");
  check("signup without a password needs the provider answer for THIS club", /social\.clubId !== club\.id/.test(signup));
  const del = code("lib/accountDeletionServer.ts");
  check("account deletion revokes the Apple token and removes the sign-in rows", del.includes("revokeAppleToken(") && del.includes("tx.userIdentity.deleteMany({ where: { userId } })"));
  const methods = code("app/api/account/sign-in-methods/route.ts");
  check("the last way in can't be removed (checked again inside the transaction)", methods.includes("canRemoveMethod(") && /\$transaction[\s\S]*count < 2/.test(methods));
  const buttons = code("components/auth/SocialButtons.tsx");
  check("Apple and Google buttons share one size (App Review 4.8)", /\? `\$\{BTN\} bg-black/.test(buttons) && /: `\$\{BTN\} bg-white/.test(buttons));
  check("the login page offers both next to email and password", code("app/login/page.tsx").includes("<SocialButtons"));
  check("iOS registers the app's return address", code("ios/App/App/Info.plist").includes("<string>com.athletixos.app</string>"));
  check("Android registers the app's return address", /android:scheme="com\.athletixos\.app" android:host="auth"/.test(code("android/app/src/main/AndroidManifest.xml")));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
