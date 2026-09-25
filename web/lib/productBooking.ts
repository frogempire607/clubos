// B10 slice 3 — booking a Bookable product (the handoff's 2d / 2f). PURE: no
// prisma, no IO. Every number comes from the product's own tables:
//   • tiers (when "Sell this as tiers" is on) or the Length & price table
//     price the booking and set its length;
//   • add-ons (flat or per guest) and max guests;
//   • bookable days + time windows + buffer + bookings per slot + booking
//     window + blackout dates decide which slots exist and which are taken;
//   • the payment mode decides what is due now.
// A booking snapshots its money (amountTotal / dueNow) — editing the product
// later never changes a booking already made.
//
// Times: the owner types wall-clock times ("16:00") for the club. Slots are
// computed in that wall clock and turned into real instants with the club's
// IANA timezone (lib/datetime) — bookings store instants.

import { wallClockUTCToInstant, tzOffsetMs } from "@/lib/datetime";
import {
  DAY_KEYS,
  timeLabel,
  type AddOn,
  type ProductSettings,
  type TimeWindow,
} from "@/lib/productSettings";

export const DEFAULT_TZ = "America/New_York";
const DEFAULT_WINDOW: Omit<TimeWindow, "days"> = { from: "09:00", to: "21:00" };
const SLOT_STEP_MIN = 30;

// ── what can be booked ───────────────────────────────────────────────────────

export type LengthOption = {
  /** "tier:Gold" or "mins:60" — what the family picks; what the server re-resolves. */
  key: string;
  label: string;
  /** For a tier: its "what's included" line. */
  includes: string | null;
  mins: number;
  price: number;
  tierName: string | null;
};

/** "2 hours" / "90 min" / "1.5 hr" / "2h" / "120" → minutes. Unreadable → 60. */
export function parseLengthMins(text: string | null | undefined): number {
  const t = String(text ?? "").toLowerCase();
  const n = Number((t.match(/(\d+(?:\.\d+)?)/) ?? [])[1]);
  if (!Number.isFinite(n) || n <= 0) return 60;
  if (/h/.test(t) && !/min/.test(t)) return Math.round(n * 60);
  return Math.round(n);
}

export function lengthOptions(settings: ProductSettings, basePrice: number): LengthOption[] {
  if (settings.tiersEnabled && settings.tiers.length > 0) {
    return settings.tiers
      .filter((t) => t.price != null)
      .map((t) => ({ key: `tier:${t.name}`, label: t.name, includes: t.includes || null, mins: parseLengthMins(t.length), price: t.price!, tierName: t.name }));
  }
  const ds = settings.durations.filter((d) => d.mins > 0 && d.price != null);
  if (ds.length > 0) {
    return ds.map((d) => ({ key: `mins:${d.mins}`, label: minsLabel(d.mins), includes: null, mins: d.mins, price: d.price!, tierName: null }));
  }
  return [{ key: "mins:60", label: minsLabel(60), includes: null, mins: 60, price: basePrice, tierName: null }];
}

export function minsLabel(mins: number): string {
  if (mins % 60 === 0) return `${mins / 60} hour${mins === 60 ? "" : "s"}`;
  if (mins > 60) return `${Math.floor(mins / 60)} hr ${mins % 60} min`;
  return `${mins} minutes`;
}

/** The windows that apply: the owner's, else 9–9 on every bookable day. A
 *  window with no days of its own applies to every bookable day. */
export function effectiveWindows(settings: ProductSettings): TimeWindow[] {
  const bookable = settings.availableDays.length ? settings.availableDays : DAY_KEYS;
  if (settings.timeWindows.length === 0) return [{ days: bookable, ...DEFAULT_WINDOW }];
  return settings.timeWindows.map((w) => ({ ...w, days: (w.days.length ? w.days : bookable).filter((d) => bookable.includes(d)) }));
}

// ── money ────────────────────────────────────────────────────────────────────

export type BookingQuoteInput = { lengthKey: string; guests: number; addOns: string[] };
export type BookingQuoteLine = { label: string; detail: string | null; amount: number };
export type BookingQuote = {
  option: LengthOption;
  guests: number;
  lines: BookingQuoteLine[];
  total: number;
  dueNow: number;
  addOns: { label: string; perGuest: boolean; price: number; amount: number }[];
  mode: ProductSettings["depositMode"];
};

const round = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `$${n.toFixed(2).replace(/\.00$/, "")}`;

export type QuoteParts = {
  options: LengthOption[];
  addOns: { label: string; price: number | null; perGuest: boolean }[];
  maxGuests: number | null;
  mode: ProductSettings["depositMode"];
  depositAmount: number | null;
};

export function bookingQuote(
  settings: ProductSettings,
  basePrice: number,
  input: BookingQuoteInput,
): { ok: true; quote: BookingQuote } | { ok: false; message: string } {
  return quoteFromParts(
    { options: lengthOptions(settings, basePrice), addOns: settings.addOns, maxGuests: settings.maxGuests, mode: settings.depositMode, depositAmount: settings.depositAmount },
    input,
  );
}

/** The same arithmetic from the parts the store view carries — so the page's
 *  order summary and the server's charge are one function. */
export function quoteFromParts(
  parts: QuoteParts,
  input: BookingQuoteInput,
): { ok: true; quote: BookingQuote } | { ok: false; message: string } {
  const settings = { maxGuests: parts.maxGuests, addOns: parts.addOns, depositMode: parts.mode, depositAmount: parts.depositAmount };
  const option = parts.options.find((o) => o.key === input.lengthKey);
  if (!option) return { ok: false, message: "Pick one of the options." };
  const guests = Math.max(1, Math.floor(input.guests || 1));
  if (settings.maxGuests != null && settings.maxGuests > 0 && guests > settings.maxGuests) {
    return { ok: false, message: `Up to ${settings.maxGuests} guests.` };
  }
  const chosen: { label: string; perGuest: boolean; price: number; amount: number }[] = [];
  for (const label of Array.from(new Set(input.addOns))) {
    const a: Pick<AddOn, "label" | "price" | "perGuest"> | undefined = settings.addOns.find((x) => x.label === label);
    if (!a || a.price == null) return { ok: false, message: `"${label}" isn't an add-on for this.` };
    chosen.push({ label: a.label, perGuest: a.perGuest, price: a.price, amount: round(a.perGuest ? a.price * guests : a.price) });
  }
  const lines: BookingQuoteLine[] = [
    { label: option.tierName ?? `${option.label}`, detail: option.tierName ? minsLabel(option.mins) : null, amount: option.price },
    ...chosen.map((c) => ({ label: c.label, detail: c.perGuest ? `${money(c.price)} × ${guests} guests` : null, amount: c.amount })),
  ];
  const total = round(lines.reduce((s, l) => s + l.amount, 0));
  const dueNow =
    settings.depositMode === "REQUEST_ONLY"
      ? 0
      : settings.depositMode === "DEPOSIT"
        ? round(Math.min(total, Math.max(0, settings.depositAmount ?? 0)))
        : total;
  return { ok: true, quote: { option, guests, lines, total, dueNow, addOns: chosen, mode: settings.depositMode } };
}

/** The sentence under the order summary. */
export function bookingPromise(settings: Pick<ProductSettings, "requiresApproval">, q: BookingQuote): string {
  const approve = settings.requiresApproval;
  if (q.mode === "REQUEST_ONLY") return `Nothing is charged now. The club confirms your request${q.total > 0 ? `, then collects ${money(q.total)}` : ""}.`;
  if (q.mode === "DEPOSIT")
    return `${money(q.dueNow)} deposit now${q.total > q.dueNow ? `, ${money(round(q.total - q.dueNow))} at the event` : ""}.${approve ? " If the club can't confirm it, the deposit is refunded." : ""}`;
  return `${money(q.total)} now.${approve ? " The club confirms your booking; if they can't, you're refunded." : ""}`;
}

// ── slots ────────────────────────────────────────────────────────────────────

export type Busy = { startsAt: Date | string; endsAt: Date | string };
export type Slot = { startsAt: string; endsAt: string; label: string; taken: boolean };

/** Minutes since midnight of "HH:MM". */
const mm = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

/** The instant of wall-clock `date` + `minutes` in `tz`. */
export function wallInstant(date: string, minutes: number, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  return wallClockUTCToInstant(new Date(Date.UTC(y, mo - 1, d, 0, minutes)), tz);
}

/** Today's date ("YYYY-MM-DD") in the club's wall clock. */
export function clubToday(tz: string, now: Date = new Date()): string {
  return new Date(now.getTime() + tzOffsetMs(tz, now)).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function dayKey(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** Why a day can't be booked, or null when it can. */
export function dayClosedReason(settings: ProductSettings, date: string, tz: string, now: Date = new Date()): string | null {
  const today = clubToday(tz, now);
  if (date < today) return "past";
  const windowDays = settings.bookingWindowDays ?? 60;
  if (date > addDays(today, windowDays)) return "too far ahead";
  if (settings.blackoutDates.includes(date)) return "blackout";
  if (!effectiveWindows(settings).some((w) => w.days.includes(dayKey(date)))) return "closed";
  return null;
}

/**
 * Every start time for a booking of `mins` on `date`, 30 minutes apart, inside
 * the windows. A slot is taken when `bookingsPerSlot` bookings (default 1)
 * already overlap it — the buffer is kept on both sides of each existing booking.
 */
export function slotsForDay(args: {
  settings: ProductSettings;
  date: string;
  mins: number;
  busy: Busy[];
  tz: string;
  now?: Date;
}): Slot[] {
  const { settings, date, mins, tz } = args;
  const now = args.now ?? new Date();
  if (dayClosedReason(settings, date, tz, now)) return [];
  const buffer = Math.max(0, settings.bufferMinutes ?? 0);
  const perSlot = Math.max(1, settings.capacityLimit ?? 1);
  // The buffer keeps a gap on BOTH sides of an existing booking (setup before, clean-up after).
  const busy = args.busy.map((b) => ({ s: new Date(b.startsAt).getTime() - buffer * 60_000, e: new Date(b.endsAt).getTime() + buffer * 60_000 }));
  const out: Slot[] = [];
  const seen = new Set<string>();
  for (const w of effectiveWindows(settings)) {
    if (!w.days.includes(dayKey(date))) continue;
    for (let start = mm(w.from); start + mins <= mm(w.to); start += SLOT_STEP_MIN) {
      const s = wallInstant(date, start, tz);
      const e = new Date(s.getTime() + mins * 60_000);
      const key = s.toISOString();
      if (seen.has(key)) continue;
      seen.add(key);
      if (s.getTime() <= now.getTime()) continue;
      const overlapping = busy.filter((b) => b.s < e.getTime() && s.getTime() < b.e).length;
      const hh = String(Math.floor(start / 60)).padStart(2, "0"), mi = String(start % 60).padStart(2, "0");
      out.push({ startsAt: key, endsAt: e.toISOString(), label: timeLabel(`${hh}:${mi}`), taken: overlapping >= perSlot });
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** True when `startsAt` is one of the day's free slots for `mins` — the server's re-check. */
export function slotIsOpen(args: { settings: ProductSettings; startsAt: string; mins: number; busy: Busy[]; tz: string; now?: Date }): boolean {
  const date = new Date(new Date(args.startsAt).getTime() + tzOffsetMs(args.tz, new Date(args.startsAt))).toISOString().slice(0, 10);
  const slot = slotsForDay({ settings: args.settings, date, mins: args.mins, busy: args.busy, tz: args.tz, now: args.now })
    .find((s) => s.startsAt === new Date(args.startsAt).toISOString());
  return !!slot && !slot.taken;
}

/** Bookings that hold a slot: confirmed, waiting on staff, or a card checkout
 *  still open (under 30 minutes old). */
export function holdsSlot(b: { status: string; createdAt: Date | string }, now: Date = new Date()): boolean {
  if (b.status === "CONFIRMED" || b.status === "PENDING") return true;
  if (b.status === "PENDING_PAYMENT") return now.getTime() - new Date(b.createdAt).getTime() < 30 * 60_000;
  return false;
}

/** Status after the money (or no money) lands. */
export function statusAfterPayment(settings: Pick<ProductSettings, "requiresApproval">): "PENDING" | "CONFIRMED" {
  return settings.requiresApproval ? "PENDING" : "CONFIRMED";
}

/** Validate the questions at checkout; returns the cleaned answers. */
export function checkAnswers(settings: ProductSettings, answers: Record<string, unknown>): { ok: true; answers: Record<string, string> } | { ok: false; message: string } {
  const out: Record<string, string> = {};
  for (const q of settings.questions) {
    const v = String(answers?.[q.label] ?? "").trim().slice(0, 1000);
    if (q.required && !v) return { ok: false, message: `"${q.label}" is required.` };
    if (v && q.kind === "NUMBER" && !Number.isFinite(Number(v))) return { ok: false, message: `"${q.label}" needs a number.` };
    if (v) out[q.label] = v;
  }
  return { ok: true, answers: out };
}

// ── the week grid (2d) ───────────────────────────────────────────────────────

export type WeekBooking = { id: string; startsAt: string; endsAt: string; status: string };

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}
