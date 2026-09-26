"use client";

// B10 slice 3 — Rental & party bookings (handoff 2d): the week grid beside
// this week's list, each with Approve · Decline or Cancel · Take payment.
// Every amount is the booking's own snapshot (priced from the product's tier /
// length / add-on tables when it was made); pending counts come from the same
// array the grid draws.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight, Plus } from "lucide-react";

type Opt = { key: string; label: string; mins: number; price: number; tierName: string | null };
type Booking = {
  id: string; productId: string; productName: string; status: string; paymentMode: string; who: string; email: string | null; phone: string | null;
  tierName: string | null; durationMins: number; startsAt: string; endsAt: string; guests: number;
  addOns: { label: string; amount: number }[]; answers: Record<string, string>; amountTotal: number; dueNow: number; amountPaid: number;
  paidByCard: boolean; notes: string | null;
};
type Payload = { tz: string; pendingTotal: number; bookings: Booking[]; products: { id: string; name: string; active: boolean; options: Opt[]; addOns: { label: string; price: number | null; perGuest: boolean }[]; maxGuests: number | null }[] };

const money = (n: number) => `$${n.toFixed(2)}`;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function mondayOf(d: Date): Date { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const dow = x.getDay(); x.setDate(x.getDate() + (dow === 0 ? -6 : 1 - dow)); return x; }
const STATUS: Record<string, { label: string; style: React.CSSProperties }> = {
  CONFIRMED: { label: "Confirmed", style: { background: "var(--color-info-surface)", color: "var(--color-brand)", border: "1px solid var(--color-info-border)" } },
  PENDING: { label: "Waiting on you", style: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)", border: "1px solid var(--color-warn-border)" } },
  PENDING_PAYMENT: { label: "Paying now", style: { background: "var(--color-chip-surface)", color: "var(--color-chip-text)" } },
  CANCELED: { label: "Canceled", style: { background: "var(--color-chip-surface)", color: "var(--color-text-muted)", textDecoration: "line-through" } },
};

export default function ProductBookingsPage() {
  const [week, setWeek] = useState<Date>(() => mondayOf(new Date()));
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);

  const range = useMemo(() => ({ from: week, to: new Date(week.getFullYear(), week.getMonth(), week.getDate() + 7) }), [week]);
  const load = () =>
    fetch(`/api/products/bookings?from=${range.from.toISOString()}&to=${range.to.toISOString()}`).then((r) => (r.ok ? r.json() : null)).then((d) => d && setData(d));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [range.from.getTime()]);

  const tz = data?.tz;
  const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString("en-US", { ...o, ...(tz ? { timeZone: tz } : {}) });
  const dayIndex = (iso: string) => { const wd = fmt(iso, { weekday: "short" }); return DAYS.indexOf(wd); };
  const live = (data?.bookings ?? []).filter((b) => b.status !== "CANCELED");
  const waiting = live.filter((b) => b.status === "PENDING").length;

  async function act(b: Booking, body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(b.id); setErr(""); setMsg("");
    const res = await fetch(`/api/products/bookings/${b.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setErr(d.error || "That didn't work."); return; }
    setMsg(d.message || "Done.");
    load();
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-7xl">
      <Link href="/dashboard/products" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary mb-3"><ArrowLeft size={15} /> Products</Link>
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="text-[20px] font-semibold text-text-primary">Rentals & parties</h1>
          <p className="text-sm text-text-muted">{data ? `${live.length} this week · ${data.pendingTotal} waiting on you` : "Loading…"}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Previous week" onClick={() => setWeek((w) => new Date(w.getFullYear(), w.getMonth(), w.getDate() - 7))} className="w-9 h-9 rounded-lg border border-app-border flex items-center justify-center hover:bg-app-bg"><ChevronLeft size={16} /></button>
          <span className="text-sm text-text-primary tabular-nums min-w-[150px] text-center">{week.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – {new Date(week.getFullYear(), week.getMonth(), week.getDate() + 6).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
          <button type="button" aria-label="Next week" onClick={() => setWeek((w) => new Date(w.getFullYear(), w.getMonth(), w.getDate() + 7))} className="w-9 h-9 rounded-lg border border-app-border flex items-center justify-center hover:bg-app-bg"><ChevronRight size={16} /></button>
          <button type="button" onClick={() => setAdding(true)} disabled={!data?.products.length} className="inline-flex items-center gap-1 px-3 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"><Plus size={14} /> Add booking</button>
        </div>
      </div>
      {msg && <div className="text-sm rounded-lg px-3 py-2 mb-3 bg-brand/5 border border-brand/25 text-text-primary">{msg}</div>}
      {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{err}</div>}
      {data && data.products.length === 0 && (
        <div className="bg-surface border border-app-border rounded-[14px] p-8 text-center text-sm text-text-muted">No bookable products yet — add one with the type Bookable.</div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="bg-surface border border-app-border rounded-[14px] p-3 overflow-x-auto">
          <div className="grid gap-2 min-w-[640px]" style={{ gridTemplateColumns: "repeat(7, 1fr)" }}>
            {DAYS.map((d, i) => {
              const date = new Date(week.getFullYear(), week.getMonth(), week.getDate() + i);
              const items = (data?.bookings ?? []).filter((b) => dayIndex(b.startsAt) === i).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
              return (
                <div key={d}>
                  <div className="text-[11px] font-semibold uppercase tracking-[.05em] text-text-muted mb-1.5">{d} {date.getDate()}</div>
                  <div className="space-y-1.5 min-h-[120px] rounded-lg p-1" style={{ border: "1px dashed var(--color-inset-dashed)" }}>
                    {items.length === 0 && <div className="text-[11px] text-text-muted px-1 py-2">Open</div>}
                    {items.map((b) => (
                      <div key={b.id} className="rounded-lg px-2 py-1.5 text-[11.5px]" style={(STATUS[b.status] ?? STATUS.CONFIRMED).style}>
                        <div className="font-semibold tabular-nums">{fmt(b.startsAt, { hour: "numeric", minute: "2-digit" })}</div>
                        <div className="truncate">{b.productName}</div>
                        <div className="truncate opacity-80">{b.who}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-3 mt-3 text-[11px] text-text-muted">
            {["CONFIRMED", "PENDING", "PENDING_PAYMENT", "CANCELED"].map((k) => <span key={k} className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded" style={STATUS[k].style} /> {STATUS[k].label}</span>)}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-[13px] font-semibold text-text-primary">This week{waiting ? ` · ${waiting} waiting on you` : ""}</div>
          {data && data.bookings.length === 0 && <div className="bg-surface border border-app-border rounded-[14px] p-4 text-sm text-text-muted">Nothing booked this week.</div>}
          {(data?.bookings ?? []).map((b) => {
            const owed = Math.round((b.amountTotal - b.amountPaid) * 100) / 100;
            const closed = b.status === "CANCELED";
            return (
              <div key={b.id} className={`bg-surface border border-app-border rounded-[14px] p-3 ${closed ? "opacity-60" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-text-primary truncate">{b.who}</div>
                    <div className="text-[12px] text-text-muted">{b.productName}{b.tierName ? ` · ${b.tierName}` : ""} · {b.guests} guest{b.guests === 1 ? "" : "s"}</div>
                    <div className="text-[12px] text-text-muted tabular-nums">{fmt(b.startsAt, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}–{fmt(b.endsAt, { hour: "numeric", minute: "2-digit" })}</div>
                  </div>
                  <span className="text-[10.5px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap" style={(STATUS[b.status] ?? STATUS.CONFIRMED).style}>{(STATUS[b.status] ?? { label: b.status }).label}</span>
                </div>
                <div className="text-[12px] text-text-primary mt-1 tabular-nums">
                  {money(b.amountTotal)} total · {money(b.amountPaid)} paid{owed > 0 && !closed ? ` · ${money(owed)} owed` : ""}
                </div>
                {b.addOns.length > 0 && <div className="text-[11.5px] text-text-muted">+ {b.addOns.map((a) => a.label).join(", ")}</div>}
                {Object.keys(b.answers ?? {}).length > 0 && <div className="text-[11.5px] text-text-muted">{Object.entries(b.answers).map(([k, v]) => `${k}: ${v}`).join(" · ")}</div>}
                {b.notes && <div className="text-[11.5px] text-text-muted whitespace-pre-wrap">{b.notes}</div>}
                {(b.email || b.phone) && <div className="text-[11.5px] text-text-muted">{[b.email, b.phone].filter(Boolean).join(" · ")}</div>}
                {!closed && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {b.status === "PENDING" && (
                      <>
                        <button type="button" disabled={busy === b.id} onClick={() => act(b, { action: "approve" })} className="text-xs font-semibold px-2.5 py-1.5 rounded-lg bg-brand text-white disabled:opacity-50">Approve</button>
                        <button type="button" disabled={busy === b.id} onClick={() => { const reason = window.prompt("Reason (the family sees it):") ?? ""; act(b, { action: "decline", reason, refund: b.paidByCard && b.amountPaid > 0 && window.confirm(`Refund the ${money(b.amountPaid)} they paid by card?`) }); }} className="text-xs px-2.5 py-1.5 rounded-lg border border-app-border disabled:opacity-50">Decline</button>
                      </>
                    )}
                    {owed > 0 && b.status === "CONFIRMED" && (
                      <button type="button" disabled={busy === b.id} onClick={() => { const v = window.prompt(`Cash / check received (up to ${money(owed)}):`, owed.toFixed(2)); if (v) act(b, { action: "record_payment", amount: Number(v) }); }} className="text-xs px-2.5 py-1.5 rounded-lg border border-app-border disabled:opacity-50">Take payment</button>
                    )}
                    {b.email && <a href={`mailto:${b.email}`} className="text-xs px-2.5 py-1.5 rounded-lg border border-app-border">Message</a>}
                    <button type="button" disabled={busy === b.id} onClick={() => act(b, { action: "cancel", refund: b.paidByCard && b.amountPaid > 0 && window.confirm(`Also refund the ${money(b.amountPaid)} paid by card? (Cancel = keep it)`) }, "Cancel this booking?")} className="text-xs px-2.5 py-1.5 rounded-lg border border-app-border text-red-700 disabled:opacity-50">Cancel</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {adding && data && <AddBooking data={data} onClose={() => setAdding(false)} onDone={(m) => { setAdding(false); setMsg(m); load(); }} />}
    </div>
  );
}

function AddBooking({ data, onClose, onDone }: { data: Payload; onClose: () => void; onDone: (m: string) => void }) {
  const products = data.products.filter((p) => p.active);
  const [productId, setProductId] = useState(products[0]?.id ?? "");
  const p = products.find((x) => x.id === productId);
  const [lengthKey, setLengthKey] = useState(p?.options[0]?.key ?? "");
  const [when, setWhen] = useState("");
  const [guests, setGuests] = useState("1");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [cash, setCash] = useState("");
  const [addOns, setAddOns] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setLengthKey(p?.options[0]?.key ?? ""); setAddOns([]); }, [productId]); // eslint-disable-line react-hooks/exhaustive-deps
  const input = "w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary";
  async function save() {
    setErr("");
    if (!when) { setErr("Pick a date and time."); return; }
    setBusy(true);
    const res = await fetch("/api/products/bookings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId, lengthKey, startsAt: new Date(when).toISOString(), guests: Math.max(1, Number(guests) || 1), guestName: name, guestEmail: email || null, guestPhone: phone || null, addOns, cashNow: cash ? Number(cash) : 0 }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(d.error || "Couldn't add it."); return; }
    onDone(`Booked ${p?.name} for ${name}.`);
  }
  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-md bg-surface rounded-t-2xl sm:rounded-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-text-primary">Add booking</h2>
        <p className="text-[12px] text-text-muted">A phone or walk-in booking — confirmed now. Times are in your computer's time zone.</p>
        <select value={productId} onChange={(e) => setProductId(e.target.value)} className={input}>{products.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <select value={lengthKey} onChange={(e) => setLengthKey(e.target.value)} className={input}>{p?.options.map((o) => <option key={o.key} value={o.key}>{o.label} · {money(o.price)}</option>)}</select>
        <div className="grid grid-cols-[1fr_90px] gap-2">
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={input} />
          <input inputMode="numeric" value={guests} onChange={(e) => setGuests(e.target.value.replace(/[^0-9]/g, ""))} placeholder="Guests" className={input} />
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={input} />
        <div className="grid grid-cols-2 gap-2">
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" className={input} />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone (optional)" className={input} />
        </div>
        {p && p.addOns.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {p.addOns.map((a) => {
              const on = addOns.includes(a.label);
              return <button key={a.label} type="button" onClick={() => setAddOns((x) => (on ? x.filter((y) => y !== a.label) : [...x, a.label]))} className={`text-xs px-2.5 py-1.5 rounded-lg border ${on ? "border-brand text-brand" : "border-app-border"}`}>{a.label}</button>;
            })}
          </div>
        )}
        <input inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="Cash / check taken now (optional)" className={input} />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="text-sm px-3 py-2 rounded-lg border border-app-border">Cancel</button>
          <button type="button" onClick={save} disabled={busy || !name.trim()} className="text-sm font-semibold px-3 py-2 rounded-lg bg-brand text-white disabled:opacity-50">{busy ? "Saving…" : "Add booking"}</button>
        </div>
      </div>
    </div>
  );
}
