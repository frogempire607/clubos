"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { UserCheck, Ban, CreditCard, ChevronDown, ChevronUp, AlertTriangle, FilePen } from "lucide-react";
import MembersTabs from "@/components/MembersTabs";

type Requester = { name: string | null; email: string | null } | null;

type GuardianApproval = {
  id: string;
  kind: "GUARDIAN_LINK";
  memberId: string;
  memberName: string;
  requestedAt: string;
  requester: Requester;
  relationship: string | null;
};

type CancelApproval = {
  id: string;
  kind: "MEMBERSHIP_CANCEL";
  memberId: string;
  memberName: string;
  requestedAt: string;
  requester: Requester;
  optionLabel: string | null;
  reason: string | null;
  amount: number | null;
};

type MigrationApproval = {
  id: string;
  kind: "MIGRATION_BILLING";
  memberId: string;
  memberName: string;
  requestedAt: string;
  optionLabel: string;
  price: number | null;
  billingPeriod: string;
  paymentMethod: string | null;
  requestedBillingDate: string | null;
  requestedCancellationDate: string | null;
};

type PurchaseApproval = {
  id: string;
  kind: "MEMBERSHIP_PURCHASE" | "PRIVATE_PACKAGE_PURCHASE";
  memberId: string;
  memberName: string;
  requestedAt: string;
  requester: Requester;
  planName: string;
  optionLabel: string | null;
  paymentMethod: string | null;
  amount: number | null;
  discountCode?: string | null;
};

type SplitApproval = {
  id: string;
  kind: "INVOICE_SPLIT";
  memberId: string;
  memberName: string;
  requestedAt: string;
  requester: Requester;
  responderName: string | null;
  proposerPercent: number | null;
  responderPercent: number | null;
};

type ChangeRequestFields = {
  membership?: string | null;
  purchaseOption?: string | null;
  billingDate?: string | null;
  frequency?: string | null;
  payer?: string | null;
  paymentMethod?: string | null;
} | null;

type ChangeRequestApproval = {
  id: string;
  kind: "REACTIVATION_CHANGE_REQUEST";
  memberId: string;
  memberName: string;
  requestedAt: string;
  reactivationId: string;
  offerVersion: number;
  request: {
    fields?: ChangeRequestFields;
    note?: string | null;
    requestedAt?: string | null;
    byEmail?: string | null;
  } | null;
};

type Approval =
  | GuardianApproval
  | CancelApproval
  | MigrationApproval
  | PurchaseApproval
  | SplitApproval
  | ChangeRequestApproval;
type CancelMode = "PERIOD_END" | "IMMEDIATE" | "IMMEDIATE_REFUND";

const CHANGE_REQUEST_FIELD_LABELS: [keyof NonNullable<ChangeRequestFields>, string][] = [
  ["membership", "Membership"],
  ["purchaseOption", "Purchase option"],
  ["billingDate", "Billing date"],
  ["frequency", "Frequency"],
  ["payer", "Payer"],
  ["paymentMethod", "Payment method"],
];

// ── Billing review panel data (GET /api/members/[id]/billing-admin) ────────
// The route returns a large object; everything here is rendered defensively.
type BillingAdminData = {
  billingState?: { key?: string; label?: string; explanation?: string } | null;
  hasPendingCharge?: boolean;
  anchorMismatch?: boolean;
  stripeReadError?: boolean;
  feeBreakdown?: { passFees?: boolean; base?: number; fee?: number; totalCharged?: number } | null;
  billing?: {
    // FALSE ⇒ the member has NO membership configured: plan/price/period are
    // null, the fee breakdown is zeroed, and offer creation is blocked
    // server-side (400 PLAN_REQUIRED). Never render "Free" for these members.
    configured?: boolean;
    planName?: string | null;
    optionLabel?: string | null;
    price?: number | null;
    periodLabel?: string | null;
    startDate?: string | null;
    billingAnchorDate?: string | null;
    finalBillingDate?: string | null;
    nextBillingDate?: string | null;
    commitmentEndDate?: string | null;
    stripeStatus?: string | null;
    chargeTiming?: { immediate?: boolean; label?: string } | null;
  } | null;
  payer?: { name?: string | null; email?: string | null } | null;
  guardians?: { name?: string | null; email?: string | null; isPayer?: boolean }[] | null;
  paymentMethods?: {
    ref?: string;
    brand?: string | null;
    last4?: string | null;
    cardholder?: string | null;
    isDefault?: boolean;
    backsLiveSubscription?: boolean;
  }[] | null;
  subscriptions?: {
    id?: string;
    optionLabel?: string | null;
    price?: number | null;
    billingPeriod?: string | null;
    status?: string | null;
    stripeStatus?: string | null;
    hasStripe?: boolean;
  }[] | null;
  reactivation?: {
    status?: string;
    offerVersion?: number;
    updatedAt?: string | null;
    open?: boolean;
    sync?: { matches?: boolean; changed?: string[] } | null;
  } | null;
  history?: { at?: string; action?: string; message?: string | null; actorName?: string | null }[] | null;
};

const LIVE_STRIPE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);

function requesterLabel(r: Requester): string {
  if (!r) return "Someone";
  if (r.name && r.email) return `${r.name} (${r.email})`;
  return r.name || r.email || "Someone";
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

// Billing anchors/final/commitment dates are date-only 00:00-UTC values —
// always render them in UTC so "Jul 12" can't display as "Jul 11".
function fmtDateUTC(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
    });
  } catch {
    return "—";
  }
}

function money(n: number | null): string {
  return n == null ? "" : `$${n.toFixed(2)}`;
}

function periodLabel(p: string): string {
  const map: Record<string, string> = {
    WEEKLY: "wk", MONTHLY: "mo", QUARTERLY: "qtr", SEMIANNUAL: "6 mo", ANNUAL: "yr", ANNUALLY: "yr",
  };
  return map[p?.toUpperCase()] || p?.toLowerCase() || "mo";
}

export default function MembersApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [cancelMode, setCancelMode] = useState<Record<string, CancelMode>>({});
  const [reviewOpen, setReviewOpen] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string; href?: string; hrefLabel?: string } | null>(null);
  // memberId → billing.configured from /billing-admin. FALSE means the member
  // has NO membership configured — the card swaps "Activate now" for a
  // profile-only approval and never implies a charge. undefined = not known yet.
  const [configuredMap, setConfiguredMap] = useState<Record<string, boolean>>({});
  const configuredFetched = useRef(new Set<string>());

  const setConfigured = useCallback((memberId: string, v: boolean) => {
    setConfiguredMap((m) => (m[memberId] === v ? m : { ...m, [memberId]: v }));
  }, []);

  const load = useCallback(async () => {
    const res = await fetch("/api/approvals");
    if (res.ok) {
      const d = await res.json();
      setApprovals((d.approvals as Approval[]) ?? []);
    } else {
      setApprovals([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Learn billing.configured for each MIGRATION_BILLING card up front so the
  // primary action is correct without opening the review panel.
  useEffect(() => {
    if (!approvals) return;
    for (const a of approvals) {
      if (a.kind !== "MIGRATION_BILLING") continue;
      if (configuredFetched.current.has(a.memberId)) continue;
      configuredFetched.current.add(a.memberId);
      fetch(`/api/members/${a.memberId}/billing-admin`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: BillingAdminData | null) => {
          const c = d?.billing?.configured;
          if (typeof c === "boolean") setConfigured(a.memberId, c);
        })
        .catch(() => {});
    }
  }, [approvals, setConfigured]);

  async function actGuardian(a: GuardianApproval, decision: "APPROVE" | "DECLINE") {
    setBusyId(a.id);
    setError("");
    const res = await fetch(`/api/members/${a.memberId}/guardians/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: a.id, decision }),
    });
    setBusyId(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Could not complete that action.");
      return;
    }
    load();
  }

  async function actCancel(a: CancelApproval, decision: "APPROVE" | "DECLINE") {
    setBusyId(a.id);
    setError("");
    const mode = cancelMode[a.id] || "PERIOD_END";
    const res = await fetch(`/api/approvals/membership-cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: a.id, decision, mode }),
    });
    setBusyId(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Could not complete that action.");
      return;
    }
    load();
  }

  async function actPurchase(a: PurchaseApproval, decision: "APPROVE" | "DECLINE") {
    setBusyId(a.id);
    setError("");
    const endpoint =
      a.kind === "MEMBERSHIP_PURCHASE"
        ? "/api/approvals/membership-purchase"
        : "/api/approvals/private-package-purchase";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: a.id, decision }),
    });
    setBusyId(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Could not complete that action.");
      return;
    }
    load();
  }

  async function actSplit(a: SplitApproval, decision: "APPROVE" | "DECLINE") {
    setBusyId(a.id);
    setError("");
    const res = await fetch(`/api/approvals/invoice-split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId: a.id, decision }),
    });
    setBusyId(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Could not complete that action.");
      return;
    }
    load();
  }

  async function approveMigration(a: MigrationApproval) {
    setBusyId(a.id);
    setError("");
    setNotice(null);
    // Approve with the billing anchor the route derives (accept the member's
    // requested date if they asked for one). Use the migration tool for finer
    // date control.
    const res = await fetch(`/api/members/migration/${a.memberId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acceptRequestedDate: !!a.requestedBillingDate }),
    });
    setBusyId(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      const msg = typeof d.error === "string" ? d.error : "Could not approve this membership.";
      if (d.code === "PLAN_REQUIRED") {
        // No plan and no imported plan name — the server refuses to start
        // billing. Point at the billing center and flip the card's action.
        setConfigured(a.memberId, false);
        setNotice({
          tone: "error",
          text: msg,
          href: `/dashboard/members/${a.memberId}/billing`,
          hrefLabel: "Open billing center",
        });
        return;
      }
      setError(msg);
      return;
    }
    load();
  }

  async function approveProfileOnly(a: MigrationApproval) {
    if (
      !confirm(
        `Approve ${a.memberName}'s profile only?\n\nThis completes the profile review. It creates NO membership, starts NO subscription, and charges nothing — ${a.memberName} remains a prospect until a membership is assigned in the billing center.`,
      )
    )
      return;
    setBusyId(a.id);
    setError("");
    setNotice(null);
    const res = await fetch(`/api/members/migration/${a.memberId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileOnly: true }),
    });
    const d = await res.json().catch(() => ({}));
    setBusyId(null);
    if (!res.ok) {
      setError(typeof d.error === "string" ? d.error : "Could not approve the profile.");
      return;
    }
    setNotice({
      tone: "success",
      text: `Profile approved — ${a.memberName} remains a prospect until a membership is assigned.`,
      href: `/dashboard/members/${a.memberId}/billing`,
      hrefLabel: "Open billing center",
    });
    load();
  }

  async function actChangeRequest(
    a: ChangeRequestApproval,
    action: "APPROVE" | "DENY",
    acknowledgeImmediateCharge = false,
  ) {
    if (action === "DENY" && !acknowledgeImmediateCharge) {
      if (!confirm("Deny this change request?\n\nThe original offer unlocks and the client can confirm it as-is.")) return;
    }
    setBusyId(a.id);
    setError("");
    setNotice(null);
    const res = await fetch(`/api/members/${a.memberId}/reactivation/change-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reactivationId: a.reactivationId,
        action,
        ...(acknowledgeImmediateCharge ? { acknowledgeImmediateCharge: true } : {}),
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusyId(null);
    if (!res.ok) {
      const msg = typeof d.error === "string" ? d.error : "Could not resolve the change request.";
      if (d.code === "IMMEDIATE_CHARGE_CONFIRM_REQUIRED") {
        // Explicit second confirm — the server says the current billing date is
        // today/past, so a confirmed offer would charge immediately.
        if (confirm(`${msg}\n\nApprove anyway? If the client confirms the new offer they are charged immediately.`)) {
          await actChangeRequest(a, action, true);
        }
        return;
      }
      if (d.code === "DATE_REQUIRED") {
        setNotice({
          tone: "error",
          text: msg,
          href: `/dashboard/members/${a.memberId}/billing`,
          hrefLabel: "Open billing center",
        });
        return;
      }
      setError(msg);
      return;
    }
    if (action === "APPROVE") {
      const v = typeof d.newOfferVersion === "number" ? `v${d.newOfferVersion}` : "version";
      setNotice({
        tone: "success",
        text: `New offer ${v} drafted for ${a.memberName} — preview and send it from the billing center. Nothing has been charged.`,
        href: `/dashboard/members/${a.memberId}/billing`,
        hrefLabel: "Open billing center",
      });
    } else {
      setNotice({ tone: "success", text: `Change request denied — ${a.memberName}'s original offer is unlocked again.` });
    }
    load();
  }

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
      <MembersTabs />
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Approvals</h1>
        <p className="text-sm text-text-muted mt-1">
          Requests that need your sign-off — new membership billing, guardian access, and cancellations.
        </p>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}
      {notice && (
        <div
          className={`mb-4 text-sm rounded-lg px-3 py-2 border ${
            notice.tone === "success"
              ? "text-text-primary bg-lime-accent/20 border-lime-accent/40"
              : "text-red-600 bg-red-50 border-red-200"
          }`}
        >
          {notice.text}
          {notice.href && (
            <>
              {" "}
              <Link href={notice.href} className="underline font-medium">
                {notice.hrefLabel || "Open billing center"}
              </Link>
            </>
          )}
        </div>
      )}

      {approvals === null ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-28 rounded-xl border border-app-border bg-surface animate-pulse" />
          ))}
        </div>
      ) : approvals.length === 0 ? (
        <div className="rounded-xl border border-app-border bg-surface p-10 text-center">
          <div className="w-12 h-12 rounded-full bg-app-bg flex items-center justify-center mx-auto mb-3">
            <UserCheck className="text-text-muted" size={22} />
          </div>
          <p className="text-sm font-medium text-text-primary">You&apos;re all caught up</p>
          <p className="text-xs text-text-muted mt-1">
            New membership billing, guardian-access, and cancellation requests will appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {approvals.map((a) => {
            if (a.kind === "MIGRATION_BILLING") {
              // FALSE ⇒ no membership configured (billing-admin is authoritative).
              // undefined = still loading; keep the standard actions until known.
              const unconfigured = configuredMap[a.memberId] === false;
              return (
                <div key={a.id} className="rounded-xl border border-app-border bg-surface p-4">
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold text-brand bg-brand/10 rounded px-2 py-0.5 mb-2">
                      <CreditCard size={11} /> Membership billing
                    </span>
                    {unconfigured && a.price == null ? (
                      <p className="text-sm text-text-primary">
                        <strong>{a.memberName}</strong> completed their profile — no membership configured yet.
                      </p>
                    ) : (
                      <p className="text-sm text-text-primary">
                        <strong>{a.memberName}</strong> activated and is ready to start{" "}
                        <strong>{a.optionLabel}</strong>
                        {a.price != null ? ` — ${money(a.price)}/${periodLabel(a.billingPeriod)}` : ""}.
                      </p>
                    )}
                    <p className="text-xs text-text-muted mt-1">
                      {a.paymentMethod === "CASH"
                        ? "Paying by cash"
                        : a.paymentMethod === "CHECK"
                          ? "Paying by check"
                          : a.paymentMethod === "LATER"
                            ? "Will add a card later"
                            : "Card on file"}
                      {a.requestedBillingDate ? ` · requested billing ${fmtDate(a.requestedBillingDate)}` : ""}
                      {a.requestedCancellationDate ? ` · ends ${fmtDate(a.requestedCancellationDate)}` : ""}
                      {" · "}activated {fmtDate(a.requestedAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    <button
                      onClick={() => setReviewOpen((m) => ({ ...m, [a.id]: !m[a.id] }))}
                      className="inline-flex items-center gap-1.5 text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
                    >
                      Review billing
                      {reviewOpen[a.id] ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                    <Link
                      href={`/dashboard/members/migration`}
                      className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
                    >
                      Set billing date…
                    </Link>
                  </div>
                  {reviewOpen[a.id] && (
                    <BillingReviewPanel memberId={a.memberId} onConfigured={(v) => setConfigured(a.memberId, v)} />
                  )}
                  <div className="mt-3 pt-3 border-t border-app-border">
                    {unconfigured ? (
                      <button
                        onClick={() => approveProfileOnly(a)}
                        disabled={busyId === a.id}
                        className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                      >
                        {busyId === a.id ? "Working…" : "Approve profile (no membership)"}
                      </button>
                    ) : (
                      <button
                        onClick={() => approveMigration(a)}
                        disabled={busyId === a.id}
                        className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                      >
                        {busyId === a.id ? "Working…" : "Activate now (charges per timing above)"}
                      </button>
                    )}
                  </div>
                </div>
              );
            }

            if (a.kind === "REACTIVATION_CHANGE_REQUEST") {
              const fields = a.request?.fields ?? null;
              const requestedFields = CHANGE_REQUEST_FIELD_LABELS.filter(([key]) => !!fields?.[key]);
              const note = a.request?.note ?? null;
              const byEmail = a.request?.byEmail ?? null;
              return (
                <div key={a.id} className="rounded-xl border border-app-border bg-surface p-4">
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold text-orange-accent bg-orange-accent/10 rounded px-2 py-0.5 mb-2">
                      <FilePen size={11} /> Offer change request
                    </span>
                    <p className="text-sm text-text-primary">
                      <strong>{a.memberName}</strong> asked for changes to offer v{a.offerVersion}.
                    </p>
                    {requestedFields.length > 0 && (
                      <dl className="mt-2 space-y-1">
                        {requestedFields.map(([key, label]) => (
                          <div key={key} className="flex gap-2 text-xs">
                            <dt className="w-28 shrink-0 text-text-muted">{label}</dt>
                            <dd className="text-text-primary font-medium min-w-0 break-words">{fields?.[key]}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                    {note && <p className="text-xs text-text-muted mt-2 italic">“{note}”</p>}
                    <p className="text-xs text-text-muted mt-1">
                      Requested {fmtDate(a.requestedAt)}
                      {byEmail ? ` by ${byEmail}` : ""} · the offer is locked until you approve or deny.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    <button
                      onClick={() => actChangeRequest(a, "APPROVE")}
                      disabled={busyId === a.id}
                      className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                    >
                      {busyId === a.id ? "Working…" : "Approve & regenerate offer"}
                    </button>
                    <button
                      onClick={() => actChangeRequest(a, "DENY")}
                      disabled={busyId === a.id}
                      className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50"
                    >
                      Deny request
                    </button>
                    <Link
                      href={`/dashboard/members/${a.memberId}/billing`}
                      className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
                    >
                      Edit in billing center
                    </Link>
                  </div>
                </div>
              );
            }

            if (a.kind === "MEMBERSHIP_PURCHASE" || a.kind === "PRIVATE_PACKAGE_PURCHASE") {
              const isPack = a.kind === "PRIVATE_PACKAGE_PURCHASE";
              const method = a.paymentMethod === "CHECK" ? "check" : "cash";
              return (
                <div key={a.id} className="rounded-xl border border-app-border bg-surface p-4">
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold text-brand bg-brand/10 rounded px-2 py-0.5 mb-2">
                      <CreditCard size={11} /> {isPack ? "Lesson package" : "Membership purchase"} — {method}
                    </span>
                    <p className="text-sm text-text-primary">
                      <strong>{requesterLabel(a.requester)}</strong> wants{" "}
                      <strong>
                        {a.planName}
                        {a.optionLabel ? ` — ${a.optionLabel}` : ""}
                      </strong>{" "}
                      for <strong>{a.memberName}</strong>
                      {a.amount != null ? ` (${money(a.amount)})` : ""}, paying by {method}.
                      {a.discountCode ? <> Discount code <strong className="font-mono">{a.discountCode}</strong> applied — approving accepts the discounted price.</> : null}
                    </p>
                    <p className="text-xs text-text-muted mt-1">
                      Approving {isPack ? "adds the lesson credits" : "starts the membership"} right away and
                      records an unpaid {method} invoice in Financials. Requested {fmtDate(a.requestedAt)}.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => actPurchase(a, "APPROVE")}
                      disabled={busyId === a.id}
                      className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                    >
                      {busyId === a.id ? "Working…" : isPack ? "Approve & add credits" : "Approve & start membership"}
                    </button>
                    <button
                      onClick={() => actPurchase(a, "DECLINE")}
                      disabled={busyId === a.id}
                      className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50"
                    >
                      Decline
                    </button>
                  </div>
                </div>
              );
            }

            if (a.kind === "INVOICE_SPLIT") {
              return (
                <div key={a.id} className="rounded-xl border border-app-border bg-surface p-4">
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold text-brand bg-brand/10 rounded px-2 py-0.5 mb-2">
                      <CreditCard size={11} /> Invoice split
                    </span>
                    <p className="text-sm text-text-primary">
                      <strong>{requesterLabel(a.requester)}</strong>
                      {a.responderName ? (
                        <>
                          {" "}and <strong>{a.responderName}</strong>
                        </>
                      ) : null}{" "}
                      agreed to split <strong>{a.memberName}</strong>&apos;s costs
                      {a.proposerPercent != null && a.responderPercent != null
                        ? ` ${a.proposerPercent}% / ${a.responderPercent}%`
                        : ""}
                      . Both guardians have approved.
                    </p>
                    <p className="text-xs text-text-muted mt-1">
                      Approving makes this the family&apos;s standing arrangement — each guardian pays
                      their share with their own payment method. Requested {fmtDate(a.requestedAt)}.
                    </p>
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => actSplit(a, "APPROVE")}
                      disabled={busyId === a.id}
                      className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                    >
                      {busyId === a.id ? "Working…" : "Approve split"}
                    </button>
                    <button
                      onClick={() => actSplit(a, "DECLINE")}
                      disabled={busyId === a.id}
                      className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50"
                    >
                      Decline
                    </button>
                  </div>
                </div>
              );
            }

            if (a.kind === "GUARDIAN_LINK") {
              return (
                <div key={a.id} className="rounded-xl border border-app-border bg-surface p-4">
                  <div className="min-w-0">
                    <span className="inline-block text-[10px] uppercase tracking-wide font-semibold text-brand bg-brand/10 rounded px-2 py-0.5 mb-2">
                      Guardian access
                    </span>
                    <p className="text-sm text-text-primary">
                      <strong>{requesterLabel(a.requester)}</strong> wants to manage{" "}
                      <strong>{a.memberName}</strong>
                      {a.relationship ? ` as ${a.relationship.toLowerCase()}` : ""}.
                    </p>
                    <p className="text-xs text-text-muted mt-1">Requested {fmtDate(a.requestedAt)}</p>
                  </div>
                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => actGuardian(a, "APPROVE")}
                      disabled={busyId === a.id}
                      className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                    >
                      {busyId === a.id ? "Working…" : "Approve access"}
                    </button>
                    <button
                      onClick={() => actGuardian(a, "DECLINE")}
                      disabled={busyId === a.id}
                      className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50"
                    >
                      Decline
                    </button>
                  </div>
                </div>
              );
            }

            // MEMBERSHIP_CANCEL (explicit narrow — TS can't subtract the
            // two-literal PurchaseApproval discriminant from the union)
            if (a.kind !== "MEMBERSHIP_CANCEL") return null;
            return (
              <div key={a.id} className="rounded-xl border border-app-border bg-surface p-4">
                <div className="min-w-0">
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold text-orange-accent bg-orange-accent/10 rounded px-2 py-0.5 mb-2">
                    <Ban size={11} /> Cancellation
                  </span>
                  <p className="text-sm text-text-primary">
                    <strong>{requesterLabel(a.requester)}</strong> requested to cancel{" "}
                    <strong>{a.optionLabel || "a membership"}</strong> for <strong>{a.memberName}</strong>
                    {a.amount != null ? ` (${money(a.amount)})` : ""}.
                  </p>
                  {a.reason && <p className="text-xs text-text-muted mt-1 italic">“{a.reason}”</p>}
                  <p className="text-xs text-text-muted mt-1">Requested {fmtDate(a.requestedAt)}</p>
                </div>
                <div className="mt-3 space-y-2">
                  <div>
                    <label className="block text-[11px] font-medium text-text-muted mb-1">When it takes effect</label>
                    <select
                      value={cancelMode[a.id] || "PERIOD_END"}
                      onChange={(e) => setCancelMode((m) => ({ ...m, [a.id]: e.target.value as CancelMode }))}
                      className="w-full sm:w-72 px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
                    >
                      <option value="PERIOD_END">End of current billing period (no refund)</option>
                      <option value="IMMEDIATE">Immediately, no refund</option>
                      <option value="IMMEDIATE_REFUND">Immediately + refund last payment</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => actCancel(a, "APPROVE")}
                      disabled={busyId === a.id}
                      className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                    >
                      {busyId === a.id ? "Working…" : "Approve cancellation"}
                    </button>
                    <button
                      onClick={() => actCancel(a, "DECLINE")}
                      disabled={busyId === a.id}
                      className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50"
                    >
                      Keep active
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Inline billing review panel (per MIGRATION_BILLING card) ───────────────
// Lazy-fetches the authoritative billing service and shows the final-review
// facts + offer actions. All actions reuse existing endpoints; editing lives
// in the billing center and never charges — billing starts only on client
// confirmation or the explicit activate button on the card.
function BillingReviewPanel({
  memberId,
  onConfigured,
}: {
  memberId: string;
  onConfigured?: (configured: boolean) => void;
}) {
  const [data, setData] = useState<BillingAdminData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState("");
  const [actionErr, setActionErr] = useState("");
  const [preview, setPreview] = useState<{ subject?: string; html?: string; to?: string } | null>(null);

  // Keep the callback out of refresh's deps so a parent re-render (new inline
  // arrow) never re-triggers the fetch effect.
  const onConfiguredRef = useRef(onConfigured);
  onConfiguredRef.current = onConfigured;

  const refresh = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch(`/api/members/${memberId}/billing-admin`);
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setLoadError(typeof d.error === "string" ? d.error : "Could not load billing details.");
        setData(null);
        return;
      }
      const parsed = (await res.json()) as BillingAdminData;
      setData(parsed);
      if (typeof parsed.billing?.configured === "boolean") onConfiguredRef.current?.(parsed.billing.configured);
    } catch {
      setLoadError("Could not load billing details.");
      setData(null);
    }
  }, [memberId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function createOffer(acknowledgeImmediateCharge = false) {
    setBusy(true);
    setActionErr("");
    setActionMsg("");
    const res = await fetch(`/api/members/${memberId}/reactivation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(acknowledgeImmediateCharge ? { acknowledgeImmediateCharge: true } : {}),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      const msg = typeof d.error === "string" ? d.error : "Could not create the offer.";
      if (d.code === "IMMEDIATE_CHARGE_CONFIRM_REQUIRED") {
        // Explicit second confirm before re-posting with the acknowledgement.
        if (confirm(`${msg}\n\nCreate the offer anyway? If the client confirms it they are charged immediately.`)) {
          await createOffer(true);
        }
        return;
      }
      if (d.code === "PLAN_REQUIRED") {
        // No membership configured (a race — the button is normally disabled).
        // Show the server's message and re-sync the panel so it flips to the
        // "No membership" presentation.
        setActionErr(msg);
        refresh();
        return;
      }
      setActionErr(msg);
      return;
    }
    setActionMsg("Offer drafted — preview it, then send. Nothing has been charged.");
    setPreview(null);
    refresh();
  }

  async function loadPreview() {
    setBusy(true);
    setActionErr("");
    setActionMsg("");
    const res = await fetch(`/api/members/${memberId}/reactivation/preview`);
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setActionErr(typeof d.error === "string" ? d.error : "Preview failed — create the offer first.");
      return;
    }
    setPreview(d as { subject?: string; html?: string; to?: string });
  }

  async function sendOffer() {
    if (!confirm("Send the offer email to the client?")) return;
    setBusy(true);
    setActionErr("");
    setActionMsg("");
    const res = await fetch(`/api/members/${memberId}/reactivation/send`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setActionErr(typeof d.error === "string" ? d.error : "Send failed.");
      return;
    }
    setActionMsg(`Offer email sent to ${typeof d.sentTo === "string" ? d.sentTo : "the client"}. Sending never charges anything.`);
    refresh();
  }

  if (loadError) {
    return (
      <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{loadError}</div>
    );
  }
  if (!data) {
    return <div className="mt-3 h-24 rounded-lg border border-app-border bg-app-bg animate-pulse" />;
  }

  const billing = data.billing ?? null;
  // configured === false ⇒ NO membership: plan shows "No membership", price
  // shows "—" (never "Free"), and charge timing / fees / offer creation hide.
  const unconfigured = billing?.configured === false;
  const price = billing?.price ?? null;
  const timing = billing?.chargeTiming ?? null;
  const fees = data.feeBreakdown ?? null;
  const paymentMethods = data.paymentMethods ?? [];
  const subscriptions = data.subscriptions ?? [];
  const guardians = data.guardians ?? [];
  const history = (data.history ?? []).slice(0, 5);
  const reactivation = data.reactivation ?? null;

  const liveSubs = subscriptions.filter(
    (s) =>
      !!s.hasStripe &&
      (s.status === "active" || s.status === "past_due" || LIVE_STRIPE_STATUSES.has(s.stripeStatus ?? "")),
  );
  const offerOutOfDate = !!reactivation?.open && !!reactivation.sync && reactivation.sync.matches === false;

  const warnings: string[] = [];
  if (!unconfigured && (price ?? 0) > 0 && paymentMethods.length === 0 && !data.stripeReadError) {
    warnings.push("No saved payment method — a paid card membership can't start charging.");
  }
  if (data.stripeReadError) {
    warnings.push("Stripe payment methods couldn't be read right now — card details may be incomplete below.");
  }
  if (!unconfigured && (price ?? 0) > 0 && (!billing?.finalBillingDate || timing?.immediate)) {
    warnings.push("No future first-billing date — activating (or a client confirmation) would charge immediately.");
  }
  if (offerOutOfDate) {
    warnings.push(
      `The open offer is out of date vs the current setup${
        reactivation?.sync?.changed?.length ? ` (changed: ${reactivation.sync.changed.join(", ")})` : ""
      } — regenerate before sending.`,
    );
  }
  if (data.anchorMismatch) {
    warnings.push("Final billing date and imported anchor date disagree — the final date wins when billing starts.");
  }

  const row = (label: string, value: ReactNode) => (
    <div className="flex gap-2 text-xs">
      <dt className="w-32 shrink-0 text-text-muted">{label}</dt>
      <dd className="text-text-primary min-w-0 break-words">{value}</dd>
    </div>
  );

  return (
    <div className="mt-3 rounded-lg border border-app-border bg-app-bg/60 p-3 space-y-3">
      {/* Authoritative state */}
      <div>
        <span className="inline-block text-[10px] uppercase tracking-wide font-semibold text-brand bg-brand/10 rounded px-2 py-0.5">
          {data.billingState?.label || data.billingState?.key || "Billing state unknown"}
        </span>
        {data.billingState?.explanation && (
          <p className="text-xs text-text-muted mt-1">{data.billingState.explanation}</p>
        )}
      </div>

      {liveSubs.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-orange-accent/50 bg-orange-accent/10 px-3 py-2">
          <AlertTriangle size={14} className="text-orange-accent mt-0.5 shrink-0" />
          <p className="text-xs font-semibold text-text-primary">
            Already has a live subscription
            {liveSubs[0]?.optionLabel ? ` (${liveSubs[0].optionLabel})` : ""} — activating could double-bill. Review in
            the billing center first.
          </p>
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="space-y-1">
          {warnings.map((w, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-text-primary">
              <AlertTriangle size={13} className="text-orange-accent mt-0.5 shrink-0" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      {unconfigured && (
        <p className="text-xs text-text-primary bg-app-bg border border-app-border rounded-lg px-2.5 py-1.5">
          No membership configured — assign a real plan in the{" "}
          <Link href={`/dashboard/members/${memberId}/billing`} className="underline font-medium">
            billing center
          </Link>{" "}
          before creating an offer.
        </p>
      )}

      {/* Pricing + billing dates */}
      <dl className="space-y-1">
        {row(
          "Plan",
          unconfigured ? (
            <span className="text-text-muted">No membership</span>
          ) : (
            <>
              {billing?.planName || "—"}
              {billing?.optionLabel ? ` — ${billing.optionLabel}` : ""}
            </>
          ),
        )}
        {row(
          "Price",
          unconfigured || price == null
            ? "—"
            : price <= 0
              ? "Free"
              : `${money(price)}${billing?.periodLabel ? ` ${billing.periodLabel}` : ""}`,
        )}
        {!unconfigured && fees?.passFees && (price ?? 0) > 0 && fees.totalCharged != null && fees.fee != null &&
          row("Total charged", `${money(fees.totalCharged)} incl. ${money(fees.fee)} processing fee`)}
        {!unconfigured && timing?.label &&
          row("Charge timing", timing.immediate ? <strong>{timing.label}</strong> : timing.label)}
        {row("First billing", fmtDateUTC(billing?.finalBillingDate))}
        {billing?.billingAnchorDate && row("Imported anchor", fmtDateUTC(billing.billingAnchorDate))}
        {billing?.startDate && row("Start date", fmtDateUTC(billing.startDate))}
        {billing?.commitmentEndDate && row("Commitment ends", fmtDateUTC(billing.commitmentEndDate))}
        {row(
          "Payer",
          data.payer ? `${data.payer.name || data.payer.email || "Unknown"}${data.payer.name && data.payer.email ? ` (${data.payer.email})` : ""}` : "Member (no designated payer)",
        )}
        {guardians.length > 0 &&
          row(
            "Guardians",
            guardians
              .map((g) => `${g.name || g.email || "Unknown"}${g.isPayer ? " · payer" : ""}`)
              .join(", "),
          )}
        {row(
          "Payment methods",
          paymentMethods.length === 0
            ? "None on file"
            : paymentMethods
                .map(
                  (pm) =>
                    `${pm.brand || "card"} ••••${pm.last4 || "????"}${pm.cardholder ? ` (${pm.cardholder})` : ""}${pm.isDefault ? " · default" : ""}`,
                )
                .join(", "),
        )}
      </dl>

      {/* Subscriptions */}
      {subscriptions.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide font-semibold text-text-muted mb-1">Subscriptions</p>
          <ul className="space-y-1">
            {subscriptions.map((s, i) => (
              <li key={s.id || i} className="text-xs text-text-primary">
                {s.optionLabel || "Membership"} — {s.price != null ? money(s.price) : "?"}
                {s.billingPeriod ? `/${periodLabel(s.billingPeriod)}` : ""} · {s.status || "unknown"}
                {s.stripeStatus ? ` (Stripe: ${s.stripeStatus})` : s.hasStripe ? " (Stripe)" : " (manual)"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Offer status */}
      <div>
        <p className="text-[10px] uppercase tracking-wide font-semibold text-text-muted mb-1">Reactivation offer</p>
        {reactivation ? (
          <p className="text-xs text-text-primary">
            v{reactivation.offerVersion ?? "?"} · {reactivation.status || "unknown"}
            {reactivation.updatedAt ? ` · updated ${fmtDate(reactivation.updatedAt)}` : ""}
            {reactivation.open && reactivation.sync
              ? reactivation.sync.matches
                ? " · matches current setup ✓"
                : ` · out of date ✗${reactivation.sync.changed?.length ? ` (changed: ${reactivation.sync.changed.join(", ")})` : ""}`
              : ""}
          </p>
        ) : (
          <p className="text-xs text-text-muted">No offer yet.</p>
        )}
      </div>

      {/* Recent history */}
      {history.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wide font-semibold text-text-muted mb-1">Recent history</p>
          <ul className="space-y-0.5">
            {history.map((h, i) => (
              <li key={i} className="text-xs text-text-muted">
                <span className="text-text-primary font-medium">{h.action || "EVENT"}</span>
                {" · "}
                {fmtDate(h.at ?? "")}
                {h.actorName ? ` · ${h.actorName}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {actionErr && <p className="text-xs text-red-600">{actionErr}</p>}
      {actionMsg && <p className="text-xs text-text-primary bg-lime-accent/20 rounded-lg px-2 py-1.5">{actionMsg}</p>}

      {/* Email preview (exactly what /send delivers) */}
      {preview && (
        <div className="rounded-lg border border-app-border overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 bg-app-bg">
            <p className="text-xs text-text-muted truncate">
              To: <strong className="text-text-primary">{preview.to || "?"}</strong>
              {preview.subject ? <> · {preview.subject}</> : null}
            </p>
            <button onClick={() => setPreview(null)} className="text-xs text-text-muted underline shrink-0 ml-2">
              Close
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto bg-white">
            <div dangerouslySetInnerHTML={{ __html: preview.html || "" }} />
          </div>
        </div>
      )}

      {/* Review actions — none of these charge anything */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Link
          href={`/dashboard/members/${memberId}/billing`}
          className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-surface"
        >
          Open billing center
        </Link>
        <button
          onClick={() => createOffer()}
          disabled={busy || unconfigured}
          title={unconfigured ? "Assign a membership first" : undefined}
          className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-surface disabled:opacity-50"
        >
          {reactivation?.open ? "Regenerate offer" : "Create offer"}
        </button>
        <button
          onClick={loadPreview}
          disabled={busy || !reactivation?.open}
          className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-surface disabled:opacity-50"
        >
          Preview offer
        </button>
        <button
          onClick={sendOffer}
          disabled={busy || !reactivation?.open}
          className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-surface disabled:opacity-50"
        >
          Send offer
        </button>
      </div>
    </div>
  );
}
