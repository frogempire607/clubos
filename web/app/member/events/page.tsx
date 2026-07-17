"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarRange, MessageCircle, Package } from "lucide-react";
import ProfileSwitcher, { type AccessibleProfile } from "@/components/ProfileSwitcher";

type EventCard = {
  id: string;
  type: string;
  name: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number | null;
  memberPrice: number | string | null;
  nonMemberPrice: number | string | null;
  dropInFee: number | string | null;
  visibility: string;
  imageUrl: string | null;
  pricingOptions: { type: string; membershipId?: string }[] | null;
  location: { name: string } | null;
  customEventType: { name: string; color: string; textColor: string } | null;
  sessions: { id: string; name: string | null; startsAt: string; endsAt: string }[];
  _count: { bookings: number };
  autoChargeDate?: string | null;
};

type BookingRef = { eventId: string; status: string };

type BundleCard = {
  id: string;
  name: string;
  description: string | null;
  price: number | string;
  items: { eventId: string; event: { id: string; name: string; startsAt: string; memberPrice: number | string | null; nonMemberPrice: number | string | null } }[];
};

const builtInColors: Record<string, { bg: string; fg: string }> = {
  CLASS: { bg: "var(--color-primary)", fg: "#fff" },
  PRIVATE: { bg: "var(--color-primary)", fg: "#fff" },
  CLINIC: { bg: "var(--color-success)", fg: "#1F1F23" },
  CAMP: { bg: "var(--color-warning)", fg: "#fff" },
  TOURNAMENT: { bg: "#FCE4E0", fg: "#7B2415" },
  OTHER: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
};

function evColor(e: EventCard) {
  if (e.customEventType) return { bg: e.customEventType.color, fg: e.customEventType.textColor };
  return builtInColors[e.type] || builtInColors.OTHER;
}
function evLabel(e: EventCard) {
  if (e.customEventType) return e.customEventType.name;
  return e.type.charAt(0) + e.type.slice(1).toLowerCase();
}

function fmtPrice(n: number | string | null) {
  if (n == null) return null;
  const num = typeof n === "string" ? parseFloat(n) : n;
  if (Number.isNaN(num)) return null;
  return num.toFixed(2);
}

export default function MemberEventsPage() {
  const router = useRouter();
  const [events, setEvents] = useState<EventCard[]>([]);
  const [bookings, setBookings] = useState<BookingRef[]>([]);
  const [activeMembershipIds, setActiveMembershipIds] = useState<string[]>([]);
  const [isActiveMember, setIsActiveMember] = useState(false);
  const [hasMemberProfile, setHasMemberProfile] = useState(true);
  const [accessible, setAccessible] = useState<AccessibleProfile[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [bundles, setBundles] = useState<BundleCard[]>([]);
  const [discountCode, setDiscountCode] = useState("");
  const [payPrompt, setPayPrompt] = useState<null | {
    eventId: string;
    pricingType: "MEMBER" | "NON_MEMBER" | "DROP_IN";
    options: string[];
  }>(null);

  function load() {
    setLoading(true);
    const mq = selectedMemberId ? `?memberId=${encodeURIComponent(selectedMemberId)}` : "";
    Promise.all([
      fetch(`/api/member/events${mq}`).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/member/event-bundles").then((r) => (r.ok ? r.json() : [])),
    ]).then(([d, b]) => {
      if (d) {
        setEvents(d.events || []);
        setBookings(d.bookings || []);
        setActiveMembershipIds(d.activeMembershipIds || []);
        setIsActiveMember(!!d.isActiveMember);
        setHasMemberProfile(d.hasMemberProfile);
        setAccessible(d.accessible || []);
        if (!selectedMemberId && d.contextMemberId) setSelectedMemberId(d.contextMemberId);
      }
      setBundles(Array.isArray(b) ? b : []);
      setLoading(false);
    });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [selectedMemberId]);

  async function openEventChat(eventId: string) {
    setBusy(`chat:${eventId}`);
    setError("");
    const res = await fetch(`/api/member/events/${eventId}/chat`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok || !d.groupId) {
      setError(d.error || "Couldn't open the event chat.");
      return;
    }
    router.push(`/member/messages/group/${d.groupId}`);
  }

  async function register(
    eventId: string,
    pricingType: "MEMBER" | "NON_MEMBER" | "DROP_IN" = "MEMBER",
    payment?: { method: string; consentLabel?: string },
    acknowledgeDocuments?: boolean,
  ) {
    setBusy(eventId);
    setError("");
    setInfo("");
    const res = await fetch(`/api/member/events/${eventId}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pricingType,
        memberId: selectedMemberId,
        discountCode: discountCode.trim() || null,
        ...(payment ? { paymentMethod: payment.method } : {}),
        ...(payment?.method === "AUTO_CARD"
          ? { autoChargeConsent: { agreed: true, buttonLabel: payment.consentLabel } }
          : {}),
        ...(acknowledgeDocuments ? { acknowledgeDocuments: true } : {}),
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    // The event offers more than one way to pay — ask, then re-submit. The
    // server decides what's offerable (incl. whether a saved card exists), so
    // the choice can't drift from what it will accept.
    if (res.status === 400 && d.error === "PAYMENT_METHOD_REQUIRED") {
      setPayPrompt({ eventId, pricingType, options: d.options ?? [] });
      return;
    }
    // Event documents: ACKNOWLEDGE-level docs get a one-tap confirm and retry;
    // SIGN_REQUIRED docs are signed in Documents first (the message says which).
    if (res.status === 400 && d.error === "DOCUMENTS_ACKNOWLEDGE_REQUIRED") {
      const titles = (d.documents ?? []).map((x: { title: string }) => x.title).join(", ");
      if (window.confirm(`This event requires acknowledging: ${titles}. Acknowledge and continue?`)) {
        register(eventId, pricingType, payment, true);
      }
      return;
    }
    if (!res.ok) { setError(d.message || d.error || "Could not register"); return; }
    if (d.coveredByMembership) {
      setInfo(d.status === "WAITLISTED" ? "You're on the waitlist (covered by your membership)." : "Registered — covered by your membership.");
      load();
      return;
    }
    if (d.variableCost) {
      const each = d.perHead != null ? ` Your estimated share is about $${Number(d.perHead).toFixed(2)}.` : "";
      setInfo(
        (d.status === "WAITLISTED" ? "You're on the waitlist. " : "Registered. ") +
          `The club will send you an invoice for this event's shared cost.${each}`,
      );
      load();
      return;
    }
    if (d.scheduled) {
      setInfo(
        `${d.status === "WAITLISTED" ? "You're on the waitlist. " : "You're registered. "}Your card will be charged $${Number(d.amountDue).toFixed(2)} on ${new Date(d.chargeOn).toLocaleDateString(undefined, { timeZone: "UTC" })}.`,
      );
      load();
      return;
    }
    if (d.offline) {
      setInfo(d.message || "You're registered.");
      load();
      return;
    }
    if (d.free) {
      setInfo(d.status === "WAITLISTED" ? "You're on the waitlist." : "Registered.");
      load();
      return;
    }
    if (d.url) { window.location.href = d.url; return; }
    setError("Unexpected response");
  }

  async function registerBundle(bundleId: string) {
    setBusy(`bundle:${bundleId}`);
    setError("");
    setInfo("");
    const res = await fetch(`/api/member/event-bundles/${bundleId}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: selectedMemberId }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) { setError(d.error || "Could not register"); return; }
    if (d.free) { setInfo(`Registered for all ${d.booked} events in the bundle.`); load(); return; }
    if (d.url) { window.location.href = d.url; return; }
    setError("Unexpected response");
  }

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 mb-1">Events</h1>
          <p className="text-sm text-stone-500">Upcoming clinics, camps, tournaments, and special programs.</p>
        </div>
        <Link href="/member/shop" className="text-xs text-stone-500 hover:text-stone-900">All purchase options →</Link>
      </div>

      <ProfileSwitcher
        accessible={accessible}
        value={selectedMemberId}
        onChange={setSelectedMemberId}
        label="Registering"
      />

      {!hasMemberProfile && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 text-sm text-amber-800">
          Your account isn't linked to a member profile yet. Contact your club to get added before registering.
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 mb-4">{error}</div>}
      {info && <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-800 mb-4">{info}</div>}

      <div className="mb-4 flex items-center gap-2">
        <label className="text-xs text-stone-500 flex-shrink-0">Discount code</label>
        <input
          type="text"
          value={discountCode}
          onChange={(e) => setDiscountCode(e.target.value.toUpperCase())}
          placeholder="Optional — applied at registration"
          className="w-full max-w-xs px-3 py-1.5 border border-stone-300 rounded-lg text-sm font-mono uppercase placeholder:font-sans placeholder:normal-case focus:outline-none focus:ring-2 focus:ring-stone-400"
        />
      </div>

      {!loading && bundles.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-stone-900 mb-2">Bundles &amp; packages</h2>
          <div className="space-y-3">
            {bundles.map((b) => {
              const separate = b.items.reduce((s, it) => s + (Number(it.event.memberPrice) || Number(it.event.nonMemberPrice) || 0), 0);
              const price = Number(b.price);
              const savings = separate > price ? separate - price : 0;
              const key = `bundle:${b.id}`;
              return (
                <div key={b.id} className="bg-white rounded-xl border border-stone-200 p-4">
                  <div className="flex items-start gap-4">
                    <div className="w-14 rounded-lg flex items-center justify-center flex-shrink-0 py-2 bg-stone-900 text-white">
                      <Package className="h-6 w-6" strokeWidth={2} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h3 className="text-sm font-semibold text-stone-900">{b.name}</h3>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-lime-accent/20 text-charcoal font-medium">
                          {b.items.length} event{b.items.length === 1 ? "" : "s"}
                        </span>
                        {savings > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">
                            Save ${savings.toFixed(2)}
                          </span>
                        )}
                      </div>
                      {b.description && <p className="text-xs text-stone-600 mt-0.5 mb-1 line-clamp-2 whitespace-pre-wrap">{b.description}</p>}
                      <p className="text-xs text-stone-500 line-clamp-1">{b.items.map((it) => it.event.name).join(", ")}</p>
                    </div>
                    <div className="flex-shrink-0">
                      <button
                        disabled={!hasMemberProfile || busy === key}
                        onClick={() => registerBundle(b.id)}
                        className="px-3 py-1.5 bg-stone-900 text-white rounded-lg text-xs font-medium hover:bg-stone-700 disabled:opacity-50"
                      >
                        {busy === key ? "…" : `Register · $${price.toFixed(2)}`}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>
      ) : events.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <CalendarRange className="h-7 w-7" strokeWidth={2} />
          </div>
          <p className="text-base font-medium text-stone-900 mb-1">No upcoming events</p>
          <p className="text-sm text-stone-500">Check back soon — your club hasn&apos;t posted any events yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {events.map((e) => {
            const c = evColor(e);
            const start = new Date(e.startsAt);
            const isFull = e.capacity ? e._count.bookings >= e.capacity : false;
            const booked = bookings.find((b) => b.eventId === e.id);
            const acceptedMembershipIds = (e.pricingOptions || [])
              .filter((p) => p.type === "membership" && p.membershipId)
              .map((p) => p.membershipId as string);
            const coveredByActiveSub =
              acceptedMembershipIds.length > 0 &&
              activeMembershipIds.some((id) => acceptedMembershipIds.includes(id));

            const memberPrice = fmtPrice(e.memberPrice);
            const nonMemberPrice = fmtPrice(e.nonMemberPrice);
            const dropInFee = fmtPrice(e.dropInFee);
            const hasPrice = !!(memberPrice || nonMemberPrice || dropInFee);

            // Auto-detect which price applies to THIS viewer. Active members
            // see the member rate; everyone else sees the full non-member
            // (full event) price. Drop-in is a single-session alternative
            // offered only on multi-session events.
            const isMultiSession = (e.sessions?.length ?? 0) > 1;
            const yourPrice = isActiveMember
              ? memberPrice ?? nonMemberPrice ?? dropInFee
              : nonMemberPrice ?? memberPrice ?? dropInFee;
            const yourPriceLabel = isActiveMember
              ? memberPrice
                ? "Member price"
                : "Price"
              : nonMemberPrice
                ? "Non-member price (full event)"
                : "Price";
            const showDropIn = isMultiSession && !!dropInFee;

            return (
              <div key={e.id} className="bg-white rounded-xl border border-stone-200 p-4">
                <div className="flex items-start gap-4">
                  <div
                    className="w-14 rounded-lg flex flex-col items-center justify-center flex-shrink-0 py-2"
                    style={{ background: c.bg, color: c.fg }}
                  >
                    <span className="text-[10px] uppercase font-medium opacity-80">
                      {start.toLocaleString("en-US", { month: "short" })}
                    </span>
                    <span className="text-xl font-bold leading-none">{start.getDate()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <h3 className="text-sm font-semibold text-stone-900">{e.name}</h3>
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: c.bg, color: c.fg }}>
                        {evLabel(e)}
                      </span>
                      {coveredByActiveSub && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">
                          Free with your membership
                        </span>
                      )}
                      {isFull && !booked && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-900 text-white font-medium">
                          Waitlist only
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-stone-500">
                      {start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                      {" · "}
                      {start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                      {e.location ? ` · ${e.location.name}` : ""}
                      {e.capacity ? ` · ${e._count.bookings}/${e.capacity}` : ""}
                    </p>
                    {e.description && (
                      <p className="text-xs text-stone-600 mt-1 line-clamp-2 whitespace-pre-wrap">{e.description}</p>
                    )}
                    {hasPrice && !coveredByActiveSub && (
                      <div className="text-xs text-stone-500 mt-1 flex flex-wrap gap-x-3">
                        {yourPrice && (
                          <span>
                            {yourPriceLabel}{" "}
                            <span className="font-semibold text-stone-700">${yourPrice}</span>
                          </span>
                        )}
                        {showDropIn && (
                          <span>
                            Drop-in (1 session){" "}
                            <span className="font-semibold text-stone-700">${dropInFee}</span>
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0 flex flex-col items-stretch gap-1.5">
                    {booked ? (
                      <>
                        <span className="text-xs px-3 py-1.5 rounded-lg bg-green-50 text-green-700 font-medium text-center">
                          {booked.status === "WAITLISTED" ? "Waitlisted" : "Registered"}
                        </span>
                        <button
                          disabled={busy === `chat:${e.id}`}
                          onClick={() => openEventChat(e.id)}
                          className="px-3 py-1.5 bg-white border border-stone-300 text-stone-700 rounded-lg text-xs font-medium hover:bg-stone-50 disabled:opacity-50 inline-flex items-center justify-center gap-1"
                        >
                          <MessageCircle className="h-3.5 w-3.5" strokeWidth={2} />
                          {busy === `chat:${e.id}` ? "Opening…" : "Event chat"}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          disabled={!hasMemberProfile || busy === e.id}
                          onClick={() => register(e.id, "MEMBER")}
                          className="px-3 py-1.5 bg-stone-900 text-white rounded-lg text-xs font-medium hover:bg-stone-700 disabled:opacity-50"
                        >
                          {busy === e.id
                            ? "…"
                            : coveredByActiveSub || !hasPrice
                              ? "Register"
                              : `Register · $${yourPrice ?? 0}`}
                        </button>
                        {showDropIn && !coveredByActiveSub && (
                          <button
                            disabled={!hasMemberProfile || busy === e.id}
                            onClick={() => register(e.id, "DROP_IN")}
                            className="px-3 py-1.5 bg-white border border-stone-300 text-stone-700 rounded-lg text-xs font-medium hover:bg-stone-50 disabled:opacity-50"
                          >
                            Drop-in · ${dropInFee}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {payPrompt && (
        <PaymentChoiceModal
          prompt={payPrompt}
          event={events.find((e) => e.id === payPrompt.eventId) ?? null}
          onClose={() => setPayPrompt(null)}
          onChoose={(method, consentLabel) => {
            const p = payPrompt;
            setPayPrompt(null);
            register(p.eventId, p.pricingType, { method, consentLabel });
          }}
        />
      )}
    </>
  );
}

// Asks how the member wants to pay for an event. `options` comes from the
// server, which already decided what this member can actually complete (e.g.
// AUTO_CARD only appears when they have a chargeable saved card).
function PaymentChoiceModal({
  prompt,
  event,
  onClose,
  onChoose,
}: {
  prompt: { eventId: string; options: string[] };
  event: EventCard | null;
  onClose: () => void;
  onChoose: (method: string, consentLabel?: string) => void;
}) {
  const [method, setMethod] = useState<string>(prompt.options[0] ?? "");
  const [consented, setConsented] = useState(false);

  const chargeDay = event?.autoChargeDate ?? event?.startsAt ?? null;
  const chargeDayLabel = chargeDay
    ? new Date(chargeDay).toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        ...(event?.autoChargeDate ? { timeZone: "UTC" as const } : {}),
      })
    : "the event date";

  const CHOICES: Record<string, { label: string; hint: string }> = {
    CARD: { label: "Pay now by card", hint: "You'll be taken to a secure checkout page." },
    AUTO_CARD: {
      label: "Charge my saved card on the event date",
      hint: `Nothing is charged today. Your card on file is charged on ${chargeDayLabel}.`,
    },
    CASH: { label: "Pay cash at the event", hint: "Bring it with you — the club records it at check-in." },
    CHECK: { label: "Pay by check at the event", hint: "Bring it with you — the club records it at check-in." },
  };

  const consentLabel =
    method === "AUTO_CARD" ? `I authorize the charge on ${chargeDayLabel}` : undefined;
  const blocked = method === "AUTO_CARD" && !consented;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md border border-stone-200 max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-stone-900">How would you like to pay?</h2>
            {event && <p className="text-xs text-stone-500 truncate">{event.name}</p>}
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none">
            ×
          </button>
        </div>
        <div className="p-5 space-y-2">
          {prompt.options.map((m) => {
            const c = CHOICES[m];
            if (!c) return null;
            return (
              <label
                key={m}
                className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer ${
                  method === m ? "border-stone-900 bg-stone-50" : "border-stone-200"
                }`}
              >
                <input
                  type="radio"
                  name="eventPayMethod"
                  checked={method === m}
                  onChange={() => {
                    setMethod(m);
                    setConsented(false);
                  }}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-stone-900">{c.label}</span>
                  <span className="block text-xs text-stone-500">{c.hint}</span>
                </span>
              </label>
            );
          })}

          {method === "AUTO_CARD" && (
            <label className="flex items-start gap-2.5 p-3 rounded-lg bg-stone-50 border border-stone-200 cursor-pointer">
              <input
                type="checkbox"
                checked={consented}
                onChange={(e) => setConsented(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-xs text-stone-700">{consentLabel}.</span>
            </label>
          )}

          <button
            disabled={!method || blocked}
            onClick={() => onChoose(method, consentLabel)}
            className="w-full mt-2 py-2.5 rounded-lg bg-stone-900 text-white text-sm font-semibold disabled:opacity-40"
          >
            {method === "CARD"
              ? "Continue to payment"
              : method === "AUTO_CARD"
                ? `Confirm — charged ${chargeDayLabel}`
                : "Confirm registration"}
          </button>
        </div>
      </div>
    </div>
  );
}
