"use client";

// Move a membership to another family member.
//
// One component for both actors. The server decides which one you are and
// whether your action takes effect immediately or files for approval; this just
// renders what it's told. That keeps the client from ever implying an outcome
// the server won't honor — a parent must never see "Done" when what actually
// happened was "sent to the club".
//
// The whole point of the screen is that the reader ends up understanding one
// thing: the athlete changes, the payment does not.

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, AlertTriangle, CreditCard, Loader2, X, Check } from "lucide-react";

type Target = { memberId: string; name: string; isMinor: boolean; hasActiveMembership: boolean };

type Preview = {
  subscriptionId: string;
  planName: string;
  optionLabel: string | null;
  price: string;
  billingPeriod: string | null;
  status: string;
  from: { memberId: string; name: string };
  to: { memberId: string; name: string } | null;
  payer: { userId: string | null; name: string };
  isLiveStripe: boolean;
  usage: {
    attendanceCount: number;
    bookingCount: number;
    transactionCount: number;
    hasUsage: boolean;
  };
  billingNote: string;
  eligibleTargets: Target[];
  blockers: { code: string; message: string }[];
  actor: "STAFF" | "ACCOUNT_HOLDER";
  requiresApproval: boolean;
};

export default function TransferMembershipModal({
  subscriptionId,
  onClose,
  onDone,
}: {
  subscriptionId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [targetId, setTargetId] = useState("");
  const [reason, setReason] = useState("");
  const [ackBilling, setAckBilling] = useState(false);
  const [ackUsage, setAckUsage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(
    async (target: string) => {
      const res = await fetch(
        `/api/member-subscriptions/${subscriptionId}/transfer${target ? `?targetMemberId=${target}` : ""}`,
      );
      if (!res.ok) {
        setErr((await res.json().catch(() => ({}))).error ?? "Could not load this membership.");
        return;
      }
      setPreview(await res.json());
    },
    [subscriptionId],
  );

  useEffect(() => { void load(targetId); }, [load, targetId]);

  async function submit() {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/member-subscriptions/${subscriptionId}/transfer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetMemberId: targetId,
        reason: reason.trim() || null,
        acknowledgeBillingUnchanged: true,
        acknowledgeUsage: ackUsage,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setErr(d.error ?? "Could not move this membership.");
      return;
    }
    setDone(d.message ?? "Done.");
  }

  const blockingTarget = preview?.blockers.find((b) => b.code !== "NOT_TRANSFERABLE");
  const hardBlock = preview?.blockers.find((b) => b.code === "NOT_TRANSFERABLE");
  const canSubmit =
    !!targetId && ackBilling && !busy && !blockingTarget && !hardBlock &&
    (!preview?.usage.hasUsage || ackUsage);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-surface w-full sm:max-w-lg rounded-t-2xl sm:rounded-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border sticky top-0 bg-surface">
          <h2 className="text-sm font-semibold text-text-primary">Move this membership</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary">
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        {!preview ? (
          <div className="p-8 flex items-center justify-center text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} />
          </div>
        ) : done ? (
          <div className="p-6 text-center">
            <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
              <Check className="h-7 w-7" strokeWidth={2} />
            </div>
            <p className="text-sm text-text-primary">{done}</p>
            <button
              onClick={() => { onDone(); onClose(); }}
              className="mt-4 px-4 py-2 rounded-lg bg-charcoal text-white text-sm hover:bg-charcoal-hover"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            {/* What's moving */}
            <div className="rounded-lg bg-app-bg px-3 py-2.5">
              <p className="text-sm font-medium text-text-primary">
                {preview.planName}
                {preview.optionLabel ? ` — ${preview.optionLabel}` : ""}
              </p>
              <p className="text-xs text-text-muted mt-0.5">
                ${preview.price}
                {preview.billingPeriod ? ` / ${preview.billingPeriod.toLowerCase()}` : ""} · {preview.status}
              </p>
            </div>

            {hardBlock && (
              <p className="text-sm text-red-600 flex items-start gap-1.5">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" strokeWidth={2} />
                {hardBlock.message}
              </p>
            )}

            {/* From → To */}
            <div>
              <label className="block text-xs font-medium text-text-primary mb-1.5">
                Who is this membership for?
              </label>
              <div className="flex items-center gap-2 text-sm">
                <span className="px-2.5 py-1.5 rounded-md bg-app-bg text-text-muted truncate">
                  {preview.from.name}
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-text-muted" strokeWidth={2} />
                <select
                  value={targetId}
                  onChange={(e) => { setTargetId(e.target.value); setAckUsage(false); }}
                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md border border-app-border bg-surface text-text-primary focus:ring-2 focus:ring-brand outline-none"
                >
                  <option value="">Choose an athlete…</option>
                  {preview.eligibleTargets.map((t) => (
                    <option key={t.memberId} value={t.memberId}>
                      {t.name}{t.hasActiveMembership ? " (already has a membership)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              {preview.eligibleTargets.length === 0 && (
                <p className="text-xs text-text-muted mt-1.5">
                  No other family members found on this account. The payer&apos;s account needs access
                  to the athlete before a membership can move to them.
                </p>
              )}
            </div>

            {blockingTarget && (
              <p className="text-sm text-orange-accent flex items-start gap-1.5">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" strokeWidth={2} />
                {blockingTarget.message}
              </p>
            )}

            {/* The money. This is the part that must land. */}
            <div className="rounded-lg border border-app-border px-3 py-2.5">
              <p className="text-xs font-medium text-text-primary flex items-center gap-1.5 mb-1">
                <CreditCard className="h-3.5 w-3.5 text-text-muted" strokeWidth={2} />
                The payment does not move
              </p>
              <p className="text-xs text-text-muted">{preview.billingNote}</p>
              <label className="flex items-start gap-2 mt-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ackBilling}
                  onChange={(e) => setAckBilling(e.target.checked)}
                  className="mt-0.5 accent-[color:var(--color-brand)]"
                />
                <span className="text-xs text-text-primary">
                  I understand {preview.payer.name} keeps paying for this membership.
                </span>
              </label>
            </div>

            {/* Usage — surfaced, never a blocker (owner decision) */}
            {preview.usage.hasUsage && (
              <div className="rounded-lg border border-orange-accent/40 bg-orange-accent/5 px-3 py-2.5">
                <p className="text-xs font-medium text-text-primary">
                  This membership has already been used
                </p>
                <p className="text-xs text-text-muted mt-0.5">
                  {preview.usage.attendanceCount} attendance record(s) and {preview.usage.bookingCount}{" "}
                  booking(s) under {preview.from.name}. Those history entries stay with{" "}
                  {preview.from.name} — only the membership itself moves.
                </p>
                <label className="flex items-start gap-2 mt-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ackUsage}
                    onChange={(e) => setAckUsage(e.target.checked)}
                    className="mt-0.5 accent-[color:var(--color-brand)]"
                  />
                  <span className="text-xs text-text-primary">Move it anyway.</span>
                </label>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-text-primary mb-1">
                Reason <span className="text-text-muted font-normal">(optional, saved to both profiles)</span>
              </label>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. bought under the wrong profile by mistake"
                className="w-full px-2.5 py-1.5 text-sm rounded-md border border-app-border bg-surface text-text-primary focus:ring-2 focus:ring-brand outline-none"
              />
            </div>

            {preview.requiresApproval && (
              <p className="text-xs text-text-muted rounded-lg bg-app-bg px-3 py-2">
                This goes to the club for approval. Nothing changes until they confirm it.
              </p>
            )}

            {err && <p className="text-sm text-red-600">{err}</p>}

            <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end pt-1">
              <button
                onClick={onClose}
                className="px-4 py-2 rounded-lg border border-app-border text-sm text-text-primary hover:bg-app-bg"
              >
                Cancel
              </button>
              <button
                disabled={!canSubmit}
                onClick={submit}
                className="px-4 py-2 rounded-lg bg-charcoal text-white text-sm hover:bg-charcoal-hover disabled:opacity-40 inline-flex items-center justify-center gap-2"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />}
                {preview.requiresApproval ? "Send request to the club" : "Move membership"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
