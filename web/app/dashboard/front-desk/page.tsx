"use client";

// Front desk (B6, group 1) — check people in at the door from a phone.
//
// One screen, three steps: which class → who (search, or a new walk-in) →
// what the door rule says (lib/doorAccess, served by /api/front-desk/door):
//   covered by a membership ........ Check in
//   no plan, free trial available .. Start the trial & check in
//   otherwise ...................... Take the drop-in: card on file, cash,
//                                    check, or text/email a payment link
// The actions are the existing attendance routes, so money lands in
// Financials exactly as it does from the Attendance page.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Search, UserPlus, CheckCircle2, CreditCard, Banknote, Send, ChevronLeft, Sparkles, AlertTriangle } from "lucide-react";
import { todayLocalISO } from "@/lib/datetime";
import { pickCurrentSession } from "@/lib/frontDesk";

type SessionRow = { id: string; startsAt: string; endsAt: string; canceled: boolean; recurringClass: { name: string }; _count: { attendance: number } };
type Person = { id: string; name: string; firstName: string; isMinor: boolean; guardianName: string | null; status: string; plans: string[] };
type Decision =
  | { kind: "PRESENT"; reason: "COVERED" | "NO_PRICE_SET" }
  | { kind: "TRIAL"; reason: "TRIAL_RUNNING" }
  | { kind: "START_TRIAL"; days: number }
  | { kind: "PAY"; amount: number };
type Door = {
  member: { id: string; name: string; firstName: string; isMinor: boolean };
  session: { id: string; classId: string; className: string; startsAt: string };
  decision: Decision;
  verdict: { reason: string; message: string; planName: string | null; optionLabel: string | null } | null;
  dropInPrice: number | null;
  trial: { active: boolean; name: string; days: number; renewable: boolean };
  trialEndsAt: string | null;
  existing: { status: string; checkedIn: boolean } | null;
};
type CardPreview = { hasSavedCard: boolean; card: { brand: string; last4: string } | null; passProcessingFees: boolean };

const money = (n: number) => `$${n.toFixed(2)}`;
// Class sessions store wall-clock time pinned to UTC — render in UTC.
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `fd-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const btnPrimary = "w-full min-h-[52px] rounded-xl bg-charcoal text-white text-[15px] font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50";
const btnSecondary = "w-full min-h-[48px] rounded-xl border border-app-border bg-surface text-text-primary text-sm font-medium inline-flex items-center justify-center gap-2 hover:bg-app-bg disabled:opacity-50";
const input = "w-full min-h-[44px] px-3 rounded-xl border border-app-border bg-surface text-[15px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand";

function FrontDeskInner() {
  const search = useSearchParams();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  const [memberId, setMemberId] = useState<string | null>(search.get("memberId"));
  const [walkIn, setWalkIn] = useState(search.get("new") === "1");
  const [done, setDone] = useState<{ title: string; detail: string } | null>(null);

  // Today's classes.
  useEffect(() => {
    fetch(`/api/attendance?date=${todayLocalISO()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { classSessions: [] }))
      .then((d) => {
        const rows: SessionRow[] = Array.isArray(d.classSessions) ? d.classSessions : [];
        setSessions(rows);
        setSessionId((cur) => cur ?? pickCurrentSession(rows));
      })
      .catch(() => setSessions([]));
  }, []);

  // Search, debounced.
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      fetch(`/api/front-desk/people?q=${encodeURIComponent(q.trim())}`)
        .then((r) => (r.ok ? r.json() : { people: [] }))
        .then((d) => setResults(Array.isArray(d.people) ? d.people : []))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const current = useMemo(() => sessions?.find((s) => s.id === sessionId) ?? null, [sessions, sessionId]);

  function reset() {
    setMemberId(null); setWalkIn(false); setQ(""); setResults([]); setDone(null);
  }

  return (
    <div className="max-w-xl mx-auto px-4 sm:px-6 py-4 sm:py-6 pb-28">
      <div className="flex items-center justify-between gap-2 mb-4">
        <h1 className="text-xl font-semibold text-text-primary">Front desk</h1>
        <Link href="/dashboard/attendance" className="text-sm text-brand min-h-[44px] inline-flex items-center">Full roster →</Link>
      </div>

      {/* 1 · Which class */}
      <section className="mb-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-1.5">Class</p>
        {sessions === null ? (
          <div className="h-12 rounded-xl bg-app-bg animate-pulse" />
        ) : sessions.length === 0 ? (
          <p className="text-sm text-text-muted border border-dashed border-app-border rounded-xl p-3">No classes today. Events are checked in from the event&apos;s roster.</p>
        ) : (
          <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1" style={{ WebkitOverflowScrolling: "touch" }}>
            {sessions.filter((s) => !s.canceled).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => { setSessionId(s.id); setDone(null); }}
                className={`shrink-0 min-h-[52px] px-3.5 rounded-xl border text-left ${s.id === sessionId ? "border-charcoal bg-charcoal text-white" : "border-app-border bg-surface text-text-primary"}`}
              >
                <span className="block text-sm font-semibold leading-tight">{s.recurringClass.name}</span>
                <span className={`block text-[11px] ${s.id === sessionId ? "text-white/70" : "text-text-muted"}`}>{fmtTime(s.startsAt)} · {s._count.attendance} in</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {current && done && (
        <div className="rounded-2xl border border-lime-accent bg-lime-accent/15 p-5 text-center">
          <CheckCircle2 className="h-10 w-10 mx-auto text-charcoal mb-2" />
          <p className="text-lg font-semibold text-text-primary">{done.title}</p>
          <p className="text-sm text-text-muted mt-1">{done.detail}</p>
          <button type="button" onClick={reset} className={`${btnPrimary} mt-4`}>Next person</button>
        </div>
      )}

      {current && !done && !memberId && !walkIn && (
        <section>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-1.5">Who&apos;s here?</p>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Athlete or parent name, email, phone"
              className={`${input} pl-9`}
              inputMode="search"
              aria-label="Search people"
            />
          </div>
          <ul className="mt-2 divide-y divide-app-border rounded-xl border border-app-border bg-surface overflow-hidden empty:hidden">
            {results.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => setMemberId(p.id)} className="w-full min-h-[56px] px-3 py-2 text-left hover:bg-app-bg flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block text-[15px] font-medium text-text-primary truncate">{p.name}</span>
                    <span className="block text-xs text-text-muted truncate">
                      {p.plans.length ? p.plans.join(", ") : "No membership"}
                      {p.isMinor && p.guardianName ? ` · parent ${p.guardianName}` : ""}
                    </span>
                  </span>
                  <span className="text-xs text-brand shrink-0">Select</span>
                </button>
              </li>
            ))}
          </ul>
          {q.trim().length >= 2 && !searching && results.length === 0 && (
            <p className="text-sm text-text-muted mt-2">Nobody matches “{q.trim()}”.</p>
          )}
          <button type="button" onClick={() => setWalkIn(true)} className={`${btnSecondary} mt-3`}>
            <UserPlus className="h-4 w-4" /> New walk-in
          </button>
        </section>
      )}

      {current && !done && walkIn && !memberId && (
        <WalkInForm
          initialName={q}
          onCancel={() => setWalkIn(false)}
          onCreated={(id) => { setWalkIn(false); setMemberId(id); }}
        />
      )}

      {current && !done && memberId && (
        <DoorPanel
          key={`${memberId}:${current.id}`}
          sessionId={current.id}
          memberId={memberId}
          onBack={() => setMemberId(null)}
          onDone={(title, detail) => setDone({ title, detail })}
        />
      )}
    </div>
  );
}

function WalkInForm({ initialName, onCancel, onCreated }: { initialName: string; onCancel: () => void; onCreated: (id: string) => void }) {
  const [first, ...rest] = initialName.trim().split(/\s+/);
  const [firstName, setFirstName] = useState(first ?? "");
  const [lastName, setLastName] = useState(rest.join(" "));
  const [isMinor, setIsMinor] = useState(true);
  const [guardianName, setGuardianName] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setError("");
    if (!firstName.trim() || !lastName.trim()) { setError("First and last name are required."); return; }
    if (isMinor && (!guardianName.trim() || !guardianEmail.trim())) { setError("A parent's name and email are required for athletes under 18."); return; }
    if (!isMinor && !email.trim()) { setError("Email is required."); return; }
    setSaving(true);
    const res = await fetch("/api/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: firstName.trim(), lastName: lastName.trim(), isMinor, status: "PROSPECT",
        email: isMinor ? null : email.trim(), phone: isMinor ? null : phone.trim() || null,
        guardianName: isMinor ? guardianName.trim() : undefined,
        guardianEmail: isMinor ? guardianEmail.trim() : null,
        guardianPhone: isMinor ? guardianPhone.trim() || null : null,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok || !d.id) { setError(typeof d.error === "string" ? d.error : "Could not add them."); return; }
    onCreated(d.id);
  }

  return (
    <section className="space-y-3">
      <button type="button" onClick={onCancel} className="text-sm text-text-muted inline-flex items-center gap-1 min-h-[44px]"><ChevronLeft className="h-4 w-4" /> Back to search</button>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">New walk-in</p>
      <div className="grid grid-cols-2 gap-2">
        <input className={input} placeholder="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="off" />
        <input className={input} placeholder="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="off" />
      </div>
      <div className="inline-flex rounded-xl border border-app-border bg-app-bg p-0.5 w-full">
        {[true, false].map((m) => (
          <button key={String(m)} type="button" onClick={() => setIsMinor(m)} className={`flex-1 min-h-[44px] rounded-lg text-sm ${isMinor === m ? "bg-surface shadow-sm font-semibold text-text-primary" : "text-text-muted"}`}>
            {m ? "Under 18" : "Adult"}
          </button>
        ))}
      </div>
      {isMinor ? (
        <div className="space-y-2">
          <input className={input} placeholder="Parent / guardian name" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} />
          <input className={input} placeholder="Parent email (for the receipt & account)" type="email" inputMode="email" value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)} />
          <input className={input} placeholder="Parent phone (optional)" type="tel" inputMode="tel" value={guardianPhone} onChange={(e) => setGuardianPhone(e.target.value)} />
        </div>
      ) : (
        <div className="space-y-2">
          <input className={input} placeholder="Email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className={input} placeholder="Phone (optional)" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="button" onClick={save} disabled={saving} className={btnPrimary}>{saving ? "Adding…" : "Add & continue"}</button>
    </section>
  );
}

function DoorPanel({ sessionId, memberId, onBack, onDone }: { sessionId: string; memberId: string; onBack: () => void; onDone: (title: string, detail: string) => void }) {
  const [door, setDoor] = useState<Door | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [card, setCard] = useState<CardPreview | null>(null);
  const clientKey = useRef(newKey());

  const load = useCallback(() => {
    setError("");
    fetch(`/api/front-desk/door?classSessionId=${encodeURIComponent(sessionId)}&memberId=${encodeURIComponent(memberId)}`, { cache: "no-store" })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Could not load"); return d as Door; })
      .then((d) => {
        setDoor(d);
        if (d.decision.kind === "PAY") {
          fetch(`/api/attendance/charge-card?memberId=${encodeURIComponent(memberId)}&classSessionId=${encodeURIComponent(sessionId)}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((c) => setCard(c ? { hasSavedCard: !!c.hasSavedCard, card: c.card ?? null, passProcessingFees: !!c.passProcessingFees } : null))
            .catch(() => setCard(null));
        }
      })
      .catch((e) => setError(e.message));
  }, [sessionId, memberId]);
  useEffect(() => { load(); }, [load]);

  async function post(url: string, body: unknown, key: string): Promise<{ ok: boolean; status: number; d: Record<string, unknown> }> {
    setBusy(key); setError("");
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, d };
    } catch {
      return { ok: false, status: 0, d: { error: "Network error — nothing was recorded. Try again." } };
    } finally {
      setBusy(null);
    }
  }
  const errOf = (d: Record<string, unknown>, fallback: string) => (typeof d.error === "string" ? d.error : typeof d.message === "string" ? d.message : fallback);

  if (error && !door) return <p className="text-sm text-red-600">{error}</p>;
  if (!door) return <div className="h-40 rounded-2xl bg-app-bg animate-pulse" />;

  const name = door.member.firstName;
  const dec = door.decision;
  const price = dec.kind === "PAY" ? dec.amount : door.dropInPrice;

  async function checkIn(status: "PRESENT" | "TRIAL", confirmNoMembership = false, label = "checkin") {
    const r = await post("/api/attendance", { classSessionId: sessionId, memberId, status, confirmNoMembership, emailReceipt: true }, label);
    if (!r.ok) { setError(errOf(r.d, "Could not check them in.")); return; }
    if (status === "TRIAL") {
      const ends = typeof r.d.trialEndsAt === "string" ? new Date(r.d.trialEndsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
      onDone(`${name} is checked in`, ends ? `Free trial — runs until ${ends}.` : "Free trial.");
    } else {
      onDone(`${name} is checked in`, confirmNoMembership ? `Owes the ${price != null ? money(price) + " " : ""}drop-in — it's on the unbilled list.` : door ? `${door.session.className}` : "");
    }
  }

  async function chargeCard() {
    if (price == null) return;
    const r = await post("/api/attendance/charge-card", { memberId, classSessionId: sessionId, amount: price, status: "DROP_IN", emailReceipt: true, clientKey: clientKey.current }, "card");
    if (r.status === 202 || r.d.outcome === "processing") { onDone(`${name} is checked in`, "Card payment is processing — it will show in Financials shortly."); return; }
    if (r.ok && r.d.outcome === "succeeded") { onDone(`${name} is checked in`, `Charged ${typeof r.d.total === "number" ? money(r.d.total) : money(price)} to the card on file.`); return; }
    setError(errOf(r.d, "The card was declined."));
    clientKey.current = newKey();
  }

  async function recordOffline(method: "CASH" | "CHECK") {
    if (price == null) return;
    const r = await post("/api/attendance/charge", { classSessionId: sessionId, memberId, status: "DROP_IN", paymentMethod: method, amount: price, emailReceipt: true }, method);
    if (!r.ok) { setError(errOf(r.d, "Could not record the payment.")); return; }
    onDone(`${name} is checked in`, `${money(price)} ${method === "CASH" ? "cash" : "check"} recorded.`);
  }

  async function sendLink() {
    const r = await post(`/api/classes/${door!.session.classId}/charge`, { memberId, classSessionId: sessionId, pricingType: "DROP_IN" }, "link");
    if (r.ok && r.d.coveredByMembership) { onDone(`${name} is checked in`, "Covered by their membership — nothing to pay."); return; }
    if (!r.ok || typeof r.d.url !== "string") { setError(errOf(r.d, "Could not create the payment link.")); return; }
    const r2 = await post("/api/attendance/send-payment-link", {
      memberId, url: r.d.url, amountLabel: price != null ? money(price) : "", contextLabel: `${door!.session.className} drop-in`,
    }, "link");
    if (!r2.ok) { setError(errOf(r2.d, "The link was created but couldn't be emailed.")); return; }
    onDone("Payment link sent", `Emailed to ${typeof r2.d.sentTo === "string" ? r2.d.sentTo : "the payer"}. ${name} is checked in automatically once it's paid.`);
  }

  return (
    <section className="space-y-3">
      <button type="button" onClick={onBack} className="text-sm text-text-muted inline-flex items-center gap-1 min-h-[44px]"><ChevronLeft className="h-4 w-4" /> Someone else</button>
      <div className="rounded-2xl border border-app-border bg-surface p-4">
        <p className="text-lg font-semibold text-text-primary">{door.member.name}</p>
        <p className="text-sm text-text-muted">{door.session.className} · {fmtTime(door.session.startsAt)}</p>

        {door.existing?.checkedIn ? (
          <p className="mt-3 text-sm text-text-primary inline-flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-green-700" /> Already checked in ({door.existing.status.replace("_", "-").toLowerCase()}).</p>
        ) : dec.kind === "PRESENT" && dec.reason === "COVERED" ? (
          <>
            <p className="mt-3 text-sm text-green-800 bg-green-50 rounded-lg px-3 py-2">{door.verdict?.planName ? `Covered by ${door.verdict.planName}${door.verdict.optionLabel ? ` · ${door.verdict.optionLabel}` : ""}.` : "Covered by their membership."}</p>
            <button type="button" disabled={!!busy} onClick={() => checkIn("PRESENT")} className={`${btnPrimary} mt-3`}>{busy ? "Checking in…" : "Check in"}</button>
          </>
        ) : dec.kind === "PRESENT" ? (
          <>
            <p className="mt-3 text-sm text-amber-800 bg-amber-50 rounded-lg px-3 py-2">No membership, and this class has no drop-in price set — check them in and settle it later.</p>
            <button type="button" disabled={!!busy} onClick={() => checkIn("PRESENT", true)} className={`${btnPrimary} mt-3`}>Check in</button>
          </>
        ) : dec.kind === "TRIAL" ? (
          <>
            <p className="mt-3 text-sm text-brand bg-brand/10 rounded-lg px-3 py-2">On their free trial{door.trialEndsAt ? ` until ${new Date(door.trialEndsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}.</p>
            <button type="button" disabled={!!busy} onClick={() => checkIn("TRIAL")} className={`${btnPrimary} mt-3`}>Check in</button>
          </>
        ) : dec.kind === "START_TRIAL" ? (
          <>
            <p className="mt-3 text-sm text-brand bg-brand/10 rounded-lg px-3 py-2 inline-flex gap-1.5"><Sparkles className="h-4 w-4 shrink-0 mt-0.5" /> No membership yet — {name} can start the {door.trial.name}: {dec.days} day{dec.days === 1 ? "" : "s"} free.</p>
            <button type="button" disabled={!!busy} onClick={() => checkIn("TRIAL", false, "trial")} className={`${btnPrimary} mt-3`}>{busy === "trial" ? "Starting…" : `Start free trial & check in`}</button>
          </>
        ) : (
          <>
            <p className="mt-3 text-sm text-amber-900 bg-amber-50 rounded-lg px-3 py-2 inline-flex gap-1.5">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                {door.verdict?.reason === "DAY_NOT_INCLUDED" || door.verdict?.reason === "OPTION_NOT_ACCEPTED"
                  ? door.verdict.message.replace(/ Drop-in \$[\d.]+\.$/, "")
                  : `${name} has no membership that covers this class${door.trial.active ? " and has already used the free trial" : ""}.`}{" "}
                <b>Drop-in {money(dec.amount)}.</b>
              </span>
            </p>
            <div className="mt-3 space-y-2">
              {card?.hasSavedCard && card.card && (
                <button type="button" disabled={!!busy} onClick={chargeCard} className={btnPrimary}>
                  <CreditCard className="h-4 w-4" /> {busy === "card" ? "Charging…" : `Charge ${card.card.brand.charAt(0).toUpperCase() + card.card.brand.slice(1)} •••• ${card.card.last4}`}
                </button>
              )}
              <div className="grid grid-cols-2 gap-2">
                <button type="button" disabled={!!busy} onClick={() => recordOffline("CASH")} className={btnSecondary}><Banknote className="h-4 w-4" /> {busy === "CASH" ? "Saving…" : "Cash"}</button>
                <button type="button" disabled={!!busy} onClick={() => recordOffline("CHECK")} className={btnSecondary}>{busy === "CHECK" ? "Saving…" : "Check"}</button>
              </div>
              <button type="button" disabled={!!busy} onClick={sendLink} className={btnSecondary}><Send className="h-4 w-4" /> {busy === "link" ? "Sending…" : "Email a payment link"}</button>
              <button type="button" disabled={!!busy} onClick={() => checkIn("PRESENT", true, "later")} className="w-full min-h-[44px] text-sm text-text-muted underline">
                Check in now, collect later
              </button>
              <Link href={`/dashboard/members/${memberId}?tab=memberships`} className="block text-center text-sm text-brand min-h-[44px] leading-[44px]">Sign them up for a membership instead →</Link>
            </div>
          </>
        )}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>
    </section>
  );
}

export default function FrontDeskPage() {
  return (
    <Suspense fallback={null}>
      <FrontDeskInner />
    </Suspense>
  );
}
