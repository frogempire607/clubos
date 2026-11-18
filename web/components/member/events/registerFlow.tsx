"use client";

// THE member event register flow — one copy, used by the event details screen
// (app/member/events/[id]) and, for bundles, the Events list. Moved here from
// app/member/events/page.tsx on 2026-11-18 so a second copy can't appear.
//
// Order, every time:
//   1. the event's questions / roster spot (EventFormModal), when it has any
//   2. POST /register WITHOUT `confirmed` — the server checks everything and
//      answers with either a review, a payment choice, or a plain error
//   3. the person confirms on ONE screen: the review sheet, or the payment
//      choice (which shows the athlete, the exact total and when it moves)
//   4. the same POST again WITH `confirmed: true` — only now is anything
//      saved or charged
// Nothing registers or charges on a first tap: the server enforces it
// (scripts/event-details-tests.ts).

import { confirmDialog } from "@/lib/dialogs";
import type { AutoDiscountView } from "@/lib/eventAutoDiscounts";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AccessibleProfile } from "@/components/ProfileSwitcher";
import { eventFormFields, type EventFormField } from "@/lib/eventForm";
import type { SignupRoster } from "@/components/events/SpotPicker";
import EntriesEditor, { entriesPayload, emptyEntry, type EntryDraft } from "@/components/events/EntriesEditor";
import { maxEntriesFor } from "@/lib/eventEntries";
import { memberErrorText } from "@/lib/memberErrorText";
import type { RegisterReview } from "@/lib/eventDetailsView";

/** One event as GET /api/member/events (and /api/member/events/[id]) sends it. */
export type MemberEventCard = {
  externalLinks?: { label: string; url: string }[];
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
  imagePositionX?: number | null;
  imagePositionY?: number | null;
  pricingOptions: { type: string; membershipId?: string }[] | null;
  location: { name: string } | null;
  customEventType: { name: string; color: string; textColor: string } | null;
  sessions: { id: string; name: string | null; startsAt: string; endsAt: string; price?: number | string | null }[];
  sellIndividualSessions?: boolean;
  pricingModel?: string | null;
  _count: { bookings: number };
  autoChargeDate?: string | null;
  registrationForm?: unknown;
  publicFormIntro?: string | null;
  roster?: SignupRoster | null;
  approvalGated?: boolean;
  allowMultipleEntries?: boolean;
  maxEntries?: number | null;
  additionalEntryPrice?: number | string | null;
  allowSameRosterTwice?: boolean;
  entriesOnPublicLink?: boolean;
  autoDiscounts?: AutoDiscountView;
  audienceLabel?: string | null;
};

// The group-rate answer rides in the modal's answers under a key no event
// question can have, and is sent as `groupValue`, not as an answer.
export const GROUP_KEY = "__groupValue";
function stripGroup(a: FormAnswers): FormAnswers {
  const { [GROUP_KEY]: _g, ...rest } = a;
  void _g;
  return rest;
}

type EntryPayload = { rosterId?: string; positionId?: string; answers: Record<string, string | boolean> };
type FormAnswers = Record<string, string | boolean>;
type PricingType = "MEMBER" | "NON_MEMBER" | "DROP_IN";
type Payment = { method: string; consentLabel?: string };

export type FlowMessage = { ok: boolean; text: string };

type ReviewState = RegisterReview & {
  request: { eventId: string; pricingType: PricingType; payment?: Payment; sessionIds?: string[] };
};

export function useEventRegisterFlow(opts: {
  getEvent: (id: string) => MemberEventCard | undefined;
  memberId: string | null;
  setMemberId: (id: string) => void;
  accessible: AccessibleProfile[];
  isActiveMember: boolean;
  discountCode?: string;
  timeZone?: string | null;
  onMessage: (m: FlowMessage | null) => void;
  /** After a registration (or request) is saved: reload what's on screen. */
  onDone: () => void;
}) {
  const { getEvent, memberId, isActiveMember } = opts;
  const [busy, setBusy] = useState<string | null>(null);
  const [myGroupValues, setMyGroupValues] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => {
    fetch("/api/member/group-values").then((r) => (r.ok ? r.json() : null)).then((d) => d && setMyGroupValues(d.values ?? {})).catch(() => undefined);
  }, []);
  const [payPrompt, setPayPrompt] = useState<(PayPromptData & { pricingType?: PricingType; sessionIds?: string[] }) | null>(null);
  const [review, setReview] = useState<ReviewState | null>(null);

  // The event's questions, asked once per athlete per event and re-sent with
  // every retry of that registration, so they're never asked twice.
  const answersRef = useRef<Record<string, FormAnswers>>({});
  const entriesRef = useRef<Record<string, { payload: EntryPayload[]; drafts: EntryDraft[] }>>({});
  const answerKey = (eventId: string) => `${eventId}:${memberId ?? ""}`;
  const [formPrompt, setFormPrompt] = useState<null | {
    eventId: string;
    pricingType: PricingType;
    sessionIds?: string[];
    fields: EventFormField[];
    intro: string | null;
    error?: string;
    initial?: FormAnswers;
    roster?: SignupRoster | null;
    approvalGated?: boolean;
    initialDrafts?: EntryDraft[];
    maxEntries?: number;
    unitPriceCents?: number | null;
    additionalCents?: number | null;
    allowSameRosterTwice?: boolean;
    group?: { label: string; options: string[] } | null;
  }>(null);

  const say = (ok: boolean, text: string) => opts.onMessage({ ok, text });

  async function register(
    eventId: string,
    pricingType: PricingType = "MEMBER",
    payment?: Payment,
    acknowledgeDocuments?: boolean,
    sessionIds?: string[],
    confirmed?: boolean,
  ) {
    const ev = getEvent(eventId);
    const fields = eventFormFields(ev?.registrationForm);
    const answers = answersRef.current[answerKey(eventId)];
    const built = entriesRef.current[answerKey(eventId)];
    const needsEntries = !!ev?.roster || fields.some((f) => f.perEntry);
    const promptExtras = () => ({
      roster: ev?.roster ?? null,
      approvalGated: !!ev?.approvalGated,
      initialDrafts: built?.drafts,
      maxEntries: ev ? maxEntriesFor({
        allowMultipleEntries: !!ev.allowMultipleEntries, maxEntries: ev.maxEntries ?? null,
        allowSameRosterTwice: !!ev.allowSameRosterTwice, entriesOnPublicLink: !!ev.entriesOnPublicLink,
      }, "PORTAL") : 1,
      unitPriceCents: (() => {
        const p = isActiveMember ? ev?.memberPrice ?? ev?.nonMemberPrice : ev?.nonMemberPrice ?? ev?.memberPrice;
        return p == null ? null : Math.round(Number(p) * 100);
      })(),
      additionalCents: ev?.additionalEntryPrice != null ? Math.round(Number(ev.additionalEntryPrice) * 100) : null,
      allowSameRosterTwice: !!ev?.allowSameRosterTwice,
      group: ev?.autoDiscounts?.group ?? null,
    });
    const asksGroup = !!ev?.autoDiscounts?.group;
    if (((fields.some((f) => !f.perEntry) || asksGroup) && !answers) || (needsEntries && !built)) {
      // An event group rate copied from a club group: pre-fill the athlete's answer from their profile.
      const rateId = ev?.autoDiscounts?.group?.clubRateId;
      const known = rateId && memberId ? myGroupValues[memberId]?.[rateId] : undefined;
      const initial = answers ?? (known ? { [GROUP_KEY]: known } : undefined);
      setFormPrompt({ eventId, pricingType, sessionIds, fields, intro: ev?.publicFormIntro ?? null, initial, ...promptExtras() });
      return;
    }
    setBusy(eventId);
    opts.onMessage(null);
    let res: Response;
    try {
      res = await fetch(`/api/member/events/${eventId}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pricingType,
          ...(sessionIds && sessionIds.length ? { sessionIds } : {}),
          memberId,
          discountCode: opts.discountCode?.trim() || null,
          ...(payment ? { paymentMethod: payment.method } : {}),
          // AUTO_CARD and APPROVAL_CHARGE carry the exact words the person
          // agreed to, as an audited snapshot.
          ...(payment?.method === "AUTO_CARD" || payment?.method === "APPROVAL_CHARGE"
            ? { autoChargeConsent: { agreed: true, buttonLabel: payment.consentLabel } }
            : {}),
          ...(acknowledgeDocuments ? { acknowledgeDocuments: true } : {}),
          ...(answers ? { formResponses: stripGroup(answers) } : {}),
          ...(answers && typeof answers[GROUP_KEY] === "string" && answers[GROUP_KEY] ? { groupValue: answers[GROUP_KEY] } : {}),
          ...(built && built.payload.length > 0 ? { entries: built.payload } : {}),
          ...(confirmed ? { confirmed: true } : {}),
        }),
      });
    } catch {
      setBusy(null);
      say(false, "Could not reach the server. Check your connection and try again.");
      return;
    }
    const d = await res.json().catch(() => ({}));
    setBusy(null);

    // Step 3: the server's review. Nothing has been saved.
    if (res.ok && d.review === true) {
      setReview({ ...(d as RegisterReview), request: { eventId, pricingType, payment, sessionIds } });
      return;
    }
    if (res.status === 409 && (d.error === "SPOT_FULL" || d.error === "UNKNOWN_SPOT")) {
      delete entriesRef.current[answerKey(eventId)];
      say(false, memberErrorText(d, "That spot isn't available any more. Pick another."));
      opts.onDone();
      return;
    }
    if (res.status === 400 && (d.error === "FORM_REQUIRED" || d.error === "FORM_INVALID" || d.error === "ROSTER_REQUIRED" || d.error === "ENTRIES_INVALID")) {
      setFormPrompt({
        eventId,
        pricingType,
        sessionIds,
        fields: d.fields ? eventFormFields(d.fields) : fields,
        intro: d.intro ?? ev?.publicFormIntro ?? null,
        error: d.error === "FORM_REQUIRED" ? undefined : memberErrorText(d, "Check the answers and try again."),
        initial: answers,
        ...promptExtras(),
      });
      delete answersRef.current[answerKey(eventId)];
      delete entriesRef.current[answerKey(eventId)];
      return;
    }
    // More than one way to pay: the choice screen is also the confirm step.
    if (res.status === 400 && d.error === "PAYMENT_METHOD_REQUIRED") {
      setPayPrompt({
        kind: "event",
        eventId,
        pricingType,
        sessionIds,
        athleteName: (opts.accessible.find((a) => a.id === memberId) ?? opts.accessible[0])?.firstName ?? null,
        options: d.options ?? [],
        quote: d.quote ?? null,
        savedCard: d.savedCard ?? null,
        documents: d.documents ?? [],
        requiresCoachApproval: !!d.requiresCoachApproval,
      });
      return;
    }
    if (res.status === 400 && d.error === "DOCUMENTS_ACKNOWLEDGE_REQUIRED") {
      const titles = (d.documents ?? []).map((x: { title: string }) => x.title).join(", ");
      if (await confirmDialog(`This event requires acknowledging: ${titles}. Acknowledge and continue?`)) {
        register(eventId, pricingType, payment, true, sessionIds, confirmed);
      }
      return;
    }
    if (res.status === 402 && d.error === "PAYMENT_SETUP_REQUIRED") {
      say(false, `${memberErrorText(d, "A saved card is needed for this event.")} Add one under Profile → Payment & billing.`);
      return;
    }
    if (!res.ok) { say(false, memberErrorText(d, "Could not register. Please try again.")); return; }

    // Saved. Every outcome below happened only after a confirm.
    if (d.pendingApproval) { say(true, memberErrorText({ message: d.message }, "Sent to your guardian for approval.")); opts.onDone(); return; }
    if (d.pendingReview) { say(true, memberErrorText({ message: d.message }, "Request sent to your coach.")); opts.onDone(); return; }
    if (d.coveredByMembership) {
      say(true, d.status === "WAITLISTED" ? "On the waitlist, covered by the membership." : "Registered, covered by the membership.");
      opts.onDone();
      return;
    }
    if (d.variableCost) {
      const each = d.perHead != null ? ` The estimated share is about $${Number(d.perHead).toFixed(2)}.` : "";
      say(true, `${d.status === "WAITLISTED" ? "On the waitlist. " : "Registered. "}The club will send an invoice for this event's shared cost.${each}`);
      opts.onDone();
      return;
    }
    if (d.scheduled) {
      say(true, `${d.status === "WAITLISTED" ? "On the waitlist. " : "Registered. "}The card will be charged $${Number(d.amountDue).toFixed(2)} on ${new Date(d.chargeOn).toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" })}.`);
      opts.onDone();
      return;
    }
    if (d.offline || d.free || d.paid) {
      say(true, memberErrorText({ message: d.message }, d.status === "WAITLISTED" ? "On the waitlist." : "Registered."));
      opts.onDone();
      return;
    }
    if (d.url) { window.location.href = d.url; return; }
    say(true, "Registered.");
    opts.onDone();
  }

  /** Start registering: questions first if the event has any, then the review. */
  function start(eventId: string, pricingType: PricingType = "MEMBER", sessionIds?: string[]) {
    void register(eventId, pricingType, undefined, undefined, sessionIds);
  }

  const modals = (
    <>
      {formPrompt && (
        <EventFormModal
          prompt={formPrompt}
          eventName={getEvent(formPrompt.eventId)?.name ?? "Event"}
          accessible={opts.accessible}
          memberId={memberId}
          onMemberChange={opts.setMemberId}
          onClose={() => setFormPrompt(null)}
          onSubmit={(answers, built) => {
            const p = formPrompt;
            answersRef.current[answerKey(p.eventId)] = answers;
            if (built) entriesRef.current[answerKey(p.eventId)] = built;
            setFormPrompt(null);
            void register(p.eventId, p.pricingType, undefined, undefined, p.sessionIds);
          }}
        />
      )}
      {payPrompt && (
        <PaymentChoiceModal
          prompt={payPrompt}
          event={payPrompt.eventId ? (getEvent(payPrompt.eventId) ?? null) : null}
          onClose={() => setPayPrompt(null)}
          onChoose={(method, consentLabel, acknowledged) => {
            const p = payPrompt;
            setPayPrompt(null);
            // The choice screen showed the athlete, the exact total and when it
            // moves: choosing IS the confirm.
            if (p.eventId) void register(p.eventId, p.pricingType ?? "MEMBER", { method, consentLabel }, acknowledged, p.sessionIds, true);
          }}
        />
      )}
      {review && (
        <ReviewSheet
          review={review}
          busy={busy === review.request.eventId}
          onClose={() => setReview(null)}
          onConfirm={(consentLabel) => {
            const r = review;
            setReview(null);
            const payment = r.method ? { method: r.method, consentLabel: consentLabel ?? r.request.payment?.consentLabel } : r.request.payment;
            void register(r.request.eventId, r.request.pricingType, payment, r.acknowledge.length > 0, r.request.sessionIds, true);
          }}
        />
      )}
    </>
  );

  return { start, busy, modals };
}

// ── The review: one screen, one button ─────────────────────────────────────

const money = (n: number) => `$${n.toFixed(2)}`;

export function ReviewSheet({
  review,
  busy,
  onClose,
  onConfirm,
}: {
  review: RegisterReview;
  busy: boolean;
  onClose: () => void;
  onConfirm: (consentLabel?: string) => void;
}) {
  const needsConsent = review.method === "AUTO_CARD" || review.method === "APPROVAL_CHARGE";
  const [consented, setConsented] = useState(false);
  const a = review.amount;
  const showCard = !!a && (review.method === "CARD" || review.method === "SAVED_CARD" || review.method === "AUTO_CARD" || review.method === "APPROVAL_CHARGE");
  const consentLabel = needsConsent && a ? `I authorize this charge of ${money(a.cardTotal)}. ${review.timing}` : undefined;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" role="dialog" aria-modal="true" aria-labelledby="review-title">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md border border-stone-200 max-h-[90dvh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id="review-title" className="text-base font-semibold text-stone-900">Check and confirm</h2>
            <p className="text-xs text-stone-500 truncate">{review.event.name}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="min-h-11 min-w-11 text-stone-400 hover:text-stone-700 text-xl leading-none">×</button>
        </div>
        <dl className="px-5 py-4 space-y-3 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-stone-500">Registering</dt>
            <dd className="font-medium text-stone-900 text-right">{review.athlete.name}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-stone-500">Price</dt>
            <dd className="font-medium text-stone-900 text-right">
              {review.pricing === "FREE" ? "Free" : review.pricing === "COVERED" ? "Included in membership" : review.pricing === "SPLIT" ? "Shared cost, billed later" : a ? money(showCard ? a.cardTotal : a.due) : "—"}
              {a && a.discountLabel && <span className="block text-xs font-normal text-emerald-700">{a.discountLabel} · was {money(a.gross)}</span>}
              {a && showCard && a.cardFee > 0 && <span className="block text-xs font-normal text-stone-500">includes {money(a.cardFee)} processing fee</span>}
            </dd>
          </div>
          <div>
            <dt className="text-stone-500 mb-0.5">When and how you pay</dt>
            <dd className="text-stone-900">{review.timing}</dd>
          </div>
          {review.acknowledge.length > 0 && (
            <div>
              <dt className="text-stone-500 mb-0.5">By confirming you acknowledge</dt>
              <dd className="text-stone-900">{review.acknowledge.map((d) => d.title).join(", ")}</dd>
            </div>
          )}
        </dl>
        <div className="px-5 pb-5 space-y-2">
          {needsConsent && (
            <label className="flex items-start gap-2.5 p-3 rounded-lg bg-stone-50 border border-stone-200 cursor-pointer">
              <input type="checkbox" checked={consented} onChange={(e) => setConsented(e.target.checked)} className="mt-0.5" />
              <span className="text-xs text-stone-700">{consentLabel}</span>
            </label>
          )}
          <button
            type="button"
            disabled={busy || (needsConsent && !consented)}
            onClick={() => onConfirm(consentLabel)}
            className="w-full min-h-11 py-2.5 rounded-lg text-white text-sm font-semibold disabled:opacity-40 pbtn-accent"
          >
            {busy ? "Working…" : review.confirmLabel}
          </button>
          <button type="button" onClick={onClose} className="w-full min-h-11 py-2 text-sm text-stone-600 hover:text-stone-900">
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}

// Asks how the member wants to pay for an event or bundle. `options` comes
// from the server, which already decided what this member can actually
// complete (saved-card options only appear with a verified card on file).
// Exact totals come from the server quote; documents attached to the event(s)
// are shown for review — unsigned SIGN_REQUIRED docs block confirming.
export type PayPromptData = {
  /** The athlete being registered, named on the confirm screen. */
  athleteName?: string | null;
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

export function PaymentChoiceModal({
  prompt,
  event,
  onClose,
  onChoose,
}: {
  prompt: PayPromptData;
  event: MemberEventCard | null;
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
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md border border-stone-200 max-h-[90dvh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-stone-900">
              {prompt.requiresCoachApproval ? "How would you pay if approved?" : "How would you like to pay?"}
            </h2>
            {event && <p className="text-xs text-stone-500 truncate">{event.name}</p>}
            {prompt.athleteName && <p className="text-xs text-stone-700 truncate">Registering {prompt.athleteName}</p>}
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
                      <p className="text-[12px] text-stone-500">
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
                      <Link href="/member/documents" className="text-[12px] text-red-600 hover:underline whitespace-nowrap mt-0.5">
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
                <p className="text-[12px] text-stone-500 mt-1.5">
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
export function EventFormModal({
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
    initialDrafts?: EntryDraft[];
    maxEntries?: number;
    unitPriceCents?: number | null;
    additionalCents?: number | null;
    allowSameRosterTwice?: boolean;
    group?: { label: string; options: string[] } | null;
  };
  eventName: string;
  accessible: AccessibleProfile[];
  memberId: string | null;
  onMemberChange: (id: string) => void;
  onClose: () => void;
  onSubmit: (answers: FormAnswers, built: { payload: EntryPayload[]; drafts: EntryDraft[] } | null) => void;
}) {
  const [answers, setAnswers] = useState<FormAnswers>(prompt.initial ?? {});
  const [drafts, setDrafts] = useState<EntryDraft[]>(prompt.initialDrafts ?? [emptyEntry()]);
  const perEntryFields = prompt.fields.filter((f) => f.perEntry);
  const onceFields = prompt.fields.filter((f) => !f.perEntry);
  const [err, setErr] = useState(prompt.error ?? "");
  const who = accessible.find((a) => a.id === memberId) ?? accessible[0] ?? null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    for (const f of onceFields) {
      const v = answers[f.id];
      if (f.required && (v === undefined || v === "" || v === false)) {
        setErr(`"${f.label}" is required`);
        return;
      }
    }
    const built = entriesPayload(drafts, {
      roster: prompt.roster ?? null,
      perEntryFields,
      allowSameRosterTwice: !!prompt.allowSameRosterTwice,
    });
    if (!built.ok) {
      setErr(built.message);
      return;
    }
    onSubmit(answers, built.entries.length > 0 ? { payload: built.entries, drafts } : null);
  }

  const inputCls = "w-full px-3 py-2.5 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-300";

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <form onSubmit={submit} className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md border border-stone-200 max-h-[90dvh] overflow-y-auto">
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
          <EntriesEditor
            value={drafts}
            onChange={(v) => { setDrafts(v); setErr(""); }}
            roster={prompt.roster ?? null}
            perEntryFields={perEntryFields}
            maxEntries={prompt.maxEntries ?? 1}
            athleteName={who?.firstName ?? null}
            approvalGated={!!prompt.approvalGated}
            unitPriceCents={prompt.unitPriceCents ?? null}
            additionalCents={prompt.additionalCents ?? null}
          />
          {onceFields.map((f) => (
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
          {prompt.group && (
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">{prompt.group.label}</label>
              {prompt.group.options.length > 0 ? (
                <select
                  value={(answers[GROUP_KEY] as string) || ""}
                  onChange={(e) => { setAnswers((a) => ({ ...a, [GROUP_KEY]: e.target.value })); setErr(""); }}
                  className={inputCls}
                >
                  <option value="">None / not listed</option>
                  {prompt.group.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input
                  type="text"
                  maxLength={80}
                  value={(answers[GROUP_KEY] as string) || ""}
                  onChange={(e) => { setAnswers((a) => ({ ...a, [GROUP_KEY]: e.target.value })); setErr(""); }}
                  className={inputCls}
                />
              )}
              <p className="text-xs text-stone-500 mt-1">Used for the group rate. Leave blank if it doesn&apos;t apply.</p>
            </div>
          )}
          {err && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
          <button type="submit" className="w-full py-3 rounded-lg bg-stone-900 text-white text-sm font-semibold">
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}
