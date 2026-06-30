# AthletixOS — Phase 2 complete (2026-06-21)

Three features: **drawn signature pad (#6)**, **two-way family messaging (#9)**, and
**co-guardian invite (#8b)**. Two DB migrations are included.

## ⚠️ Deploy — run the migrations BEFORE pushing

New code writes two new columns. Apply both migrations to prod first (a push
auto-deploys), then push:

```bash
# 0) Clear the stale git lock left by the assistant's sandbox (else commit fails)
rm -f ~/Desktop/clubos/.git/index.lock

cd ~/Desktop/clubos/web

# 1) Apply BOTH pending migrations (signature image + message subject)
npx prisma migrate deploy

# 2) Regenerate client + verify
npx prisma generate
npx tsc --noEmit        # should be clean
npm run build

# 3) Remove the two scratch files still on main, then commit + push
git rm -f __deltest tsconfig.member.json
git add -A
git commit -m "Phase 2: signature pad, two-way family messaging, co-guardian invite"
git push
```

Migrations added:
- `20260621000000_document_signature_image` — `document_signatures.signatureDataUrl TEXT`
- `20260621010000_message_subject_member` — `messages.subjectMemberId TEXT` + index

Both are additive and safe on a live DB (existing rows stay NULL).

> Note: the Prisma writes for these two columns use a localized `as Prisma.*Input`
> cast because this sandbox can't regenerate the Prisma client (engine download is
> blocked). After `prisma generate` runs in your build the columns are first-class;
> the casts are harmless. (If you prefer, you can remove the casts after a local
> `prisma generate` — but they don't need to be removed.)

## What shipped

**Signature pad (#6)** — covered in `SIGNATURE_PAD_2026-06-21.md`: drawn signature in
the member documents flow, onboarding, and the owner's signature audit.

**Two-way family messaging (#9)**
- Parents can **start** a conversation with any coach/owner — new "New message" composer on the Messages page (pick recipient + who it's *about*: you or a specific child).
- A thread can be **about a specific child even if that child has no login** (new `Message.subjectMemberId`), so every athlete gets their own tagged thread.
- **Coaches/owners messaging a minor now reach the guardian** (this already routed to the guardian; now it's tagged so the parent sees a "For {child}" pill).
- Threads about a child show the "For {child}" tag in the list and the thread header; a guardian messaging the same coach about two kids gets two separate threads.
- Parental control to disable a minor's own messaging still applies.

**Co-guardian invite (#8b)**
- On a child's **Manage** page → "Add another guardian": invite a co-parent by email.
- It files a standard guardian-link request in the **owner's Approvals** queue (no access is granted until the owner approves — same security model as every other guardian link).
- The co-parent must already have a club account; if not, the parent gets a clear "ask them to sign up first" message.

## Test checklist — Phase 2

### Two-way messaging
- [ ] **Parent → coach (about self):** Messages → New message → pick a coach, About = "Me" → send. Thread opens; the coach receives it in the dashboard.
- [ ] **Parent → coach (about a child):** New message → About = a child → send. The thread shows a **"For {child}"** tag and appears under "Messages for your athletes."
- [ ] **No-login child:** pick a child who has **no** portal login as the subject — the tagged thread still works (this was impossible before).
- [ ] **Coach → parent:** from the owner dashboard, message a **minor** member → the **guardian** receives it; on the parent's side it's tagged for that child.
- [ ] **Two kids, one coach:** message the same coach about child A and child B → two separate tagged threads, not one merged thread.
- [ ] **Self vs child separation:** a parent's own thread with a coach stays separate from the child threads with that coach.
- [ ] **Disabled messaging:** a controlled minor with messaging turned off still sees the "managed by your guardian" banner.

### Co-guardian invite
- [ ] Child **Manage** → "Add another guardian" → enter the email of a co-parent **who has a club account** → "Request sent." Owner sees it in **Members → Approvals** → Approve → the co-parent now sees the child in their portal and can manage them.
- [ ] Enter an email with **no** account → friendly "ask them to create an account first" message (not an error).
- [ ] Invite someone already linked, or yourself → friendly message, no duplicate.

### Signature pad (recap)
- [ ] Member documents: signing requires a drawn signature; owner audit shows the image. (Full list in `SIGNATURE_PAD_2026-06-21.md`.)

## Phase 2 leftovers (optional, minor)
- Bring the signature pad to the member **signup** wizard (currently typed acknowledgement).
- Show the "about {child}" tag on the **owner's** message thread view (data is already tagged; owner already picks the member, so low value).
