"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarRange, MessageCircle, Package } from "lucide-react";
import ProfileSwitcher, { type AccessibleProfile } from "@/components/ProfileSwitcher";
import { eventFormFields, type EventFormField } from "@/lib/eventForm";
import SpotPicker, { type SignupRoster, type SpotValue } from "@/components/events/SpotPicker";

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
  sessions: { id: string; name: string | null; startsAt: string; endsAt: string; price?: number | string | null }[];
  // slice 2 — FIXED events can sell sessions one by one
  sellIndividualSessions?: boolean;
  pricingModel?: string | null;
  _count: { bookings: number };
  autoChargeDate?: string | null;
  // The event's questions (weight class, division, …) and the owner's note.
  registrationForm?: unknown;
  publicFormIntro?: string | null;
  // B16 — the roster to pick a spot from, and whether a coach reviews signups.
  roster?: SignupRoster | null;
  approvalGated?: boolean;
};

type FormAnswers = Record<string, string | boolean>;

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
    kind: "event" | "bundle";
    eventId?: string;
    bundleId?: string;
    pricingType?: "MEMBER" | "NON_MEMBER" | "DROP_IN";
    sessionIds?: string[];
    // §5.3.3 — set by the server when this event is approval-gated.
    requiresCoachApproval?: boolean;
    options: string[];
    quote?: { base: number; cardFee: number; cardTotal: number; offlineTotal: number } | null;
    savedCard?: { label: string } | null;
    documents?: {
      id: string;
      title: string;
      requirement: string;
      requirementLabel?: string;
      eventName?: string;
      needsSignature?: boolean;
      needsAcknowledgement?: boolean;
    }[];
  }>(null);

  // The event's questions, asked once per athlete per event before anything
  // else and re-sent with every retry of that registration (payment choice,
  // document acknowledgement) so they're never asked twice.
  const answersRef = useRef<Record<string, FormAnswers>>({});
  const spotRef = useRef<Record<string, { rosterId: string; positionId: string }>>({});
  const answerKey = (eventId: string) => `${eventId}:${selectedMemberId ?? ""}`;
  const [formPrompt, setFormPrompt] = useState<null | {
    eventId: string;
    pricingType: "MEMBER" | "NON_MEMBER" | "DROP_IN";
    sessionIds?: string[];
    fields: EventFormField[];
    intro: string | null;
    error?: string;
    initial?: FormAnswers;
    roster?: SignupRoster | null;
    approvalGated?: boolean;
    initialSpot?: SpotValue;
  }>(null);

  // Deep link from the public event page (/e/[slug] → sign in → here):
  // ?event=<id> opens that event's registration for the current athlete.
  const deepLinkRef = useRef<{ id: string | null; handled: boolean }>({ id: null, handled: false });
  useEffect(() => {
    try {
      deepLinkRef.current.id = new URLSearchParams(window.location.search).get("event");
    } catch {
      /* no location — nothing to open */
    }
  }, []);

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
        const link = deepLinkRef.current;
        if (link.id && !link.handled) {
          link.handled = true;
          const target = (d.events || []).find((x: EventCard) => x.id === link.id);
          const booked = (d.bookings || []).some((b: BookingRef) => b.eventId === link.id);
          if (!target) {
            setError("That event isn't open for registration from your account. Contact your club if you think it should be.");
          } else if (booked) {
            setInfo(`You're already registered for ${target.name}.`);
          } else {
            setPendingDeepLink(target.id);
          }
        }
      }
      setBundles(Array.isArray(b) ? b : []);
      setLoading(false);
    });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [selectedMemberId]);

  // Start the deep-linked registration once `events` holds it (register reads
  // the event from state for its questions).
  const [pendingDeepLink, setPendingDeepLink] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingDeepLink || !events.some((e) => e.id === pendingDeepLink)) return;
    const id = pendingDeepLink;
    setPendingDeepLink(null);
    register(id, "MEMBER");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDeepLink, events]);

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

  // Per-session picks, per event (slice 2). Only shown when the event sells
  // sessions individually; the server prices the pick from the sessions' own
  // prices, so this holds ids and nothing about money.
  const [picking, setPicking] = useState<Record<string, string[]>>({});

  async function register(
    eventId: string,
    pricingType: "MEMBER" | "NON_MEMBER" | "DROP_IN" = "MEMBER",
    payment?: { method: string; consentLabel?: string },
    acknowledgeDocuments?: boolean,
    sessionIds?: string[],
  ) {
    // Ask the event's questions first (weight class, division, …). The server
    // enforces them too (FORM_REQUIRED) — this just asks before a round trip.
    const ev = events.find((x) => x.id === eventId);
    const fields = eventFormFields(ev?.registrationForm);
    const answers = answersRef.current[answerKey(eventId)];
    const spot = spotRef.current[answerKey(eventId)];
    if ((fields.length > 0 && !answers) || (ev?.roster && !spot)) {
      setFormPrompt({
        eventId, pricingType, sessionIds, fields, intro: ev?.publicFormIntro ?? null,
        roster: ev?.roster ?? null, approvalGated: !!ev?.approvalGated, initial: answers, initialSpot: spot ?? null,
      });
      return;
    }
    setBusy(eventId);
    setError("");
    setInfo("");
    const res = await fetch(`/api/member/events/${eventId}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pricingType,
        ...(sessionIds && sessionIds.length ? { sessionIds } : {}),
        memberId: selectedMemberId,
        discountCode: discountCode.trim() || null,
        ...(payment ? { paymentMethod: payment.method } : {}),
        // APPROVAL_CHARGE consents to a charge that fires when the coach
        // approves — same audited snapshot shape as AUTO_CARD's event-date
        // charge, because it is the same promise about the same card.
        ...(payment?.method === "AUTO_CARD" || payment?.method === "APPROVAL_CHARGE"
          ? { autoChargeConsent: { agreed: true, buttonLabel: payment.consentLabel } }
          : {}),
        ...(acknowledgeDocuments ? { acknowledgeDocuments: true } : {}),
        ...(answers ? { formResponses: answers } : {}),
        ...(spot ? { entries: [spot] } : {}),
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    // The server has questions this page didn't know about, or an answer it
    // won't take — ask (again), keeping what was typed.
    // The spot filled up (or vanished) since the page loaded — refresh the
    // counts and ask again, keeping everything else they entered.
    if (res.status === 409 && (d.error === "SPOT_FULL" || d.error === "UNKNOWN_SPOT")) {
      delete spotRef.current[answerKey(eventId)];
      setError(d.message || "That spot isn't available any more. Pick another.");
      load();
      return;
    }
    if (res.status === 400 && (d.error === "FORM_REQUIRED" || d.error === "FORM_INVALID" || d.error === "ROSTER_REQUIRED")) {
      setFormPrompt({
        eventId,
        pricingType,
        sessionIds,
        fields: d.fields ? eventFormFields(d.fields) : fields,
        intro: d.intro ?? ev?.publicFormIntro ?? null,
        error: d.error === "FORM_INVALID" || d.error === "ROSTER_REQUIRED" ? d.message : undefined,
        initial: answers,
        roster: ev?.roster ?? null,
        approvalGated: !!ev?.approvalGated,
        initialSpot: spot ?? null,
      });
      delete answersRef.current[answerKey(eventId)];
      delete spotRef.current[answerKey(eventId)];
      return;
    }
    // The event offers more than one way to pay — ask, then re-submit. The
    // server decides what's offerable (incl. whether a saved card exists), so
    // the choice can't drift from what it will accept.
    if (res.status === 400 && d.error === "PAYMENT_METHOD_REQUIRED") {
      setPayPrompt({
        kind: "event",
        eventId,
        pricingType,
        sessionIds,
        options: d.options ?? [],
        quote: d.quote ?? null,
        savedCard: d.savedCard ?? null,
        documents: d.documents ?? [],
        requiresCoachApproval: !!d.requiresCoachApproval,
      });
      return;
    }
    // Event documents: ACKNOWLEDGE-level docs get a one-tap confirm and retry;
    // SIGN_REQUIRED docs are signed in Documents first (the message says which).
    if (res.status === 400 && d.error === "DOCUMENTS_ACKNOWLEDGE_REQUIRED") {
      const titles = (d.documents ?? []).map((x: { title: string }) => x.title).join(", ");
      if (window.confirm(`This event requires acknowledging: ${titles}. Acknowledge and continue?`)) {
        register(eventId, pricingType, payment, true, sessionIds);
      }
      return;
    }
    // No chargeable card on file for a "charge on approval" event. The card
    // is verified NOW, while the parent is here to fix it — not at approval
    // time, when they are not.
    if (res.status === 402 && d.error === "PAYMENT_SETUP_REQUIRED") {
      setError(`${d.message} Add one under Profile → Payment & billing.`);
      return;
    }
    if (!res.ok) { setError(d.message || d.error || "Could not register"); return; }
    // Coach approval (§5.4.5): a request, not a spot. Every branch of the
    // server's approval fork returns pendingReview with copy that already
    // says what happens to the money, so it is shown verbatim rather than
    // re-derived here.
    if (d.pendingReview) {
      setInfo(d.message || "Request sent to your coach.");
      load();
      return;
    }
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

  async function registerBundle(bundleId: string, paymentMethod?: string) {
    setBusy(`bundle:${bundleId}`);
    setError("");
    setInfo("");
    const res = await fetch(`/api/member/event-bundles/${bundleId}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memberId: selectedMemberId,
        ...(paymentMethod ? { paymentMethod } : {}),
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (res.status === 400 && d.error === "PAYMENT_METHOD_REQUIRED") {
      setPayPrompt({
        kind: "bundle",
        bundleId,
        options: d.options ?? [],
        quote: d.quote ?? null,
        savedCard: d.savedCard ?? null,
        documents: d.documents ?? [],
      });
      return;
    }
    if (!res.ok) { setError(d.message || d.error || "Could not register"); return; }
    if (d.free) { setInfo(`Registered for all ${d.booked} events in the bundle.`); load(); return; }
    if (d.url) { window.location.href = d.url; return; }
    if (d.paid) { setInfo(d.message || "Paid — you're booked into every event."); load(); return; }
    if (d.offline) { setInfo(d.message || "You're in — payment due at the club."); load(); return; }
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
            const pricedSessions = (e.sessions ?? []).filter((x) => x.price != null && Number(x.price) > 0 && new Date(x.startsAt).getTime() > Date.now());
            const sellsSessions = !!e.sellIndividualSessions && pricedSessions.length > 0;
            // The old single drop-in button stays only for events that never
            // moved to per-session prices.
            const showDropIn = !sellsSessions && isMultiSession && !!dropInFee;
            const picked = picking[e.id] ?? null;
            const pickedTotal = picked ? pricedSessions.filter((x) => picked.includes(x.id)).reduce((a, x) => a + Number(x.price), 0) : 0;

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
                        {sellsSessions && !coveredByActiveSub ? (
                          <button
                            type="button"
                            disabled={!hasMemberProfile || busy === e.id}
                            onClick={() => setPicking((p) => ({ ...p, [e.id]: p[e.id] ? undefined as unknown as string[] : [] }))}
                            className="px-3 py-1.5 bg-white border border-stone-300 text-stone-700 rounded-lg text-xs font-medium hover:bg-stone-50 disabled:opacity-50"
                          >
                            {picking[e.id] ? "Hide sessions" : `Pick sessions · from $${fmtPrice(Math.min(...pricedSessions.map((x) => Number(x.price))))}`}
                          </button>
                        ) : showDropIn && !coveredByActiveSub ? (
                          <button
                            disabled={!hasMemberProfile || busy === e.id}
                            onClick={() => register(e.id, "DROP_IN")}
                            className="px-3 py-1.5 bg-white border border-stone-300 text-stone-700 rounded-lg text-xs font-medium hover:bg-stone-50 disabled:opacity-50"
                          >
                            Drop-in · ${dropInFee}
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
                {/* Per-session picker (slice 2). Prices come from each session;
                    the server re-quotes the pick, so the total here is a
                    preview, never the charge. */}
                {picked && !booked && sellsSessions && (
                  <div className="mt-3 border-t border-stone-200 pt-3">
                    <p className="text-xs font-medium text-stone-700 mb-1.5">Which sessions?</p>
                    <div className="space-y-1">
                      {pricedSessions.map((x) => {
                        const on = picked.includes(x.id);
                        const when = `${new Date(x.startsAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · ${new Date(x.startsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
                        return (
                          <label key={x.id} className="flex items-center justify-between gap-3 text-xs text-stone-700 py-1.5 min-h-[44px]">
                            <span className="flex items-center gap-2 min-w-0">
                              <input type="checkbox" checked={on} onChange={() => setPicking((p) => ({ ...p, [e.id]: on ? (p[e.id] ?? []).filter((id) => id !== x.id) : [...(p[e.id] ?? []), x.id] }))} />
                              <span className="truncate">{x.name || "Session"} <span className="text-stone-500">· {when}</span></span>
                            </span>
                            <span className="font-semibold shrink-0">${fmtPrice(x.price ?? 0)}</span>
                          </label>
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-between gap-3 mt-2">
                      <span className="text-xs text-stone-500">{picked.length} session{picked.length === 1 ? "" : "s"} · <strong className="text-stone-800">${fmtPrice(pickedTotal)}</strong></span>
                      <button
                        type="button"
                        disabled={!hasMemberProfile || busy === e.id || picked.length === 0}
                        onClick={() => register(e.id, "DROP_IN", undefined, undefined, picked)}
                        className="px-3 py-1.5 bg-stone-900 text-white rounded-lg text-xs font-medium hover:bg-stone-700 disabled:opacity-50 min-h-[36px]"
                      >
                        {busy === e.id ? "…" : `Register ${picked.length || ""} · $${fmtPrice(pickedTotal)}`}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {formPrompt && (
        <EventFormModal
          prompt={formPrompt}
          eventName={events.find((e) => e.id === formPrompt.eventId)?.name ?? "Event"}
          accessible={accessible}
          memberId={selectedMemberId}
          onMemberChange={(id) => {
            setSelectedMemberId(id);
          }}
          onClose={() => setFormPrompt(null)}
          onSubmit={(answers, spot) => {
            const p = formPrompt;
            answersRef.current[answerKey(p.eventId)] = answers;
            if (spot) spotRef.current[answerKey(p.eventId)] = spot;
            setFormPrompt(null);
            register(p.eventId, p.pricingType, undefined, undefined, p.sessionIds);
          }}
        />
      )}

      {payPrompt && (
        <PaymentChoiceModal
          prompt={payPrompt}
          event={payPrompt.eventId ? (events.find((e) => e.id === payPrompt.eventId) ?? null) : null}
          onClose={() => setPayPrompt(null)}
          onChoose={(method, consentLabel, acknowledged) => {
            const p = payPrompt;
            setPayPrompt(null);
            if (p.kind === "bundle" && p.bundleId) {
              registerBundle(p.bundleId, method);
            } else if (p.eventId) {
              register(p.eventId, p.pricingType ?? "MEMBER", { method, consentLabel }, acknowledged, p.sessionIds);
            }
          }}
        />
      )}
    </>
  );
}

// Asks how the member wants to pay for an event or bundle. `options` comes
// from the server, which already decided what this member can actually
// complete (saved-card options only appear with a verified card on file).
// Exact totals come from the server quote; documents attached to the event(s)
// are shown for review — unsigned SIGN_REQUIRED docs block confirming.
type PayPromptData = {
  kind: "event" | "bundle";
  // §5.3.3 — changes what every option below means, so the modal says it
  // before the picker rather than after.
  requiresCoachApproval?: boolean;
  eventId?: string;
  bundleId?: string;
  options: string[];
  quote?: { base: number; cardFee: number; cardTotal: number; offlineTotal: number } | null;
  savedCard?: { label: string } | null;
  documents?: {
    id: string;
    title: string;
    requirement: string;
    requirementLabel?: string;
    eventName?: string;
    needsSignature?: boolean;
    needsAcknowledgement?: boolean;
  }[];
};

function PaymentChoiceModal({
  prompt,
  event,
  onClose,
  onChoose,
}: {
  prompt: PayPromptData;
  event: EventCard | null;
  onClose: () => void;
  onChoose: (method: string, consentLabel?: string, acknowledged?: boolean) => void;
}) {
  const [method, setMethod] = useState<string>(prompt.options[0] ?? "");
  const [consented, setConsented] = useState(false);
  const [ackChecked, setAckChecked] = useState(false);

  const chargeDay = event?.autoChargeDate ?? event?.startsAt ?? null;
  const chargeDayLabel = chargeDay
    ? new Date(chargeDay).toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
        ...(event?.autoChargeDate ? { timeZone: "UTC" as const } : {}),
      })
    : "the event date";

  const q = prompt.quote ?? null;
  const money = (n: number) => `$${n.toFixed(2)}`;
  const cardTotal = q ? money(q.cardTotal) : "";
  const offlineTotal = q ? money(q.offlineTotal) : "";
  const feeNote = q && q.cardFee > 0 ? ` (includes ${money(q.cardFee)} processing fee)` : "";

  const CHOICES: Record<string, { label: string; hint: string }> = {
    SAVED_CARD: {
      label: `Pay now with saved card${prompt.savedCard ? ` — ${prompt.savedCard.label}` : ""}`,
      hint: `${cardTotal ? `${cardTotal} is` : "You're"} charged immediately${feeNote}.`,
    },
    CARD: { label: "Pay now by card", hint: `You'll be taken to a secure checkout page${cardTotal ? ` — total ${cardTotal}${feeNote}` : ""}.` },
    AUTO_CARD: prompt.requiresCoachApproval
      ? {
          label: `Charge my saved card on ${chargeDayLabel} if approved${prompt.savedCard ? ` — ${prompt.savedCard.label}` : ""}`,
          hint: `Nothing is charged today. If your coach approves, ${cardTotal || "the total"} is charged on ${chargeDayLabel}${feeNote}. If they don't, nothing is charged.`,
        }
      : {
          label: "Charge my saved card on the event date",
          hint: `Nothing is charged today. ${cardTotal ? `${cardTotal} is` : "Your card on file is"} charged on ${chargeDayLabel}.`,
        },
    CASH: { label: prompt.kind === "bundle" ? "Pay cash at the club" : "Pay cash at the event", hint: `Bring ${offlineTotal || "it"} with you — the club records it when received.` },
    CHECK: { label: prompt.kind === "bundle" ? "Pay by check at the club" : "Pay by check at the event", hint: `Bring a check for ${offlineTotal || "the amount"} — the club records it when received.` },
    PAY_LATER: {
      label: "Pay later — the club will invoice me",
      hint: `Nothing is collected now. The club sends you an invoice or payment link for ${offlineTotal || "the amount"}. This is not an automatic card charge.`,
    },
    // Phase 5 §5.1 — a saved-card charge that fires on approval, never an
    // authorization hold: an auth expires in 7 days and tournament approval
    // routinely takes longer than that.
    APPROVAL_CHARGE: {
      label: `Charge my saved card when the coach approves${prompt.savedCard ? ` — ${prompt.savedCard.label}` : ""}`,
      hint: `Nothing is charged today. ${cardTotal ? `${cardTotal} is` : "Your card on file is"} charged the moment your coach approves${feeNote}. If they don't, nothing is charged at all.`,
    },
    INVOICE: {
      label: "Bill me if I'm approved",
      hint: `No card needed now. If your coach approves, the club emails a payment link for ${offlineTotal || "the amount"}.`,
    },
  };

  const docs = prompt.documents ?? [];
  const signBlocked = docs.filter((d) => d.needsSignature);
  const ackDocs = docs.filter((d) => d.needsAcknowledgement);

  const consentLabel =
    method === "AUTO_CARD"
      ? `I authorize the charge of ${cardTotal || "the total"} on ${chargeDayLabel}${prompt.requiresCoachApproval ? " if my coach approves" : ""}`
      : method === "APPROVAL_CHARGE"
        ? `I authorize the charge of ${cardTotal || "the total"} if my coach approves`
        : undefined;
  const blocked =
    ((method === "AUTO_CARD" || method === "APPROVAL_CHARGE") && !consented) ||
    (prompt.kind === "event" && signBlocked.length > 0) ||
    (prompt.kind === "event" && ackDocs.length > 0 && !ackChecked);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md border border-stone-200 max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-stone-900">
              {prompt.requiresCoachApproval ? "How would you pay if approved?" : "How would you like to pay?"}
            </h2>
            {event && <p className="text-xs text-stone-500 truncate">{event.name}</p>}
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none">
            ×
          </button>
        </div>
        <div className="p-5 space-y-2">
          {prompt.requiresCoachApproval && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 mb-1">
              <p className="text-sm font-medium text-amber-900">
                Registration isn&apos;t confirmed until the coach reviews it.
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                You&apos;ll be notified as soon as they do — no money moves until then.
              </p>
            </div>
          )}
          {docs.length > 0 && (
            <div className="mb-3">
              <p className="text-sm font-medium text-stone-900 mb-1">
                {prompt.kind === "bundle" ? "Documents for the included events" : "Event documents"}
              </p>
              <div className="space-y-1.5">
                {docs.map((d, i) => (
                  <div key={`${d.id}-${i}`} className="flex items-start justify-between gap-2 border border-stone-200 rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <p className="text-sm text-stone-900 truncate">{d.title}</p>
                      <p className="text-[11px] text-stone-500">
                        {prompt.kind === "bundle"
                          ? d.requirement === "SIGN_REQUIRED"
                            ? `Must be completed before ${d.eventName ?? "the event"} check-in`
                            : d.requirement === "ACKNOWLEDGE"
                              ? `Acknowledgement required at ${d.eventName ?? "the event"}`
                              : `For your information · ${d.eventName ?? ""}`
                          : d.requirementLabel ?? d.requirement}
                      </p>
                    </div>
                    {d.needsSignature && (
                      <Link href="/member/documents" className="text-[11px] text-red-600 hover:underline whitespace-nowrap mt-0.5">
                        Sign first →
                      </Link>
                    )}
                  </div>
                ))}
              </div>
              {prompt.kind === "event" && signBlocked.length > 0 && (
                <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1.5 mt-2">
                  {signBlocked.map((d) => d.title).join(", ")} must be signed before you can register — open Documents to sign, then come back.
                </p>
              )}
              {prompt.kind === "event" && ackDocs.length > 0 && (
                <label className="flex items-start gap-2.5 mt-2 p-3 rounded-lg bg-stone-50 border border-stone-200 cursor-pointer">
                  <input type="checkbox" checked={ackChecked} onChange={(e) => setAckChecked(e.target.checked)} className="mt-0.5" />
                  <span className="text-xs text-stone-700">
                    I have read and acknowledge: {ackDocs.map((d) => d.title).join(", ")}.
                  </span>
                </label>
              )}
              {prompt.kind === "bundle" && (
                <p className="text-[11px] text-stone-500 mt-1.5">
                  You won't sign anything now — documents marked &quot;must be completed&quot; are required before that event&apos;s check-in.
                </p>
              )}
            </div>
          )}
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

          {(method === "AUTO_CARD" || method === "APPROVAL_CHARGE") && (
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
            onClick={() => onChoose(method, consentLabel, ackChecked)}
            className="w-full mt-2 py-2.5 rounded-lg bg-stone-900 text-white text-sm font-semibold disabled:opacity-40"
          >
            {method === "SAVED_CARD"
              ? `Pay ${cardTotal || "now"} now`
              : method === "CARD"
                ? `Continue to payment${cardTotal ? ` — ${cardTotal}` : ""}`
                : method === "AUTO_CARD"
                  ? prompt.requiresCoachApproval
                    ? `Register — charged ${cardTotal || "the total"} on ${chargeDayLabel} if approved`
                    : `Confirm — ${cardTotal || "charged"} on ${chargeDayLabel}`
                  : // §5.3.3: the button states the exact server-computed
                    // amount and when it moves, so nobody agrees to a number
                    // they were never shown.
                    method === "APPROVAL_CHARGE"
                    ? `Register — reviewed by coach, then charged ${cardTotal || "the total"}`
                    : method === "INVOICE"
                      ? "Register — billed if approved"
                      : method === "PAY_LATER"
                        ? `Confirm — club invoices ${offlineTotal || "me"}`
                        : `Confirm — ${offlineTotal || "due"} at ${prompt.kind === "bundle" ? "the club" : "the event"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// The event's own questions (Event.registrationForm), asked before payment.
// Same fields the public link shows, validated again on the server by
// lib/eventForm. Names who is being registered, with a switch for families
// with more than one athlete.
function EventFormModal({
  prompt,
  eventName,
  accessible,
  memberId,
  onMemberChange,
  onClose,
  onSubmit,
}: {
  prompt: {
    fields: EventFormField[];
    intro: string | null;
    error?: string;
    initial?: FormAnswers;
    roster?: SignupRoster | null;
    approvalGated?: boolean;
    initialSpot?: SpotValue;
  };
  eventName: string;
  accessible: AccessibleProfile[];
  memberId: string | null;
  onMemberChange: (id: string) => void;
  onClose: () => void;
  onSubmit: (answers: FormAnswers, spot: { rosterId: string; positionId: string } | null) => void;
}) {
  const [answers, setAnswers] = useState<FormAnswers>(prompt.initial ?? {});
  const [spot, setSpot] = useState<SpotValue>(prompt.initialSpot ?? null);
  const [err, setErr] = useState(prompt.error ?? "");
  const who = accessible.find((a) => a.id === memberId) ?? accessible[0] ?? null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    for (const f of prompt.fields) {
      const v = answers[f.id];
      if (f.required && (v === undefined || v === "" || v === false)) {
        setErr(`"${f.label}" is required`);
        return;
      }
    }
    if (prompt.roster && !(spot?.rosterId && spot.positionId)) {
      setErr("Pick a spot on the roster.");
      return;
    }
    onSubmit(answers, spot?.rosterId && spot.positionId ? { rosterId: spot.rosterId, positionId: spot.positionId } : null);
  }

  const inputCls = "w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-300";

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <form onSubmit={submit} className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md border border-stone-200 max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-stone-900">Register for {eventName}</h2>
            {who && accessible.length <= 1 && (
              <p className="text-xs text-stone-500 truncate">Registering {who.firstName} {who.lastName}</p>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-4">
          {accessible.length > 1 && (
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Who are you registering?</label>
              <select value={who?.id ?? ""} onChange={(e) => onMemberChange(e.target.value)} className={inputCls}>
                {accessible.map((a) => (
                  <option key={a.id} value={a.id}>{a.firstName} {a.lastName}</option>
                ))}
              </select>
            </div>
          )}
          {prompt.intro && <p className="text-sm text-stone-500 whitespace-pre-wrap">{prompt.intro}</p>}
          {prompt.roster && (
            <SpotPicker
              roster={prompt.roster}
              value={spot}
              onChange={(v) => { setSpot(v); setErr(""); }}
              approvalGated={!!prompt.approvalGated}
            />
          )}
          {prompt.fields.map((f) => (
            <div key={f.id}>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                {f.label}{f.required ? " *" : ""}
              </label>
              {f.type === "select" ? (
                <select
                  value={(answers[f.id] as string) || ""}
                  onChange={(e) => { setAnswers((a) => ({ ...a, [f.id]: e.target.value })); setErr(""); }}
                  className={inputCls}
                >
                  <option value="">Select…</option>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.type === "checkbox" ? (
                <label className="flex items-center gap-2 text-sm text-stone-700 min-h-[44px]">
                  <input type="checkbox" checked={!!answers[f.id]} onChange={(e) => { setAnswers((a) => ({ ...a, [f.id]: e.target.checked })); setErr(""); }} />
                  Yes
                </label>
              ) : f.type === "textarea" ? (
                <textarea
                  rows={3}
                  value={(answers[f.id] as string) || ""}
                  onChange={(e) => { setAnswers((a) => ({ ...a, [f.id]: e.target.value })); setErr(""); }}
                  className={inputCls}
                />
              ) : (
                <input
                  type={f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text"}
                  value={(answers[f.id] as string) || ""}
                  onChange={(e) => { setAnswers((a) => ({ ...a, [f.id]: e.target.value })); setErr(""); }}
                  className={inputCls}
                />
              )}
            </div>
          ))}
          {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
          <button type="submit" className="w-full py-3 rounded-lg bg-stone-900 text-white text-sm font-semibold">
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}
