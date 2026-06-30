# ClubOS / AthletixOS — Security & Correctness Path Map + Remediation

**Date:** 2026-06-13
**Scope:** `web/` workspace — ~150 API routes, middleware, auth/permissions core, Stripe/Plaid money flows, member portal & guardian model, public/token surfaces.
**Method:** Read the security core directly (`lib/auth.ts`, `middleware.ts`, `lib/apiGuard.ts`, `lib/permissions.ts`, `lib/preview.ts`, `lib/ratelimit.ts`), fanned out auditors across the 8 trust boundaries below, then hand-verified the two highest-severity findings against source.

This complements `SECURITY_AUDIT_RESULTS.md` (the prior Tasks 1–8 audit). It does **not** contradict it — the prior hardening is real and in place. This pass goes one level deeper on end-to-end *flow* correctness and surfaces two exploitable bugs the file-by-file audit did not catch.

---

## 1. The MECE path map

Every request is partitioned by the **8 mutually-exclusive concern-axes** it crosses. Within each axis: the happy path vs. the unhappy/abuse paths. Each leaf states *why* it holds or breaks.

**Legend:** `✓` verified correct · `⚠` gap / defense-in-depth debt (not independently exploitable) · `✗` confirmed exploitable vulnerability

```
ClubOS request lifecycle
│
├─ 1. AUTHENTICATION — "are you who you claim"
│  ├─ Happy
│  │  └─ ✓ club-scoped credentials login (slug→club, clubId_email lookup, bcrypt-12, JWT{role,clubId,perms})
│  │        why: composite clubId_email key means same email in 2 clubs = 2 distinct accounts; no cross-club login
│  ├─ Unhappy — credential
│  │  ├─ ✓ wrong password / unknown email / unknown club → null → generic CredentialsSignin
│  │  │     why: identical return on every failure ⇒ no oracle in the response body
│  │  ├─ ✓ soft-deleted user (deletedAt) rejected AT LOGIN (auth.ts:86)
│  │  ├─ ✓ brute force → 10/10min per-IP rate limit → null (no distinct throttle error)
│  │  └─ ⚠ rate limit is in-memory/per-process, keyed on raw X-Forwarded-For, NO per-account lockout
│  │        why: distributed cred-stuffing on one account is unthrottled; limit = 10×warm-instances on Vercel (known debt)
│  ├─ Unhappy — enumeration
│  │  └─ ⚠ timing oracle: unknown user returns before bcrypt (:75/:86), valid user runs ~250ms bcrypt (:88)
│  │        why: response-time delta enumerates which emails exist in a club; rate-limit does not close timing
│  └─ Unhappy — session lifecycle
│     └─ ⚠ JWT never re-validated server-side for 14 days (no session table)
│           why: role downgrade, soft-delete, password change/reset do NOT revoke a live token; signOutEverywhere is client-only
│
├─ 2. AUTHORIZATION (RBAC) — "what may this role do"
│  ├─ Happy
│  │  ├─ ✓ middleware gates /dashboard,/admin,/member by role + longest-prefix permission (PATH_PERMISSIONS)
│  │  ├─ ✓ apiGuard.requirePermission/requireOwner; OWNER bypasses, STAFF checked by level rank
│  │  └─ ✓ privates routes moved from hardcoded OWNER to events:edit/full (head-coach can manage)
│  ├─ Unhappy
│  │  ├─ ✓ MEMBER→dashboard API = 403; STAFF lacking perm = 403; no session = 401; denied STAFF → /dashboard?denied=1
│  │  └─ ⚠ permissions snapshot lives in JWT; owner edits to staff perms need re-login to gate the API
│  │        why: live nav reads /api/me (not stale) but API guard trusts the 14-day token
│  └─ Privilege escalation
│     └─ ✓ signup hardcodes OWNER(new club)|MEMBER; no client role field ⇒ cannot self-mint STAFF/OWNER in an existing club
│
├─ 3. MULTI-TENANT ISOLATION — "you only touch your club's rows"
│  ├─ Happy
│  │  └─ ✓ every authenticated route derives clubId from session, never from body/param
│  ├─ Unhappy — IDOR by guessed id (audited ~60 routes, all domains)
│  │  ├─ ✓ pattern A: findFirst({id,clubId,deletedAt:null}) precheck → 404 before bare-id update/delete
│  │  ├─ ✓ pattern B: updateMany/deleteMany({id,clubId}) combined-key mutation
│  │  ├─ ✓ pattern C: child models scoped via parent FK (e.g. MemberSubscription via member:{clubId})
│  │  └─ ✓ files/[id] explicit file.clubId === session.clubId; cross-member writes verify BOTH members
│  └─ Architectural
│     ├─ ⚠ NO central tenant-enforcement layer — 271 sites correct by manual discipline only (deferred F-3)
│     │     why: one forgetful future query = silent cross-tenant leak; no DB safety net
│     └─ ⚠ events/[id]/charge membership-covered branch doesn't re-scope body memberId (charge:51-107)
│           why: not exploitable today (owner/staff, own-club plans) but diverges from hardened sibling branches
│
├─ 4. MONEY MOVEMENT — "money moves correctly & once"
│  ├─ Happy
│  │  ├─ ✓ Stripe webhook: constructEvent over RAW body, env secret, idempotent via StripeWebhookEvent.stripeEventId (@unique)
│  │  ├─ ✓ Connect vs platform split by event.account; sub handlers safe via globally-unique stripeSubscriptionId
│  │  ├─ ✓ member purchase routes resolve member as SELF (userId+clubId); credits/inventory granted ONLY in webhook
│  │  └─ ✓ Plaid exchange server-side; accessToken stored, never in any GET select; OWNER-only + Pro-tier gated
│  ├─ Unhappy — webhook abuse
│  │  ├─ ✓ bad signature / missing secret → 400; replayed event id → early return (processed flag)
│  │  └─ ⚠ productSale.update(:401), eventRegistration(:492), migration member.update(:239/256) write by bare id (no clubId)
│  │        why: signature-gated so not reachable by an attacker, but inconsistent with hardened membership/class branches
│  ├─ Unhappy — durability
│  │  └─ ⚠ handler swallows exceptions → HTTP 200 (no Stripe retry)
│  │        why: transient DB failure mid-activation = paid-but-not-active divergence; relies on manual diagnostics replay
│  └─ Unhappy — cross-club / tier
│     ├─ ✓ charging another club's member blocked (member.findFirst{id,clubId}); paid path requires connected charges-enabled acct
│     └─ ⚠ diagnostics returns clubId===null webhook events to every owner (metadata only, no PII/amounts)
│
├─ 5. MEMBER PORTAL & FAMILY/GUARDIAN — "act only on self or your child"
│  ├─ Happy
│  │  ├─ ✓ member resolved from session (findOrAutoLinkMember), NOT client localStorage active-profile
│  │  ├─ ✓ ?memberId validated against accessible set (self ∪ verified guardianOf) → 403 otherwise
│  │  ├─ ✓ DM requires same-club + pre-existing inbound thread (no cold-DM); groups require membership
│  │  └─ ✓ document sign requires isSelf|guardianOf; minor can't self-sign guardian-required doc
│  ├─ Unhappy — access control
│  │  ├─ ✓ arbitrary memberId / other-club member / not-in-group / non-guardian → all rejected
│  │  └─ ✗ guardian self-linking: any MEMBER links as guardian to ANY club-mate by email (link-child:22-55)  ← FINDING 1
│  │        why: only checks club+email+not-self — NO consent/approval/relationship/DOB check; member emails are
│  │             low-entropy & shared ⇒ attacker reads victim's bookings/docs/messages, signs docs, sets parental controls
│  │        ↳ same unverified link at signup PARENT path (member/signup ~:108) — works unauthenticated
│  └─ Preview mode
│     ├─ ✓ only OWNER/STAFF can set cookie (canStartPreview); MEMBER POST /api/preview → 401; cookie HttpOnly
│     ├─ ✓ /portal & /schedule return sanitized stub (club brand only, no real member data) under preview
│     └─ ⚠ other ~25 /api/member/* routes aren't preview-aware; safe only because owner has no member profile (not an explicit gate)
│
├─ 6. PUBLIC / TOKEN-GATED SURFACES — "unauth surface can't be abused"
│  ├─ Happy
│  │  ├─ ✓ public event register: 10/10min IP rate-limit, Zod, capacity/deadline/publicRegistration gated, no User/charge w/o checkout
│  │  ├─ ✓ unsubscribe: HMAC(clubId+email, NEXTAUTH_SECRET) + timingSafeEqual → unforgeable, no enumeration
│  │  ├─ ✓ partner-invite / staff setup / contractor invite: randomBytes(32) tokens, expiry, reused→409, owner-gated
│  │  └─ ✓ reset-password & staff-setup tokens are single-use + cleared on use (the CORRECT pattern)
│  ├─ Unhappy — token replay / takeover
│  │  └─ ✗ migration activation token NEVER invalidated + replayable (activate/[token]:144,179,196-302)  ← FINDING 2
│  │        why: 409 guard fires only on COMPLETED, but POST sets status ACTIVATED; token (30d, re-extended on resend)
│  │             stays live ⇒ re-POST overwrites the member's portal passwordHash (:179) again = account takeover
│  ├─ Unhappy — open registration / enumeration
│  │  ├─ ⚠ open MEMBER self-registration into ANY club by public slug (signup ~:44) — no invite/verify/approval
│  │  ├─ ⚠ emailVerified column exists but is never set ⇒ can register someone else's email
│  │  └─ ⚠ /api/checkin/[id] unauthenticated + NOT clubId-scoped (checkin/[id]:9-16) — cross-club read (low-sensitivity)
│  └─ Middleware coverage
│     └─ ✓ matcher only guards /dashboard|/admin|/member by design; other pages self-guard or are intentionally public
│
├─ 7. INPUT HANDLING — "no injection, no stored XSS, no bad upload"
│  ├─ Happy
│  │  ├─ ✓ 114/131 mutating routes Zod-validated; 0 $queryRawUnsafe; the 1 $queryRaw is parameterized
│  │  ├─ ✓ rich-text (Document.body, the only dangerouslySetInnerHTML sink) sanitized via DOMPurify at WRITE time
│  │  └─ ✓ upload: session-gated, 30/min, 10MB, MIME allowlist, random storage key (no path traversal)
│  └─ Unhappy
│     ├─ ✓ injection N/A — search uses Prisma contains (parameterized); help-search is in-memory keyword filter
│     ├─ ⚠ SVG allowed + served inline → stored-XSS risk if same-club user opens it directly
│     │     why: mitigated by nosniff + (Report-Only) CSP, but CSP isn't enforcing yet so not yet a real control
│     └─ ⚠ several catch-alls return String(err) to client (change-password:42, link-child:60) — minor info leak
│
└─ 8. TRANSPORT / CONFIG / SECRETS — "the envelope is hardened"
   ├─ Happy
   │  ├─ ✓ cookies httpOnly + sameSite=lax + __Secure-/__Host- prefixes in prod; 14-day session cap
   │  ├─ ✓ HSTS / X-Frame-DENY / nosniff / Referrer-Policy / Permissions-Policy enforced
   │  └─ ✓ no real sk_live/whsec_/DATABASE_URL in code or 155-commit history; .env gitignored
   └─ Unhappy
      ├─ ⚠ CSP still Report-Only with script-src 'unsafe-inline' ⇒ provides NO XSS protection yet (deferred)
      └─ ⚠ all reset/activation/setup tokens stored PLAINTEXT at rest (User.resetToken, Member.activationToken)
            why: a DB read (backup leak, insider, future SQLi) hands an attacker every live token directly
```

---

## 2. Verdict

**No trivial cross-tenant IDOR, no broken auth primitive.** The manual `clubId`-scoping discipline genuinely holds across the ~60 routes sampled, the Stripe webhook is correctly signature-gated + idempotent, and the prior audit's hardening (bcrypt-12, login rate-limit, security headers, cookie prefixes) is real.

**Two confirmed, exploitable vulnerabilities** (both hand-verified against source):

| # | Severity | What | Location |
|---|----------|------|----------|
| 1 | **HIGH** | Unverified guardian self-linking → cross-family PII/account access | `app/api/member/portal/link-child/route.ts:22-55`; `app/api/member/signup/route.ts` PARENT path |
| 2 | **HIGH** | Activation-token replay → member portal account takeover | `app/api/members/migration/activate/[token]/route.ts:144,179,196-302` |

Everything else is defense-in-depth debt — real, worth fixing before scale, but not an open exploit on its own.

---

## 3. Fixes

### FINDING 1 — Unverified guardian self-linking (HIGH)

#### The bug

`POST /api/member/portal/link-child` creates a `MemberGuardianUser` row — which grants full guardian access to a member's bookings, documents, messages, billing, and parental controls — after checking only three things: same club, email matches a member, and "not yourself."

```ts
// app/api/member/portal/link-child/route.ts:22-55  (current)
const childMember = await prisma.member.findFirst({
  where: { clubId: session.user.clubId, email: body.childEmail.toLowerCase(), deletedAt: null },
});
if (!childMember) return 404;
// ...only a "not yourself" check...
const guardian = await prisma.memberGuardianUser.upsert({               // ← link created immediately
  where: { userId_memberId: { userId: session.user.id, memberId: childMember.id } },
  update: { relationship: body.relationship || null },
  create: { userId: session.user.id, memberId: childMember.id, relationship: body.relationship || null },
});
```

Member emails are low-entropy and routinely shared (rosters, team chats). Knowing a club-mate's email is the only prerequisite to read their family's data. The identical unverified link also runs **unauthenticated** in the PARENT branch of `app/api/member/signup/route.ts`.

#### Why the chosen fix is minimal-yet-correct

The whole portal treats **"a `MemberGuardianUser` row exists" ≡ "this user has active guardian access."** ~10 downstream consumers rely on that invariant (`/api/member/portal`, `documents/[id]/sign`, `family/[memberId]/controls`, `family/approvals`, `classes/book`, `events/[id]/register`, `member/me`, `messages`, …). So the safe fix is to **never create the row unless access is actually authorized** — preserving the invariant and requiring **zero** changes to consumers.

Authorization signal that already exists: the owner sets `Member.guardianEmail` when they add a minor. If the requester's account email matches that owner-vetted `guardianEmail`, the owner has *already* designated this person as the guardian — auto-link is safe. Otherwise the link goes into an **owner approval queue**; no access is granted until the owner approves.

#### Fix 1a — gate `link-child`

```ts
// app/api/member/portal/link-child/route.ts  (replace the body after the not-yourself check)

// Pull the requester's email to compare against the owner-set guardian email.
const requester = await prisma.user.findUnique({
  where: { id: session.user.id },
  select: { email: true },
});

const guardianEmailOnFile = childMember.guardianEmail?.toLowerCase() ?? null;
const requesterEmail = requester?.email?.toLowerCase() ?? null;

// AUTO-APPROVE ONLY when the owner has already named this exact person as the
// member's guardian (they typed this email into guardianEmail when adding the
// minor). That is the owner's vouch — no extra approval needed.
const ownerVouched =
  childMember.isMinor && !!guardianEmailOnFile && guardianEmailOnFile === requesterEmail;

if (ownerVouched) {
  const guardian = await prisma.memberGuardianUser.upsert({
    where: { userId_memberId: { userId: session.user.id, memberId: childMember.id } },
    update: { relationship: body.relationship || null },
    create: {
      userId: session.user.id,
      memberId: childMember.id,
      relationship: body.relationship || null,
    },
  });
  return NextResponse.json({ ok: true, linked: true, guardian }, { status: 201 });
}

// OTHERWISE: do NOT grant access. Queue the request for the club owner to
// approve. No MemberGuardianUser row exists yet, so no downstream consumer
// can be tricked — the invariant "row == active access" is preserved.
await prisma.pendingApproval.create({
  data: {
    clubId: session.user.clubId,
    memberId: childMember.id,
    kind: "GUARDIAN_LINK",
    payload: {
      requestingUserId: session.user.id,
      requestingUserEmail: requesterEmail,
      relationship: body.relationship || null,
    },
    status: "PENDING",
  },
});

return NextResponse.json(
  {
    ok: true,
    linked: false,
    pendingApproval: true,
    message:
      "Your request to manage this athlete was sent to the club for approval. " +
      "You'll get access once they confirm you're the guardian.",
  },
  { status: 202 },
);
```

> Reuses the existing `PendingApproval` model (`prisma/schema.prisma:218`) — add `GUARDIAN_LINK` to its `kind` comment enum. No migration needed; `payload` is `Json` and `amount` stays null.

#### Fix 1b — the owner-approval endpoint

```ts
// app/api/members/[id]/guardians/approve/route.ts  (NEW)
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { prisma } from "@/lib/prisma";

const schema = z.object({ approvalId: z.string(), decision: z.enum(["APPROVE", "DECLINE"]) });

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  const denied = requirePermission(session, "members", "edit");   // owner or members:edit staff
  if (denied) return denied;

  const { approvalId, decision } = schema.parse(await req.json());

  // Scope the approval to THIS club + THIS member — blocks cross-tenant approval by guessed id.
  const approval = await prisma.pendingApproval.findFirst({
    where: {
      id: approvalId,
      clubId: session!.user.clubId,
      memberId: params.id,
      kind: "GUARDIAN_LINK",
      status: "PENDING",
    },
  });
  if (!approval) return NextResponse.json({ error: "Request not found." }, { status: 404 });

  const payload = approval.payload as { requestingUserId: string; relationship: string | null };

  if (decision === "APPROVE") {
    await prisma.$transaction([
      prisma.memberGuardianUser.upsert({
        where: { userId_memberId: { userId: payload.requestingUserId, memberId: params.id } },
        update: { relationship: payload.relationship },
        create: { userId: payload.requestingUserId, memberId: params.id, relationship: payload.relationship },
      }),
      prisma.pendingApproval.update({
        where: { id: approval.id },
        data: { status: "APPROVED", respondedAt: new Date(), respondedById: session!.user.id },
      }),
    ]);
    return NextResponse.json({ ok: true, approved: true });
  }

  await prisma.pendingApproval.update({
    where: { id: approval.id },
    data: { status: "DECLINED", respondedAt: new Date(), respondedById: session!.user.id },
  });
  return NextResponse.json({ ok: true, approved: false });
}
```

> The owner UI surfaces pending `GUARDIAN_LINK` rows on `/dashboard/members/[id]` (and/or a club-wide queue) with Approve/Decline buttons hitting this route. The dashboard already has the members-detail page to host it.

#### Fix 1c — close the same hole at signup

In `app/api/member/signup/route.ts` PARENT branch, apply the **identical** gate: only auto-create the `MemberGuardianUser` row when `child.isMinor && child.guardianEmail === newUser.email`; otherwise create a `PendingApproval(kind:"GUARDIAN_LINK")` and tell the parent their access is pending club approval. Do not let an **unauthenticated** signup grant guardian access.

#### Tests to add

- Member A (email `a@x.com`) requests link to Member B whose `guardianEmail` is `someone-else@x.com` → **202 pending, no row created**, B's `/api/member/portal` data is NOT reachable by A.
- Member A whose email == B's `guardianEmail` and `B.isMinor` → **201 linked**.
- Non-minor target → always pending (no `isMinor`, no auto-link).
- Owner approves → row created, A now sees B. Owner of a *different* club cannot approve A's request (404 via clubId scope).

---

### FINDING 2 — Activation-token replay → account takeover (HIGH)

#### The bug

`POST /api/members/migration/activate/[token]` sets a member's portal password from a 30-day emailed token. Two defects combine into account takeover:

1. **The replay guard checks the wrong status.** It 409s only on `COMPLETED`, but a successful POST sets status to **`ACTIVATED`** (line 207), not `COMPLETED`. So the guard never fires after activation.

```ts
// activate/[token]/route.ts:144  (current)
if (member.migrationStatus === MIGRATION_STATUS.COMPLETED) {       // ← never true post-activation
  return NextResponse.json({ error: "This membership is already active." }, { status: 409 });
}
```

2. **The token is never cleared and the password is overwritten unconditionally.** No code sets `activationToken: null`. If a `User` already exists for the contact email, the handler overwrites its `passwordHash` with no proof of control:

```ts
// activate/[token]/route.ts:175-191  (current)
let user = await prisma.user.findUnique({ where: { clubId_email: { clubId: club.id, email: contactEmail } } });
if (user) {
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });   // ← unconditional overwrite
}
```

Net effect: anyone who obtains the activation link (email forwarding, shared device, leaked logs) can POST it repeatedly — each time **resetting the member's portal password**. Resends re-extend the 30-day TTL, so the window is effectively unbounded until the member reaches `COMPLETED` (and the no-payment branch never does).

#### Fix 2a — make the token single-use (the core fix)

Clear the token on every successful activation, in the **first** `member.update` so all branches consume it:

```ts
// activate/[token]/route.ts:196  (add the two clearing lines to the existing update)
await prisma.member.update({
  where: { id: member.id },
  data: {
    ...(member.userId ? {} : { userId: user.id }),
    ...(editable.phone && body.phone?.trim() ? { phone: body.phone.trim() } : {}),
    ...(newEmail ? { email: newEmail } : {}),
    ...(editable.billingDateRequest && validRequested ? { requestedBillingDate: validRequested } : {}),
    ...(editable.billingDateRequest && body.requestedBillingNote
      ? { requestedBillingNote: body.requestedBillingNote.trim() } : {}),
    ...(editable.notes && body.activationNote ? { activationNote: body.activationNote.trim() } : {}),
    migrationStatus: MIGRATION_STATUS.ACTIVATED,
    activatedAt: new Date(),
    approvalStatus: "PENDING_APPROVAL",
    activationToken: null,            // ← consume the token: single-use
    activationTokenExpires: null,     // ← belt-and-suspenders
  },
});
```

Once cleared, `loadByToken` (`:25`) returns `"invalid"` on any replay → 404. This alone closes the replay.

#### Fix 2b — fix the guard so the window can't be raced

Reject re-entry once the token has already been consumed (status past PENDING), so two near-simultaneous POSTs can't both pass:

```ts
// activate/[token]/route.ts:144  (replace)
if (
  member.migrationStatus === MIGRATION_STATUS.COMPLETED ||
  member.migrationStatus === MIGRATION_STATUS.ACTIVATED
) {
  return NextResponse.json({ error: "This membership is already active." }, { status: 409 });
}
```

> For true race-safety under concurrent POSTs, also make the clearing write conditional so only one wins:
> ```ts
> const consumed = await prisma.member.updateMany({
>   where: { id: member.id, activationToken: token },   // only matches if still unconsumed
>   data: { /* ...activation fields..., */ activationToken: null, activationTokenExpires: null },
> });
> if (consumed.count === 0) {
>   return NextResponse.json({ error: "This membership is already active." }, { status: 409 });
> }
> ```
> `updateMany` with the token in the `where` is a compare-and-swap: the loser updates 0 rows and 409s.

#### Fix 2c — don't silently overwrite an existing portal account

If a real `User` already exists for the contact email (a member who already set up portal login), do **not** reset their password from a migration token. Either link the existing user without touching `passwordHash`, or require they use the normal reset flow:

```ts
// activate/[token]/route.ts:175-191  (replace the `if (user)` branch)
let user = await prisma.user.findUnique({
  where: { clubId_email: { clubId: club.id, email: contactEmail } },
});
if (user) {
  // Existing portal account — link the migration to it, but NEVER overwrite the
  // password via a migration token. They already have a login + the reset flow.
  // (no passwordHash write)
} else {
  user = await prisma.user.create({
    data: { clubId: club.id, email: contactEmail, passwordHash,
            firstName: member.firstName, lastName: member.lastName, role: "MEMBER" },
  });
}
```

#### Fix 2d — bound the resend lifetime (hardening)

`lib/migrationServer.ts` re-extends `activationTokenExpires` to now+30d on every resend, making the window unbounded. Cap total lifetime from the original issue date (e.g. refuse to resend more than 90 days after first send, or stop extending once near the cap). Lower priority once 2a makes the token single-use.

#### Tests to add

- Activate successfully → POST the same token again → **404** (token cleared) and member password unchanged.
- Two concurrent POSTs with the same token → exactly one succeeds, the other **409** (compare-and-swap).
- Activation where a portal `User` already exists → existing user's `passwordHash` is **unchanged**.
- No-payment club path (status never reaches COMPLETED) → token still single-use.

---

## 4. Systemic backlog (defense-in-depth, prioritized)

Not open exploits on their own, but each should be closed before real scale. Roughly highest-leverage first.

| # | Item | Where | Why it matters |
|---|------|-------|----------------|
| S1 | **No server-side session revocation** — JWT trusted 14 days; reset/role-change/soft-delete don't revoke | `lib/auth.ts` jwt/session callbacks | Defeats the recovery purpose of password reset; removed staff keep access. Add a `User.tokenVersion` (or `sessionsValidAfter`) checked in the `jwt` callback; bump it on password change/reset, role change, and "sign out everywhere." |
| S2 | **Tokens stored plaintext at rest** | `User.resetToken`, `Member.activationToken` | A DB read hands over every live token. Store `sha256(token)`; look up by hash; keep the raw token only in the emailed URL. |
| S3 | **Promote CSP to enforcing** + drop inline-SVG serving (or force `Content-Disposition: attachment`) | `next.config.mjs`, `app/api/upload`, `app/api/files/[id]` | Report-Only CSP provides zero XSS protection today; SVG-inline is a same-club stored-XSS vector until then. |
| S4 | **Open MEMBER self-registration by public slug**; `emailVerified` never set | `app/api/auth/signup`, `app/api/member/signup` | Anyone with a club slug spawns unverified member accounts. Gate join-mode behind an invite, or require email verification before the account is usable. |
| S5 | **Webhook bare-id writes** → use `updateMany({id, clubId})` and assert metadata `clubId` === row `clubId` | `app/api/stripe/webhook/route.ts:401,492,239,256` | Defense-in-depth parity with the already-hardened membership/class branches. |
| S6 | **Central tenant-enforcement layer** (deferred F-3) | route-handler boundary | Replace 271-site manual discipline with a `tenantDb(clubId)` wrapper so a future query can't forget the filter. |
| S7 | **Login user-enumeration via bcrypt timing** | `lib/auth.ts:75/86/88` | Run a dummy `bcrypt.compare` on the user-not-found path to equalize timing. |
| S8 | **Per-account login lockout** + don't trust raw `X-Forwarded-For` | `lib/auth.ts`, `lib/ratelimit.ts` | Current per-IP, in-memory limit doesn't stop distributed stuffing on one account; move to Upstash/Redis with a per-account counter when abuse risk is real. |
| S9 | **`checkin/[id]` unauthenticated cross-club read** | `app/api/checkin/[id]/route.ts:9-16` | Low-sensitivity (class/event title + club branding) but unscoped. Sign the kiosk id or scope it. |
| S10 | **Stop returning `String(err)` to clients** | `change-password:42`, `link-child:60`, others | Minor internal-detail disclosure; return a generic 500 body, log the detail server-side. |
| S11 | **Webhook 200-on-exception hides activation failures** | `app/api/stripe/webhook/route.ts:681` | Keep the no-retry-storm behavior but add alerting on persisted `errorMessage` rows so paid-but-not-activated divergence is caught. |

---

## 5. What was confirmed correct (don't "fix" these)

- Club-scoped credential login + `clubId_email` composite throughout; bcrypt cost 12 at all hash sites; `deletedAt` checked at login.
- Stripe webhook signature verification over raw body + env secret + idempotency via `StripeWebhookEvent`.
- Manual `clubId` scoping holds across ~60 sampled routes (patterns A/B/C above); `files/[id]` cross-club check; cross-member writes verify both members.
- Member-portal `memberId` validation against the accessible set; DM cold-message block; group-membership gate; minor self-sign block.
- Plaid token exchange server-side; access token never serialized to any response; OWNER + Pro-tier gating.
- `reset-password` and `staff-setup` tokens are single-use and cleared (the pattern the activation flow should copy).
- `unsubscribe` HMAC + `timingSafeEqual`; partner/staff/contractor tokens high-entropy with expiry + reuse rejection.
- Cookie prefixes/flags, security headers, no secrets in code or history.
```
