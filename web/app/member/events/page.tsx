"use client";

import { memberErrorText } from "@/lib/memberErrorText";
import { confirmDialog } from "@/lib/dialogs";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarRange, ChevronRight, Package } from "lucide-react";
import ProfileSwitcher, { type AccessibleProfile } from "@/components/ProfileSwitcher";
import { PaymentChoiceModal, type MemberEventCard, type PayPromptData } from "@/components/member/events/registerFlow";
import { CardSkeleton } from "@/components/member/ui";
import { spotsText } from "@/lib/eventDetailsView";
import { eventDetailsPath } from "@/lib/memberErrorText";
import { rememberScroll, restoreScroll } from "@/lib/scrollMemory";

// Events (Book → Events). A list to browse; every card opens the event's
// details screen (/member/events/[id]), and registering starts from there,
// after the family has read what they're signing up for. Nothing on this page
// registers anyone for an event.

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

function evColor(e: MemberEventCard) {
  if (e.customEventType) return { bg: e.customEventType.color, fg: e.customEventType.textColor };
  return builtInColors[e.type] || builtInColors.OTHER;
}
function evLabel(e: MemberEventCard) {
  if (e.customEventType) return e.customEventType.name;
  return e.type.charAt(0) + e.type.slice(1).toLowerCase();
}
function fmtPrice(n: number | string | null | undefined) {
  if (n == null) return null;
  const num = typeof n === "string" ? parseFloat(n) : n;
  return Number.isNaN(num) ? null : num.toFixed(2);
}

export default function MemberEventsPage() {
  const router = useRouter();
  const [events, setEvents] = useState<MemberEventCard[]>([]);
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
  const [payPrompt, setPayPrompt] = useState<(PayPromptData & { bundleId: string }) | null>(null);

  // Old links (?event=<id>[&memberId=]) — the Schedule page's former hand-off,
  // the public event page, emails — now open the details screen.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get("event");
    if (id) router.replace(eventDetailsPath(id, sp.get("memberId"), sp.get("register") === "1"));
  }, [router]);

  function load() {
    setLoading(true);
    const mq = selectedMemberId ? `?memberId=${encodeURIComponent(selectedMemberId)}` : "";
    Promise.all([
      fetch(`/api/member/events${mq}`).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/member/event-bundles").then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([d, b]) => {
        if (d) {
          setEvents(d.events || []);
          setBookings(d.bookings || []);
          setActiveMembershipIds(d.activeMembershipIds || []);
          setIsActiveMember(!!d.isActiveMember);
          setHasMemberProfile(d.hasMemberProfile);
          setAccessible(d.accessible || []);
          if (!selectedMemberId && d.contextMemberId) setSelectedMemberId(d.contextMemberId);
        } else {
          setError("Couldn't load events. Please try again.");
        }
        setBundles(Array.isArray(b) ? b : []);
      })
      .catch(() => setError("Couldn't load events. Check your connection and try again."))
      .finally(() => {
        setLoading(false);
        restoreScroll("events");
      });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [selectedMemberId]);

  async function registerBundle(bundleId: string, paymentMethod?: string) {
    setBusy(`bundle:${bundleId}`);
    setError("");
    setInfo("");
    const res = await fetch(`/api/member/event-bundles/${bundleId}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: selectedMemberId, ...(paymentMethod ? { paymentMethod } : {}) }),
    }).catch(() => null);
    const d = res ? await res.json().catch(() => ({})) : {};
    setBusy(null);
    if (!res) { setError("Could not reach the server. Check your connection and try again."); return; }
    if (res.status === 400 && d.error === "PAYMENT_METHOD_REQUIRED") {
      const who = accessible.find((a) => a.id === selectedMemberId) ?? accessible[0];
      setPayPrompt({ kind: "bundle", bundleId, athleteName: who?.firstName ?? null, options: d.options ?? [], quote: d.quote ?? null, savedCard: d.savedCard ?? null, documents: d.documents ?? [] });
      return;
    }
    if (!res.ok) { setError(memberErrorText(d, "Could not register.")); return; }
    if (d.free) { setInfo(`Registered for all ${d.booked} events in the bundle.`); load(); return; }
    if (d.url) { window.location.href = d.url; return; }
    if (d.paid) { setInfo(memberErrorText({ message: d.message }, "Paid. You're booked into every event.")); load(); return; }
    if (d.offline) { setInfo(memberErrorText({ message: d.message }, "You're in. Payment is due at the club.")); load(); return; }
    setError("Something went wrong. Please try again.");
  }

  /** A bundle registers several events at once: ask first, in the app's own dialog. */
  async function startBundle(b: BundleCard) {
    const who = accessible.find((a) => a.id === selectedMemberId) ?? accessible[0];
    const ok = await confirmDialog(
      `Register ${who ? who.firstName : "this athlete"} for all ${b.items.length} events in ${b.name} for $${Number(b.price).toFixed(2)}? You'll choose how to pay next if there's a choice.`,
    );
    if (ok) void registerBundle(b.id);
  }

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 mb-1">Events</h1>
          <p className="text-sm text-stone-500">Upcoming events and special programs. Tap one to read everything before you register.</p>
        </div>
        <Link href="/member/shop" className="text-xs text-stone-500 hover:text-stone-900">All purchase options →</Link>
      </div>

      <ProfileSwitcher accessible={accessible} value={selectedMemberId} onChange={setSelectedMemberId} label="Registering" />

      {!hasMemberProfile && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 text-sm text-amber-800">
          Your account isn&apos;t linked to a member profile yet. Contact your club to get added before registering.
        </div>
      )}

      {error && <div role="alert" className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 mb-4">{error}</div>}
      {info && <div role="status" className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-800 mb-4">{info}</div>}

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
                        <span className="text-[12px] px-1.5 py-0.5 rounded-full bg-lime-accent/20 text-charcoal font-medium">
                          {b.items.length} event{b.items.length === 1 ? "" : "s"}
                        </span>
                        {savings > 0 && (
                          <span className="text-[12px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">Save ${savings.toFixed(2)}</span>
                        )}
                      </div>
                      {b.description && <p className="text-xs text-stone-600 mt-0.5 mb-1 whitespace-pre-wrap">{b.description}</p>}
                      <ul className="text-xs text-stone-500 space-y-0.5">
                        {b.items.map((it) => (
                          <li key={it.eventId}>
                            <Link href={eventDetailsPath(it.eventId, selectedMemberId)} onClick={() => rememberScroll("events")} className="underline decoration-stone-300 hover:text-stone-900">{it.event.name}</Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="flex-shrink-0">
                      <button
                        type="button"
                        disabled={!hasMemberProfile || busy === key}
                        onClick={() => startBundle(b)}
                        className="min-h-11 px-3 py-1.5 bg-stone-900 text-white rounded-lg text-xs font-medium hover:bg-stone-700 disabled:opacity-50"
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
        <div className="space-y-3" aria-busy="true" aria-label="Loading events">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : events.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <CalendarRange className="h-7 w-7" strokeWidth={2} />
          </div>
          <p className="text-base font-medium text-stone-900 mb-1">No upcoming events</p>
          <p className="text-sm text-stone-500">Check back soon. Your club hasn&apos;t posted any events yet.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {events.map((e) => {
            const c = evColor(e);
            const start = new Date(e.startsAt);
            const booked = bookings.find((b) => b.eventId === e.id);
            const accepted = (e.pricingOptions || []).filter((p) => p.type === "membership" && p.membershipId).map((p) => p.membershipId as string);
            const covered = accepted.length > 0 && activeMembershipIds.some((id) => accepted.includes(id));
            const memberPrice = fmtPrice(e.memberPrice);
            const nonMemberPrice = fmtPrice(e.nonMemberPrice);
            const dropInFee = fmtPrice(e.dropInFee);
            const hasPrice = !!(memberPrice || nonMemberPrice || dropInFee);
            const yourPrice = isActiveMember ? memberPrice ?? nonMemberPrice ?? dropInFee : nonMemberPrice ?? memberPrice ?? dropInFee;
            const spots = spotsText(e.capacity, e._count.bookings);
            return (
              <li key={e.id}>
                <Link
                  href={eventDetailsPath(e.id, selectedMemberId)}
                  onClick={() => rememberScroll("events")}
                  className="block bg-white rounded-xl border border-stone-200 p-4 hover:border-stone-300 focus:outline-none focus:ring-2 focus:ring-stone-400"
                >
                  <div className="flex items-start gap-4">
                    <div className="w-14 rounded-lg flex flex-col items-center justify-center flex-shrink-0 py-2" style={{ background: c.bg, color: c.fg }}>
                      <span className="text-[12px] uppercase font-medium opacity-80">{start.toLocaleString("en-US", { month: "short" })}</span>
                      <span className="text-xl font-bold leading-none">{start.getDate()}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h3 className="text-sm font-semibold text-stone-900">{e.name}</h3>
                        <span className="text-[12px] px-1.5 py-0.5 rounded font-medium" style={{ background: c.bg, color: c.fg }}>{evLabel(e)}</span>
                        {covered && <span className="text-[12px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">Free with your membership</span>}
                        {booked && (
                          <span className="text-[12px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-700 font-medium">
                            {booked.status === "WAITLISTED" ? "Waitlisted" : "Registered"}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-stone-500">
                        {start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                        {" · "}
                        {start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                        {e.location ? ` · ${e.location.name}` : ""}
                        {spots ? ` · ${spots}` : ""}
                      </p>
                      {(e.autoDiscounts?.lines ?? []).map((l) => <p key={l} className="text-xs text-emerald-700 mt-1">{l}</p>)}
                      {e.description && <p className="text-xs text-stone-600 mt-1 line-clamp-2 whitespace-pre-wrap">{e.description}</p>}
                      {hasPrice && !covered && yourPrice && (
                        <p className="text-xs text-stone-500 mt-1">
                          {isActiveMember && memberPrice ? "Member price" : "Price"} <span className="font-semibold text-stone-700">${yourPrice}</span>
                        </p>
                      )}
                    </div>
                    <span className="flex-shrink-0 self-center inline-flex items-center gap-0.5 text-xs font-medium text-stone-700">
                      {booked ? "Details" : "Details & register"}
                      <ChevronRight className="h-4 w-4" strokeWidth={2} aria-hidden />
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {payPrompt && (
        <PaymentChoiceModal
          prompt={payPrompt}
          event={null}
          onClose={() => setPayPrompt(null)}
          onChoose={(method) => {
            const p = payPrompt;
            setPayPrompt(null);
            void registerBundle(p.bundleId, method);
          }}
        />
      )}
    </>
  );
}
