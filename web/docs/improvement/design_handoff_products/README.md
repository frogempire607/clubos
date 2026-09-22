# Handoff: Products redesign (AthletixOS / clubos)

## Overview

Replaces `web/app/dashboard/products/page.tsx` (the products table, `ProductModal` and `SellModal`) and the member-facing store, with seven screens:

| Screen | Replaces / adds |
| --- | --- |
| **2a** Add / edit product | `ProductModal` (lines ~230–635) |
| **2b** Product list | the products table (lines ~150–230) |
| **2c** Inventory across all products | **new** — no equivalent today |
| **2d** Rental & party bookings | **new** — no equivalent today |
| **2e** Member store product detail | `web/app/member/products/page.tsx` (list-only today) |
| **2f** Party / rental booking flow | **new** |
| **2g** Front-desk Sell | `SellModal` (lines ~637–764) |
| **2h** QR outputs (shelf tag, poster, public page) | **new** |

### The four problems it fixes

1. **Variants aren't real.** Today `settings.variantOptions` and `settings.variantStock` are free-text textareas, and the second one's own hint says "Simple stock notes for staff until variant checkout is connected." So nobody can answer "how many Youth M are left?" The redesign makes each Size × Color combination a row with its own **stock, price, SKU and photo**.
2. **Every type-specific field is a "one per line" textarea** — package tiers, add-ons, duration prices, time windows, blackout dates, custom questions. All become structured editors.
3. **One photo per product.** Now up to 4, first is the cover, and a variant can carry its own.
4. **`visibility` + `showLocation` overlap** and can contradict (members-only visibility while listed on the public checkout link). They collapse into one "where it's sold" list.

## About the Design Files

`Products redesign.dc.html` is a **design reference created in HTML** — a streaming-template prototype with its own small runtime (`support.js`), inline styles and one logic class. **Do not port that structure.** Recreate the designs in the existing clubos environment: Next.js App Router client components, Tailwind v4 with the `@theme` tokens in `web/app/globals.css`, `lucide-react` icons, following the patterns already in `web/app/dashboard/products/page.tsx`, `web/components/` and `web/app/member/`.

Every colour in the prototype is a literal copy of a token defined in `globals.css`. When implementing, use the token (`bg-app-bg`, `text-text-muted`, `border-app-border`, `bg-brand`, `--color-warn-surface`, and in the member portal `.pcard` / `.pbtn-accent` / `--club-accent`) rather than the hex.

Open it in a browser with `support.js` beside it. The canvas pans and zooms; options are labelled `2a`–`2h`.

## Fidelity

**High-fidelity**, and the prototype is interactive — the type locks, exclusivity rules, variant matrix, per-guest maths, filters and derived copy all really run and **are the specification**. Exercise them before implementing.

**One rule matters more than any single screen: nothing that appears twice is stored twice.** In the prototype a single variant ledger feeds the editor matrix, the product cards, the inventory table, the member store and the Sell tiles; one tier table feeds the editor, the booking flow and the poster; one duration table prices every booking; one bookings array drives both the calendar and each card's "n pending". Six review rounds on this file were caused by hard-coded copies of numbers that had a real source. Implement the derivations, not the strings.

---

## Screens

### 2a — Add / edit product (940px card)

Header: title, a derived summary line (`{type} · {price or n tiers} · {storefronts}`), Cancel / Save product.

**Type picker** (a `#FAFAFB` panel at the top): 11 chips, each with an explanatory note below the row that changes with the selection.

| Type | Stock behaviour | Note shown |
| --- | --- | --- |
| Gear / merch | Variant matrix | "Physical items with sizes and colors. Each variant carries its own stock, price, SKU and photo." |
| Bookable | No stock — slots | "Facility rentals and birthday parties… **Private lessons stay OUT of products**: they keep their own Privates surface (coach selection, request times, partner rules) at `/dashboard/privates` and `/member/privates`." |
| Punch card / class pack | None | "A number of visits sold up front. Stock is unlimited…" |
| Team registration kit | None | "A kit's stock comes from the items inside it… counting the bundle separately would double-count." |
| Concessions | Simple count | "Snack-bar items sold fast at the desk. Simple count per item, no sizes." |
| Gift card | None | "A gift card is a balance, not an object — there is nothing to count and nothing to ship." |
| Membership add-on | None | "Add-ons bill alongside a membership, so there is no shelf to count." |
| Tournament entry | None | "Entries are capped by the event's capacity…" |
| Fundraiser pre-order | Variant matrix | "Sold before it exists — collect orders now, count what you owe families later." |
| Digital item | None | "Delivered after purchase. Nothing to count…" |
| Other | None | "Anything else purchasable, with optional questions at checkout." |

Collapsible cards, same language as the events editor: header `padding: 14px 16px`, title 15px/600 `#111111`, derived summary 12px `#6B7280`, right-side `Edit` / `Hide` in 11.5px brand. Body `padding: 0 16px 16px; gap: 14px`.

**Basics & photos** — name, short description, and a 4-slot photo row (96px tiles, 11px radius; slot 1 carries a black `COVER` badge; the empty slot is dashed). Hint: "JPG, PNG, WebP — max 10 MB each. A variant can also carry its own photo below."

**Pricing** — Price, Member price, Taxable in a 3-column row, then a **"Sell this as tiers"** switch (universal — any type). Tiers are a table: Tier · What's included · Length · Price · remove, with `+ Add tier` and a derived range line ("Families choose one at checkout · $150 to $300").

**Inventory & variants** — locked with a per-type reason (table above) when the type doesn't hold stock. When it does: option groups (Size, Color) as chip rows with `+ value`, then the **variant matrix** — 34px photo thumb, variant name, SKU, price, stock, status pill — plus `Set all stock to 10`, `Apply base price to all`, an editable low-stock threshold and a derived total ("30 units · $1,020.00 at retail"). Stock inputs take a red border at 0 and an amber border at or below the threshold; status pills are Out of stock / Low — reorder / In stock.

**Booking & availability** — locked for non-Bookable types. Contains: bookable-day chips; time-window rows (days + from/to); Buffer between / Bookings per slot / Booking window; a **Length & price table** (30/60/90/120 min at $40/$75/$110/$140 — this is the repo's `durationPrices`, and every booking's money reads from it); **Payment at booking** as three exclusive cards (Pay in full / Deposit / Request first) where the deposit amount only exists in Deposit mode and is otherwise a dashed lock panel with the reason; an **Add-ons table** (label · Flat/Per guest · price · remove); **Max guests**; a **Questions at checkout** list (label · Short text/Long text/Number · Required/Optional · remove); "Staff approves each booking"; blackout-date chips.

**Where it's sold** — three checkbox rows replacing `visibility` + `showLocation`: Member portal store / Public checkout link / Front desk only. When the public link is on, a **Public link, QR & website embed** panel appears (below). Then Fulfillment (greyed with a reason for types that need no handover) and an internal note.

**Recap panel** (brand-tinted, bottom) — states the consequence of the current settings, e.g. which variants will show as sold out, or "3 tiers on 6 days, a $75 deposit, each request waiting on staff."

#### Public link, QR & website embed

- **Link address** — editable slug behind a `/p/` prefix. Labelled honestly: **new route**, mirroring the existing public event page `/e/{slug}`; today `PUBLIC_CHECKOUT` only widens who sees a product inside the member store (both `/api/member/products*` filters accept it). Copy follows events: "the shareable link is generated when you save."
- **Share it** — the URL with Copy, plus Email it / Announcement (both exist in the app; no SMS path was found, so there is no "Text it").
- **QR code** — grounded in `web/components/QRModal.tsx`: the actions are its real trio **Open · Copy link · Print**, and the note names the generation path (`QRModal → qrcode`, `toDataURL`, 320 px, margin 2, error correction "M"). The checker tile is a mock placeholder — use the real generator. **Print tag sheet** is marked **New**: today's print view does a single 320 px code with the URL beneath; 6-to-a-page tags are the addition.
- **Count scans** — labelled **New** ("nothing counts scans today").
- **Website button** — a copyable `<a href>` snippet; note explains non-members check out with Stripe while members get the member price after signing in.

### 2b — Product list (1000px)

Header with a derived subtitle (`9 products · $3,012.00 inventory at retail · 3 need attention`), Receive stock, + Add product. Filter chips with **derived counts** (All / Gear / Bookable / Low or out / Inactive) plus search. Body is a 4-column photo-card grid: 104px striped cover with a stock badge bottom-left (`30 in stock` / `Out of stock` / `Bookable` / `Unlimited` / `Pre-order` / `Inactive`), name, type line, price, sold count, derived chips (`1 sold out`, `4 low`, `6 variants`, `1 pending`, `Hidden from store`), then a primary action (Sell / Bookings / Restock / Orders / Activate) and `⋯`.

### 2c — Inventory (1000px)

Four tiles — Units on hand, Retail value, Low stock, Sold out — all computed. Then every tracked variant in one table, **worst first**: thumb, variant + product, SKU, a −/+ stepper, alert-at, sold 30 d, value, status pill. Footnote: adjusting here writes the number the member store and Sell screen read.

### 2d — Bookings (1000px)

Header (week nav, `+ Add booking`, "2 waiting on you"), then `1fr 340px`: a week grid (`56px repeat(6,1fr)`, 5 hourly rows, cells = Confirmed brand-tint / Waiting-on-you warn / Blackout hatched / Open dashed, with a legend) beside a list of this week's bookings — name, what, when, money and Approve · Decline or Message · Cancel. Every amount computes from the tier and duration tables; each product's pending count comes from this same array.

### 2e — Member store detail (393px)

**Member-portal language, not dashboard**: `#FAFAF9` page, `.pcard` surfaces (`#FFFFFF`, `1px solid #ECEAE7`, 16px radius, `0 1px 2px rgba(28,25,23,.04), 0 1px 3px rgba(28,25,23,.03)`), stone text (`#1C1917` / `#78716C` / `#A8A29E`), accent `--club-accent #1C1917` with white contrast.

Photo carousel (4 dots), Shop pill, name, member price with struck-through list price, **"Buying for"** athlete switcher (`ProfileSwitcher`), size and colour pickers showing **per-variant stock** ("2 left" / "sold out"), a derived stock banner, quantity stepper, uppercase discount-code field, and a sticky `Checkout · $29.00` (disabled and relabelled "Sold out" when that combination is 0) with "Secure checkout by Stripe" and the real 5-tab nav (Home · Book · Schedule · Messages · More).

### 2f — Party / rental booking flow (3 × 393px)

Step 1: tier cards (selectable; selection retitles step 2) and a derived line "Up to {maxGuests} guests. {n} add-ons available on the last step."
Step 2: day strip (closed days greyed), slot grid (taken slots greyed), header and slot label derived from the chosen tier's length.
Step 3: the questions from 2a's list rendered by type, add-on rows from 2a's table (per-guest ones show `+$90 × 8`), then an order summary — tier row, each selected add-on (per-guest rows show `$90 × 8 guests`), Total, and Due now — and a confirmation sentence that adapts to the payment mode and approval setting. CTA is "Request this party" with approval on, otherwise "Book & pay $X".

### 2g — Front-desk Sell (860px)

Grounded in `SellModal` + `StaffDiscountPicker`. Left: variant tiles (each a variant, not a product, with its stock; sold-out tiles disabled). Right: **Member (optional)** select including "Walk-in / no member", cart lines with per-line stock, an optional **Note** ("Size, color, special instructions…"), the **Discount** picker showing ineligible codes with their reason and previewing the maths, Subtotal / discount / Total, the two real payment paths — **Cash / Manual** ("Records the sale immediately without Stripe.") and **Stripe Checkout** ("Opens a Stripe payment link for the customer.") — and a CTA that switches between **Record sale** and **Generate link**.

There is deliberately **no tax line**: `SellModal` and `/api/products/[id]/sell` don't compute tax. If you add it, drive it from the product's `taxable` flag per line.

### 2h — QR outputs

Shelf tag (3 × 4 in: name, price, QR, "Scan to buy · pick your size", URL — 6 to a sheet), gym-door poster preset (club name, headline, QR, derived "From $199 · 45–120 minutes"), and the public landing page mock in club branding with per-variant stock, a derived "Members save $14" badge (hidden when there's no member discount) and "No account needed · secure checkout by Stripe".

---

## Interactions & rules

**Type locks** — each non-stock type replaces the inventory body with a dashed panel carrying that type's reason (table in 2a). Booking is locked for non-Bookable types; fulfillment greys out for types with nothing to hand over.

**Exclusivity** — pricing is one choice per product (price vs tiers is additive, but deposit mode is exclusive): deposit amount exists only in Deposit mode, with the reason shown in the other two modes.

**Derived everywhere** (implement as computed values from one source):
- variant ledger → editor totals, card stock badges, `n low`/`n sold out` chips, inventory rows and all four tiles, 2b's subtitle, member-store per-variant stock, Sell tiles;
- tier table → Pricing summary, range line, booking-flow cards, step-2 header/slot label, order summary, poster "From $X";
- duration table → every booking's money in 2d;
- bookings array → 2d's list, the calendar and each card's "n pending";
- add-ons table → the flow's chips, order rows and total (**per-guest = price × guest answer**);
- max guests → step-1 sentence and the guest-count clamp;
- questions list → step-3 fields, including their input type and "(optional)" suffix;
- base − member price → the public page's "Members save $X" badge.

## State / data model

```
// Product
id, name, description, productType            // the 11 types above
photos[]                                       // up to 4, [0] is cover  ← replaces single imageUrl
price, memberPrice, taxable
tiersEnabled, tiers[]                          // { name, includes, length, price }  ← replaces settings.packageTiers text
trackInventory
optionGroups[]                                 // { name, values[] }                 ← replaces settings.variantOptions text
variants[]                                     // { id, label, sku, price, stock, photoUrl, sold }  ← replaces settings.variantStock notes
lowStockAlertQuantity
storefronts[]                                  // MEMBER_PORTAL | PUBLIC_LINK | STAFF_ONLY  ← replaces visibility + showLocation
publicSlug                                     // new public route, mirroring /e/{slug}
fulfillment, internalNotes

// Bookable only
bookableDays[], timeWindows[]                  // { days, from, to }   ← replaces settings.timeWindows text
durations[]                                    // { mins, price }      ← the repo's settings.durationPrices, structured
bufferMinutes, bookingsPerSlot, bookingWindow
paymentMode                                    // FULL | DEPOSIT | REQUEST
depositAmount                                  // only when DEPOSIT
addOns[]                                       // { label, price, perGuest }  ← replaces settings.addOns text
maxGuests
questions[]                                    // { label, kind, required, hint }  ← replaces settings.customQuestions text
requiresApproval, blackoutDates[]

// Booking (new)
id, productId, memberId|guestName, tierName|durationMins, startsAt,
guests, answers{}, status: PENDING|CONFIRMED|CANCELED, deposit, amountDue
```

**Migration:** parse the existing free-text settings into their structured equivalents (`"Basic: 60 minutes, $150"` → a tier row; `"Youth S / Black: 8"` → a variant row; `"30 minutes: $40"` → a duration row; `"Extra 30 minutes: $75"` → an add-on). Map `visibility`/`showLocation` → `storefronts` (public link wins over members-only; internal-only becomes STAFF_ONLY). `FACILITY_RENTAL` and `BIRTHDAY_PARTY` both become `BOOKABLE` (the party preset turns tiers on). Keep `productType` values you don't recreate mapping to `OTHER`.

**Out of scope:** private lessons. They already have `/dashboard/privates`, `/member/privates`, `lib/privateLessonRules.ts` and `lib/privatePartners.ts` with a coach-selection and request-times flow; the Bookable type must not absorb them.

## Design tokens

**Dashboard (2a–2d, 2g):** brand `#6D5DF6` / hover `#5948E8`; lime `#A3E635`; orange `#FF6A00`; bg `#F7F7F9`; surface `#FFFFFF`; border `#E5E7EB`; text `#111111`; muted `#6B7280`; plus `#374151` labels, `#4B5563` body, `#9CA3AF` kickers. Semantic pairs from `globals.css`: warn `#FFF7ED` / `#B45309` / `rgba(180,83,9,.22)`; danger `#FEF2F2` / `#B91C1C` / `rgba(185,28,28,.22)`; success `rgba(163,230,53,.25)` / `#3F6212`; info `rgba(109,93,246,.06)` / `rgba(109,93,246,.25)`; pending `#EDEBFF` / `#4F46E5`; chip `#F1F1F3` / `#4B5563`; hairline `#F1F1F3`; table chrome `#FAFAFB`; inset `#F4F4F6` + dashed `#D7D7DC`.

**Member portal (2e, 2f, 2h's page mock):** `--club-accent #1C1917`, contrast `#FFFFFF`, soft `rgba(28,25,23,.06)`, ring `rgba(28,25,23,.18)`; page `#FAFAF9`; `.pcard` `#FFFFFF` + `1px solid #ECEAE7` + 16px radius + `0 1px 2px rgba(28,25,23,.04), 0 1px 3px rgba(28,25,23,.03)`; stone text `#1C1917` / `#44403C` / `#57534E` / `#78716C` / `#A8A29E`; `#F5F5F4` pills; `#D6D3D1` input borders; `.pbtn-accent` shadow `0 1px 2px rgba(28,25,23,.16)`.

**Type:** Inter. 20px/600 screen titles · 19px/600 member titles · 15px/600 card titles · 14px inputs · 13.5px dense rows · 12.5px meta · 12px/600 field labels · 11.5px hints · 11px/600 uppercase `.05–.07em` kickers · 10–10.5px/600 pills. Tabular numerals on every money and count.

**Spacing** 4/6/8/10/12/14/16/20/24px · cards 14px inner gap, 10–12px between · dashboard inputs `10px 12px`, dense rows `8px 10px`, member inputs `11px 12px`.
**Radii** 16px member cards · 14px dashboard cards · 12px inner panels · 10px inputs · 9px desktop buttons · 8px table inputs · 7px checkboxes · 9999px pills.
**Shadows** `0 12px 32px rgba(17,17,17,.10)` dashboard cards · `0 12px 32px rgba(28,25,23,.14)` phones.

## Assets

None. Photos are striped placeholders (`repeating-linear-gradient(135deg,#F4F4F6,#F4F4F6 6px,#EDEDF1 6px,#EDEDF1 12px)`, member-portal variant in `#F1EFEC`/`#E9E6E2`) with monospace labels — use the real `ImageUpload` component. QR images are `repeating-conic-gradient` checkers standing in for `qrcode`-generated data URLs. Icons are text glyphs standing in for the `lucide-react` set already in use.

## Files

| File | What it is |
| --- | --- |
| `Products redesign.dc.html` | The redesign, options `2a`–`2h`. Interactive — exercise the type locks, variant matrix, per-guest add-ons and filters here |
| `support.js` | The prototype runtime; must sit beside the HTML |

**Source files this was built from:** `web/app/dashboard/products/page.tsx` (`ProductsPage` table ~150–230, `ProductModal` ~230–635, `SellModal` ~637–764, `productTypeLabels`/`visibilityLabels`/`showLocationLabels` ~50–80), `web/components/StaffDiscountPicker.tsx`, `web/components/QRModal.tsx`, `web/components/ImageUpload.tsx`, `web/app/member/products/page.tsx`, `web/app/member/shop/page.tsx`, `web/components/member/ItemCard.tsx`, `web/components/member/ui.tsx`, `web/app/member/layout.tsx`, `web/app/globals.css`, `web/app/api/products/route.ts`, `web/app/api/member/products/route.ts`.
