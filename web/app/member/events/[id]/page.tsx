"use client";

// Event details (/member/events/[id]). Everything a family needs to decide,
// and the ONLY place registering for an event starts. Every event link in the
// portal opens this screen (lib/memberErrorText eventDetailsPath): the Events
// list, Schedule, Home, bundles, the public event page, emails and the app.
//
// Registering runs the one shared flow (components/member/events/
// registerFlow): questions, roster spot, then a confirm step that shows the
// athlete, the price and when and how the money moves. Nothing is saved or
// charged before that confirm; the server enforces it.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, CalendarPlus, Share2, FileText, Users, Clock, AlertTriangle } from "lucide-react";
import EventInfoBlock, { DescriptionText } from "@/components/events/EventInfoBlock";
import { CardSkeleton, Skeleton } from "@/components/member/ui";
import type { AccessibleProfile } from "@/components/ProfileSwitcher";
import { useEventRegisterFlow, type FlowMessage, type MemberEventCard } from "@/components/member/events/registerFlow";
import { memberErrorText } from "@/lib/memberErrorText";
import { isNativeApp, shareLink } from "@/lib/native";
import {
  athleteStatusText,
  deadlineText,
  paymentSummary,
  priceView,
  sessionWhen,
  spotsText,
  type PaymentMethodKey,
  type PricingKind,
} from "@/lib/eventDetailsView";

type Details = {
  clubName: string;
  timezone: string | null;
  typeLabel: string;
  location: { name: string; address: string | null; mapUrl: string | null } | null;
  staff: { name: string; role: string }[];
  audience: string | null;
  pricing: PricingKind;
  price: { member: number | null; nonMember: number | null; dropIn: number | null; yours: number | null; cardFee: number; cardTotal: number | null; passFees: boolean };
  methods: PaymentMethodKey[];
  chargeOn: string | null;
  split: { mode: string | null; perHead: number | null } | null;
  approval: boolean;
  onlinePaymentsReady: boolean;
  capacity: number | null;
  taken: number;
  deadline: string | null;
  registrationClosed: boolean;
  started: boolean;
  cancellationPolicy: string | null;
  questions: { label: string; type: string; required: boolean; options: string[]; perEntry: boolean }[];
  documents: { id: string; title: string; requirement: string; requirementLabel: string; needsSignature: boolean }[];
  sessions: { id: string; name: string | null; startsAt: string; endsAt: string; price: number | null; pickable: boolean }[];
  divisions: string | null;
};

type Payload = {
  event: MemberEventCard;
  accessible: AccessibleProfile[];
  contextMemberId: string | null;
  isActiveMember: boolean;
  family: { memberId: string; firstName: string; lastName: string; status: string | null }[];
  details: Details;
};

const money = (n: number) => `$${n.toFixed(2)}`;

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-stone-200 p-5 mb-4">
      <h2 className="text-sm font-semibold text-stone-900 mb-2 flex items-center gap-1.5">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function DetailsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading event">
      <Skeleton className="h-6 w-24 mb-4" />
      <CardSkeleton lines={5} />
      <div className="mt-4"><CardSkeleton lines={3} /></div>
      <div className="mt-4"><CardSkeleton lines={3} /></div>
    </div>
  );
}

function Inner() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<Payload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(searchParams.get("memberId"));
  const [msg, setMsg] = useState<FlowMessage | null>(null);
  const [discountCode, setDiscountCode] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const autoStarted = useRef(false);

  const load = useCallback(
    async (mid: string | null) => {
      try {
        const res = await fetch(`/api/member/events/${encodeURIComponent(id)}${mid ? `?memberId=${encodeURIComponent(mid)}` : ""}`, { cache: "no-store" });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
          setLoadError(memberErrorText(d, "This event isn't available to your account."));
          return;
        }
        setLoadError(null);
        setData(d as Payload);
        if (!mid && (d as Payload).contextMemberId) setMemberId((d as Payload).contextMemberId);
      } catch {
        setLoadError("Couldn't load this event. Check your connection and try again.");
      }
    },
    [id],
  );
  useEffect(() => { void load(memberId); }, [load, memberId]);

  const flow = useEventRegisterFlow({
    getEvent: (eid) => (data?.event.id === eid ? data.event : undefined),
    memberId,
    setMemberId,
    accessible: data?.accessible ?? [],
    isActiveMember: !!data?.isActiveMember,
    discountCode,
    timeZone: data?.details.timezone ?? null,
    onMessage: setMsg,
    onDone: () => { setPicked(null); void load(memberId); },
  });

  const d = data?.details;
  const ev = data?.event;
  const me = data?.family.find((f) => f.memberId === memberId) ?? null;
  const blockedReason = !data
    ? null
    : data.accessible.length === 0
      ? "Your account isn't linked to a member profile yet. Contact your club to get added."
      : d?.started
        ? "This event has already started."
        : d?.registrationClosed
          ? "Registration is closed."
          : me?.status
            ? `${me.firstName}: ${athleteStatusText(me.status)}`
            : null;

  // The Schedule page's hand-off (?register=1) opens the flow on arrival. It
  // still ends on the confirm step.
  useEffect(() => {
    if (!data || autoStarted.current || searchParams.get("register") !== "1") return;
    autoStarted.current = true;
    if (!blockedReason) flow.start(data.event.id);
  }, [data, blockedReason, searchParams, flow]);

  const price = useMemo(() => {
    if (!d || !ev) return null;
    return priceView({
      pricing: d.pricing,
      isActiveMember: !!data?.isActiveMember,
      memberPrice: d.price.member,
      nonMemberPrice: d.price.nonMember,
      dropInFee: d.price.dropIn,
      multiSession: (ev.sessions?.length ?? 0) > 1,
      cardFee: d.price.cardFee,
      passFees: d.price.passFees,
      discountLines: ev.autoDiscounts?.lines ?? [],
      athleteName: me?.firstName ?? null,
      split: d.split,
    });
  }, [d, ev, data?.isActiveMember, me?.firstName]);

  const payLines = d
    ? paymentSummary({
        pricing: d.pricing,
        methods: d.methods,
        facts: d.price.yours != null
          ? { cardTotal: d.price.cardTotal ?? d.price.yours, offlineTotal: d.price.yours, cardFee: d.price.cardFee, chargeOn: d.chargeOn, tz: d.timezone }
          : null,
        approval: d.approval,
        athleteName: me?.firstName ?? null,
        split: d.split,
      })
    : [];

  function back() {
    try {
      if (window.history.length > 1 && document.referrer && new URL(document.referrer).origin === window.location.origin) {
        router.back();
        return;
      }
    } catch {
      /* fall through */
    }
    router.push("/member/events");
  }

  async function share() {
    if (!ev) return;
    const url = `${window.location.origin}/member/events/${ev.id}`;
    if (isNativeApp()) {
      await shareLink({ title: ev.name, url });
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setMsg({ ok: false, text: `Couldn't copy the link. The address is ${url}` });
    }
  }

  if (loadError) {
    return (
      <div className="max-w-2xl mx-auto">
        <button type="button" onClick={back} className="min-h-11 inline-flex items-center gap-1 text-sm text-stone-600 hover:text-stone-900 mb-3">
          <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden /> Back
        </button>
        <div role="alert" className="bg-white rounded-xl border border-stone-200 p-8 text-center">
          <p className="text-base font-medium text-stone-900 mb-1">{loadError}</p>
          <Link href="/member/events" className="text-sm text-stone-600 underline">See all events</Link>
        </div>
      </div>
    );
  }
  if (!data || !d || !ev) return <div className="max-w-2xl mx-auto"><DetailsSkeleton /></div>;

  const spots = spotsText(d.capacity, d.taken);
  const deadline = deadlineText(d.deadline, new Date(), d.timezone);
  const pickable = d.sessions.filter((s) => s.pickable);
  const pickedTotal = picked ? pickable.filter((s) => picked.includes(s.id)).reduce((a, s) => a + (s.price ?? 0), 0) : 0;
  const busy = flow.busy === ev.id;
  const registerLabel = d.approval ? "Request to register" : spots?.startsWith("Full") ? "Join the waitlist" : "Register";
  const rosterLabels = (ev.roster?.rosters ?? []).map((r) => r.label);

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between gap-2 mb-3">
        <button type="button" onClick={back} className="min-h-11 inline-flex items-center gap-1 text-sm text-stone-600 hover:text-stone-900">
          <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden /> Back
        </button>
        <div className="flex items-center gap-1">
          <a
            href={`/api/member/events/${encodeURIComponent(ev.id)}/ics`}
            className="min-h-11 inline-flex items-center gap-1.5 px-3 text-sm text-stone-700 rounded-lg hover:bg-stone-100"
          >
            <CalendarPlus className="h-4 w-4" strokeWidth={2} aria-hidden /> Add to calendar
          </a>
          <button type="button" onClick={share} className="min-h-11 inline-flex items-center gap-1.5 px-3 text-sm text-stone-700 rounded-lg hover:bg-stone-100">
            <Share2 className="h-4 w-4" strokeWidth={2} aria-hidden /> {copied ? "Link copied" : "Share"}
          </button>
        </div>
      </div>

      <EventInfoBlock
        name={ev.name}
        badge={<span className="text-[12px] px-2 py-0.5 rounded-full font-medium bg-stone-100 text-stone-700">{d.typeLabel}</span>}
        imageUrl={ev.imageUrl}
        imagePositionX={ev.imagePositionX}
        imagePositionY={ev.imagePositionY}
        startsAt={ev.startsAt}
        endsAt={ev.endsAt}
        timeZone={d.timezone}
        location={d.location}
        description={ev.description}
        links={ev.externalLinks}
      />

      {msg && (
        <div role={msg.ok ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm mb-4 border ${msg.ok ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-700"}`}>
          {msg.text}
        </div>
      )}

      {data.family.length > 0 && (
        <Section title={data.family.length > 1 ? "Your athletes" : "Your registration"} icon={<Users className="h-4 w-4" strokeWidth={2} aria-hidden />}>
          {data.family.length > 1 && <p className="text-xs text-stone-500 mb-2">Choose who you&apos;re registering.</p>}
          <ul className="space-y-1.5">
            {data.family.map((f) => {
              const status = athleteStatusText(f.status);
              const chosen = f.memberId === memberId;
              return (
                <li key={f.memberId}>
                  <label className={`flex items-center justify-between gap-3 rounded-lg border px-3 min-h-11 py-2 ${chosen ? "border-stone-900 bg-stone-50" : "border-stone-200"} ${data.family.length > 1 ? "cursor-pointer" : ""}`}>
                    <span className="flex items-center gap-2 min-w-0">
                      {data.family.length > 1 && (
                        <input type="radio" name="athlete" checked={chosen} onChange={() => { setMsg(null); setMemberId(f.memberId); }} />
                      )}
                      <span className="text-sm font-medium text-stone-900 truncate">{f.firstName} {f.lastName}</span>
                    </span>
                    <span className={`text-xs shrink-0 ${status ? "text-green-700 font-medium" : "text-stone-500"}`}>{status ?? "Not registered"}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {price && (
        <Section title="Price">
          <p className="text-xl font-semibold text-stone-900">{price.headline}</p>
          {price.lines.map((l) => <p key={l} className="text-sm text-stone-600 mt-0.5">{l}</p>)}
        </Section>
      )}

      {payLines.length > 0 && (
        <Section title="How and when you pay">
          <ul className="space-y-1.5 text-sm text-stone-700">
            {payLines.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </Section>
      )}

      {(deadline || spots || d.approval) && (
        <Section title="Registration" icon={<Clock className="h-4 w-4" strokeWidth={2} aria-hidden />}>
          <ul className="space-y-1 text-sm text-stone-700">
            {deadline && <li className={deadline.closed ? "text-red-700" : ""}>{deadline.text}</li>}
            {spots && <li>{spots}</li>}
            {d.approval && <li>The club reviews each registration before it&apos;s confirmed.</li>}
          </ul>
        </Section>
      )}

      {(d.audience || d.staff.length > 0) && (
        <Section title="Who it's for">
          {d.audience && <p className="text-sm text-stone-700">{d.audience}</p>}
          {d.staff.length > 0 && (
            <p className="text-sm text-stone-700 mt-1">
              Staff attending: {d.staff.map((s) => s.name).join(", ")}
            </p>
          )}
        </Section>
      )}

      {d.sessions.length > 1 && (
        <Section title={`Sessions (${d.sessions.length})`}>
          <ul className="space-y-1">
            {d.sessions.map((s) => {
              const on = !!picked?.includes(s.id);
              const label = <span className="min-w-0"><span className="text-stone-900">{s.name || "Session"}</span> <span className="text-stone-500">· {sessionWhen(s.startsAt, s.endsAt, d.timezone)}</span></span>;
              return (
                <li key={s.id} className="flex items-center justify-between gap-3 text-sm min-h-11">
                  {picked && s.pickable ? (
                    <label className="flex items-center gap-2 min-w-0 cursor-pointer">
                      <input type="checkbox" checked={on} onChange={() => setPicked((p) => (on ? (p ?? []).filter((x) => x !== s.id) : [...(p ?? []), s.id]))} />
                      {label}
                    </label>
                  ) : label}
                  {s.price != null && s.pickable && <span className="font-semibold text-stone-900 shrink-0">{money(s.price)}</span>}
                </li>
              );
            })}
          </ul>
          {/* Older events price one session with a single drop-in fee instead of per-session prices. */}
          {pickable.length === 0 && d.price.dropIn != null && !blockedReason && d.pricing === "PAID" && (
            <div className="mt-3 pt-3 border-t border-stone-100 flex items-center justify-between gap-3">
              <span className="text-sm text-stone-600">Coming to one session only? <strong className="text-stone-900">{money(d.price.dropIn)}</strong></span>
              <button
                type="button"
                disabled={busy}
                onClick={() => { setMsg(null); flow.start(ev.id, "DROP_IN"); }}
                className="min-h-11 px-4 rounded-lg border border-stone-300 text-stone-800 text-sm font-medium disabled:opacity-50"
              >
                Register for one session
              </button>
            </div>
          )}
          {pickable.length > 0 && !blockedReason && d.pricing === "PAID" && (
            <div className="mt-3 pt-3 border-t border-stone-100 flex items-center justify-between gap-3">
              {picked ? (
                <>
                  <span className="text-sm text-stone-600">{picked.length} picked · <strong className="text-stone-900">{money(pickedTotal)}</strong></span>
                  <button
                    type="button"
                    disabled={busy || picked.length === 0}
                    onClick={() => flow.start(ev.id, "DROP_IN", picked)}
                    className="min-h-11 px-4 rounded-lg bg-stone-900 text-white text-sm font-medium disabled:opacity-50"
                  >
                    Register for these
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setPicked([])} className="min-h-11 text-sm font-medium text-stone-900 underline">
                  Pick single sessions instead
                </button>
              )}
            </div>
          )}
        </Section>
      )}

      {(rosterLabels.length > 0 || d.divisions) && (
        <Section title="Divisions and spots">
          {rosterLabels.length > 0 && <p className="text-sm text-stone-700">You&apos;ll pick a spot in: {rosterLabels.join(", ")}.</p>}
          {d.divisions && <DescriptionText text={d.divisions} className="text-sm text-stone-700 mt-1" />}
        </Section>
      )}

      {d.questions.length > 0 && (
        <Section title="Questions you'll be asked">
          <ul className="space-y-1.5 text-sm text-stone-700">
            {d.questions.map((q, i) => (
              <li key={`${q.label}-${i}`}>
                {q.label}
                {q.required ? <span className="text-stone-500"> (required)</span> : null}
                {q.options.length > 0 && <span className="block text-xs text-stone-500">Choices: {q.options.join(", ")}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {d.documents.length > 0 && (
        <Section title="Documents" icon={<FileText className="h-4 w-4" strokeWidth={2} aria-hidden />}>
          <ul className="space-y-1.5">
            {d.documents.map((doc) => (
              <li key={doc.id} className="flex items-start justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="text-stone-900">{doc.title}</span>
                  <span className="block text-xs text-stone-500">{doc.requirementLabel}</span>
                </span>
                {doc.needsSignature && (
                  <Link href="/member/documents" className="min-h-11 inline-flex items-center text-xs font-medium text-red-700 underline shrink-0">Sign first</Link>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {d.cancellationPolicy && (
        <Section title="Cancellations and refunds" icon={<AlertTriangle className="h-4 w-4" strokeWidth={2} aria-hidden />}>
          <DescriptionText text={d.cancellationPolicy} className="text-sm text-stone-700" />
        </Section>
      )}

      {!blockedReason && d.pricing === "PAID" && (
        <div className="mb-4 flex items-center gap-2">
          <label htmlFor="discount" className="text-xs text-stone-500 flex-shrink-0">Discount code</label>
          <input
            id="discount"
            type="text"
            value={discountCode}
            onChange={(e) => setDiscountCode(e.target.value.toUpperCase())}
            placeholder="Optional"
            className="w-full max-w-xs min-h-11 px-3 border border-stone-300 rounded-lg text-sm font-mono uppercase placeholder:font-sans placeholder:normal-case focus:outline-none focus:ring-2 focus:ring-stone-400"
          />
        </div>
      )}

      {/* The Register bar: sticky above the phone tab bar, inline-feeling on desktop. */}
      <div className="sticky z-30 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:bottom-4 mt-2">
        <div className="bg-white/95 backdrop-blur rounded-xl border border-stone-200 shadow-lg p-3 flex items-center justify-between gap-3">
          <div className="min-w-0 text-sm">
            {blockedReason ? (
              <p className="text-stone-700">{blockedReason}</p>
            ) : (
              <>
                <p className="font-semibold text-stone-900 truncate">{price?.headline ?? ""}</p>
                <p className="text-xs text-stone-500 truncate">{me ? `For ${me.firstName}` : ""}{d.approval ? " · reviewed by the club" : ""}</p>
              </>
            )}
          </div>
          {!blockedReason && (
            <button
              type="button"
              disabled={busy}
              onClick={() => { setMsg(null); flow.start(ev.id); }}
              className="min-h-11 px-5 rounded-lg text-white text-sm font-semibold disabled:opacity-50 pbtn-accent shrink-0"
            >
              {busy ? "Checking…" : registerLabel}
            </button>
          )}
        </div>
      </div>

      {flow.modals}
    </div>
  );
}

export default function MemberEventDetailsPage() {
  return (
    <Suspense fallback={<div className="max-w-2xl mx-auto"><DetailsSkeleton /></div>}>
      <Inner />
    </Suspense>
  );
}
