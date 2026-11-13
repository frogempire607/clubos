# AthletixOS — open tasks (one list)

Verified against production and the repo on **2026-11-10**; sections 3 and 5 updated **2026-11-13**. This replaces hunting through chats.
**Rule:** every chat/session ends by ticking or adding lines here. `BACKLOG.md` keeps the long history;
this file is what's actually left. Order = do top to bottom.

## 1. Money this month (you, in the app)
- [ ] **Weston Knowlton — turn auto-renew ON before Nov 14** (his dad asked; still set to end Nov 14).
- [ ] **14 memberships end Nov 13–29 unless renewed ($2,061/mo):** Lincoln & Mason Martinez, Cameron & Kellan Lister,
      Grady Loureiro, Beatriz Godden, Parker Strickland, André Serra, Vancen Small, Orson Chorba, Max Hall, Harvey King,
      Weston, Thaeden (→ Jason's card). Lincoln, André, Orson show auto-renew "on" but still have an end date.
- [ ] **Thaeden McGuinness — Nov 27:** assign MS/HS 2 days, Charge to = Jason's Mastercard 8793.
- [ ] **21 people trained 3+ times in the last 30 days with no membership** (52 total; 14 paid a drop-in, 12 are in/after
      a free trial). Biggest leak: ~21 × $110 ≈ $2,300/mo. Convert, charge drop-in, or archive.
- [ ] Cash due: Hudson Reichard $175 (overdue since Oct 23), Aylen Grubusic $80 (Nov 12), Drew Telesky $110 (Nov 20).

## 2. Clean records (you, in the app — 15 min)
- [ ] Cancel **John Doe** test memberships (one is a real $5/mo Stripe charge).
- [ ] End **Dakota Mastrantonio** (last paid Aug 14, last came Aug 17).
- [ ] **Wenhuan Wang** has two $60 Tadpoles memberships (cash + card) — end the cash one.
- [ ] **Blake Decker** — Sync from Stripe (no payment recorded since Sep 28).
- [ ] Mark **Paul Ortega** and **Barrett David** "free on purpose" (comps).
- [ ] **Jacob Vann:** guardian email jvann@tessy.com → vannjudson@gmail.com; **archive the empty "Judson Vann" record**.
- [ ] **Zachary Lawell:** login is still the parent's account under Zachary's name. Give Claude the parent's real name →
      run the fix (rename user → guardian link → detach login → re-sign docs).
- [ ] 9 members stuck in migration "Needs review", 193 "Invited" never finished — decide: leave, re-send, or archive.
- [ ] Jason Reynolds' team: add each athlete's real parent as guardian when ready (Paid by stays Jason);
      create the "Team" group rate if you want the 10%.

## 3. Financials — start Jan 1, 2027, covering July 2026 onward
Decided 2026-11-13: all bookkeeping work waits until **Jan 1, 2027**, and when it starts it covers **July 2026 onward**
(QuickBooks has almost nothing after July). Nothing in this section is due before then except the prep.

**Prep (you, before Jan 1):**
- [ ] Download the **Amex statements for Jul–Dec 2026** (PDF + CSV if offered), one per month.
- [ ] Write down every **payment to John** (date, amount, what it was — loan repayment vs. pay) for Jul–Dec.
- [ ] Write down every **owner draw** (date, amount) for Jul–Dec.

**Then (you + Claude, from Jan 1, 2027):**
- [ ] Categorize the uncategorized bank payments (185 as of Nov 10 — Financials → Bank): coaches' Zelle →
      payroll/contractors, rent checks, NYSEG/Spectrum → utilities, Hotels/Enterprise → event costs, owner draws /
      John's loan repayments (from the prep notes above).
- [ ] Connect or import **Amex** from the downloaded statements (lump Amex payments from checking hide what was
      bought) → mark those payments Transfer.
- [ ] Receipts: none uploaded yet (Financials → Receipts).
- [x] **`FIELD_ENCRYPTION_KEY` set in Netlify** (done; needed before any coach fills a W-9). Keep the copy in the
      password manager — losing the key makes saved tax IDs unreadable.

## 4. Accounts & decisions (only you)
- [ ] D-U-N-S for MC Technologies Group LLC → Apple Developer (team J5TSB958YP) + Google Play ($25).
- [ ] Later, for the branded Frog Empire app: Frog Empire's own D-U-N-S + Apple/Google accounts.
- [ ] COPPA switch (`FEATURE_PARENTAL_CONSENT`): 44 consents on file; check the minors who log in themselves first.
- [ ] Approve or reject the auto-renew redesign (3 modes instead of on/off — fixes "auto-renew on but ends").

## 5. Code follow-ups (Claude, one branch, after 1–4)
Built 2026-11-13 on branch `followups-2026-11` (**not pushed / not deployed yet — Julian pushes**). No migration.
- [x] Parent portal shows the card that actually pays a membership (e.g. Jason's), not just the card on file.
      The card number shows only to the person who pays; other guardians see "<Name>'s card".
- [x] Unfinished checkouts stay "pending" forever → closed after 24h by the hourly cron (only when Stripe says the
      checkout was not completed; audit row written).
- [x] Member schedule: a cancelled class day shows as "Canceled"; late call-out reads "1h 59m"; a coach dropped by a
      rule change is notified (in-app, like other staff changes); the review step names the role being added.
- [x] Events: public link refuses the same child twice ("already registered"); "Private link" badge on Attendees;
      an event that is no longer public shows "This event isn't available" at its old link (B31/B32).
- [x] "Paid another way" for a past-due month; a pending cash request closes when card checkout completes;
      payment list names the method ("Visa ·4242", "Cash", "Check") (B28).
- [x] Commitment end can never be after the membership end date (one shared, tested cap).
- [x] Security: member autopay / cancel-request / plan-change routes now require a CONFIRMED guardian link
      (file that had the loose check: `app/api/member/subscriptions/[id]/autopay/route.ts`).
- [ ] **Same loose guardian check is still in `app/api/member/consent/route.ts`** (parental consent). Left alone on
      purpose: tightening it could block a parent whose link is still waiting for approval from giving consent.
      Decide with the COPPA switch (section 4).
- [ ] Cancelled class days are still left out of the calendar feed (ICS / `/cal`) — needs a proper "cancelled" entry.
- [ ] Coach-removed notices are in-app only (no email) — say if they should follow the coverage email setting.
- [ ] Optional: setting to let group rate + sibling discount stack.
- [x] Housekeeping: B36–B40 marked shipped in BACKLOG.md; stale branches and worktrees LISTED with the exact
      commands in `docs/BRANCH-CLEANUP-2026-11.md` (95 merged local, 77 merged remote, 7 unmerged to review —
      `claude/nifty-pasteur-1ecb47` CSP/security commit first). Nothing deleted.
- [ ] Run the clean-up commands in `docs/BRANCH-CLEANUP-2026-11.md` (you), and move the stray
      `web/backfill-platform-fee-…json` out of the repo.

## 6. Then: the app
- [ ] Follow `docs/MOBILE-APP-AUDIT-2026-10-18.md` slices 1–7 (B22 App Store 4.2 work first).
