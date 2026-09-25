/**
 * B10 slice 3 — types, time windows, bookings, inventory. Pure.
 * `npm run test:product-booking`.
 * Worked example: a party room — Basic 90 min $150 / Deluxe 2 hours $250,
 * pizza $90 per guest, Sat–Sun 10:00–18:00, 30-min buffer, one party at a time.
 */
import {
  normalizeProductSettings, parseTimeWindowLine, normTime, stockBehaviour, isBookable, categoryForType, PRODUCT_TYPES,
  emptyProductSettings, type ProductSettings,
} from "../lib/productSettings";
import {
  parseLengthMins, lengthOptions, bookingQuote, quoteFromParts, slotsForDay, slotIsOpen, holdsSlot, effectiveWindows,
  dayClosedReason, checkAnswers, statusAfterPayment, weekStart, wallInstant, clubToday,
} from "../lib/productBooking";
import { inventoryRows, adjustStock } from "../lib/productInventory";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
}
const TZ = "America/New_York";
const party: ProductSettings = {
  ...emptyProductSettings(),
  tiersEnabled: true,
  tiers: [{ name: "Basic", includes: "Room + host", length: "90 min", price: 150 }, { name: "Deluxe", includes: "Room, host, cake", length: "2 hours", price: 250 }],
  availableDays: ["Sat", "Sun"],
  timeWindows: [{ days: [], from: "10:00", to: "18:00" }],
  bufferMinutes: 30,
  capacityLimit: 1,
  maxGuests: 12,
  addOns: [{ label: "Pizza", price: 90, perGuest: true }, { label: "Balloons", price: 25, perGuest: false }],
  questions: [{ label: "Birthday child's name", kind: "SHORT", required: true }, { label: "Allergies", kind: "LONG", required: false }],
  depositMode: "DEPOSIT",
  depositAmount: 75,
  requiresApproval: true,
};

console.log("types:");
{
  check("11 types offered", PRODUCT_TYPES.length === 11);
  check("gear + pre-order: variant matrix", stockBehaviour("GEAR").variants && stockBehaviour("PRE_ORDER").variants);
  check("concessions: plain count, no sizes", stockBehaviour("CONCESSION").holdsStock && !stockBehaviour("CONCESSION").variants);
  check("gift card / add-on / kit / punch card hold no stock", ["GIFT_CARD", "MEMBERSHIP_ADDON", "TEAM_KIT", "PUNCH_CARD", "TOURNAMENT_ENTRY", "DIGITAL"].every((t) => !stockBehaviour(t as never).holdsStock));
  check("old rental + party values still bookable", isBookable("BOOKABLE") && isBookable("FACILITY_RENTAL") && isBookable("BIRTHDAY_PARTY") && !isBookable("GEAR"));
  check("category for Financials", categoryForType("BOOKABLE") === "FACILITY" && categoryForType("CONCESSION") === "GEAR" && categoryForType("GIFT_CARD") === "SERVICE");
}

console.log("time windows:");
{
  check("4 PM → 16:00", normTime("4:00 PM") === "16:00" && normTime("4pm") === "16:00" && normTime("12am") === "00:00" && normTime("25:00") === null);
  const w = parseTimeWindowLine("Mon-Fri 4:00 PM-8:00 PM");
  check("'Mon-Fri 4:00 PM-8:00 PM' parsed", !!w && w.days.join() === "Mon,Tue,Wed,Thu,Fri" && w.from === "16:00" && w.to === "20:00", w);
  check("'Sat,Sun 9am-1pm'", parseTimeWindowLine("Sat,Sun 9am-1pm")?.days.join() === "Sat,Sun");
  check("backwards window refused", parseTimeWindowLine("Mon 8pm-4pm") === null);
  const legacy = normalizeProductSettings({ v: 2, timeWindows: ["Mon-Fri 4:00 PM-8:00 PM", "gibberish"] });
  check("stored text lines upgrade on read; junk dropped", legacy.timeWindows.length === 1 && legacy.timeWindows[0].from === "16:00");
  const eff = effectiveWindows(party);
  check("a dayless window covers every bookable day", eff[0].days.join() === "Sat,Sun");
  check("no windows ⇒ 9–9 on bookable days", effectiveWindows({ ...party, timeWindows: [] })[0].from === "09:00");
}

console.log("what can be booked:");
{
  check("'2 hours' = 120, '90 min' = 90, '1.5 hr' = 90", parseLengthMins("2 hours") === 120 && parseLengthMins("90 min") === 90 && parseLengthMins("1.5 hr") === 90);
  const o = lengthOptions(party, 0);
  check("tiers are the options", o.length === 2 && o[1].key === "tier:Deluxe" && o[1].mins === 120 && o[1].price === 250);
  const d = lengthOptions({ ...emptyProductSettings(), durations: [{ mins: 60, price: 75 }, { mins: 30, price: 40 }] }, 0);
  check("length table when no tiers", d.length === 2 && d[0].key === "mins:60" && d[0].price === 75);
  check("nothing set ⇒ one hour at the base price", lengthOptions(emptyProductSettings(), 50)[0].price === 50);
}

console.log("money:");
{
  const q = bookingQuote(party, 0, { lengthKey: "tier:Deluxe", guests: 8, addOns: ["Pizza", "Balloons"] });
  check("Deluxe + pizza × 8 + balloons = $250 + $720 + $25 = $995", q.ok && q.quote.total === 995, q);
  check("deposit mode: $75 due now", q.ok && q.quote.dueNow === 75);
  const full = bookingQuote({ ...party, depositMode: "FULL" }, 0, { lengthKey: "tier:Basic", guests: 2, addOns: [] });
  check("pay in full: all due now", full.ok && full.quote.dueNow === 150);
  const req = bookingQuote({ ...party, depositMode: "REQUEST_ONLY" }, 0, { lengthKey: "tier:Basic", guests: 2, addOns: [] });
  check("request first: nothing due now", req.ok && req.quote.dueNow === 0);
  check("deposit never above the total", (() => { const r = bookingQuote({ ...party, depositAmount: 999 }, 0, { lengthKey: "tier:Basic", guests: 1, addOns: [] }); return r.ok && r.quote.dueNow === 150; })());
  check("over max guests refused", !bookingQuote(party, 0, { lengthKey: "tier:Basic", guests: 13, addOns: [] }).ok);
  check("an add-on that isn't on the product refused", !bookingQuote(party, 0, { lengthKey: "tier:Basic", guests: 1, addOns: ["Pony"] }).ok);
  check("unknown option refused", !bookingQuote(party, 0, { lengthKey: "tier:Gold", guests: 1, addOns: [] }).ok);
  const view = quoteFromParts({ options: lengthOptions(party, 0), addOns: party.addOns, maxGuests: 12, mode: "DEPOSIT", depositAmount: 75 }, { lengthKey: "tier:Deluxe", guests: 8, addOns: ["Pizza", "Balloons"] });
  check("the page's summary = the server's charge", view.ok && q.ok && view.quote.total === q.quote.total && view.quote.dueNow === q.quote.dueNow);
  check("per-guest line reads $90 × 8 guests", q.ok && q.quote.lines[1].detail === "$90 × 8 guests");
}

console.log("slots:");
{
  const now = new Date("2026-10-01T12:00:00Z"); // a Thursday
  const sat = "2026-10-03";
  const s = slotsForDay({ settings: party, date: sat, mins: 90, busy: [], tz: TZ, now });
  check("Sat 10:00–18:00, 90 min, every 30 min ⇒ 10:00 … 16:30 (14 slots)", s.length === 14 && s[0].label === "10:00 AM" && s[13].label === "4:30 PM", s.map((x) => x.label));
  check("10:00 local = 14:00Z in October (EDT)", s[0].startsAt === "2026-10-03T14:00:00.000Z");
  const busy = [{ startsAt: wallInstant(sat, 12 * 60, TZ), endsAt: wallInstant(sat, 13 * 60 + 30, TZ) }];
  const t = slotsForDay({ settings: party, date: sat, mins: 90, busy, tz: TZ, now });
  const taken = t.filter((x) => x.taken).map((x) => x.label);
  check("a 12:00–1:30 party + 30-min buffer takes 10:30 through 1:30", taken.join() === "10:30 AM,11:00 AM,11:30 AM,12:00 PM,12:30 PM,1:00 PM,1:30 PM", taken);
  check("2:00 PM is free again", t.find((x) => x.label === "2:00 PM")?.taken === false);
  check("two per slot ⇒ nothing taken by one booking", slotsForDay({ settings: { ...party, capacityLimit: 2 }, date: sat, mins: 90, busy, tz: TZ, now }).every((x) => !x.taken));
  check("weekday closed", dayClosedReason(party, "2026-10-05", TZ, now) === "closed");
  check("blackout date closed", dayClosedReason({ ...party, blackoutDates: [sat] }, sat, TZ, now) === "blackout");
  check("past closed", dayClosedReason(party, "2026-09-27", TZ, now) === "past");
  check("beyond the booking window closed", dayClosedReason({ ...party, bookingWindowDays: 1 }, sat, TZ, now) === "too far ahead");
  check("server re-check: an open slot passes", slotIsOpen({ settings: party, startsAt: "2026-10-03T18:00:00.000Z", mins: 90, busy, tz: TZ, now }));
  check("server re-check: a taken slot fails", !slotIsOpen({ settings: party, startsAt: "2026-10-03T16:00:00.000Z", mins: 90, busy, tz: TZ, now }));
  check("server re-check: an off-grid time fails", !slotIsOpen({ settings: party, startsAt: "2026-10-03T14:10:00.000Z", mins: 90, busy: [], tz: TZ, now }));
  check("clubToday in the club's zone", clubToday(TZ, new Date("2026-10-02T02:00:00Z")) === "2026-10-01");
}

console.log("status + answers:");
{
  const now = new Date("2026-10-01T12:00:00Z");
  check("an open card checkout holds its slot for 30 min", holdsSlot({ status: "PENDING_PAYMENT", createdAt: new Date(now.getTime() - 10 * 60_000) }, now));
  check("an abandoned one releases it", !holdsSlot({ status: "PENDING_PAYMENT", createdAt: new Date(now.getTime() - 40 * 60_000) }, now));
  check("declined / canceled never hold", !holdsSlot({ status: "DECLINED", createdAt: now }, now) && !holdsSlot({ status: "CANCELED", createdAt: now }, now));
  check("paid + staff approves ⇒ waits on staff", statusAfterPayment(party) === "PENDING" && statusAfterPayment({ requiresApproval: false }) === "CONFIRMED");
  check("required question enforced", !checkAnswers(party, {}).ok);
  const a = checkAnswers(party, { "Birthday child's name": " Ava ", Allergies: "", extra: "x" });
  check("answers trimmed, blanks + unknown dropped", a.ok && a.answers["Birthday child's name"] === "Ava" && !("Allergies" in a.answers) && !("extra" in a.answers));
  check("week starts Monday", weekStart("2026-10-04") === "2026-09-28" && weekStart("2026-09-28") === "2026-09-28");
}

console.log("inventory:");
{
  const hoodie = {
    id: "h", name: "Hoodie", price: 40, productType: "GEAR", active: true, trackInventory: true, inventory: 3,
    settings: { v: 2, lowStockAlertQuantity: 2, optionGroups: [{ name: "Size", values: ["S", "M", "L"] }], variants: [{ id: "S", label: "S", stock: 0 }, { id: "M", label: "M", stock: 1, price: 45 }, { id: "L", label: "L", stock: 2 }] },
  };
  const water = { id: "w", name: "Water", price: 2, productType: "CONCESSION", active: true, trackInventory: true, inventory: 24, settings: {} };
  const party2 = { id: "p", name: "Party", price: 0, productType: "BOOKABLE", active: true, trackInventory: false, inventory: null, settings: {} };
  const v = inventoryRows([hoodie, water, party2], (pid, vid) => (pid === "h" && vid === "M" ? 5 : 0));
  check("rows: 3 sizes + the plain count; nothing for a bookable", v.rows.length === 4, v.rows.map((r) => r.label));
  check("worst first: sold out, then low (fewest first)", v.rows[0].label === "S" && v.rows[1].label === "M" && v.rows[2].label === "L", v.rows.map((r) => `${r.label}:${r.status}`));
  check("tiles", v.tiles.units === 27 && v.tiles.soldOut === 1 && v.tiles.low === 2 && v.tiles.retailValue === 45 + 80 + 48, v.tiles);
  check("sold 30 d per variant", v.rows[1].sold30 === 5);
  const s = normalizeProductSettings(hoodie.settings);
  const r = adjustStock(s, hoodie, { variantId: "S", delta: 6 });
  check("receive 6 of S", r.ok && r.stock === 6 && r.settings!.variants.find((x) => x.id === "S")!.stock === 6);
  const neg = adjustStock(s, hoodie, { variantId: "M", delta: -5 });
  check("never below 0", neg.ok && neg.stock === 0);
  check("a product with sizes needs the size", !adjustStock(s, hoodie, { variantId: null, delta: 1 }).ok);
  const plain = adjustStock(normalizeProductSettings({}), { inventory: 24, trackInventory: true }, { variantId: null, set: 30 });
  check("plain count set to 30", plain.ok && plain.inventory === 30 && plain.settings === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
