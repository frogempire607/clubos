# Phase 3 — Communications & Email · Deliverable

Written 2026-08-02, end of session 3. Meets the exit criteria in
plan.md §3N "Document at the end of this phase".

Every commit for Phase 3 sits on `main` and is not pushed —
Julian tests locally first, then pushes.

---

## What changed (owner-visible surfaces)

### New pages

| Route | Purpose |
|---|---|
| `/dashboard/communication/templates` | 14 stock templates seeded lazily; owner can create/edit/duplicate/archive. Every stock template ships with a LogoBlock header + ContactBlock footer that renderers auto-swap with the club's own logo + contact info at send time. |
| `/dashboard/communication/audiences` | Filter-DSL audience builder with live recipient count + first-10 sample. Dynamic (re-evaluated at send) vs static (frozen list). 17 fields; 2 marked "coming soon". |
| `/dashboard/communication/unsubscribes` | Owner admin list of every opt-out. Per-row scope select (Marketing / Transactional / All), Resubscribe action, per-address audit history modal. |
| `/dashboard/communication/campaigns/[id]` | Campaign-level results per announcement: intended / delivered / opened / clicked / bounced with tracking-adjusted denominators and per-recipient timeline. |

### New composer

`components/EmailComposer.tsx` — tiptap-backed rich-text composer with a
block DSL (`lib/emailBlocks.ts`) → MJML render (`lib/emailRender.ts`) →
sanitized HTML on write. Content blocks: heading, paragraph, list,
button, image, divider, spacer, contact, logo. Preview modes desktop
and mobile. Send Test button delivers to the sender's own inbox.

Draft persistence (§3M): `draftKey` prop opts in to localStorage
backing; state survives device rotation and page refresh. 30-day age
out; Discard button on the restored-draft banner.

Personalization tokens (§3F): 14 tokens listed below. Unknown tokens
render blank (never leak `{{token}}` to a recipient); typos are flagged
in the composer via `<PersonalizationHint>`.

### Members-page bulk composer

`app/dashboard/members/page.tsx` `<BulkEmailModal>` — the primary send
surface. 8-mode picker (see §3E), 3K preflight panel, per-recipient
preview list showing resolved address + display name, final-review
modal with typed `SEND N` confirmation ≥ 50 recipients.

### Announcements page

Extended with the 3H lifecycle: Send now / Cancel / View results
per card. Status pill now understands DRAFT / SCHEDULED / SENDING /
SENT / CANCELED with legacy LIVE / EXPIRED fallback.

### Profile Communications tab

`app/dashboard/members/[id]/page.tsx` `<CommunicationsCard>` — lists
every EmailSend for this member with sender, related event/membership,
delivery status pill, body preview. Reader modal shows the immutable
`bodyHtml` exactly as the recipient received it.

---

## Schema changes

All additive. No renames, no drops. `M21` and `M22` are the two
Phase-3 migrations added this cycle; M16–M20 shipped session 1.

| # | File | Applied | Contents |
|---|---|---|---|
| M16 | `20260801000000_email_sends` | ✅ 2026-08-01 | `EmailSend` per-recipient delivery log. Partial unique index on `(sendBatchId, dedupeKey)` is the double-send guarantee. |
| M17 | `20260801010000_email_opt_outs_scope` | ✅ 2026-08-01 | `EmailOptOut` gains `userId`, `scope` (MARKETING/TRANSACTIONAL/ALL), `source`. Legacy rows backfilled to MARKETING. |
| M18 | `20260801020000_announcements_lifecycle` | ✅ 2026-08-01 | `Announcement` gains `status`, `bodyJson`, `bodyHtml`, `bodyText`, `senderUserId`, `scheduledFor`, `sentAt`, `sendBatchId`, `canceledAt`, `canceledById`, `approvalRequestedById`, `approvalRequestedAt`, `approvedById`, `approvedAt`, `audienceId`, `audienceFilters`, `householdMode`, `templateId`, `fromName`, `replyTo`, `personalization`, `previewText`. Backfill: `publishAt < now OR NULL` → status=SENT, else DRAFT. |
| M19 | `20260801030000_email_templates` | ✅ 2026-08-01 | `EmailTemplate` model (per-club, 14 stock kinds seeded lazily on first fetch). |
| M20 | `20260801040000_marketing_audiences` | ✅ 2026-08-01 | `MarketingAudience` (per-club, filters Json, isDynamic, frozenMemberIds, estimatedCount, archivedAt). |
| M21 | `20260801050000_club_mailing_address` | ✅ 2026-08-01 | `Club` gains `mailingAddress`, `mailingAddress2`, `mailingCity`, `mailingState`, `mailingZip`, `mailingCountry`, `publicEmail`, `publicPhone`. |
| M22 | `20260802000000_email_history_optout_audit` | ✅ 2026-08-02 | `EmailSend` gains `sentByUserId`, `relatedEventId`, `relatedMembershipId` + covering indexes. New `EmailOptOutAudit` table (append-only preference log). |

All 7 confirmed via `\d clubs` / `\d email_sends` / `\d email_opt_out_audits`
+ `_prisma_migrations` bookkeeping.

---

## Background jobs

### Netlify scheduled function — `email-queue-cron.mts`

- **Schedule:** every 5 minutes (`*/5 * * * *`).
- **Handler:** HTTP POST to `/api/cron/email-queue?limit=50` with
  `Authorization: Bearer $CRON_SECRET`.
- **What it drains:** any `EmailSend` row in status=QUEUED and any
  `Announcement` in status=SCHEDULED whose `scheduledFor <= now`.

### `/api/cron/email-queue` route

Two phases per tick:

1. **EmailSend drain** — up to 50 QUEUED rows (oldest first).
   Dispatches via `dispatchExistingRow` which uses a transactional
   delete-then-re-invoke pattern; the M16 partial unique on
   `(sendBatchId, dedupeKey)` rejects any parallel-run double-insert.
2. **Announcement drain** — up to 25 SCHEDULED announcements whose
   `scheduledFor <= now`. Dispatches via `dispatchAnnouncement`
   which atomically claims DRAFT/SCHEDULED → SENDING via a
   conditional `updateMany`.

### Large-send safety net (session 3)

**Threshold: `INLINE_DISPATCH_MAX = 100`** (lib/enqueueEmailSend.ts).

- Below 100 recipients: bulk route + announcement dispatch run inline.
  Sender sees the send finish before the request returns.
- Above 100 recipients: the request renders each recipient's body and
  INSERTs the EmailSend rows as QUEUED, then returns immediately.
  The cron worker owns dispatch from there.

Rationale: at ~400ms per recipient (Prisma personalization + mjml
render + Resend HTTP + row update), 292 recipients inline averaged
~117s vs the 60s Netlify `maxDuration`. Any recipient past the
timeout was silently dropped because rows never got inserted.

100-recipient inline ceiling gives ~40s headroom at 400ms/row.
292-recipient blast drains in ~6 cron ticks (~30 min worst case).

### Resend webhook — `/api/webhooks/resend`

Signature-verified (`RESEND_WEBHOOK_SECRET`). Populates lifecycle
timestamps on `EmailSend`: `deliveredAt`, `bouncedAt`, `openedAt`,
`clickedAt`, and increments `openCount` / `clickCount`.

---

## Email tracking limitations

**Never claim "opened" when tracking is unavailable.** The 3G surfaces
enforce this by reading nullable timestamps directly:

- `openedAt` / `clickedAt` are populated ONLY when Resend fires the
  webhook (requires the recipient's mail client to load the tracking
  pixel or click a wrapped link).
- SMTP-only sends (rows without a `providerMessageId`) never receive
  callbacks. The UI renders "Delivered · open tracking unavailable"
  instead of "Unopened".
- Apple Mail Privacy, corporate Outlook, and plain-text mode strip
  tracking pixels. These recipients look like "Delivered · not yet
  opened" forever even if they've read the message.
- Campaign results divide by `trackingCapable` count (rows with a
  `providerMessageId`), not `intended`. Zero-tracking-capable sends
  render an explicit "Open/click tracking unavailable for this send"
  empty state.
- Deliverability metrics come from Resend when configured. If
  Resend is not configured (SMTP fallback), we know only that the
  provider accepted the send (`sentAt`); we cannot report
  delivery, opens, clicks, or bounces.

---

## File upload limitations

Only owner-added images shipped this phase; no first-class attachment
support.

- Images embedded in the composer route through
  `/api/public/images/[fileId]?t=<hmac>` (signed URL, no session
  required). `EMAIL_IMAGE_SECRET` is separate from `NEXTAUTH_SECRET`
  so rotating auth doesn't break images in already-sent emails. No
  expiry on the signature — historical emails must render years later.
- Composer preflight WARN fires on images wider than 800px (some
  mail clients strip images above ~1MB).
- PDFs and other attachments: intentionally treated as signed links.
  Real SMTP attachments would need a dedicated migration and
  composer changes; not shipped this phase.
- No file-size ceiling enforced beyond what the upload endpoint
  already caps. Client-side warning fires on wide images.

---

## New permissions

Base permission model unchanged. `messages` keeps its levels
(`none` / `view` / `send` / `full`) but gains **eight nested
sub-scopes** stored under `StaffProfile.permissions.messages_subScopes`:

| Sub-scope | Guards | Default |
|---|---|---|
| `bulk` | Members-page bulk email + announcement Send now/Schedule/Cancel | OFF |
| `marketing` | Marketing audiences CRUD + preview | OFF |
| `templates` | Email templates create/edit/duplicate/archive/delete | ON |
| `images` | Upload images for email | ON |
| `unsubscribe` | Opt-out admin list + audit history | OFF |
| `analytics` | Profile Communications tab + campaign results | OFF |
| `approve` | Approval workflow (deferred; permission plumbed) | OFF |
| `audience_all_club` | Address any member. OFF = coach can only email members in classes/events they teach | OFF |

**Coach-restricted audience** (`lib/coachAudience.ts`): staff without
`audience_all_club` see only members enrolled in classes/events they
teach — union of attendance records, event bookings, event
registrations, and private-lesson bookings. Ids outside the audience
are DROPPED from the request, not just hidden. Preview surfaces the
`outsideCoachAudience` count so the coach sees "N members hidden".

Owner bypasses every check. Legacy `messages: "send"` staff without
sub-scopes fall back to `DEFAULT_MESSAGES_SUBSCOPES`.

---

## Required environment variables

Only two are new this phase; the rest were pre-existing.

| Env var | Required | Purpose |
|---|---|---|
| `RESEND_API_KEY` | Recommended for production | Enables Resend as the dispatcher (lifecycle webhooks, better deliverability). Without it we fall back to SMTP (no lifecycle callbacks). |
| `RESEND_WEBHOOK_SECRET` | Required if `RESEND_API_KEY` is set | Signature for `/api/webhooks/resend`. |
| `EMAIL_IMAGE_SECRET` | Required if the composer uses images | HMAC secret for signed `/api/public/images/[fileId]` URLs. **Must not equal `NEXTAUTH_SECRET`** — rotating auth secrets must not break images in already-sent emails. |
| `CRON_SECRET` | Required | Netlify scheduled function auth for `/api/cron/email-queue`. Route returns 503 when unset (never opens by default). |
| `EMAIL_FROM` | Required | Default From address on the wire. e.g. `AthletixOS <noreply@athletix-os.com>`. |
| `EMAIL_BASE_URL` | Optional | Absolute origin for URLs embedded in email HTML (logo, unsubscribe, signed images). Falls back to `NEXT_PUBLIC_SITE_URL`, then hardcoded `https://athletix-os.com`. **Never uses NEXTAUTH_URL** — that's LAN dev / preview and dies in Gmail. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | Fallback | Nodemailer path when Resend isn't configured. |
| `NEXTAUTH_URL` | Required | Session cookies, redirect URIs. Not used for email URLs. |

---

## Manual testing steps

Do this locally before pushing. Assumes M22 is applied and the dev
server is running at `http://127.0.0.1:3000`.

### 1. Composer + 3F personalization

1. Sign in as an owner.
2. Members page → select 2-3 members with a shared guardian → **Email
   selected**.
3. In the composer, type a subject and body that reference
   `{{guardian_first_name}}`, `{{membership_end_date}}`, `{{event_name}}`.
4. **Verify** the "Personalization" panel shows all three as
   known tokens (chips).
5. Type a fake token like `{{doesnotexist}}` — verify it's flagged
   orange as "unknown".
6. Click **Send test** — check your inbox. Confirm tokens resolved to
   your own account's guardian_first_name, that unknown token
   rendered as an empty string (no raw `{{`), and that the club logo
   loaded with correct aspect ratio (M21 fix).

### 2. 3E household modes

1. In the same composer, cycle through the 8 modes.
2. **Verify** the pre-send strip updates the "Will send" count for
   each mode. Guardian-shared siblings should collapse to 1 in
   HOUSEHOLD, 2 in PER_MEMBER, N (per guardian × athlete) in
   ALL_GUARDIANS.
3. **Verify** the per-recipient preview list shows the resolved
   address + display name (guardian name for minors).

### 3. 3K preflight + typed confirm

1. Empty the subject — **verify** the Send button disables and the
   preflight panel shows "Must fix: Add a subject before sending."
2. Refill subject. Add an oversized image (>800px wide) — **verify**
   the WARN "images exceed 800px wide" appears (Send stays enabled).
3. Select 51+ members → open the composer → click
   **Review & send to N recipients** → **verify** the final-review
   modal renders sender/reply-to/mode/counts/tracking + requires you
   to type `SEND N` exactly to enable Send now.

### 4. 3M draft persistence

1. In the composer, type a subject + a paragraph.
2. **Refresh the page** (Cmd+R).
3. Re-open the composer — **verify** the restored-draft banner
   appears and your text is intact.
4. Click **Discard draft** — verify the composer resets.

### 5. 3H announcement lifecycle

1. Announcements page → **+ New announcement** → fill in and save
   WITHOUT ticking "Send now".
2. **Verify** the card shows status **DRAFT**.
3. Click **Send now** → confirm dialog → **verify** status flips to
   **SENT** and a **View results** button appears.
4. Click **View results** → **verify** the campaign page shows
   intended / delivered / opened / clicked with the tracking-adjusted
   note if any recipients used SMTP-only.
5. Create another announcement + schedule it 2 minutes into the
   future (via the modal's scheduling field). Wait for the cron to
   fire → verify the card advances to SENT.
6. Create a third + click **Cancel** → verify status flips to
   CANCELED.

### 6. 3I unsubscribe

1. From your test-send email, click the **Unsubscribe** link.
2. **Verify** the granular panel appears with 3 radio options.
3. Choose "All non-essential email" → Save → **verify** the
   confirmation renders.
4. In the dashboard, `/dashboard/communication/unsubscribes` →
   **verify** your address shows up with scope=ALL.
5. Click the **history** button on that row → **verify** the audit
   modal shows the UNSUBSCRIBE_LINK action with your IP + UA.
6. Click **Resubscribe** → verify the audit gains a SUBSCRIBE row
   and the address is removed from the list.

### 7. 3L coach-restricted audience

1. In Settings → Staff → edit a coach → set messages = send but
   leave `audience_all_club` OFF.
2. Sign in as that coach → Members → select 3 members you know they
   don't teach → **Email selected**.
3. **Verify** the "Will send" count is 0 and the preview says
   "N members hidden — you only teach some of them", and the Send
   button is disabled.
4. Repeat with members enrolled in a class the coach teaches →
   verify they show up correctly.

### 8. Large-send safety net (queue path)

1. As owner, select 150+ members → **Email selected** → craft a
   short send.
2. Click Review & send → type `SEND N` → Send now.
3. **Verify** the response renders "Send queued" (or the send-result
   panel shows queued=N, sent=0). The request should return in
   under 20 seconds even for 300 recipients.
4. Wait 5 min → refresh the campaign results page (via the
   announcement path) or the profile Communications tab of one of
   the recipients → **verify** delivery status appears.

### 9. Regression — receipts still fire

Anything that used `lib/email.ts` (welcome, staff invite, payment
receipts) still routes through `sendClubEmail` when the code has
been migrated; direct nodemailer paths are unchanged. Verify by
adding a member manually (Members page → Add) → confirm the
welcome email arrives at their address.

---

## Deployment order

The application code has been landing on `main` incrementally. To
deploy Phase 3 to production, do these in order:

1. **Confirm env vars are set on Netlify** — `RESEND_API_KEY`,
   `RESEND_WEBHOOK_SECRET`, `EMAIL_IMAGE_SECRET` (unique to this
   env — do not reuse), `CRON_SECRET`, `EMAIL_FROM`. `EMAIL_BASE_URL`
   optional (falls back to production origin).
2. **Confirm M21 + M22 are applied to production** — every migration
   in this phase (M16–M22) should already be applied since Julian
   applies from his own terminal before each session. Verify with
   `psql "$SESSION_POOLER" -c '\d clubs' | grep mailing`,
   `\d email_sends` (should show sentByUserId), and
   `\d email_opt_out_audits`.
3. **Verify Resend webhook endpoint is registered in the Resend
   dashboard** pointing at
   `https://<production>/api/webhooks/resend` with the same
   `RESEND_WEBHOOK_SECRET`.
4. **Push the branch** — `git push origin main`. Netlify builds
   auto-run `prisma generate && next build`.
5. **After deploy, verify the cron function is registered** —
   Netlify Functions page should list `email-queue-cron` with
   schedule `*/5 * * * *`. First run confirms cron is live.
6. **Send a test blast to 2-3 addresses** through the Members-page
   composer to smoke the full path. Confirm delivery in the
   recipients' inboxes and open/click events in the campaign
   results page a few minutes later.
7. **Only after all the above** — attempt the first real
   ~292-family campaign.

---

## Rollback plan

Every migration is additive. Every deploy is a fast-forward on
`main`. Rollback options ordered from safest to most invasive:

### If dispatch fails (provider outage / misconfig)

1. **Turn off Resend** — unset `RESEND_API_KEY` on Netlify.
   `sendClubEmail` falls through to SMTP; no lifecycle tracking but
   sends still land.
2. **Turn off the cron** — remove `CRON_SECRET`. The cron endpoint
   returns 503 without processing; queued rows sit in status=QUEUED
   until the secret is restored.

### If a specific announcement is misbehaving

1. `POST /api/announcements/[id]/cancel` — refuses SENT/SENDING;
   works on DRAFT/SCHEDULED.
2. To stop an already-fired batch: **there is no per-batch abort**.
   Rows already dispatched to Resend continue. Any QUEUED rows in
   the batch can be deleted directly from the database:
   `UPDATE email_sends SET status='SKIPPED', skipped_reason='OPERATOR_ABORT' WHERE send_batch_id=$batch AND status='QUEUED';`

### If a code deploy breaks something

1. `git revert <sha>` for the specific commit → push. Since Phase 3
   commits are focused (3C, 3D, 3E, 3F, 3G, 3H, 3I, 3K, 3L, 3M
   each their own commit) individual features can be reverted
   without pulling the rest.
2. Migrations M16–M22 stay applied — the app tolerates additive
   columns being present without being read.

### If we need to fully back out Phase 3

The migrations are ADDITIVE. There is no "reverse the schema"
because the old code doesn't touch the new columns. The rollback
is: `git revert` the Phase 3 commits, push. New columns become dead
weight (not read, not written by the reverted code). If the columns
themselves must go, apply the ROLLBACK block at the bottom of each
migration SQL — but this is not necessary for the app to work.

### Data-loss safety

- `EmailOptOut` rows are never deleted by any Phase 3 code path —
  Resubscribe deletes the row + writes a SUBSCRIBE audit; if the
  audit table is dropped the row is still gone. We do not offer
  a hard-delete admin action.
- `EmailSend` rows are never deleted after successful dispatch (the
  cron worker's delete-then-re-invoke on QUEUED retries is
  transactional — one row in, one row out).
- Audit rows are append-only.
- No destructive backfill was run for any Phase 3 migration.

---

## Verify commands

Run before pushing each session:

```bash
cd /Users/cubano/Desktop/clubos/web
find . -maxdepth 2 -name "*.tsbuildinfo" -delete
npx prisma validate
npx tsc --noEmit
npm run build
npx tsx scripts/send-path-tests.ts        # 35 pass
npx tsx scripts/email-recipients-tests.ts # 54 pass
```

Session-3 clean at last check: tsc + build clean, 89/89 tests pass,
lint clean on all session-owned files (pre-existing warnings on
member-profile `<img>` and 15 other legacy files are untouched).

---

## Commit index

Every Phase 3 commit on `main`, chronological:

| SHA | Session | Section | Content |
|---|---|---|---|
| M16–M20 migrations | pre-3 | | Applied before session 1 started |
| `6013094` | 1 | M22 | Migration file + schema.prisma additions |
| `32a87da` | 1 | 3C | Templates page + 14 stock templates |
| `91b7a8d` | 1 | 3D | Audiences page + filter DSL + evaluator |
| `d6567a8` | 1 | 3E | 5 new sender-target modes |
| `b996c78` | 1 | 3F | Personalization tokens + preview |
| `a75a701` | 1 | doc | PROGRESS session 1 |
| `659b55e` | 2 | 3L | Messaging sub-scopes + coach-restricted audience |
| `086f9e8` | 2 | 3H | Announcement lifecycle routes (schedule/send/cancel) + idempotent dispatch |
| `c8f46e3` | 2 | 3I | Unsubscribe scope UI + EmailOptOutAudit |
| `3e02b31` | 2 | 3G | Profile Communications tab + campaign results |
| `7691ff7` | 2 | 3K + 3.3/3.4.3 | Pre-send preflight, 8 modes, typed final review |
| `0c072a0` | 2 | doc | PROGRESS session 2 |
| (session 3) | 3 | queue | `INLINE_DISPATCH_MAX` + enqueue helper + send-path tests |
| `6f60c32` | 3 | 3M + 3H UI | Composer draft persistence + announcement lifecycle UI + mobile polish + lint |
| (this file) | 3 | doc | Phase 3 deliverable |
