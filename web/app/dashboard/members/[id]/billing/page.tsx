"use client";

// Billing control center — one athlete's complete billing picture plus every
// authorized correction: plan/option/price/dates, payer, payment methods
// (add / replace / remove via Stripe-hosted collection only), migration
// triage, and the reactivation offer lifecycle. Money edits show a
// before/after diff and require explicit confirmation; nothing here charges
// anyone. Permission: billing:view to see, billing:full to change (owners
// always pass).

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, CreditCard, RefreshCw } from "lucide-react";
import { feeBreakdown } from "@/lib/fees";

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
    startDate: string | null; billingAnchorDate: string | null; finalBillingDate: string | null;
    nextBillingDate: string | null; commitmentEndDate: string | null;
    requestedPaymentMethod: string | null; finalPeriodPaid: boolean;
    lastPayment: { amount: number; at: string } | null;
    stripeStatus: string | null;
    chargeTiming: { immediate: boolean; label: string };
    legacy: { name: string | null; price: number | null; frequency: string | null; source: string | null };
  };
  subscriptions: {
    id: string; optionLabel: string; price: number; billingPeriod: string | null; billingType: string;
    status: string; stripeStatus: string | null; hasStripe: boolean;
    startDate: string | null; endDate: string | null; billingAnchorDate: string | null;
    currentPeriodEnd: string | null; cancelAt: string | null;
    card: { brand?: string; last4?: string } | null;
    lastPayment: { amount: number; at: string } | null;
    notes: string | null; autoRenew: boolean; createdAt: string;
  }[];
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
  plans: { id: string; name: string; options: { label?: string; price?: number; billingPeriod?: string }[] }[];
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

const READINESS_STYLE: Record<string, { bg: string; fg: string }> = {
  READY: { bg: "rgba(163,230,53,0.25)", fg: "#3F6212" },
  WAITING_OWNER: { bg: "rgba(255,106,0,0.15)", fg: "#9A3412" },
  WAITING_CLIENT: { bg: "rgba(109,93,246,0.15)", fg: "#4338CA" },
  HOLD: { bg: "rgba(239,68,68,0.12)", fg: "#B91C1C" },
  LEAVE_ALONE: { bg: "rgba(120,113,108,0.15)", fg: "#57534E" },
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

export default function MemberBillingPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const search = useSearchParams();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [reactOpen, setReactOpen] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/members/${id}/billing-admin`)
      .then(async (r) => {
        if (r.status === 403) { setForbidden(true); return null; }
        return r.ok ? r.json() : null;
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (search.get("card_saved")) {
      setMsg(
        search.get("intent") === "REPLACE"
          ? "Replacement card collected. It becomes the charged method only after you make it the default below."
          : "Card saved. It may take a few seconds to appear — refresh if needed.",
      );
    }
    if (search.get("card_canceled")) setMsg("Card entry was canceled — nothing was saved.");
  }, [search]);

  if (loading) return <div className="p-8 text-center text-text-muted text-sm">Loading…</div>;
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
  const rs = READINESS_STYLE[data.readiness.state] ?? READINESS_STYLE.LEAVE_ALONE;

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <Link href={`/dashboard/members/${id}`} className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Back to profile
      </Link>

      <div className="mt-3 mb-5 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">
            {m.firstName} {m.lastName} <span className="text-text-muted font-normal">· Billing</span>
          </h1>
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-charcoal text-white" title={data.billingState.explanation}>
              {data.billingState.label}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: rs.bg, color: rs.fg }} title={data.readiness.reasons.join("; ") || undefined}>
              {data.readiness.label}
            </span>
            {m.isMinor && <span className="text-xs px-2 py-0.5 rounded-full bg-app-bg text-text-muted">Minor</span>}
            {data.lastChangedBy && (
              <span className="text-xs text-text-muted">
                Billing last changed by {data.lastChangedBy.name} on {fmtDate(data.lastChangedBy.at)}
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted mt-1">{data.billingState.explanation}</p>
          {data.readiness.reasons.length > 0 && (
            <p className="text-xs text-text-muted mt-0.5">{data.readiness.reasons.join(" · ")}</p>
          )}
        </div>
        <button onClick={() => load()} className="text-xs inline-flex items-center gap-1 text-text-muted hover:text-text-primary border border-app-border rounded-lg px-2.5 py-1.5">
          <RefreshCw className="h-3 w-3" /> Refresh
        </button>
      </div>

      {msg && (
        <div className="mb-4 text-sm text-text-primary bg-lime-accent/20 border border-app-border rounded-lg px-3 py-2 flex justify-between gap-3">
          <span>{msg}</span>
          <button className="text-xs text-text-muted" onClick={() => setMsg(null)}>Dismiss</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* ── Membership & pricing ── */}
        <Card
          title="Membership & pricing"
          action={<button onClick={() => setEditOpen(true)} className="text-xs text-brand hover:underline">Edit</button>}
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
              <Row label="Plan" strong><span className="text-text-muted font-normal">No membership</span></Row>
              <p className="text-xs text-text-muted mt-1">
                No membership configured. This member is a prospect — assign a plan or set an explicit $0
                price to make them deliberately free.
              </p>
            </div>
          )}
          {b.priceOverride != null && (
            <Row label="Owner price override">{fmtMoney(b.priceOverride)}{b.discountNote ? ` — ${b.discountNote}` : ""}</Row>
          )}
          <Row label="Membership start">{fmtDateUTC(b.startDate)}</Row>
          <Row label="Imported billing anchor">{fmtDateUTC(b.billingAnchorDate)}</Row>
          <Row label="Owner-approved final billing date">
            {b.finalBillingDate ? fmtDateUTC(b.finalBillingDate) : <span className="text-orange-accent font-medium">Not set</span>}
          </Row>
          {data.anchorMismatch && (
            <p className="text-xs text-orange-accent mt-1">
              The final billing date differs from the imported anchor — the final date is what billing
              flows use when they start.
            </p>
          )}
          <Row label="Next billing">{fmtDateUTC(b.nextBillingDate)}</Row>
          {b.commitmentEndDate && <Row label="Commitment through">{fmtDateUTC(b.commitmentEndDate)}</Row>}
          {b.finalPeriodPaid && <Row label="Final period">Already paid — non-renewing</Row>}
          {b.lastPayment && <Row label="Last successful payment">{fmtMoney(b.lastPayment.amount)} on {fmtDate(b.lastPayment.at)}</Row>}
          {b.stripeStatus && <Row label="Stripe subscription state">{b.stripeStatus}</Row>}
          {b.legacy.name && (
            <p className="text-xs text-text-muted mt-2 pt-2 border-t border-app-border">
              Imported from {b.legacy.source || "previous software"}: {b.legacy.name}
              {b.legacy.price != null ? ` · $${b.legacy.price}` : ""}{b.legacy.frequency ? ` ${b.legacy.frequency.toLowerCase()}` : ""}
            </p>
          )}
          {b.configured && (
            <p className="text-xs mt-2 pt-2 border-t border-app-border text-text-muted">
              If billing started now it {b.chargeTiming.immediate
                ? <strong className="text-orange-accent">would charge immediately</strong>
                : <>would first charge on <strong className="text-text-primary">{fmtDateUTC(b.finalBillingDate || b.billingAnchorDate)}</strong></>}.
            </p>
          )}
          <p className="text-xs mt-2 text-text-muted">
            Saving changes here does <strong className="text-text-primary">not</strong> charge the client.
            They take effect only when the client confirms the reactivation offer or an authorized user
            explicitly activates the membership.
          </p>
        </Card>

        {/* ── People & payer ── */}
        <Card title="People & responsible payer">
          <Row label="Athlete" strong>{m.firstName} {m.lastName}</Row>
          {m.guardianName && <Row label="Guardian on file">{m.guardianName}{m.guardianEmail ? ` · ${m.guardianEmail}` : ""}</Row>}
          {data.guardians.length > 0 ? (
            <div className="mt-2">
              <p className="text-xs text-text-muted mb-1">Portal accounts managing this athlete</p>
              {data.guardians.map((g) => (
                <div key={g.userId} className="flex items-center justify-between py-1 text-sm">
                  <span className="text-text-primary">{g.name} <span className="text-text-muted text-xs">{g.email}</span></span>
                  {g.isPayer && <span className="text-xs px-2 py-0.5 rounded-full bg-lime-accent/25 text-text-primary">Payer</span>}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-muted mt-2">No linked portal guardians yet.</p>
          )}
          <Row label="Responsible payer">
            {data.payer ? `${data.payer.name} (${data.payer.email})` : <span className="text-text-muted">Implied — card owner / guardian on file</span>}
          </Row>
          <p className="text-xs text-text-muted mt-2 pt-2 border-t border-app-border">
            Set the payer in Edit. Cards always belong to the Stripe customer shown under each payment method —
            they are never copied between families.
          </p>
        </Card>

        {/* ── Payment methods ── */}
        <Card
          title="Payment methods"
          className="lg:col-span-2"
          action={
            <div className="flex gap-2">
              <PMButton id={id} intent="ADD" label="Add method" onMsg={setMsg} />
              {data.paymentMethods.length > 0 && <PMButton id={id} intent="REPLACE" label="Replace…" onMsg={setMsg} />}
            </div>
          }
        >
          {data.stripeReadError && (
            <p className="text-xs text-orange-accent mb-2">Stripe couldn&apos;t be reached — payment methods may be incomplete. Refresh to retry.</p>
          )}
          {data.paymentMethods.length === 0 ? (
            <p className="text-sm text-text-muted">
              No saved payment method. Use <strong>Add method</strong> to open a secure Stripe page — cards are never
              typed into AthletixOS.
            </p>
          ) : (
            <div className="space-y-2">
              {data.paymentMethods.map((pm) => (
                <PaymentMethodRow key={pm.ref} pm={pm} memberId={id} hasPendingCharge={data.hasPendingCharge} onChanged={() => { setMsg(null); load(); }} onMsg={setMsg} />
              ))}
            </div>
          )}
        </Card>

        {/* ── Reactivation ── */}
        <Card
          title="Reactivation offer"
          className="lg:col-span-2"
          action={<button
            onClick={() => setReactOpen(true)}
            disabled={!b.configured}
            title={!b.configured ? "Assign a membership first" : undefined}
            className="text-xs text-brand hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
          >
            {data.reactivation && (data.reactivation.status === "DRAFT" || data.reactivation.status === "SENT") ? "Manage / resend" : "Create offer"}
          </button>}
        >
          {data.reactivation ? (
            <div>
              {data.reactivation.changeRequestStatus === "OPEN" && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 mb-2">
                  <p className="text-xs font-semibold text-amber-800">
                    Client requested changes — confirmation is locked
                  </p>
                  {data.reactivation.changeRequest?.fields && (
                    <p className="text-xs text-amber-700 mt-0.5">
                      {Object.entries(data.reactivation.changeRequest.fields)
                        .filter(([, v]) => v)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" · ") || ""}
                    </p>
                  )}
                  {data.reactivation.changeRequest?.note && (
                    <p className="text-xs text-amber-700 mt-0.5 italic">&ldquo;{data.reactivation.changeRequest.note}&rdquo;</p>
                  )}
                  <p className="text-[11px] text-amber-700 mt-1">
                    Approve or deny it from <a href="/dashboard/members/approvals" className="underline">Approvals</a> —
                    approving regenerates a new offer version from the current setup.
                  </p>
                </div>
              )}
              <Row label="Status" strong>
                {data.reactivation.status}{data.reactivation.status === "SENT" ? ` — to ${data.reactivation.sentToEmail} (${data.reactivation.emailSendCount}×)` : ""}
              </Row>
              <Row label="Offer version">v{data.reactivation.offerVersion}</Row>
              <Row label="Last updated">{fmtDate(data.reactivation.updatedAt)}</Row>
              {data.reactivation.emailSentAt && <Row label="Last sent">{fmtDate(data.reactivation.emailSentAt)}</Row>}
              {data.reactivation.viewedAt && <Row label="First viewed">{fmtDate(data.reactivation.viewedAt)}</Row>}
              {data.reactivation.confirmedAt && <Row label="Confirmed">{fmtDate(data.reactivation.confirmedAt)}</Row>}

              {/* The offer is an immutable snapshot — show EXACTLY what the
                  client's link presents, independent of later billing edits. */}
              <div className="mt-2 pt-2 border-t border-app-border">
                <p className="text-xs font-semibold text-text-primary mb-1">What this offer contains (frozen at send time)</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                  <Row label="Plan">{data.reactivation.offer.planName || "—"}{data.reactivation.offer.optionLabel ? ` · ${data.reactivation.offer.optionLabel}` : ""}</Row>
                  <Row label="Price">
                    {(data.reactivation.offer.price ?? 0) <= 0 ? "Free" : `${fmtMoney(data.reactivation.offer.price!)} ${(data.reactivation.offer.billingPeriod || "").toLowerCase()}`}
                  </Row>
                  {data.feeBreakdown?.passFees && (data.reactivation.offer.price ?? 0) > 0 && data.reactivation.offer.paymentMode === "CARD" && (() => {
                    const fb = feeBreakdown(data.reactivation.offer.price!, true);
                    return (
                      <Row label="Total charged">
                        {fmtMoney(fb.total)} (includes {fmtMoney(fb.fee)} processing fee)
                      </Row>
                    );
                  })()}
                  <Row label="Start">{fmtDateUTC(data.reactivation.offer.startDate)}</Row>
                  <Row label="First payment">{data.reactivation.offer.firstChargeDate ? fmtDateUTC(data.reactivation.offer.firstChargeDate) : "No charge"}</Row>
                  <Row label="Commitment through">{fmtDateUTC(data.reactivation.offer.commitmentEndDate)}</Row>
                  <Row label="Payment">{data.reactivation.offer.paymentMode === "CARD" ? "Saved card at confirmation" : data.reactivation.offer.paymentMode === "OFFLINE" ? "Offline / club collects" : "Free — none"}</Row>
                </div>
              </div>

              {data.reactivation.open && data.reactivation.sync && (
                data.reactivation.sync.matches ? (
                  <p className="text-xs mt-2 px-2.5 py-1.5 rounded-lg bg-lime-accent/20 text-text-primary">
                    ✓ Matches the current billing setup — the client will confirm exactly what this page shows.
                  </p>
                ) : (
                  <div className="text-xs mt-2 px-2.5 py-2 rounded-lg border border-orange-accent/50 bg-orange-accent/10 text-text-primary">
                    <p className="font-semibold">✗ Out of date — billing changed after this offer was created</p>
                    <p className="mt-0.5 text-text-muted">Changed: {data.reactivation.sync.changed.join(", ")}. The client&apos;s
                    link is now <strong className="text-text-primary">blocked from confirming</strong>. Regenerate the offer
                    (new version + fresh link), preview, and resend.</p>
                  </div>
                )
              )}
              {data.reactivation.consent != null && (
                <div className="mt-2 pt-2 border-t border-app-border">
                  <p className="text-xs font-semibold text-text-primary mb-1">Consent record</p>
                  <pre className="text-xs text-text-muted bg-app-bg rounded-lg p-2 overflow-x-auto">{JSON.stringify(data.reactivation.consent, null, 2)}</pre>
                </div>
              )}
              {data.reactivation.url && (
                <p className="text-xs text-text-muted mt-2">
                  Secure link (expires {fmtDate(data.reactivation.tokenExpires)}):{" "}
                  <button className="text-brand hover:underline" onClick={() => { navigator.clipboard.writeText(data.reactivation!.url!); setMsg("Link copied."); }}>Copy</button>
                  {" · "}
                  <a className="text-brand hover:underline" href={data.reactivation.url} target="_blank" rel="noreferrer">Preview page</a>
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-text-muted">
              {b.configured
                ? "No offer yet. Create one to send the client a secure link where they review the owner-approved membership and confirm — with the first-payment date spelled out before anything is charged."
                : "No offer yet — and none can be created until a membership is assigned. Use Edit on the pricing card to assign a plan (or an explicit $0 price for a deliberately free membership)."}
            </p>
          )}
        </Card>

        {/* ── Migration triage ── */}
        <TriageCard data={data} memberId={id} onSaved={() => load()} />

        {/* ── Subscriptions ── */}
        <Card title="Membership history (subscriptions)" className="lg:col-span-2">
          {data.subscriptions.length === 0 ? (
            <p className="text-sm text-text-muted">No subscriptions on record.</p>
          ) : (
            <div className="space-y-2">
              {data.subscriptions.map((s) => (
                <div key={s.id} className="border border-app-border rounded-lg px-3 py-2 text-sm flex flex-wrap gap-x-4 gap-y-1 items-center justify-between">
                  <div>
                    <span className="font-medium text-text-primary">{s.optionLabel}</span>{" "}
                    <span className="text-text-muted text-xs">
                      {s.price <= 0 ? "Free" : `${fmtMoney(s.price)}${s.billingPeriod ? ` ${s.billingPeriod.toLowerCase()}` : ""}`} · {s.billingType.toLowerCase()} · {s.status}
                      {s.stripeStatus && s.stripeStatus !== s.status ? ` (Stripe: ${s.stripeStatus})` : ""}
                    </span>
                    <div className="text-xs text-text-muted">
                      {fmtDate(s.startDate)} → {s.endDate ? fmtDate(s.endDate) : "open-ended"}
                      {s.currentPeriodEnd ? ` · next billing ${fmtDate(s.currentPeriodEnd)}` : ""}
                      {s.card?.last4 ? ` · ${s.card.brand ?? "card"} ····${s.card.last4}` : ""}
                    </div>
                    {s.notes && <div className="text-xs text-text-muted italic mt-0.5">{s.notes}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* ── Danger zone ── */}
        <DangerCard data={data} memberId={id} onDone={() => load()} onMsg={setMsg} />

        {/* ── History ── */}
        <Card title="Billing & migration history" className="lg:col-span-2">
          {data.history.length === 0 ? (
            <p className="text-sm text-text-muted">No history yet.</p>
          ) : (
            <div className="space-y-1.5 max-h-96 overflow-y-auto">
              {data.history.map((h, i) => (
                <div key={i} className="text-xs flex gap-2 items-start">
                  <span className="text-text-muted whitespace-nowrap">{new Date(h.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                  <span className={`px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${h.kind === "BILLING" ? "bg-brand/10 text-brand" : "bg-app-bg text-text-muted"}`}>{h.action}</span>
                  <span className="text-text-primary">
                    {h.message || ""}
                    {h.actorName ? <span className="text-text-muted"> — {h.actorName}</span> : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {editOpen && <EditBillingModal data={data} memberId={id} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); load(); }} />}
      {reactOpen && <ReactivationModal data={data} memberId={id} onClose={() => setReactOpen(false)} onChanged={() => load()} />}
    </div>
  );
}

// ── Payment-method pieces ───────────────────────────────────────────────────

function PMButton({ id, intent, label, onMsg }: { id: string; intent: "ADD" | "REPLACE"; label: string; onMsg: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        if (intent === "REPLACE" && !confirm("Collect a NEW card on a secure Stripe page?\n\nThe current card keeps being charged until you explicitly make the new one the default.")) return;
        setBusy(true);
        const r = await fetch(`/api/members/${id}/payment-methods/setup`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent }),
        });
        const d = await r.json().catch(() => ({}));
        setBusy(false);
        if (r.ok && d.url) window.open(d.url, "_blank");
        else onMsg(d.error || "Could not open the Stripe page.");
      }}
      className="text-xs inline-flex items-center gap-1 border border-app-border rounded-lg px-2.5 py-1.5 text-text-primary hover:bg-app-bg"
    >
      <CreditCard className="h-3 w-3" /> {busy ? "Opening…" : label}
    </button>
  );
}

function PaymentMethodRow({ pm, memberId, hasPendingCharge, onChanged, onMsg }: { pm: PaymentMethod; memberId: string; hasPendingCharge: boolean; onChanged: () => void; onMsg: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const label = pm.type === "link"
    ? `Link wallet${pm.linkEmail ? ` (${pm.linkEmail})` : ""}`
    : `${(pm.brand || "Card").replace(/^\w/, (c) => c.toUpperCase())} ···· ${pm.last4}`;
  const exp = pm.expMonth && pm.expYear ? `${String(pm.expMonth).padStart(2, "0")}/${String(pm.expYear).slice(-2)}` : null;

  const makeDefault = async () => {
    if (!confirm(`Make ${label} the default?\n\nThis repoints the customer default, any live subscription, and the card pending activation/reactivation will charge.`)) return;
    setBusy(true);
    const r = await fetch(`/api/members/${memberId}/payment-methods/make-default`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: pm.ref, confirm: true }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { onMsg(`${d.method || label} is now the default${d.liveSubscriptionsRepointed ? ` — ${d.liveSubscriptionsRepointed} live subscription(s) repointed` : ""}.`); onChanged(); }
    else onMsg(d.error || "Could not make it the default.");
  };
  const remove = async () => {
    if (!confirm(`Remove ${label}?\n\nRemoval is blocked automatically if anything live or pending still charges this method. Payment history is never deleted.`)) return;
    setBusy(true);
    const r = await fetch(`/api/members/${memberId}/payment-methods/remove`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: pm.ref, confirm: true }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { onMsg(`${d.removed || label} removed.`); onChanged(); }
    else onMsg(d.error || "Removal blocked.");
  };

  return (
    <div className="border border-app-border rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2">
      <div className="text-sm">
        <span className="font-medium text-text-primary">{label}</span>
        {exp && <span className="text-text-muted text-xs"> · exp {exp}</span>}
        {pm.cardholder && <span className="text-text-muted text-xs"> · {pm.cardholder}</span>}
        <div className="text-xs text-text-muted mt-0.5 flex flex-wrap gap-x-2">
          {pm.customerName || pm.customerEmail ? <span>Owner: {pm.customerName || pm.customerEmail}</span> : null}
          {pm.isDefault && <span className="text-brand font-medium">Customer default</span>}
          {pm.isCapturedForActivation && (
            <span className="text-brand font-medium">
              {hasPendingCharge ? "Will be charged when the pending activation completes" : "On file for future billing"}
            </span>
          )}
          {pm.backsLiveSubscription && <span className="text-orange-accent font-medium">Backs a live subscription</span>}
          {pm.customerRole === "LEGACY" && <span>Legacy customer</span>}
        </div>
      </div>
      <div className="flex gap-2">
        {!pm.isCapturedForActivation && (
          <button disabled={busy} onClick={makeDefault} className="text-xs border border-app-border rounded-lg px-2 py-1 hover:bg-app-bg text-text-primary">Make default</button>
        )}
        <button disabled={busy} onClick={remove} className="text-xs border border-app-border rounded-lg px-2 py-1 hover:bg-app-bg text-red-600">Remove</button>
      </div>
    </div>
  );
}

// ── Migration triage card ──────────────────────────────────────────────────

// Group A/B/C were one-time migration-planning shorthand — DEPRECATED and no
// longer offered. A member still carrying one shows it as a legacy value so
// the owner can move them to an operational state.
const GROUPS: ReadonlyArray<readonly [string, string]> = [
  ["", "— Unclassified —"], ["LEAVE_ALONE", "Leave alone"], ["FUTURE_FOLLOW_UP", "Future follow-up"],
  ["NEEDS_PAYMENT_METHOD", "Needs payment method"],
];
const LEGACY_GROUP_LABELS: Record<string, string> = {
  A: "Group A (legacy — pick a new state)",
  B: "Group B (legacy — pick a new state)",
  C: "Group C (legacy — pick a new state)",
};
const ACTIONS = [
  ["", "— None —"], ["MANUAL_APPROVE", "Manual approve"], ["ACTIVATION_EMAIL", "Reactivation email"],
  ["LEAVE_ALONE", "Leave alone"], ["FUTURE_FOLLOW_UP", "Future follow-up"], ["NEEDS_CARD", "Needs card"],
  ["OWNER_REVIEW", "Owner review"],
] as const;

function TriageCard({ data, memberId, onSaved }: { data: Data; memberId: string; onSaved: () => void }) {
  const mig = data.migration;
  const [group, setGroup] = useState(mig.group ?? "");
  const [action, setAction] = useState(mig.finalAction ?? "");
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
        migrationGroup: group || null,
        migrationFinalAction: action || null,
        migrationGroupNote: note || null,
        migrationFinalBillingDate: finalDate || null,
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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <label className="text-xs text-text-muted">Owner state
          <select value={group} onChange={(e) => setGroup(e.target.value)} className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary">
            {LEGACY_GROUP_LABELS[group] && <option value={group}>{LEGACY_GROUP_LABELS[group]}</option>}
            {GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="text-xs text-text-muted">Final action
          <select value={action} onChange={(e) => setAction(e.target.value)} className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary">
            {ACTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label className="text-xs text-text-muted">Final billing date
          <input type="date" value={finalDate} onChange={(e) => setFinalDate(e.target.value)} className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary" />
        </label>
        <label className="text-xs text-text-muted">Note
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. decide July payment" className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary" />
        </label>
      </div>
      {finalDate && new Date(finalDate + "T23:59:59") < new Date() && (
        <p className="text-xs text-orange-accent mt-2">That date is in the past — activation flows will demand a new future date or an explicit immediate-charge confirmation.</p>
      )}
      {err && <p className="text-xs text-red-600 mt-2">{err}</p>}
      <div className="mt-3 flex items-center gap-3">
        <button disabled={busy} onClick={save} className="text-sm bg-charcoal text-white rounded-lg px-4 py-1.5 hover:bg-charcoal-hover">{busy ? "Saving…" : "Save triage"}</button>
        {saved && <span className="text-xs text-text-muted">Saved.</span>}
      </div>
    </Card>
  );
}

// ── Danger zone ────────────────────────────────────────────────────────────

function DangerCard({ data, memberId, onDone, onMsg }: { data: Data; memberId: string; onDone: () => void; onMsg: (s: string) => void }) {
  const [busy, setBusy] = useState(false);
  const pendingActivation =
    data.migration.approvalStatus === "PENDING_APPROVAL" ||
    data.migration.migrationStatus === "INVITED" ||
    data.migration.migrationStatus === "ACTIVATED";

  const cancelPending = async () => {
    if (!confirm("Cancel the pending activation?\n\nBefore: the activation link works and the member awaits approval.\nAfter: the link stops working, approval state clears, and the member returns to the imported pool.\n\nAll history, requests, and any saved card are preserved. Nothing is charged.")) return;
    setBusy(true);
    const r = await fetch(`/api/members/${memberId}/billing-admin/actions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel_pending_activation", confirm: true }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { onMsg("Pending activation canceled — history preserved."); onDone(); }
    else onMsg(d.error || "Could not cancel.");
  };

  if (!pendingActivation) return null;
  return (
    <Card title="Pending activation" className="lg:col-span-2">
      <p className="text-xs text-text-muted mb-2">
        This member has an activation in flight. Canceling invalidates the link without deleting any history.
      </p>
      <button disabled={busy} onClick={cancelPending} className="text-sm border border-red-300 text-red-600 rounded-lg px-4 py-1.5 hover:bg-red-50">
        {busy ? "Working…" : "Cancel pending activation"}
      </button>
    </Card>
  );
}

// ── Edit modal (preview-diff → confirm) ────────────────────────────────────

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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ before: Record<string, unknown>; after: Record<string, unknown>; changed: string[] } | null>(null);

  const plan = useMemo(() => data.plans.find((p) => p.id === planId) ?? null, [data.plans, planId]);

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
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={() => !busy && onClose()}>
      <div className="bg-surface w-full sm:max-w-lg rounded-t-2xl sm:rounded-xl p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-text-primary mb-1">Edit billing setup</h3>
        <p className="text-xs text-text-muted mb-3">
          Saving these changes does not charge the client. They take effect only when the client confirms
          the reactivation offer or an authorized user explicitly activates the membership. If an offer is
          already out, changing these fields marks it out of date — you&apos;ll regenerate and resend.
        </p>

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
            <div className="grid grid-cols-2 gap-3">
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
            <div className="grid grid-cols-3 gap-3">
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
              <button disabled={busy} onClick={onClose} className="text-sm px-4 py-1.5 rounded-lg border border-app-border text-text-primary">Cancel</button>
              <button disabled={busy} onClick={preview} className="text-sm px-4 py-1.5 rounded-lg bg-charcoal text-white hover:bg-charcoal-hover">{busy ? "Checking…" : "Preview changes"}</button>
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
              <button disabled={busy} onClick={() => setDiff(null)} className="text-sm px-4 py-1.5 rounded-lg border border-app-border text-text-primary">Back</button>
              {diff.changed.length > 0 && (
                <button disabled={busy} onClick={commit} className="text-sm px-4 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover">{busy ? "Applying…" : "Apply changes"}</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
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
    else if (d.code === "PLAN_REQUIRED") {
      // No membership configured — the server refuses to draft a $0 offer.
      setErr(d.error || "No membership is configured for this member. Assign a plan (or an explicit $0 price) in the billing setup before creating an offer.");
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

  const send = async () => {
    if (!confirm(`Send the reactivation email now?\n\nIt goes to the client with the secure confirmation link. Sending never charges anything.`)) return;
    setBusy(true); setErr(null);
    const r = await fetch(`/api/members/${memberId}/reactivation/send`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) { setSentMsg(`Email sent to ${d.sentTo} (${d.sendCount}×).`); onChanged(); }
    else setErr(d.error || "Send failed.");
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={() => !busy && onClose()}>
      <div className="bg-surface w-full sm:max-w-2xl rounded-t-2xl sm:rounded-xl p-5 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-text-primary mb-1">Reactivation offer</h3>
        <p className="text-xs text-text-muted mb-3">
          Offer: <strong className="text-text-primary">{data.billing.configured ? data.billing.planName : "No membership configured"}</strong>
          {data.billing.configured
            ? <> — {(data.billing.price ?? 0) <= 0 ? "Free" : `$${(data.billing.price ?? 0).toFixed(2)} ${data.billing.periodLabel ?? ""}`}</>
            : null}
          {data.billing.configured && data.feeBreakdown?.passFees && (data.billing.price ?? 0) > 0
            ? ` ($${data.feeBreakdown.totalCharged.toFixed(2)} charged incl. $${data.feeBreakdown.fee.toFixed(2)} processing fee)`
            : ""}.
          The client reviews these owner-approved terms on a secure page; nothing is charged until they confirm, and
          the first-payment date is spelled out on the button itself.
        </p>

        {preview ? (
          <div>
            <p className="text-xs text-text-muted mb-2">To: <strong className="text-text-primary">{preview.to}</strong> · Subject: <strong className="text-text-primary">{preview.subject}</strong></p>
            <div className="border border-app-border rounded-lg overflow-hidden mb-3 max-h-[50vh] overflow-y-auto bg-white">
              <div dangerouslySetInnerHTML={{ __html: preview.html }} />
            </div>
            {err && <p className="text-xs text-red-600 mb-2">{err}</p>}
            {sentMsg && <p className="text-xs text-text-primary bg-lime-accent/20 rounded-lg px-2 py-1.5 mb-2">{sentMsg}</p>}
            <div className="flex justify-end gap-2">
              <button disabled={busy} onClick={() => setPreview(null)} className="text-sm px-4 py-1.5 rounded-lg border border-app-border text-text-primary">Back</button>
              <button disabled={busy} onClick={send} className="text-sm px-4 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover">
                {busy ? "Sending…" : open?.status === "SENT" ? "Resend email" : "Send email"}
              </button>
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
              <div className="border border-orange-accent/50 bg-orange-accent/10 rounded-lg px-3 py-2 text-xs text-text-primary">
                That date is today or already passed — if the client confirms, <strong>they are charged immediately</strong>.
                Pick a future date (recommended), or explicitly proceed:
                <button disabled={busy} onClick={() => createOffer(true)} className="ml-2 underline text-orange-accent font-medium">Proceed with immediate charge</button>
              </div>
            )}
            {err && <p className="text-xs text-red-600">{err}</p>}
            {sentMsg && <p className="text-xs text-text-primary bg-lime-accent/20 rounded-lg px-2 py-1.5">{sentMsg}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button disabled={busy} onClick={onClose} className="text-sm px-4 py-1.5 rounded-lg border border-app-border text-text-primary">Close</button>
              <button disabled={busy} onClick={() => createOffer(false)} className="text-sm px-4 py-1.5 rounded-lg bg-charcoal text-white hover:bg-charcoal-hover">
                {busy ? "Working…" : open ? "Regenerate offer" : "Create offer"}
              </button>
              <button disabled={busy || !open} onClick={loadPreview} title={!open ? "Create the offer first" : undefined}
                className="text-sm px-4 py-1.5 rounded-lg bg-brand text-white hover:bg-brand-hover disabled:opacity-50">
                Preview email
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
