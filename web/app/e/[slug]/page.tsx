"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { AlertOctagon, MapPin, CheckCircle2, PartyPopper, ArrowRight } from "lucide-react";
import { mapsDirectionsUrl } from "@/lib/maps";

type FormField = {
  id: string;
  label: string;
  type: "text" | "email" | "phone" | "textarea" | "select" | "checkbox";
  required: boolean;
  options?: string[];
};

type PublicEvent = {
  id: string;
  name: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  imageUrl: string | null;
  imagePositionX: number;
  imagePositionY: number;
  location: { name: string; address: string | null; latitude: number | null; longitude: number | null } | null;
  club: { name: string; logoUrl: string | null; primaryColor: string | null };
  isTournament: boolean;
  tournamentMode: string | null;
  publicFormIntro: string | null;
  registrationForm: FormField[];
  price: number | null;
  priceLabel: string;
  variableCost?: boolean;
  capacityReached: boolean;
  registrationOpen: boolean;
  paymentMethods?: string[];
  // Phase 5 §5.3.3 — a coach reviews this registration before the spot is
  // confirmed, and billOnApproval means no payment choice is offered now.
  requiresCoachApproval?: boolean;
  billOnApproval?: boolean;
  cancellationPolicyText?: string | null;
  documents?: { id: string; title: string; type: string; body: string | null; requirement: string }[];
};

// What each public payment choice means to the registrant. AUTO_CARD is
// member-only and never offered here.
const PAY_CHOICES: Record<string, { label: string; hint: string }> = {
  CARD: { label: "Pay now by card", hint: "You'll be sent to a secure checkout page." },
  CASH: { label: "Pay cash at the event", hint: "Bring the exact amount to the event." },
  CHECK: { label: "Pay by check at the event", hint: "Bring your check to the event." },
};

export default function PublicEventPage() {
  const { slug } = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [responses, setResponses] = useState<Record<string, string | boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<null | { message: string }>(null);
  const [payMethod, setPayMethod] = useState<string>("");
  const [docsAcknowledged, setDocsAcknowledged] = useState(false);
  // Discount code. `applied` is the server's verdict — the page never does its
  // own discount math, so what's shown here is what the register route will
  // charge. Typing again clears it, so a stale total can't sit on screen.
  const [codeInput, setCodeInput] = useState("");
  const [codeChecking, setCodeChecking] = useState(false);
  const [codeError, setCodeError] = useState("");
  const [applied, setApplied] = useState<null | {
    code: string;
    label: string | null;
    quotable: boolean;
    gross?: number;
    discountOff?: number;
    net?: number;
    processingFee?: number;
    total?: number;
    message?: string;
  }>(null);

  const justRegistered = searchParams.get("registered") === "true";
  const justPaid = searchParams.get("paid") === "true";
  const wasCanceled = searchParams.get("canceled") === "true";

  useEffect(() => {
    fetch(`/api/public/events/${slug}`)
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          setError(d.error || "Event not found");
          setLoading(false);
          return null;
        }
        return r.json();
      })
      .then((d: PublicEvent | null) => {
        if (d) {
          setEvent(d);
          // Preselect when there's only one way to pay — no decision to make.
          const opts = (d.paymentMethods ?? []).filter((m) => PAY_CHOICES[m]);
          if (opts.length === 1) setPayMethod(opts[0]);
        }
        setLoading(false);
      });
  }, [slug]);

  // Only ask how they'll pay when money is actually owed at registration.
  const payOptions = (event?.paymentMethods ?? []).filter((m) => PAY_CHOICES[m]);
  // A club that bills on approval collects nothing now, so there is no choice
  // to make — offering one would ask a question the server ignores.
  const needsPayChoice =
    !!event && (event.price ?? 0) > 0 && payOptions.length > 0 && !event.billOnApproval;
  const eventDocs = event?.documents ?? [];
  const gatedDocs = eventDocs.filter((d) => d.requirement !== "INFO");

  async function applyCode() {
    const code = codeInput.trim();
    if (!code) return;
    setCodeChecking(true);
    setCodeError("");
    try {
      const res = await fetch(`/api/public/events/${slug}/validate-discount`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCodeError(typeof d.error === "string" ? d.error : "Could not check that code.");
        setApplied(null);
      } else if (d.valid) {
        setApplied(d);
        setCodeError("");
      } else {
        setApplied(null);
        setCodeError(typeof d.error === "string" ? d.error : "That code isn't valid for this event.");
      }
    } catch {
      setCodeError("Could not check that code. Try again.");
      setApplied(null);
    }
    setCodeChecking(false);
  }

  function clearCode() {
    setApplied(null);
    setCodeError("");
    setCodeInput("");
  }

  // What the visitor actually pays, once a code is applied. Falls back to the
  // event's own price when there's no code.
  const payableNow = applied?.quotable && applied.net != null ? applied.net : (event?.price ?? 0);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (needsPayChoice && !payMethod) {
      setError("Please choose how you'd like to pay.");
      return;
    }
    if (gatedDocs.length > 0 && !docsAcknowledged) {
      setError("Please review and acknowledge the event documents.");
      return;
    }
    setSubmitting(true);
    setError("");
    const res = await fetch(`/api/public/events/${slug}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        email,
        phone: phone || null,
        formResponses: responses,
        ...(needsPayChoice ? { paymentMethod: payMethod } : {}),
        ...(applied ? { discountCode: applied.code } : {}),
        ...(gatedDocs.length > 0 ? { acknowledgeDocuments: docsAcknowledged } : {}),
      }),
    });
    const d = await res.json().catch(() => ({}));
    setSubmitting(false);
    if (!res.ok) {
      setError(typeof d.error === "string" ? d.error : "Registration failed");
      return;
    }
    if (d.url) {
      window.location.href = d.url;
      return;
    }
    setDone({
      message:
        d.message ||
        (d.free ? "You're registered! See you there." : "You're registered."),
    });
  }

  const accent = event?.club.primaryColor || "#534AB7";

  if (loading) {
    return <div className="min-h-screen bg-stone-50 flex items-center justify-center text-stone-400 text-sm">Loading…</div>;
  }

  if (error && !event) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-xl border border-stone-200 p-8 max-w-md text-center">
          <AlertOctagon className="h-10 w-10 mx-auto mb-2 text-stone-400" strokeWidth={1.5} />
          <h1 className="text-lg font-semibold text-stone-900 mb-1">Can&apos;t open this event</h1>
          <p className="text-sm text-stone-500">{error}</p>
        </div>
      </div>
    );
  }

  if (!event) return null;

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Header */}
      <header className="bg-white border-b border-stone-200">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-2">
          {event.club.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={event.club.logoUrl} alt="" className="w-7 h-7 rounded-md object-cover" />
          ) : (
            <div className="w-7 h-7 rounded-md flex items-center justify-center text-white text-xs font-bold" style={{ background: accent }}>
              {event.club.name[0]}
            </div>
          )}
          <span className="text-sm font-semibold text-stone-900">{event.club.name}</span>
          <div className="ml-auto">
            {session?.user ? (
              <Link href="/member" className="text-xs px-3 py-1.5 rounded-lg border border-stone-300 text-stone-700 hover:bg-stone-50">
                Member portal →
              </Link>
            ) : (
              <Link
                href={`/login?callbackUrl=${encodeURIComponent(`/e/${slug}`)}`}
                className="text-xs px-3 py-1.5 rounded-lg border border-stone-300 text-stone-700 hover:bg-stone-50"
              >
                Member sign in
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6">
        {event.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={event.imageUrl}
            alt={event.name}
            className="w-full aspect-[16/9] object-cover rounded-xl border border-stone-200 mb-4"
            style={{ objectPosition: `${event.imagePositionX ?? 50}% ${event.imagePositionY ?? 50}%` }}
          />
        )}

        <div className="bg-white rounded-xl border border-stone-200 p-6 mb-4">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            {event.isTournament && (
              <span className="text-[11px] px-2 py-0.5 rounded-full font-medium text-white" style={{ background: accent }}>
                {event.tournamentMode === "HOST" ? "Tournament" : "Tournament Trip"}
              </span>
            )}
          </div>
          <h1 className="text-2xl font-semibold text-stone-900">{event.name}</h1>
          <p className="text-sm text-stone-500 mt-1">
            {new Date(event.startsAt).toLocaleString("en-US", {
              weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
            })}
            {" – "}
            {new Date(event.endsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
          </p>
          {event.location && (
            <p className="text-sm text-stone-500 mt-0.5 inline-flex items-center gap-1">
              <MapPin className="h-4 w-4 inline" strokeWidth={2} />
              {event.location.name}{event.location.address ? ` · ${event.location.address}` : ""}
              {(() => {
                // Coordinates when set, address otherwise — either way the
                // visitor gets a Directions link.
                const href = mapsDirectionsUrl(event.location!);
                return href ? (
                  <>
                    {" · "}
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                      style={{ color: event.club.primaryColor ?? undefined }}
                    >
                      Directions
                    </a>
                  </>
                ) : null;
              })()}
            </p>
          )}
          {event.description && (
            <p className="text-sm text-stone-700 mt-3 whitespace-pre-wrap leading-relaxed">{event.description}</p>
          )}
          <div className="mt-4 pt-4 border-t border-stone-100 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-stone-400 font-medium">Cost</span>
            <span className="text-sm font-semibold text-stone-900">{event.priceLabel}</span>
          </div>
          {/* Members get their own pricing through the portal. This banner
              points them at the right surface so they don't double-pay at
              the public non-member rate. */}
          {session?.user?.role === "MEMBER" ? (
            <div className="mt-3 rounded-lg bg-stone-50 border border-stone-200 px-3 py-2 text-xs text-stone-700 flex items-center justify-between gap-2">
              <span>You&apos;re signed in. Register from your member portal to use member pricing or your active membership.</span>
              <Link href="/member/events" className="inline-flex items-center gap-1 underline whitespace-nowrap" style={{ color: accent }}>
                Open portal <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
              </Link>
            </div>
          ) : !session?.user ? (
            <div className="mt-3 rounded-lg bg-stone-50 border border-stone-200 px-3 py-2 text-xs text-stone-700">
              Already a member of {event.club.name}?{" "}
              <Link
                href={`/login?callbackUrl=${encodeURIComponent(`/e/${slug}`)}`}
                className="underline"
                style={{ color: accent }}
              >
                Sign in
              </Link>{" "}
              to use your member pricing.
            </div>
          ) : null}
        </div>

        {/* Status banners */}
        {(justRegistered || justPaid) && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-4 text-sm text-green-800 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" strokeWidth={2} />
            <span>Payment received — you&apos;re registered. A confirmation has been emailed to you.</span>
          </div>
        )}
        {wasCanceled && (
          <div className="bg-stone-100 border border-stone-200 rounded-xl p-4 mb-4 text-sm text-stone-600">
            Checkout canceled — you can try again below.
          </div>
        )}

        {done ? (
          <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
            <PartyPopper className="h-10 w-10 mx-auto mb-2 text-stone-700" strokeWidth={1.5} />
            <h2 className="text-lg font-semibold text-stone-900 mb-1">{done.message}</h2>
            <p className="text-sm text-stone-500">A confirmation has been sent to {email}.</p>
          </div>
        ) : !event.registrationOpen ? (
          <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
            <h2 className="text-base font-semibold text-stone-900 mb-1">
              {event.capacityReached ? "This event is full" : "Registration is closed"}
            </h2>
            <p className="text-sm text-stone-500">Contact {event.club.name} for more information.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="bg-white rounded-xl border border-stone-200 p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-stone-900">Register</h2>
              {event.publicFormIntro && (
                <p className="text-sm text-stone-500 mt-1 whitespace-pre-wrap">{event.publicFormIntro}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Full name *</label>
              <input
                type="text" required value={name} onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2"
                style={{ outlineColor: accent }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Email *</label>
                <input
                  type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Phone</label>
                <input
                  type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2"
                />
              </div>
            </div>

            {/* Owner-defined custom fields */}
            {event.registrationForm.map((f) => (
              <div key={f.id}>
                <label className="block text-sm font-medium text-stone-700 mb-1">
                  {f.label}{f.required ? " *" : ""}
                </label>
                {f.type === "textarea" ? (
                  <textarea
                    required={f.required}
                    value={(responses[f.id] as string) || ""}
                    onChange={(e) => setResponses((r) => ({ ...r, [f.id]: e.target.value }))}
                    rows={3}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2"
                  />
                ) : f.type === "select" ? (
                  <select
                    required={f.required}
                    value={(responses[f.id] as string) || ""}
                    onChange={(e) => setResponses((r) => ({ ...r, [f.id]: e.target.value }))}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2"
                  >
                    <option value="">Select…</option>
                    {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f.type === "checkbox" ? (
                  <label className="flex items-center gap-2 text-sm text-stone-700">
                    <input
                      type="checkbox"
                      checked={!!responses[f.id]}
                      onChange={(e) => setResponses((r) => ({ ...r, [f.id]: e.target.checked }))}
                    />
                    Yes
                  </label>
                ) : (
                  <input
                    type={f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text"}
                    required={f.required}
                    value={(responses[f.id] as string) || ""}
                    onChange={(e) => setResponses((r) => ({ ...r, [f.id]: e.target.value }))}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2"
                  />
                )}
              </div>
            ))}

            {eventDocs.length > 0 && (
              <div className="pt-1">
                <p className="text-sm font-medium text-stone-900 mb-1">Event documents</p>
                <div className="space-y-2">
                  {eventDocs.map((d) => (
                    <details key={d.id} className="border border-stone-200 rounded-lg p-3">
                      <summary className="text-sm text-stone-900 cursor-pointer">
                        {d.title}
                        <span className="ml-2 text-[11px] text-stone-500">
                          {d.requirement === "INFO" ? "for your information" : "acknowledgement required"}
                        </span>
                      </summary>
                      {d.body ? (
                        <div className="doc-prose mt-2 text-sm" dangerouslySetInnerHTML={{ __html: d.body }} />
                      ) : (
                        <p className="mt-2 text-xs text-stone-500">See the club for the full document.</p>
                      )}
                    </details>
                  ))}
                </div>
                {gatedDocs.length > 0 && (
                  <label className="flex items-start gap-2.5 mt-2 p-3 rounded-lg bg-stone-50 border border-stone-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={docsAcknowledged}
                      onChange={(e) => setDocsAcknowledged(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-xs text-stone-700">
                      I have read and acknowledge: {gatedDocs.map((d) => d.title).join(", ")}.
                    </span>
                  </label>
                )}
              </div>
            )}

            {/* §5.3.3 — said BEFORE the pay picker, because it changes what
                every option below means. */}
            {event.requiresCoachApproval && (
              <div
                className="rounded-lg border px-3 py-2.5"
                style={{ borderColor: `${accent}66`, background: `${accent}0f` }}
              >
                <p className="text-sm font-medium text-stone-900">
                  Registration isn&apos;t confirmed until the coach reviews it.
                </p>
                <p className="text-xs text-stone-600 mt-0.5">
                  You&apos;ll be notified as soon as they do — no money moves until then.
                  {event.billOnApproval
                    ? " If they approve, the club emails a payment link."
                    : ""}
                </p>
              </div>
            )}

            {needsPayChoice && !event.billOnApproval && (
              <div className="pt-1">
                <p className="text-sm font-medium text-stone-900 mb-1">
                  {event.requiresCoachApproval ? "How would you pay if approved?" : "How would you like to pay?"}
                </p>
                <p className="text-xs text-stone-500 mb-2">
                  {event.requiresCoachApproval
                    ? "Nothing is charged while your request is with the coach."
                    : "Your spot isn't held until this is settled."}
                </p>
                <div className="space-y-2">
                  {payOptions.map((m) => (
                    <label
                      key={m}
                      className="flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer"
                      style={{
                        borderColor: payMethod === m ? accent : "#d6d3d1",
                        background: payMethod === m ? `${accent}0f` : "#fff",
                      }}
                    >
                      <input
                        type="radio"
                        name="paymentMethod"
                        value={m}
                        checked={payMethod === m}
                        onChange={() => setPayMethod(m)}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-stone-900 font-medium">
                          {PAY_CHOICES[m].label}
                        </span>
                        <span className="block text-xs text-stone-500">{PAY_CHOICES[m].hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Discount code. Shown whenever money is owed OR the event bills
                later (variable cost) — in the latter case there's no total to
                quote, but the code still binds to the registration and comes
                off the invoice. */}
            {(!!(event.price && event.price > 0) || event.variableCost) && (
              <div>
                <label htmlFor="discount-code" className="block text-sm font-medium text-stone-700 mb-1">
                  Discount code <span className="font-normal text-stone-400">(optional)</span>
                </label>
                {applied ? (
                  <div
                    className="rounded-lg border px-3 py-2.5"
                    style={{ borderColor: `${accent}55`, background: `${accent}0d` }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-stone-900 min-w-0 truncate">
                        {applied.label || applied.code} applied
                      </span>
                      <button
                        type="button"
                        onClick={clearCode}
                        className="text-xs text-stone-500 underline shrink-0"
                      >
                        Remove
                      </button>
                    </div>
                    {applied.quotable && applied.net != null ? (
                      <div className="mt-2 space-y-1 text-sm">
                        <div className="flex justify-between text-stone-500">
                          <span>Subtotal</span>
                          <span>${(applied.gross ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-stone-500">
                          <span>Discount</span>
                          <span>−${(applied.discountOff ?? 0).toFixed(2)}</span>
                        </div>
                        {(applied.processingFee ?? 0) > 0 && (
                          <div className="flex justify-between text-stone-500">
                            <span>Processing fee</span>
                            <span>${(applied.processingFee ?? 0).toFixed(2)}</span>
                          </div>
                        )}
                        <div className="flex justify-between font-semibold text-stone-900 border-t border-stone-200 pt-1">
                          <span>{(applied.processingFee ?? 0) > 0 ? "You pay" : "New total"}</span>
                          <span>${(applied.total ?? applied.net).toFixed(2)}</span>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-1 text-xs text-stone-500">
                        {applied.message || "It'll come off the invoice the club sends you."}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input
                      id="discount-code"
                      type="text"
                      value={codeInput}
                      onChange={(e) => {
                        setCodeInput(e.target.value.toUpperCase());
                        if (codeError) setCodeError("");
                      }}
                      onKeyDown={(e) => {
                        // Enter checks the code instead of submitting the whole
                        // registration — a half-typed code must never register.
                        if (e.key === "Enter") {
                          e.preventDefault();
                          applyCode();
                        }
                      }}
                      placeholder="Enter code"
                      autoCapitalize="characters"
                      autoCorrect="off"
                      spellCheck={false}
                      className="flex-1 min-w-0 px-3 py-2 border border-stone-300 rounded-lg text-sm font-mono uppercase focus:outline-none focus:ring-2"
                    />
                    <button
                      type="button"
                      onClick={applyCode}
                      disabled={codeChecking || !codeInput.trim()}
                      className="shrink-0 px-4 py-2 rounded-lg border border-stone-300 text-sm font-medium text-stone-700 disabled:opacity-50"
                    >
                      {codeChecking ? "Checking…" : "Apply"}
                    </button>
                  </div>
                )}
                {codeError && <p className="mt-1 text-xs text-red-600">{codeError}</p>}
              </div>
            )}

            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-lg text-white text-sm font-semibold disabled:opacity-50"
              style={{ background: accent }}
            >
              {submitting
                ? "Submitting…"
                : !(event.price && event.price > 0)
                  ? "Register"
                  : payableNow <= 0
                    ? "Register — no payment due"
                    : payMethod === "CASH" || payMethod === "CHECK"
                      ? `Register — pay $${payableNow.toFixed(2)} at the event`
                      : `Register & pay $${(applied?.total ?? payableNow).toFixed(2)}`}
            </button>
            <p className="text-[11px] text-stone-400 text-center">
              Powered by AthletixOS
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
