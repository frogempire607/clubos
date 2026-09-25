"use client";

// B10 slice 3 — the party / rental booking flow (handoff 2f), in member-portal
// language. Used by the member store (signed in) and the public page (guest
// name + email). Three steps: what (tier / length), when (day + slot), details
// (questions, add-ons, guests) with the order summary. The summary is computed
// by lib/productBooking.quoteFromParts — the same function the server charges
// with — so the number on the button is the number charged.

import { useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { quoteFromParts, minsLabel, type LengthOption } from "@/lib/productBooking";
import type { StoreProduct } from "@/lib/productStore";

type Booking = NonNullable<StoreProduct["booking"]>;
type Slot = { startsAt: string; endsAt: string; label: string; taken: boolean };
export type BookingPayload = { lengthKey: string; startsAt: string; guests: number; addOns: string[]; answers: Record<string, string>; notes: string | null; name?: string; email?: string; phone?: string | null };

const money = (n: number) => `$${n.toFixed(2).replace(/\.00$/, "")}`;
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export default function BookingFlow({ booking, availabilityUrl, guest, busy, error, onSubmit }: {
  booking: Booking;
  availabilityUrl: (date: string, lengthKey: string) => string;
  /** Public link: ask name + email. */
  guest?: boolean;
  busy: boolean;
  error: string;
  onSubmit: (p: BookingPayload) => void;
}) {
  const [step, setStep] = useState(1);
  const [opt, setOpt] = useState<LengthOption | null>(booking.options.length === 1 ? booking.options[0] : null);
  const days = useMemo(() => {
    const out: { date: string; label: string; dow: string; closed: boolean }[] = [];
    const t = new Date();
    for (let i = 0; i < Math.min(28, booking.bookingWindowDays + 1); i++) {
      const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() + i);
      const date = ymd(d);
      out.push({ date, label: String(d.getDate()), dow: DAY[d.getDay()], closed: !booking.openDays.includes(DAY[d.getDay()]) || booking.blackoutDates.includes(date) });
    }
    return out;
  }, [booking]);
  const [date, setDate] = useState<string>(() => days.find((d) => !d.closed)?.date ?? days[0]?.date ?? "");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [guests, setGuests] = useState(1);
  const [addOns, setAddOns] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [localErr, setLocalErr] = useState("");

  useEffect(() => {
    if (!opt || !date) return;
    let alive = true;
    setSlots(null); setSlot(null);
    fetch(availabilityUrl(date, opt.key)).then((r) => (r.ok ? r.json() : { slots: [] })).then((d) => { if (alive) setSlots(d.slots ?? []); }).catch(() => alive && setSlots([]));
    return () => { alive = false; };
  }, [opt, date, availabilityUrl]);

  const q = opt ? quoteFromParts({ options: booking.options, addOns: booking.addOns, maxGuests: booking.maxGuests, mode: booking.mode, depositAmount: booking.depositAmount }, { lengthKey: opt.key, guests, addOns }) : null;
  const quote = q && q.ok ? q.quote : null;
  const promise = quote
    ? quote.mode === "REQUEST_ONLY"
      ? `Nothing is charged now — the club confirms your request${quote.total > 0 ? `, then collects ${money(quote.total)}` : ""}.`
      : quote.mode === "DEPOSIT"
        ? `${money(quote.dueNow)} deposit now${quote.total > quote.dueNow ? `, ${money(quote.total - quote.dueNow)} at the event` : ""}.${booking.requiresApproval ? " The club confirms it; if they can't, the deposit is refunded." : ""}`
        : `${money(quote.total)} now.${booking.requiresApproval ? " The club confirms it; if they can't, you're refunded." : ""}`
    : "";
  const cta = !quote ? "Book" : booking.requiresApproval || quote.mode === "REQUEST_ONLY" ? `Request this${quote.dueNow > 0 ? ` · ${money(quote.dueNow)} now` : ""}` : quote.dueNow > 0 ? `Book & pay ${money(quote.dueNow)}` : "Book";

  function submit() {
    setLocalErr("");
    if (!opt || !slot) { setLocalErr("Pick a time."); return; }
    for (const qq of booking.questions) if (qq.required && !(answers[qq.label] ?? "").trim()) { setLocalErr(`"${qq.label}" is required.`); return; }
    if (guest && (!name.trim() || !email.trim())) { setLocalErr("Add your name and email."); return; }
    onSubmit({ lengthKey: opt.key, startsAt: slot.startsAt, guests, addOns, answers, notes: notes.trim() || null, ...(guest ? { name: name.trim(), email: email.trim(), phone: phone.trim() || null } : {}) });
  }

  const inputCls = "w-full px-3 py-2.5 border border-stone-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-300";
  const stepHead = (n: number, title: string, done: string | null) => (
    <button type="button" onClick={() => n < step && setStep(n)} className="w-full flex items-center justify-between text-left">
      <span className="text-sm font-semibold text-stone-900">{n}. {title}</span>
      {step > n && done && <span className="text-xs text-stone-500 truncate ml-2">{done} · change</span>}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="pcard p-4 space-y-3">
        {stepHead(1, "Choose", opt ? `${opt.label} · ${money(opt.price)}` : null)}
        {step === 1 && (
          <>
            <div className="space-y-2">
              {booking.options.map((o) => (
                <button key={o.key} type="button" onClick={() => setOpt(o)} className={`w-full text-left rounded-xl border px-3 py-2.5 ${opt?.key === o.key ? "border-stone-900 bg-stone-50" : "border-stone-200 bg-white"}`}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-stone-900">{o.label}</span>
                    <span className="text-sm font-semibold text-stone-900 tabular-nums">{money(o.price)}</span>
                  </div>
                  <div className="text-xs text-stone-500">{[o.includes, o.tierName ? minsLabel(o.mins) : null].filter(Boolean).join(" · ")}</div>
                </button>
              ))}
            </div>
            <p className="text-xs text-stone-500">
              {booking.maxGuests ? `Up to ${booking.maxGuests} guests.` : ""}{booking.addOns.length ? ` ${booking.addOns.length} add-on${booking.addOns.length === 1 ? "" : "s"} available on the last step.` : ""}
            </p>
            <button type="button" disabled={!opt} onClick={() => setStep(2)} className="w-full pbtn-accent rounded-xl py-3 text-sm font-semibold min-h-[44px]">Next — pick a time</button>
          </>
        )}
      </div>

      <div className="pcard p-4 space-y-3">
        {stepHead(2, opt ? `When · ${minsLabel(opt.mins)}` : "When", slot ? `${days.find((d) => d.date === date)?.dow ?? ""} ${date.slice(5)} ${slot.label}` : null)}
        {step === 2 && opt && (
          <>
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
              {days.map((d) => (
                <button key={d.date} type="button" disabled={d.closed} onClick={() => setDate(d.date)} className={`shrink-0 w-12 rounded-xl border py-1.5 text-center ${d.closed ? "border-stone-100 text-stone-300" : date === d.date ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 text-stone-900 bg-white"}`}>
                  <span className="block text-[10px] uppercase">{d.dow}</span>
                  <span className="block text-sm font-semibold">{d.label}</span>
                </button>
              ))}
            </div>
            {slots === null ? (
              <p className="text-xs text-stone-500">Loading times…</p>
            ) : slots.length === 0 ? (
              <p className="text-xs text-stone-500">No times this day — try another.</p>
            ) : (
              <div className="grid grid-cols-3 gap-1.5">
                {slots.map((s) => (
                  <button key={s.startsAt} type="button" disabled={s.taken} onClick={() => setSlot(s)} className={`rounded-xl border py-2 text-sm ${s.taken ? "border-stone-100 text-stone-300 line-through" : slot?.startsAt === s.startsAt ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200 text-stone-900 bg-white"}`}>{s.label}</button>
                ))}
              </div>
            )}
            <button type="button" disabled={!slot} onClick={() => setStep(3)} className="w-full pbtn-accent rounded-xl py-3 text-sm font-semibold min-h-[44px]">Next — details</button>
          </>
        )}
      </div>

      <div className="pcard p-4 space-y-3">
        {stepHead(3, "Details", null)}
        {step === 3 && quote && (
          <>
            {guest && (
              <div className="space-y-2">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className={inputCls} />
                <div className="grid grid-cols-2 gap-2">
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className={inputCls} />
                  <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (optional)" className={inputCls} />
                </div>
              </div>
            )}
            <label className="block">
              <span className="block text-sm font-medium text-stone-900 mb-1">Guests</span>
              <input type="number" min={1} max={booking.maxGuests ?? 500} value={guests} onChange={(e) => setGuests(Math.max(1, Math.min(booking.maxGuests ?? 500, Math.floor(Number(e.target.value) || 1))))} className={`${inputCls} max-w-[120px]`} />
            </label>
            {booking.questions.map((qq) => (
              <label key={qq.label} className="block">
                <span className="block text-sm font-medium text-stone-900 mb-1">{qq.label}{qq.required ? "" : " (optional)"}</span>
                {qq.kind === "LONG" ? (
                  <textarea rows={3} value={answers[qq.label] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [qq.label]: e.target.value }))} className={inputCls} />
                ) : (
                  <input type={qq.kind === "NUMBER" ? "number" : "text"} value={answers[qq.label] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [qq.label]: e.target.value }))} className={inputCls} />
                )}
              </label>
            ))}
            {booking.addOns.length > 0 && (
              <div className="space-y-1.5">
                <span className="block text-sm font-medium text-stone-900">Add-ons</span>
                {booking.addOns.map((a) => {
                  const on = addOns.includes(a.label);
                  return (
                    <button key={a.label} type="button" onClick={() => setAddOns((x) => (on ? x.filter((y) => y !== a.label) : [...x, a.label]))} className={`w-full flex items-center justify-between rounded-xl border px-3 py-2 text-sm ${on ? "border-stone-900 bg-stone-50" : "border-stone-200 bg-white"}`}>
                      <span className="flex items-center gap-2">{on && <Check size={14} />}{a.label}</span>
                      <span className="tabular-nums text-stone-600">{a.perGuest ? `+${money(a.price)} × ${guests}` : `+${money(a.price)}`}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <label className="block">
              <span className="block text-sm font-medium text-stone-900 mb-1">Anything else? (optional)</span>
              <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
            </label>
            <div className="rounded-xl bg-stone-50 border border-stone-200 p-3 space-y-1 text-sm">
              {quote.lines.map((l) => (
                <div key={l.label} className="flex justify-between gap-2"><span className="text-stone-700">{l.label}{l.detail ? <span className="text-stone-500"> · {l.detail}</span> : null}</span><span className="tabular-nums">{money(l.amount)}</span></div>
              ))}
              <div className="flex justify-between gap-2 font-semibold border-t border-stone-200 pt-1"><span>Total</span><span className="tabular-nums">{money(quote.total)}</span></div>
              {quote.dueNow !== quote.total && <div className="flex justify-between gap-2 text-stone-700"><span>Due now</span><span className="tabular-nums">{money(quote.dueNow)}</span></div>}
              <p className="text-xs text-stone-500 pt-1">{promise}</p>
            </div>
            {(localErr || error) && <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2 text-sm text-red-700">{localErr || error}</div>}
            <button type="button" disabled={busy} onClick={submit} className="w-full pbtn-accent rounded-xl py-3.5 text-sm font-semibold min-h-[48px]">{busy ? "Working…" : cta}</button>
          </>
        )}
      </div>
    </div>
  );
}
