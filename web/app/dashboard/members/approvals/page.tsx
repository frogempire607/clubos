"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { UserCheck, Ban, CreditCard } from "lucide-react";
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

type Approval = GuardianApproval | CancelApproval | MigrationApproval;
type CancelMode = "PERIOD_END" | "IMMEDIATE" | "IMMEDIATE_REFUND";

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

  async function approveMigration(a: MigrationApproval) {
    setBusyId(a.id);
    setError("");
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
      setError(typeof d.error === "string" ? d.error : "Could not approve this membership.");
      return;
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
              return (
                <div key={a.id} className="rounded-xl border border-app-border bg-surface p-4">
                  <div className="min-w-0">
                    <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold text-brand bg-brand/10 rounded px-2 py-0.5 mb-2">
                      <CreditCard size={11} /> Membership billing
                    </span>
                    <p className="text-sm text-text-primary">
                      <strong>{a.memberName}</strong> activated and is ready to start{" "}
                      <strong>{a.optionLabel}</strong>
                      {a.price != null ? ` — ${money(a.price)}/${periodLabel(a.billingPeriod)}` : ""}.
                    </p>
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
                      onClick={() => approveMigration(a)}
                      disabled={busyId === a.id}
                      className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
                    >
                      {busyId === a.id ? "Working…" : "Approve & start membership"}
                    </button>
                    <Link
                      href={`/dashboard/members/migration`}
                      className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
                    >
                      Set billing date…
                    </Link>
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

            // MEMBERSHIP_CANCEL
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
