# AthletixOS — Phase 2.1: Document signature pad (2026-06-21)

Replaces the typed "I acknowledge" step with a real **drawn signature** (finger/mouse),
stored as an image and shown in the owner's signature audit. Works in the member
portal **and** during public onboarding/activation.

## ⚠️ This one has a DB migration — run it BEFORE the code goes live

The new code writes a `signatureDataUrl` column that doesn't exist yet. Because a push
auto-deploys on Netlify, apply the migration to the production DB **first**, then push:

```bash
cd ~/Desktop/clubos/web

# 1) Apply the migration to prod (uses DIRECT_URL; migrate deploy = no shadow DB)
npx prisma migrate deploy

# 2) Regenerate the client + verify
npx prisma generate
npx tsc --noEmit        # should be clean
npm run build

# 3) Clean up the two scratch files still on main from last push, then commit + push
git rm -f __deltest tsconfig.member.json
git add -A
git commit -m "Phase 2.1: drawn signature pad for documents + onboarding"
git push
```

The migration is `web/prisma/migrations/20260621000000_document_signature_image/` — it just adds a nullable `signatureDataUrl TEXT` to `document_signatures` (additive, safe; existing rows stay NULL).

## What changed
- **New** `web/components/member/SignaturePad.tsx` — dependency-free canvas pad (pointer events, high-DPI, Clear).
- **New** `web/lib/signature.ts` — shared PNG-data-URL validation (format + ~220 KB cap).
- **Member documents** (`app/member/documents/page.tsx`) — the sign step now shows the pad; the button enables only once a signature is drawn.
- **Sign API** (`app/api/member/documents/[id]/sign/route.ts`) — accepts/validates/stores `signatureDataUrl`.
- **Onboarding** (`app/activate/[token]/page.tsx` + activation route) — required documents now collect one drawn signature, applied to each acknowledged doc.
- **Owner audit** (`app/dashboard/documents/page.tsx`) — the Signatures table shows each signer's signature image (or "Typed acknowledgement" for legacy rows).
- Schema: `DocumentSignature.signatureDataUrl String?`.

Back-compat: old signatures (no image) still display; the signup wizard still uses the typed acknowledgement for now (can adopt the pad next).

## Test checklist — signature pad
- [ ] **Member, self:** Documents → open a required doc → a signature box appears. The "Agree & sign" button is **disabled** until you draw. Draw → Clear works → draw again → sign. Card shows "✓ Signed".
- [ ] **Member, guardian:** switch to a child → sign a guardian-required doc → records as "Guardian".
- [ ] **Re-sign:** an expired doc shows "Re-sign document" and requires a fresh drawing.
- [ ] **Onboarding:** open an activation link with a required waiver → read + check each doc → a "Your signature" pad appears → submit is blocked until you sign → activate succeeds.
- [ ] **Owner audit:** Dashboard → Documents → a document's Signatures → each row shows the **signature image**, signer, relationship, date, IP; legacy/typed rows show "Typed acknowledgement".
- [ ] **Mobile:** the pad draws smoothly with a finger and the page doesn't scroll while signing.
- [ ] **Validation:** signing still works if the image is large but reasonable; a malformed image is rejected with a clear message (not a 500).

## Still in Phase 2 (not started)
- Two-way parent⇄coach messaging (#9).
- Co-guardian / co-parent invite (#8b).
- (Minor) bring the pad to the member **signup** wizard too.
