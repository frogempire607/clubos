"use client";

import { useCallback, useEffect, useState } from "react";
import { UserCheck, Ban } from "lucide-react";

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

type Approval = GuardianApproval | CancelApproval;
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

export default function ApprovalsPage() {
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

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Approvals</h1>
        <p className="text-sm text-text-muted mt-1">
          Requests from members and parents that need your sign-off — guardian access and membership cancellations.
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
          <p className="text-xs text-text-muted mt-1">New guardian-access and cancellation requests will appear here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {approvals.map((a) =>
            a.kind === "GUARDIAN_LINK" ? (
              <div key={a.id} className="rounded-xl border border-app-border bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
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
            ) : (
              <div key={a.id} className="rounded-xl border border-app-border bg-surface p-4">
                <div className="min-w-0">
                  <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-semibold text-orange-accent bg-orange-accent/10 rounded px-2 py-0.5 mb-2">
                    <Ban size={11} /> Cancellation
                  </span>
                  <p className="text-sm text-text-primary">
                    <strong>{requesterLabel(a.requester)}</strong> requested to cancel{" "}
                    <strong>{a.optionLabel || "a membership"}</strong> for <strong>{a.memberName}</strong>
                    {a.amount != null ? ` ($${a.amount.toFixed(2)})` : ""}.
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
            ),
          )}
        </div>
      )}
    </div>
  );
}
