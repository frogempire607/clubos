# AthletixOS — open tasks (one list)

Verified against production and the repo on **2026-11-10**. This replaces hunting through chats.
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

## 3. Financials (you + Claude)
- [ ] **DECIDE:** QuickBooks has almost nothing after July, but the plan says AthletixOS books start Jan 1, 2027
      (QuickBooks = 2026 record). Either catch QuickBooks up for Jul–Dec or move the AthletixOS start to Jul 1, 2026.
- [ ] Categorize **185** uncategorized bank payments (Financials → Bank): coaches' Zelle → payroll/contractors,
      rent checks, NYSEG/Spectrum → utilities, Hotels/Enterprise → event costs, owner draws / John's loan repayments.
- [ ] Connect or import **Amex** (lump Amex payments from checking hide what was bought) → mark those payments Transfer.
- [ ] Receipts: none uploaded yet (Financials → Receipts).
- [ ] **Set `FIELD_ENCRYPTION_KEY` in Netlify + .env before any coach fills a W-9** (staff W-9 shipped; the key wasn't in
      the Nov 3 build's env list). `openssl rand -base64 32` → `1:<value>`; save a copy in a password manager.

## 4. Accounts & decisions (only you)
- [ ] D-U-N-S for MC Technologies Group LLC → Apple Developer (team J5TSB958YP) + Google Play ($25).
- [ ] Later, for the branded Frog Empire app: Frog Empire's own D-U-N-S + Apple/Google accounts.
- [ ] COPPA switch (`FEATURE_PARENTAL_CONSENT`): 44 consents on file; check the minors who log in themselves first.
- [ ] Approve or reject the auto-renew redesign (3 modes instead of on/off — fixes "auto-renew on but ends").

## 5. Code follow-ups (Claude, one branch, after 1–4)
- [ ] Parent portal shows the card on file instead of the card actually paying a membership (e.g. Jason's).
- [ ] Unfinished checkouts stay "pending" forever → auto-close after a day.
- [ ] Member schedule: show a cancelled class day as "Cancelled" (B33 UI/QA list); late-call-out "2h" rounding;
      coach dropped by a rule change isn't notified.
- [ ] Events: public link accepts the same child twice; "came via private link" badge (B31/B32).
- [ ] "Paid another way" for a past-due month; auto-close a pending cash request when card checkout completes (B28).
- [ ] Optional: setting to let group rate + sibling discount stack.
- [ ] Housekeeping: 5 stale branches (oldest July; review `claude/nifty-pasteur-1ecb47` CSP/security commit before
      deleting), 5 prunable worktrees, stray `web/backfill-platform-fee-…json`; mark B36–B40 shipped in BACKLOG.md
      (all migrations through 20261027 are applied).

## 6. Then: the app
- [ ] Follow `docs/MOBILE-APP-AUDIT-2026-10-18.md` slices 1–7 (B22 App Store 4.2 work first).
