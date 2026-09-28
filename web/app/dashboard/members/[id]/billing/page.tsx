"use client";

// Migration setup — what replaced "Advanced billing" (2026-09-28).
//
// The old page mixed a MIGRATION SETUP (a draft of what an imported member
// will be billed once they activate — saving it changes nothing live) with
// live billing controls, and staff could not tell them apart: Sal set Blake's
// "Payment method" to Cash in the setup form because the dad paid cash, and
// Stripe kept charging, as it should.
//
// So every day-to-day billing action now lives in the Membership panel on the
// profile (and payment methods + Stripe details in PaymentMethodsCard beside
// it). This page keeps ONLY the migration pieces — the setup draft and its
// activation, the reactivation offer, triage, cancelling a pending activation,
// and the billing & migration history — and ONLY for members whose migration
// is not finished. Everyone else, and every live-billing deep link, is sent to
// the profile's Memberships tab (lib/migrationSetup billingPageDecision).
//
// Once ANY membership is live the setup form is not rendered at all — no
// payment-method, plan or price fields — just one line pointing at the panel.
// Permission: billing:view to see, billing:full to change (owners always pass).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { feeBreakdown } from "@/lib/fees";
import StaffDiscountPicker, { previewDiscountMath, useEligibleDiscounts } from "@/components/StaffDiscountPicker";
import EnrollAlreadyPaidCard from "@/components/EnrollAlreadyPaidCard";
import PaymentMethodsCard from "@/components/members/PaymentMethodsCard";
import PageHeader from "@/components/PageHeader";
import Sheet from "@/components/Sheet";
import {
  billingIsLive,
  billingPageDecision,
  membershipPanelHref,
  migrationSetupSections,
  LIVE_BILLING_NOTICE,
  PASS_THROUGH_KEYS,
} from "@/lib/migrationSetup";

type PaymentMethod = {
  ref: string;
  type: "card" | "link";
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  cardholder: string | null;
  linkEmail: string | null;
  isDefault: boolean;
  customerRole: "SETUP" | "LEGACY";
  customerName: string | null;
  customerEmail: string | null;
  backsLiveSubscription: boolean;
  isCapturedForActivation: boolean;
};

type Data = {
  member: {
    id: string; firstName: string; lastName: string; isMinor: boolean; status: string;
    email: string | null; phone: string | null; guardianName: string | null; guardianEmail: string | null;
  };
  guardians: { userId: string; name: string; email: string; relationship: string | null; isPayer: boolean }[];
  payer: { userId: string; name: string; email: string } | null;
  billingState: { key: string; label: string; explanation: string };
  hasPendingCharge: boolean;
  anchorMismatch: boolean;
  // Club rule for CASH/CHECK offers: ON_PAYMENT (default) = activates only
  // when staff records the money; ON_ACCEPTANCE = activates on acceptance.
  offlineActivationPolicy?: "ON_PAYMENT" | "ON_ACCEPTANCE";
  // What the customer is actually charged when the club passes the Stripe
  // processing fee (computed server-side from the effective price).
  feeBreakdown?: { passFees: boolean; feePercentLabel: string; base: number; fee: number; totalCharged: number };
  billing: {
    // FALSE ⇒ this member has NO membership configured: planName/optionLabel/
    // price/period/periodLabel are null and the fee breakdown is zeroed.
    // UIs must show "No membership" (never "Free") and block offer creation.
    configured: boolean;
    planId: string | null; planName: string | null; optionLabel: string | null;
    price: number | null; period: string | null; periodLabel: string | null;
    priceOverride: number | null; discountNote: string | null;
    // Staff-selected discount code for the staged offer (dropdown-picked).
    discountCode: string | null;
    startDate: string | null; billingAnchorDate: string | null; finalBillingDate: string | null;
    nextBillingDate: string | null; commitmentEndDate: string | null;
    requestedPaymentMethod: string | null; finalPeriodPaid: boolean;
    lastPayment: { amount: number; at: string } | null;
    stripeStatus: string | null;
    chargeTiming: { immediate: boolean; label: string };
    legacy: { name: string | null; price: number | null; frequency: string | null; source: string | null };
  };
  subscriptions: {
    id: string; optionId: string | null; membershipId: string | null; minimumTermEndsAt: string | null;
    optionLabel: string; price: number; billingPeriod: string | null; billingType: string;
    status: string; stripeStatus: string | null; hasStripe: boolean;
    startDate: string | null; endDate: string | null; billingAnchorDate: string | null;
    currentPeriodEnd: string | null; cancelAt: string | null;
    card: { brand?: string; last4?: string } | null;
    lastPayment: { amount: number; at: string } | null;
    notes: string | null; autoRenew: boolean; deliberateFree: boolean; createdAt: string;
  }[];
  // The one owner-side action that turns the saved setup into a membership.
  activation: {
    available: boolean; reason: string | null;
    // CARD ⇒ charge the saved card (Stripe subscription); OFFLINE ⇒ record cash/check.
    mode: "CARD" | "OFFLINE"; hasCard: boolean;
    optionId: string | null; amount: number | null; coversUntil: string | null; draftLabel: string | null;
  };
  paymentMethods: PaymentMethod[];
  stripeReadError: boolean;
  hasSetupCustomer: boolean;
  hasCapturedCard: boolean;
  migration: {
    migrationStatus: string | null; approvalStatus: string | null; paymentSetupStatus: string | null;
    group: string | null; finalAction: string | null; groupNote: string | null;
    activationEmailSentAt: string | null; activationEmailSendCount: number;
    requestedBillingDate: string | null; requestedBillingNote: string | null; activationNote: string | null;
  };
  reactivation: {
    id: string; status: string; offerVersion: number; offer: {
      planName?: string; optionLabel?: string | null; price?: number; billingPeriod?: string;
      startDate?: string | null; firstChargeDate?: string | null; commitmentEndDate?: string | null;
      paymentMode?: string; payerUserId?: string | null;
      // Frozen staff selections (snapshot fields — see lib/reactivation.ts).
      paymentMethod?: "SAVED_CARD" | "NEW_CARD" | "CASH" | "CHECK" | null;
      discount?: { code: string; name: string; type: string; value: number; amountOff: number; finalPrice: number } | null;
    };
    personalNote: string | null; emailSentAt: string | null; emailSendCount: number;
    sentToEmail: string | null; viewedAt: string | null; confirmedAt: string | null;
    consent: Record<string, unknown> | null; tokenExpires: string; createdAt: string; updatedAt: string;
    open: boolean; sync: { matches: boolean; changed: string[] } | null; url: string | null;
    changeRequest?: { fields?: Record<string, string | null>; note?: string | null } | null;
    changeRequestStatus?: string | null; changeRequestAt?: string | null;
  } | null;
  readiness: { state: string; label: string; reasons: string[] };
  lastChangedBy: { name: string; at: string } | null;
  history: { at: string; kind: string; action: string; message: string | null; actorName: string | null; before: unknown; after: unknown }[];
  plans: {
    id: string; name: string; contractMonths: number | null; autoRenewDefault: boolean;
    options: { id: string | null; label: string; price: number; billingPeriod: string; contractMonths: number | null; autoRenewDefault: boolean | null }[];
  }[];
};
const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
// Billing DATES (anchor / final / commitment / start) are date-only values
// pinned to 00:00 UTC — render them in UTC or they show as the previous day
// in US timezones and appear to contradict the date inputs.
const fmtDateUTC = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";
const fmtMoney = (n: number) => `$${n.toFixed(2)}`;
const dateInput = (s: string | null | undefined) => (s ? new Date(s).toISOString().slice(0, 10) : "");

// Staff payment-method preference (member.requestedPaymentMethod) — shared
// vocabulary with the PATCH's paymentMethodPreference. null = saved card.
const PM_PREF_LABELS: Record<string, string> = {
  CARD: "Saved card",
  LATER: "New card (client adds)",
  CASH: "Cash — club collects",
  CHECK: "Check — club collects",
};
const pmPrefLabel = (v: string | null | undefined) => (v && PM_PREF_LABELS[v]) || "Saved card (default)";
const OFFER_METHOD_LABELS: Record<string, string> = {
  SAVED_CARD: "Saved card at confirmation",
  NEW_CARD: "New card (client adds on the offer page)",
  CASH: "Cash — club collects",
  CHECK: "Check — club collects",
};
const offlineRuleLabel = (policy: string | undefined) =>
  policy === "ON_ACCEPTANCE"
    ? "Cash/check rule: the membership activates on acceptance (payment still due to the club)."
    : "Cash/check rule: the membership activates only after staff records the payment as received.";

const READINESS_CLASS: Record<string, string> = {
  READY: "bg-lime-accent/25 text-text-primary",
  WAITING_OWNER: "bg-[var(--color-warn-surface)] text-[var(--color-warn-text)]",
  WAITING_CLIENT: "bg-brand/10 text-brand",
  HOLD: "bg-red-50 text-red-700",
  LEAVE_ALONE: "bg-app-bg text-text-muted",
};

function Card({ title, action, children, className = "" }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-surface border border-app-border rounded-xl p-5 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children, strong = false }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="text-xs text-text-muted whitespace-nowrap pt-0.5">{label}</span>
      <span className={`text-sm text-right ${strong ? "font-semibold text-text-primary" : "text-text-primary"}`}>{children}</span>
    </div>
  );
}

// "SIBLING — $50.00 off → final $480.00 quarterly" for the pricing card.
// Resolves the stored code against the eligible-discount list; the math shown
// is a display preview — the server recomputes at offer build / charge time.
function DiscountSummaryRow({ code, planId, price, periodLabel }: { code: string; planId: string | null; price: number | null; periodLabel: string | null }) {
  const { discounts } = useEligibleDiscounts("MEMBERSHIP", planId);
  const d = discounts?.find((x) => x.code === code) ?? null;
  if (!d || price == null) return <Row label="Discount"><span className="font-mono">{code}</span></Row>;
  const math = previewDiscountMath(d, price);
  return (
    <Row label="Discount" strong>
      {d.code} — {d.type === "PERCENT" ? `${d.value}% off` : `${fmtMoney(math.amountOff)} off`} → final {fmtMoney(math.finalPrice)}{periodLabel ? ` ${periodLabel}` : ""}
      {!d.eligible && <span className="block text-xs font-normal text-orange-accent">{d.reason || "No longer eligible"} — offers can&apos;t be created until this is fixed or cleared.</span>}
    </Row>
  );
}

export default function MigrationSetupPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const search = useSearchParams();
  const router = useRouter();
  const [data, setData] = useState<Data | null>(null);
  const [facts, setFacts] = useState<{ migrating: boolean; live: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);
  const [enrolSignal, setEnrolSignal] = useState(0);
  const [cardActivateOpen, setCardActivateOpen] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      fetch(`/api/members/${id}/billing-admin`).then(async (r) => {
        if (r.status === 403) { setForbidden(true); return null; }
        return r.ok ? r.json() : null;
      }),
      fetch(`/api/members/${id}/billing-details`).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([d, det]) => {
        setData(d);
        if (det) setFacts({ migrating: !!det.migration?.inProgress, live: !!det.live });
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  // Old links, bookmarks and deep links (?changePlan=, ?enrol=1) from before
  // this page was retired: anyone who is not mid-migration — and any live
  // billing action — belongs on the Membership panel.
  const live = data ? billingIsLive(data.subscriptions) || !!facts?.live : false;
  const decision = facts
    ? billingPageDecision({
        memberId: id,
        migrating: facts.migrating,
        live,
        query: Object.fromEntries(PASS_THROUGH_KEYS.map((k) => [k, search.get(k)])),
      })
    : null;
  useEffect(() => {
    if (decision?.kind === "REDIRECT") router.replace(decision.to);
  }, [decision?.kind, decision && decision.kind === "REDIRECT" ? decision.to : null, router]); // eslint-disable-line react-hooks/exhaustive-deps

  // /billing?enrol=1 — "Record payment" lands on the open form (setup not yet live).
  useEffect(() => {
    if (search.get("enrol") && data) setEnrolSignal((n) => (n === 0 ? 1 : n));
  }, [search, data]);

  if (loading || decision?.kind === "REDIRECT") return <div className="p-8 text-center text-text-muted text-sm">Loading…</div>;
  if (forbidden)
    return (
      <div className="p-8 max-w-xl mx-auto text-center">
        <p className="text-sm text-text-muted">
          You don&apos;t have billing-management access. Ask the club owner to grant the
          <strong> Billing management</strong> permission on your staff profile.
        </p>
      </div>
    );
  if (!data) return <div className="p-8 text-center text-text-muted text-sm">Member not found.</div>;

  const m = data.member;
  const b = data.billing;
  const panelHref = membershipPanelHref(id);
  const pendingActivation =
    data.migration.approvalStatus === "PENDING_APPROVAL" ||
    data.migration.migrationStatus === "INVITED" ||
    data.migration.migrationStatus === "ACTIVATED";
  const show = migrationSetupSections({
    live,
    activationAvailable: data.activation.available,
    pendingActivation,
    hasReactivationOffer: !!data.reactivation,
  });

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <Link href={`/dashboard/members/${id}`} className="inline-flex min-h-[44px] items-center gap-1 text-sm text-text-muted hover:text-text-primary md:min-h-0">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Back to profile
      </Link>

      <div className="mt-3">
        <PageHeader
          eyebrow={`${m.firstName} ${m.lastName}`}
          title="Migration setup"
          description={
            show.liveNotice
              ? "What this member was set up with when they moved over, their offer and the migration history."
              : "What this member will be billed once they finish moving over. Saving here never charges anyone."
          }
          actions={
            <button type="button" onClick={() => load()} className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-app-border px-3 text-xs text-text-muted hover:text-text-primary md:min-h-[36px]">
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
          }
        />
        <div className="-mt-3 mb-5 flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${READINESS_CLASS[data.readiness.state] ?? READINESS_CLASS.LEAVE_ALONE}`} title={data.readiness.reasons.join("; ") || undefined}>
            {data.readiness.label}
          </span>
          {m.isMinor && <span className="rounded-full bg-app-bg px-2 py-0.5 text-xs text-text-muted">Minor</span>}
          {data.lastChangedBy && (
            <span className="text-xs text-text-muted">Setup last changed by {data.lastChangedBy.name} on {fmtDate(data.lastChangedBy.at)}</span>
          )}
        </div>
      </div>

      {msg && (
        <div className="mb-4 flex justify-between gap-3 rounded-lg border border-app-border bg-lime-accent/20 px-3 py-2 text-sm text-text-primary">
          <span>{msg}</span>
          <button type="button" className="inline-flex min-h-[44px] items-center text-xs text-text-muted md:min-h-0" onClick={() => setMsg(null)}>Dismiss</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ── Billing is live: the setup form is gone, not merely disabled ── */}
        {show.liveNotice && (
          <div className="lg:col-span-2 rounded-xl border border-app-border bg-app-bg px-4 py-3">
            <Link href={panelHref} className="inline-flex min-h-[44px] items-center text-sm font-medium text-brand hover:underline">
              {LIVE_BILLING_NOTICE}
            </Link>
          </div>
        )}

        {/* ── Migration setup (draft) ── */}
        {show.setupEdit && (
          <Card
            title="Migration setup"
            className="lg:col-span-2"
            action={<button type="button" onClick={() => setEditOpen(true)} className="inline-flex min-h-[44px] items-center text-xs text-brand hover:underline md:min-h-0">Edit setup</button>}
          >
            {b.configured ? (
              <>
                <Row label="Plan" strong>{b.planName}{b.optionLabel ? ` · ${b.optionLabel}` : ""}</Row>
                <Row label="Price" strong>{(b.price ?? 0) <= 0 ? "Free" : `${fmtMoney(b.price ?? 0)} ${b.periodLabel ?? ""}`}</Row>
                {data.feeBreakdown?.passFees && (b.price ?? 0) > 0 && (
                  <Row label="Total charged" strong>
                    {fmtMoney(data.feeBreakdown.totalCharged)} {b.periodLabel} (includes {fmtMoney(data.feeBreakdown.fee)} {data.feeBreakdown.feePercentLabel} processing fee)
                  </Row>
                )}
              </>
            ) : (
              <div className="py-1">
                <Row label="Plan" strong><span className="font-normal text-text-muted">No membership</span></Row>
                <p className="mt-1 text-xs text-text-muted">
                  No membership in the setup yet. Pick a plan in Edit setup, or set an explicit $0 price to make them deliberately free.
                </p>
              </div>
            )}
            {b.priceOverride != null && (
              <Row label="Owner price override">{fmtMoney(b.priceOverride)}{b.discountNote ? ` — ${b.discountNote}` : ""}</Row>
            )}
            {b.discountCode && (
              <DiscountSummaryRow code={b.discountCode} planId={b.planId} price={b.price} periodLabel={b.periodLabel} />
            )}
            <Row label="Will pay by">{pmPrefLabel(b.requestedPaymentMethod)}</Row>
            <Row label="Responsible payer">
              {data.payer ? `${data.payer.name} (${data.payer.email})` : <span className="text-text-muted">Implied — card owner / guardian on file</span>}
            </Row>
            <Row label="Membership start">{fmtDateUTC(b.startDate)}</Row>
            <Row label="Imported billing anchor">{fmtDateUTC(b.billingAnchorDate)}</Row>
            <Row label="Owner-approved final billing date">
              {b.finalBillingDate ? fmtDateUTC(b.finalBillingDate) : <span className="font-medium text-[var(--color-warn-text)]">Not set</span>}
            </Row>
            {data.anchorMismatch && (
              <p className="mt-1 text-xs text-[var(--color-warn-text)]">
                The final billing date differs from the imported anchor — the final date is what activation uses.
              </p>
            )}
            {b.commitmentEndDate && <Row label="Commitment through">{fmtDateUTC(b.commitmentEndDate)}</Row>}
            {b.finalPeriodPaid && <Row label="Final period">Already paid — non-renewing</Row>}
            {b.legacy.name && (
              <p className="mt-2 border-t border-app-border pt-2 text-xs text-text-muted">
                Imported from {b.legacy.source || "previous software"}: {b.legacy.name}
                {b.legacy.price != null ? ` · $${b.legacy.price}` : ""}{b.legacy.frequency ? ` ${b.legacy.frequency.toLowerCase()}` : ""}
              </p>
            )}
            {b.configured && (
              <p className="mt-2 border-t border-app-border pt-2 text-xs text-text-muted">
                If this setup were activated now it {b.chargeTiming.immediate
                  ? <strong className="text-[var(--color-warn-text)]">would charge immediately</strong>
                  : <>would first charge on <strong className="text-text-primary">{fmtDateUTC(b.finalBillingDate || b.billingAnchorDate)}</strong></>}.
              </p>
            )}
            {show.activate && (
              <div className="mt-3 border-t border-app-border pt-3">
                {data.activation.mode === "CARD" ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setCardActivateOpen(true)}
                      disabled={!data.activation.hasCard}
                      className="inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-brand px-4 text-sm text-white hover:bg-brand-hover disabled:opacity-50 sm:w-auto"
                    >
                      Activate this setup now
                    </button>
                    <p className="mt-1.5 text-xs text-text-muted">
                      {data.activation.hasCard
                        ? `Starts the membership above on the saved card — ${b.chargeTiming.immediate ? "charged today" : `first charge ${fmtDateUTC(b.finalBillingDate || b.billingAnchorDate)}`}. You confirm the amount and date first.`
                        : "No saved card on file. Use “Add method” below to collect one, or set the setup to cash/check in Edit setup and record it with “Already paid?”."}
                    </p>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setEnrolSignal((n) => n + 1)}
                      className="inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-brand px-4 text-sm text-white hover:bg-brand-hover sm:w-auto"
                    >
                      Activate this setup now
                    </button>
                    <p className="mt-1.5 text-xs text-text-muted">
                      Records the cash/check payment and starts the membership on the plan above. Nothing above is a membership until this is done.
                    </p>
                  </>
                )}
              </div>
            )}
            <p className="mt-2 text-xs text-text-muted">
              <strong className="text-text-primary">Edit setup only saves a draft — it does not start or change a membership.</strong>{" "}
              The setup becomes a membership when the client confirms a reactivation offer, or when you
              {show.activate ? " activate it above" : " use “Already paid?” below"}.
              {data.activation.reason && !data.activation.available && ` ${data.activation.reason}`}
            </p>
          </Card>
        )}

        {/* ── Card collection for the activation charge ── */}
        {show.paymentMethods && (
          <PaymentMethodsCard memberId={id} returnTo="migration" className="lg:col-span-2" onChanged={() => load()} />
        )}

        {/* ── Already paid, no membership yet — the offline activation ── */}
        {show.alreadyPaid && (
          <EnrollAlreadyPaidCard
            id="enrol"
            memberId={id}
            memberName={`${m.firstName} ${m.lastName}`.trim()}
            className="lg:col-span-2"
            openSignal={enrolSignal}
            prefill={{
              planId: b.planId,
              optionId: data.activation.optionId,
              amount: data.activation.amount,
              coversUntil: data.activation.coversUntil,
              draftLabel: data.activation.draftLabel,
            }}
            onChanged={() => { setMsg(null); load(); }}
          />
        )}

        {/* ── Reactivation offer ── */}
        {show.reactivation && (
          <ReactivationCard
            data={data}
            canCreate={show.createOffer}
            onOpen={() => setReactOpen(true)}
            onMsg={setMsg}
          />
        )}

        {/* ── Migration triage ── */}
        {show.triage && <TriageCard data={data} memberId={id} showFinalDate={show.triageFinalDate} onSaved={() => load()} />}

        {/* ── Pending activation ── */}
        {show.cancelPendingActivation && <DangerCard memberId={id} onDone={() => load()} onMsg={setMsg} />}

        {/* ── History ── */}
        {show.history && (
          <Card title="Billing & migration history" className="lg:col-span-2">
            {data.history.length === 0 ? (
              <p className="text-sm text-text-muted">No history yet.</p>
            ) : (
              <div className="max-h-96 space-y-1.5 overflow-y-auto">
                {data.history.map((h, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <span className="whitespace-nowrap text-text-muted">{new Date(h.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 font-medium ${h.kind === "BILLING" ? "bg-brand/10 text-brand" : "bg-app-bg text-text-muted"}`}>{h.action}</span>
                    <span className="text-text-primary">
                      {h.message || ""}
                      {h.actorName ? <span className="text-text-muted"> — {h.actorName}</span> : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </div>

      {cardActivateOpen && (
        <CardActivateModal
          data={data}
          memberId={id}
          onClose={() => setCardActivateOpen(false)}
          onDone={(t) => { setCardActivateOpen(false); setMsg(t); load(); }}
        />
      )}
      {editOpen && show.setupEdit && <EditBillingModal data={data} memberId={id} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); load(); }} />}
      {reactOpen && show.createOffer && <ReactivationModal data={data} memberId={id} onClose={() => setReactOpen(false)} onChanged={() => load()} />}
    </div>
  );
}

// ── Reactivation offer card ──────────────────────────────────────────────────

function ReactivationCard({ data, canCreate, onOpen, onMsg }: { data: Data; canCreate: boolean; onOpen: () => void; onMsg: (s: string) => void }) {
  const b = data.billing;
  const r = data.reactivation;
  return (
    <Card
      title="Reactivation offer"
      className="lg:col-span-2"
      action={canCreate ? (
        <button
          type="button"
          onClick={onOpen}
          disabled={!b.configured}
          title={!b.configured ? "Put a membership in the setup first" : undefined}
          className="inline-flex min-h-[44px] items-center text-xs text-brand hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50 md:min-h-0"
        >
          {r && (r.status === "DRAFT" || r.status === "SENT") ? "Manage / resend" : "Create offer"}
        </button>
      ) : undefined}
    >
      {r ? (
        <div>
          {r.changeRequestStatus === "OPEN" && (
            <div className="mb-2 rounded-lg border border-[var(--color-warn-text)] bg-[var(--color-warn-surface)] px-3 py-2">
              <p className="text-xs font-semibold text-[var(--color-warn-text)]">Client requested changes — confirmation is locked</p>
              {r.changeRequest?.fields && (
                <p className="mt-0.5 text-xs text-text-primary">
                  {Object.entries(r.changeRequest.fields).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(" · ") || ""}
                </p>
              )}
              {r.changeRequest?.note && <p className="mt-0.5 text-xs italic text-text-primary">&ldquo;{r.changeRequest.note}&rdquo;</p>}
              <p className="mt-1 text-[12px] text-text-muted">
                Approve or deny it from <Link href="/dashboard/members/approvals" className="underline">Approvals</Link> —
                approving regenerates a new offer version from the current setup.
              </p>
            </div>
          )}
          <Row label="Status" strong>
            {r.status}{r.status === "SENT" ? ` — to ${r.sentToEmail} (${r.emailSendCount}×)` : ""}
          </Row>
          <Row label="Offer version">v{r.offerVersion}</Row>
          <Row label="Last updated">{fmtDate(r.updatedAt)}</Row>
          {r.emailSentAt && <Row label="Last sent">{fmtDate(r.emailSentAt)}</Row>}
          {r.viewedAt && <Row label="First viewed">{fmtDate(r.viewedAt)}</Row>}
          {r.confirmedAt && <Row label="Confirmed">{fmtDate(r.confirmedAt)}</Row>}

          {/* The offer is an immutable snapshot — show EXACTLY what the
              client's link presents, independent of later setup edits. */}
          <div className="mt-2 border-t border-app-border pt-2">
            <p className="mb-1 text-xs font-semibold text-text-primary">What this offer contains (frozen at send time)</p>
            <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
              <Row label="Plan">{r.offer.planName || "—"}{r.offer.optionLabel ? ` · ${r.offer.optionLabel}` : ""}</Row>
              <Row label="Price">
                {(r.offer.price ?? 0) <= 0 ? "Free" : `${fmtMoney(r.offer.price!)} ${(r.offer.billingPeriod || "").toLowerCase()}`}
              </Row>
              {r.offer.discount && (
                <Row label="Discount" strong>{r.offer.discount.name} Discount Applied — final {fmtMoney(r.offer.discount.finalPrice)}</Row>
              )}
              {data.feeBreakdown?.passFees && (r.offer.price ?? 0) > 0 && r.offer.paymentMode === "CARD" && (() => {
                const effective = r.offer.discount?.finalPrice ?? r.offer.price!;
                if (effective <= 0) return null;
                const fb = feeBreakdown(effective, true);
                return <Row label="Total charged">{fmtMoney(fb.total)} (includes {fmtMoney(fb.fee)} processing fee)</Row>;
              })()}
              <Row label="Start">{fmtDateUTC(r.offer.startDate)}</Row>
              <Row label="First payment">{r.offer.firstChargeDate ? fmtDateUTC(r.offer.firstChargeDate) : "No charge"}</Row>
              <Row label="Commitment through">{fmtDateUTC(r.offer.commitmentEndDate)}</Row>
              <Row label="Payment">
                {(r.offer.paymentMethod && OFFER_METHOD_LABELS[r.offer.paymentMethod]) ||
                  (r.offer.paymentMode === "CARD" ? "Saved card at confirmation" : r.offer.paymentMode === "OFFLINE" ? "Offline / club collects" : "Free — none")}
              </Row>
            </div>
            {(r.offer.paymentMethod === "CASH" || r.offer.paymentMethod === "CHECK") && (
              <p className="mt-1 text-xs text-text-muted">{offlineRuleLabel(data.offlineActivationPolicy)}</p>
            )}
          </div>

          {r.open && r.sync && (
            r.sync.matches ? (
              <p className="mt-2 rounded-lg bg-lime-accent/20 px-2.5 py-1.5 text-xs text-text-primary">
                ✓ Matches the current setup — the client will confirm exactly what this page shows.
              </p>
            ) : (
              <div className="mt-2 rounded-lg border border-[var(--color-warn-text)] bg-[var(--color-warn-surface)] px-2.5 py-2 text-xs text-text-primary">
                <p className="font-semibold">✗ Out of date — the setup changed after this offer was created</p>
                <p className="mt-0.5 text-text-muted">Changed: {r.sync.changed.join(", ")}. The client&apos;s link is now{" "}
                <strong className="text-text-primary">blocked from confirming</strong>. Regenerate the offer (new version + fresh link), preview, and resend.</p>
              </div>
            )
          )}
          {r.consent != null && (
            <div className="mt-2 border-t border-app-border pt-2">
              <p className="mb-1 text-xs font-semibold text-text-primary">Consent record</p>
              <pre className="overflow-x-auto rounded-lg bg-app-bg p-2 text-xs text-text-muted">{JSON.stringify(r.consent, null, 2)}</pre>
            </div>
          )}
          {r.url && (
            <p className="mt-2 text-xs text-text-muted">
              Secure link (expires {fmtDate(r.tokenExpires)}):{" "}
              <button type="button" className="inline-flex min-h-[44px] items-center text-brand hover:underline md:min-h-0" onClick={() => { navigator.clipboard.writeText(r.url!); onMsg("Link copied."); }}>Copy</button>
              {" · "}
              <a className="inline-flex min-h-[44px] items-center text-brand hover:underline md:min-h-0" href={r.url} target="_blank" rel="noreferrer">Preview page</a>
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-text-muted">
          {b.configured
            ? "No offer yet. Create one to send the client a secure link where they review the owner-approved membership and confirm — with the first-payment date spelled out before anything is charged."
            : "No offer yet — and none can be created until the setup has a membership. Use Edit setup (or an explicit $0 price for a deliberately free membership)."}
        </p>
      )}
    </Card>
  );
}


// ── Migration triage card ──────────────────────────────────────────────────

// Group A/B/C were one-time migration-planning shorthand — DEPRECATED and no
// longer offered. A member still carrying one shows it as a legacy value so
// the owner can move them to an operational state.

function TriageCard({ data, memberId, showFinalDate, onSaved }: { data: Data; memberId: string; showFinalDate: boolean; onSaved: () => void }) {
  const mig = data.migration;
  const [note, setNote] = useState(mig.groupNote ?? "");
  const [finalDate, setFinalDate] = useState(dateInput(data.billing.finalBillingDate));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setBusy(true); setErr(null); setSaved(false);
    const r = await fetch(`/api/members/${memberId}/billing-admin`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // 4.5.1 — migrationGroup and migrationFinalAction are retired from the
        // UI. The COLUMNS and the PATCH field both survive: existing values are
        // untouched, deriveReadiness still honours them, and the billing
        // centre's own readiness chip still reads them. What is gone is the
        // second place a staffer was asked to classify someone by hand, which
        // the 7-step meter now answers from facts.
        migrationGroupNote: note || null,
        // Once billing is live the final billing date means nothing (activation
        // already happened) — it is not offered, and not sent.
        ...(showFinalDate ? { migrationFinalBillingDate: finalDate || null } : {}),
      }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { setSaved(true); onSaved(); } else setErr(d.error || "Save failed.");
  };

  return (
    <Card title="Migration triage" className="lg:col-span-2">
      <p className="text-xs text-text-muted mb-3">
        Planning only — classifying a client never charges anyone or touches Stripe. Saving these changes
        does not charge the client; billing changes take effect only when the client confirms the
        reactivation offer or an authorized user explicitly activates the membership.
        {mig.migrationStatus ? ` Migration status: ${mig.migrationStatus}${mig.approvalStatus ? ` · ${mig.approvalStatus}` : ""}.` : ""}
        {mig.activationEmailSentAt ? ` Activation email sent ${mig.activationEmailSendCount}× (last ${fmtDate(mig.activationEmailSentAt)}).` : " No activation email sent yet."}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {showFinalDate && (
          <label className="text-xs text-text-muted">Final billing date
            <input type="date" value={finalDate} onChange={(e) => setFinalDate(e.target.value)} className="mt-1 min-h-[44px] w-full rounded-lg border border-app-border bg-surface px-2 py-1.5 text-sm text-text-primary md:min-h-0" />
          </label>
        )}
        <label className="text-xs text-text-muted">Note
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. decide July payment" className="mt-1 min-h-[44px] w-full rounded-lg border border-app-border bg-surface px-2 py-1.5 text-sm text-text-primary md:min-h-0" />
        </label>
      </div>
      {showFinalDate && finalDate && new Date(finalDate + "T23:59:59") < new Date() && (
        <p className="text-xs text-[var(--color-warn-text)] mt-2">That date is in the past — activation flows will demand a new future date or an explicit immediate-charge confirmation.</p>
      )}
      {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button type="button" disabled={busy} onClick={save} className="inline-flex min-h-[44px] items-center rounded-lg bg-charcoal px-4 text-sm text-white hover:bg-charcoal-hover md:min-h-[36px]">{busy ? "Saving…" : "Save triage"}</button>
        {saved && <span className="text-xs text-text-muted">Saved.</span>}
      </div>
    </Card>
  );
}

function DangerCard({ memberId, onDone, onMsg }: { memberId: string; onDone: () => void; onMsg: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

  const cancelPending = async () => {
    setBusy(true);
    const r = await fetch(`/api/members/${memberId}/billing-admin/actions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel_pending_activation", confirm: true }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    setAsking(false);
    if (r.ok) { onMsg("Pending activation canceled — history preserved."); onDone(); }
    else onMsg(d.error || "Could not cancel.");
  };

  return (
    <Card title="Pending activation" className="lg:col-span-2">
      <p className="mb-2 text-xs text-text-muted">
        This member has an activation in flight. Canceling invalidates the link without deleting any history.
      </p>
      <button type="button" disabled={busy} onClick={() => setAsking(true)} className="inline-flex min-h-[44px] items-center rounded-lg border border-red-300 px-4 text-sm text-red-600 hover:bg-red-50 md:min-h-[36px]">
        Cancel pending activation
      </button>
      <Sheet
        open={asking}
        onClose={() => { if (!busy) setAsking(false); }}
        title="Cancel the pending activation?"
        footer={
          <>
            <button type="button" onClick={() => setAsking(false)} disabled={busy} className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-app-border px-4 text-sm text-text-primary hover:bg-app-bg">Keep it</button>
            <button type="button" onClick={cancelPending} disabled={busy} className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-red-600 px-4 text-sm text-white hover:bg-red-700 disabled:opacity-50">{busy ? "Working…" : "Cancel activation"}</button>
          </>
        }
      >
        <div className="space-y-1.5 text-sm text-text-primary">
          <p><strong>Before:</strong> the activation link works and the member awaits approval.</p>
          <p><strong>After:</strong> the link stops working, approval state clears, and the member returns to the imported pool.</p>
          <p className="text-text-muted">All history, requests, and any saved card are preserved. Nothing is charged.</p>
        </div>
      </Sheet>
    </Card>
  );
}


// "Activate this setup now" for a saved-card payer. One screen that states
// the exact charge in the words the audit log will use, then runs
// activate_card. An immediate charge is a second, explicit acknowledgement.
function CardActivateModal({ data, memberId, onClose, onDone }: { data: Data; memberId: string; onClose: () => void; onDone: (msg: string) => void }) {
  const b = data.billing;
  const immediate = b.chargeTiming.immediate;
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fee = data.feeBreakdown;
  const total = fee?.passFees ? fee.totalCharged : (b.price ?? 0);
  const firstCharge = immediate ? "today" : fmtDateUTC(b.finalBillingDate || b.billingAnchorDate);
  const ends = b.commitmentEndDate ? fmtDateUTC(b.commitmentEndDate) : null;

  async function run() {
    setBusy(true); setError("");
    const r = await fetch(`/api/members/${memberId}/billing-admin/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "activate_card", confirm: true, confirmImmediateCharge: immediate && ack }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setError(typeof d.error === "string" ? d.error : "Could not activate."); return; }
    onDone(typeof d.message === "string" ? d.message : "Membership activated.");
  }

  return (
    <Sheet
      open
      onClose={() => { if (!busy) onClose(); }}
      title="Activate on the saved card"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-app-border px-4 text-sm text-text-primary hover:bg-app-bg">Cancel</button>
          <button
            type="button"
            onClick={run}
            disabled={busy || (immediate && !ack)}
            className="inline-flex min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 text-sm text-white hover:bg-brand-hover disabled:opacity-50"
          >
            {busy ? "Working…" : immediate ? `Charge ${fmtMoney(total)} & activate` : "Activate"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <p className="rounded-lg bg-red-600 px-2.5 py-2 text-xs text-white">{error}</p>}
        <div className="space-y-1 rounded-lg bg-app-bg px-3 py-2.5 text-sm text-text-primary">
          <p><strong>{data.member.firstName} {data.member.lastName}</strong> goes on <strong>{b.planName}{b.optionLabel ? ` · ${b.optionLabel}` : ""}</strong>.</p>
          <p>
            <strong>{fmtMoney(total)}</strong> {b.periodLabel}
            {fee?.passFees && (b.price ?? 0) > 0 ? <span className="text-text-muted"> ({fmtMoney(b.price ?? 0)} + {fmtMoney(fee.fee)} processing fee)</span> : null}
            {" "}— first charge <strong className={immediate ? "text-[var(--color-warn-text)]" : ""}>{firstCharge}</strong>.
          </p>
          <p className="text-text-muted">
            {ends ? `Ends ${ends} (the commitment date) — no charge after that.` : "Renews each period until it is turned off."}
          </p>
          <p className="text-text-muted">Card: {pmPrefLabel(b.requestedPaymentMethod)}. Nothing else changes.</p>
        </div>
        {immediate && (
          <label className="flex min-h-[44px] items-start gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 h-5 w-5" />
            <span>I understand the saved card is charged <strong>{fmtMoney(total)} right now</strong>.</span>
          </label>
        )}
      </div>
    </Sheet>
  );
}

function EditBillingModal({ data, memberId, onClose, onSaved }: { data: Data; memberId: string; onClose: () => void; onSaved: () => void }) {
  const b = data.billing;
  const [planId, setPlanId] = useState(b.planId ?? "");
  const [optionLabel, setOptionLabel] = useState(b.optionLabel ?? "");
  const [priceOverride, setPriceOverride] = useState(b.priceOverride != null ? String(b.priceOverride) : "");
  const [discountNote, setDiscountNote] = useState(b.discountNote ?? "");
  const [frequency, setFrequency] = useState(b.period ?? "MONTHLY");
  const [startDate, setStartDate] = useState(dateInput(b.startDate));
  const [anchorDate, setAnchorDate] = useState(dateInput(b.billingAnchorDate));
  const [commitDate, setCommitDate] = useState(dateInput(b.commitmentEndDate));
  const [payerUserId, setPayerUserId] = useState(data.payer?.userId ?? "");
  const [markFree, setMarkFree] = useState(false);
  const [finalPeriodPaid, setFinalPeriodPaid] = useState(b.finalPeriodPaid);
  // Staff-selected discount (dropdown; server-validated — DISCOUNT_INVALID
  // blocks the save) and payment method for the staged offer.
  const [discountCode, setDiscountCode] = useState<string | null>(b.discountCode ?? null);
  const initialPayPref =
    b.requestedPaymentMethod && ["CARD", "LATER", "CASH", "CHECK"].includes(b.requestedPaymentMethod)
      ? b.requestedPaymentMethod
      : "CARD";
  const [payPref, setPayPref] = useState(initialPayPref);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ before: Record<string, unknown>; after: Record<string, unknown>; changed: string[] } | null>(null);

  const plan = useMemo(() => data.plans.find((p) => p.id === planId) ?? null, [data.plans, planId]);

  // The price the discount previews against — mirrors the server's precedence
  // (override > selected option > current resolved price). Display only.
  const selOpt = useMemo(
    () => (plan && optionLabel ? (plan.options || []).find((o) => String(o.label ?? "") === optionLabel) ?? null : null),
    [plan, optionLabel],
  );
  const discountBasePrice = markFree
    ? 0
    : priceOverride !== ""
      ? Number(priceOverride) || 0
      : typeof selOpt?.price === "number"
        ? selOpt.price
        : b.price ?? 0;

  const buildBody = () => ({
    membershipId: planId || null,
    selectedOptionLabel: optionLabel || null,
    priceOverride: markFree ? undefined : priceOverride === "" ? null : Number(priceOverride),
    discountNote: discountNote || null,
    billingFrequency: frequency || null,
    membershipStartDate: startDate || null,
    billingAnchorDate: anchorDate || null,
    commitmentEndDate: commitDate || null,
    responsiblePayerUserId: payerUserId || null,
    markFree: markFree || undefined,
    finalPeriodPaid,
    // Only send when actually changed — keeps the preview diff clean.
    ...(discountCode !== (b.discountCode ?? null) ? { discountCode } : {}),
    ...(payPref !== initialPayPref ? { paymentMethodPreference: payPref } : {}),
  });

  const preview = async () => {
    setBusy(true); setErr(null);
    const r = await fetch(`/api/members/${memberId}/billing-admin`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...buildBody(), preview: true }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) setDiff(d);
    else setErr(d.error || "Preview failed.");
  };

  const commit = async () => {
    setBusy(true); setErr(null);
    const r = await fetch(`/api/members/${memberId}/billing-admin`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildBody()),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) onSaved();
    else setErr(d.error || "Save failed.");
  };

  return (
    <Sheet
      open
      onClose={() => { if (!busy) onClose(); }}
      title="Edit migration setup"
      width={560}
      description={
        <>
          A draft of what this member will be billed when they activate. Saving never charges anyone and never
          changes a live membership. If an offer is already out, changing these fields marks it out of date —
          you&apos;ll regenerate and resend.
        </>
      }
    >

        {!diff ? (
          <div className="space-y-3">
            <label className="block text-xs text-text-muted">Membership plan
              <select value={planId} onChange={(e) => { setPlanId(e.target.value); setOptionLabel(""); }} className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary">
                <option value="">— Keep legacy snapshot ({b.legacy.name || "none"}) —</option>
                {data.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            {plan && (
              <label className="block text-xs text-text-muted">Purchase option
                <select value={optionLabel} onChange={(e) => setOptionLabel(e.target.value)} className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary">
                  <option value="">— Plan default (first option) —</option>
                  {(plan.options || []).map((o, i) => (
                    <option key={i} value={String(o.label ?? "")}>{String(o.label ?? "Option")} — ${o.price} {String(o.billingPeriod || "").toLowerCase()}</option>
                  ))}
                </select>
              </label>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block text-xs text-text-muted">Price override ($)
                <input type="number" min="0" step="0.01" value={priceOverride} disabled={markFree} onChange={(e) => setPriceOverride(e.target.value)} placeholder="none" className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary" />
              </label>
              <label className="block text-xs text-text-muted">Billing frequency
                <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary">
                  {["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL"].map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
            </div>
            <label className="block text-xs text-text-muted">Override reason / discount note
              <input value={discountNote} onChange={(e) => setDiscountNote(e.target.value)} placeholder="e.g. Founding member rate" className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary" />
            </label>
            <StaffDiscountPicker
              itemType="MEMBERSHIP"
              membershipId={planId || b.planId}
              value={discountCode}
              onChange={(code) => setDiscountCode(code)}
              originalPrice={discountBasePrice}
              passProcessingFees={!!data.feeBreakdown?.passFees}
            />
            <label className="block text-xs text-text-muted">Will pay by (after activation)
              <select value={payPref} onChange={(e) => setPayPref(e.target.value)} className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary">
                <option value="CARD">Saved card</option>
                <option value="LATER">New card (client adds)</option>
                <option value="CASH">Cash</option>
                <option value="CHECK">Check</option>
              </select>
              {(payPref === "CASH" || payPref === "CHECK") && (
                <span className="block mt-1 text-[12px] text-text-muted">{offlineRuleLabel(data.offlineActivationPolicy)}</span>
              )}
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block text-xs text-text-muted">Start date
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary" />
              </label>
              <label className="block text-xs text-text-muted">Billing anchor
                <input type="date" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary" />
              </label>
              <label className="block text-xs text-text-muted">Commitment end
                <input type="date" value={commitDate} onChange={(e) => setCommitDate(e.target.value)} className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary" />
              </label>
            </div>
            <label className="block text-xs text-text-muted">Responsible payer
              <select value={payerUserId} onChange={(e) => setPayerUserId(e.target.value)} className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary">
                <option value="">— Implied (card owner / guardian) —</option>
                {data.guardians.map((g) => <option key={g.userId} value={g.userId}>{g.name} ({g.email})</option>)}
              </select>
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-xs text-text-muted">
                <input type="checkbox" checked={markFree} onChange={(e) => setMarkFree(e.target.checked)} />
                Mark genuinely free ($0, no recurring charge)
              </label>
              <label className="flex items-center gap-2 text-xs text-text-muted">
                <input type="checkbox" checked={finalPeriodPaid} onChange={(e) => setFinalPeriodPaid(e.target.checked)} />
                Final period already paid
              </label>
            </div>
            {err && <p className="text-xs text-red-600">{err}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button disabled={busy} onClick={onClose} className="inline-flex min-h-[44px] items-center rounded-lg border border-app-border px-4 text-sm text-text-primary md:min-h-[36px]">Cancel</button>
              <button disabled={busy} onClick={preview} className="inline-flex min-h-[44px] items-center rounded-lg bg-charcoal px-4 text-sm text-white hover:bg-charcoal-hover md:min-h-[36px]">{busy ? "Checking…" : "Preview changes"}</button>
            </div>
          </div>
        ) : (
          <div>
            {diff.changed.length === 0 ? (
              <p className="text-sm text-text-muted mb-3">No changes — everything matches the current setup.</p>
            ) : (
              <div className="space-y-1.5 mb-3">
                <p className="text-xs text-text-muted">Review before applying — nothing is charged by these edits:</p>
                {diff.changed.map((k) => (
                  <div key={k} className="text-xs border border-app-border rounded-lg px-2.5 py-1.5">
                    <span className="font-medium text-text-primary">{k}</span>
                    <div className="text-text-muted">
                      <span className="line-through">{String(diff.before[k] ?? "—")}</span>
                      {" → "}
                      <span className="text-text-primary font-medium">{String(diff.after[k] ?? "—")}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
            <div className="flex justify-end gap-2">
              <button disabled={busy} onClick={() => setDiff(null)} className="inline-flex min-h-[44px] items-center rounded-lg border border-app-border px-4 text-sm text-text-primary md:min-h-[36px]">Back</button>
              {diff.changed.length > 0 && (
                <button disabled={busy} onClick={commit} className="inline-flex min-h-[44px] items-center rounded-lg bg-brand px-4 text-sm text-white hover:bg-brand-hover md:min-h-[36px]">{busy ? "Applying…" : "Apply changes"}</button>
              )}
            </div>
          </div>
        )}
    </Sheet>
  );
}

// ── Reactivation modal (compose → preview → send) ──────────────────────────

function ReactivationModal({ data, memberId, onClose, onChanged }: { data: Data; memberId: string; onClose: () => void; onChanged: () => void }) {
  const open = data.reactivation && (data.reactivation.status === "DRAFT" || data.reactivation.status === "SENT") ? data.reactivation : null;
  const [firstCharge, setFirstCharge] = useState(dateInput(data.billing.finalBillingDate) || "");
  const [note, setNote] = useState(open?.personalNote ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [needsAck, setNeedsAck] = useState(false);
  const [preview, setPreview] = useState<{ subject: string; html: string; to: string; pageUrl: string } | null>(null);
  const [sentMsg, setSentMsg] = useState<string | null>(null);

  const createOffer = async (ack = false) => {
    setBusy(true); setErr(null); setNeedsAck(false);
    const r = await fetch(`/api/members/${memberId}/reactivation`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstChargeDate: firstCharge || null, personalNote: note || null, acknowledgeImmediateCharge: ack }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { onChanged(); setSentMsg("Offer created. Preview the email, then send."); }
    else if (d.code === "IMMEDIATE_CHARGE_CONFIRM_REQUIRED") setNeedsAck(true);
    else if (d.code === "DISCOUNT_INVALID") {
      // The stored discount code is no longer valid — fix or clear it in Edit.
      setErr(d.error || "The selected discount is no longer valid. Fix or clear it in the billing Edit modal, then create the offer again.");
    }
    else if (d.code === "PLAN_REQUIRED") {
      // No membership configured — the server refuses to draft a $0 offer.
      setErr(d.error || "No membership is configured for this member. Put a plan (or an explicit $0 price) in Edit setup before creating an offer.");
      onChanged(); // re-sync so the page flips to the "No membership" state
    }
    else setErr(d.error || "Could not create the offer.");
  };

  const loadPreview = async () => {
    setBusy(true); setErr(null);
    const r = await fetch(`/api/members/${memberId}/reactivation/preview`);
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) setPreview(d);
    else setErr(d.error || "Preview failed — create the offer first.");
  };

  const [confirmSend, setConfirmSend] = useState(false);
  const send = async () => {
    setConfirmSend(false);
    setBusy(true); setErr(null);
    const r = await fetch(`/api/members/${memberId}/reactivation/send`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { setSentMsg(`Email sent to ${d.sentTo} (${d.sendCount}×).`); onChanged(); }
    else setErr(d.error || "Send failed.");
  };

  return (
    <Sheet open onClose={() => { if (!busy) onClose(); }} title="Reactivation offer" width={680}>
        <p className="text-xs text-text-muted mb-3">
          Offer: <strong className="text-text-primary">{data.billing.configured ? data.billing.planName : "No membership configured"}</strong>
          {data.billing.configured
            ? <> — {(data.billing.price ?? 0) <= 0 ? "Free" : `$${(data.billing.price ?? 0).toFixed(2)} ${data.billing.periodLabel ?? ""}`}</>
            : null}
          {data.billing.configured && data.feeBreakdown?.passFees && (data.billing.price ?? 0) > 0 &&
          data.billing.requestedPaymentMethod !== "CASH" && data.billing.requestedPaymentMethod !== "CHECK"
            ? ` ($${data.feeBreakdown.totalCharged.toFixed(2)} charged incl. $${data.feeBreakdown.fee.toFixed(2)} processing fee)`
            : ""}.
          The client reviews these owner-approved terms on a secure page; nothing is charged until they confirm, and
          the first-payment date is spelled out on the button itself.
        </p>
        <div className="text-xs text-text-muted mb-3 border border-app-border rounded-lg px-2.5 py-2 space-y-0.5">
          <p>Payment method: <strong className="text-text-primary">{pmPrefLabel(data.billing.requestedPaymentMethod)}</strong></p>
          {data.billing.discountCode && (
            <p>Discount: <strong className="text-text-primary font-mono">{data.billing.discountCode}</strong> — validated and frozen into the offer when it&apos;s created.</p>
          )}
          {(data.billing.requestedPaymentMethod === "CASH" || data.billing.requestedPaymentMethod === "CHECK") && (
            <p className="text-[var(--color-warn-text)]">{offlineRuleLabel(data.offlineActivationPolicy)}</p>
          )}
        </div>

        {preview ? (
          <div>
            <p className="text-xs text-text-muted mb-2">To: <strong className="text-text-primary">{preview.to}</strong> · Subject: <strong className="text-text-primary">{preview.subject}</strong></p>
            <div className="border border-app-border rounded-lg overflow-hidden mb-3 max-h-[50vh] overflow-y-auto bg-white">
              <div dangerouslySetInnerHTML={{ __html: preview.html }} />
            </div>
            {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
            {sentMsg && <p className="text-xs text-text-primary bg-lime-accent/20 rounded-lg px-2 py-1.5 mb-2">{sentMsg}</p>}
            {confirmSend && (
              <p className="mb-2 text-xs text-text-muted">It goes to the client with the secure confirmation link. Sending never charges anything.</p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button disabled={busy} onClick={() => { setPreview(null); setConfirmSend(false); }} className="inline-flex min-h-[44px] items-center rounded-lg border border-app-border px-4 text-sm text-text-primary md:min-h-[36px]">Back</button>
              {confirmSend ? (
                <button type="button" disabled={busy} onClick={send} className="inline-flex min-h-[44px] items-center rounded-lg bg-brand px-4 text-sm text-white hover:bg-brand-hover md:min-h-[36px]">
                  {busy ? "Sending…" : `Yes — send to ${preview.to}`}
                </button>
              ) : (
                <button type="button" disabled={busy} onClick={() => setConfirmSend(true)} className="inline-flex min-h-[44px] items-center rounded-lg bg-brand px-4 text-sm text-white hover:bg-brand-hover md:min-h-[36px]">
                  {open?.status === "SENT" ? "Resend email" : "Send email"}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {open && (
              <p className="text-xs text-text-muted">
                Current offer v{open.offerVersion} ({open.status}{open.sentToEmail ? ` → ${open.sentToEmail}` : ""}), link expires {fmtDate(open.tokenExpires)}.
                Creating again regenerates the token and supersedes it.
              </p>
            )}
            <label className="block text-xs text-text-muted">Owner-approved first billing date
              <input type="date" value={firstCharge} onChange={(e) => setFirstCharge(e.target.value)} className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary" />
            </label>
            <label className="block text-xs text-text-muted">Personal note (optional — added to the standard email)
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={1500}
                placeholder="e.g. Our payment processor connector malfunctioned during the switch — that's fixed now, and nothing was ever charged without your confirmation. Sorry for the hassle!"
                className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary" />
            </label>
            {needsAck && (
              <div className="border border-[var(--color-warn-text)] bg-[var(--color-warn-surface)] rounded-lg px-3 py-2 text-xs text-text-primary">
                That date is today or already passed — if the client confirms, <strong>they are charged immediately</strong>.
                Pick a future date (recommended), or explicitly proceed:
                <button disabled={busy} onClick={() => createOffer(true)} className="ml-2 underline text-[var(--color-warn-text)] font-medium">Proceed with immediate charge</button>
              </div>
            )}
            {err && <p className="text-xs text-red-600">{err}</p>}
            {sentMsg && <p className="text-xs text-text-primary bg-lime-accent/20 rounded-lg px-2 py-1.5">{sentMsg}</p>}
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <button disabled={busy} onClick={onClose} className="inline-flex min-h-[44px] items-center rounded-lg border border-app-border px-4 text-sm text-text-primary md:min-h-[36px]">Close</button>
              <button disabled={busy} onClick={() => createOffer(false)} className="inline-flex min-h-[44px] items-center rounded-lg bg-charcoal px-4 text-sm text-white hover:bg-charcoal-hover md:min-h-[36px]">
                {busy ? "Working…" : open ? "Regenerate offer" : "Create offer"}
              </button>
              <button disabled={busy || !open} onClick={loadPreview} title={!open ? "Create the offer first" : undefined}
                className="inline-flex min-h-[44px] items-center rounded-lg bg-brand px-4 text-sm text-white hover:bg-brand-hover disabled:opacity-50 md:min-h-[36px]">
                Preview email
              </button>
            </div>
          </div>
        )}
    </Sheet>
  );
}
