"use client";

// Invoice split (Client UX Phase 7, behind FEATURE_INVOICE_SPLIT — hidden
// entirely when the server says the feature is off or the athlete has fewer
// than two guardians). Guardian A proposes a % split → Guardian B approves →
// staff give the final OK → Active. Each guardian always pays their share
// with their OWN payment method — never the other guardian's card.

import { useCallback, useEffect, useState } from "react";
import { Pill } from "@/components/member/ui";

type SplitParty = { userId: string; name: string; percent: number };

type Split = {
  id: string;
  status: "PENDING_GUARDIAN" | "PENDING_STAFF" | "ACTIVE";
  proposer: SplitParty;
  responder: SplitParty;
  note: string | null;
  viewerIsProposer: boolean;
  viewerIsResponder: boolean;
};

type Guardian = { userId: string; name: string; isYou: boolean };

const STEP_LABELS = ["Proposed", "Other guardian", "Staff review", "Active"];

function stepIndex(status: Split["status"] | null): number {
  // Completed step count: proposal exists → 1; guardian approved → 2;
  // staff approved → all 4 (Active is a state, not a task).
  if (status === "PENDING_GUARDIAN") return 1;
  if (status === "PENDING_STAFF") return 2;
  if (status === "ACTIVE") return 4;
  return 0;
}

function SplitBar({ a, b }: { a: number; b: number }) {
  return (
    <div
      className="h-[13px] rounded-full overflow-hidden flex bg-stone-100"
      role="img"
      aria-label={`Split ${a}% / ${b}%`}
    >
      <div style={{ width: `${a}%`, background: "var(--club-accent)" }} />
      <div style={{ width: `${b}%`, background: "#4F46E5" }} />
    </div>
  );
}

function ApprovalStepper({ done }: { done: number }) {
  return (
    <div className="grid grid-cols-4 my-3.5">
      {STEP_LABELS.map((label, i) => {
        const state = i < done ? "done" : i === done ? "active" : "todo";
        return (
          <div key={label} className="relative flex flex-col items-center gap-1.5">
            {i > 0 && (
              <span
                className="absolute top-[13px] right-1/2 w-full h-[2px]"
                style={{ background: i <= done ? "var(--club-accent)" : "#E7E5E4" }}
                aria-hidden
              />
            )}
            <span
              className="relative z-[1] w-[27px] h-[27px] rounded-full flex items-center justify-center text-xs font-extrabold"
              style={
                state === "done"
                  ? { background: "var(--club-accent)", color: "var(--club-accent-contrast)" }
                  : state === "active"
                    ? { background: "#fff", color: "var(--club-accent)", boxShadow: "0 0 0 2px var(--club-accent)" }
                    : { background: "#F5F5F4", color: "#A8A29E", boxShadow: "inset 0 0 0 1px #E7E5E4" }
              }
            >
              {state === "done" ? (
                <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              ) : (
                i + 1
              )}
            </span>
            <span className={`text-[10px] font-semibold text-center max-w-[64px] ${state === "active" ? "text-stone-900" : "text-stone-500"}`}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function InvoiceSplit({ memberId, childName }: { memberId: string; childName: string }) {
  const [enabled, setEnabled] = useState(false);
  const [split, setSplit] = useState<Split | null>(null);
  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [percent, setPercent] = useState(50);
  const [responderId, setResponderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(() => {
    fetch(`/api/member/family/${memberId}/invoice-split`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.enabled) return;
        setEnabled(true);
        setSplit(d.split ?? null);
        const others = (d.guardians ?? []).filter((g: Guardian) => !g.isYou);
        setGuardians(d.guardians ?? []);
        if (others.length === 1) setResponderId(others[0].userId);
      })
      .catch(() => {});
  }, [memberId]);
  useEffect(load, [load]);

  const others = guardians.filter((g) => !g.isYou);
  // The whole card only exists for two-guardian families with the flag on.
  if (!enabled || (others.length === 0 && !split)) return null;

  async function propose() {
    setBusy(true);
    setError("");
    setMsg("");
    const res = await fetch(`/api/member/family/${memberId}/invoice-split`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ responderUserId: responderId, proposerPercent: percent }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof d.error === "string" ? d.error : "Could not propose the split.");
      return;
    }
    setSplit(d.split ?? null);
    setMsg(d.message ?? "");
  }

  async function act(action: "APPROVE" | "DECLINE" | "REVOKE") {
    setBusy(true);
    setError("");
    setMsg("");
    const res = await fetch(`/api/member/family/${memberId}/invoice-split`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(typeof d.error === "string" ? d.error : "Could not update the split.");
      return;
    }
    const next = (d.split ?? null) as Split | null;
    setSplit(next && ["PENDING_GUARDIAN", "PENDING_STAFF", "ACTIVE"].includes(next.status) ? next : null);
    setMsg(d.message ?? "");
  }

  const pill = !split ? (
    <Pill tone="neutral">Draft</Pill>
  ) : split.status === "PENDING_GUARDIAN" ? (
    <Pill tone="warn">Pending {split.responder.name.split(" ")[0]}</Pill>
  ) : split.status === "PENDING_STAFF" ? (
    <Pill tone="warn">Pending staff</Pill>
  ) : (
    <Pill tone="success">Active</Pill>
  );

  const a = split ? split.proposer.percent : percent;
  const b = split ? split.responder.percent : 100 - percent;
  const aName = split ? (split.viewerIsProposer ? "You" : split.proposer.name.split(" ")[0]) : "You";
  const bName = split
    ? split.viewerIsResponder
      ? "You"
      : split.responder.name.split(" ")[0]
    : others.find((g) => g.userId === responderId)?.name.split(" ")[0] ?? "Them";

  const stepCard = !split
    ? {
        title: "Propose a split",
        body: `Pick your share of ${childName}'s costs. No card is charged — the split needs the other guardian and your club to sign off first.`,
      }
    : split.status === "PENDING_GUARDIAN"
      ? split.viewerIsResponder
        ? {
            title: "Your turn",
            body: `${split.proposer.name} proposed covering ${split.proposer.percent}% — your share would be ${split.responder.percent}%. You'd always pay with your own saved card, never theirs.`,
          }
        : {
            title: `Waiting on ${split.responder.name.split(" ")[0]}`,
            body: `${split.responder.name} reviews their ${split.responder.percent}% share and approves. They pay with their own saved card — never yours.`,
          }
      : split.status === "PENDING_STAFF"
        ? {
            title: "Waiting on staff",
            body: "Your club gives the final OK so billing splits cleanly on future purchases.",
          }
        : {
            title: "Split is live",
            body: "This is the family's standing arrangement — your club applies it when billing future purchases, and each guardian pays their share with their own payment method.",
          };

  return (
    <div className="pcard p-4">
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <h2 className="text-sm font-semibold text-stone-900">Invoice split</h2>
        {pill}
      </div>

      <SplitBar a={a} b={b} />
      <div className="flex justify-between mt-2 text-[11px] font-semibold text-stone-600">
        <span className="flex items-center gap-1.5">
          <span className="w-[11px] h-[11px] rounded-[3px]" style={{ background: "var(--club-accent)" }} aria-hidden />
          {aName} (A) · {a}%
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-[11px] h-[11px] rounded-[3px] bg-[#4F46E5]" aria-hidden />
          {bName} (B) · {b}%
        </span>
      </div>

      <ApprovalStepper done={stepIndex(split?.status ?? null)} />

      <div
        className="rounded-xl p-3"
        style={{ background: "var(--club-accent-soft)", border: "1px solid var(--club-accent-ring)" }}
      >
        <p className="text-[13px] font-semibold" style={{ color: "var(--club-accent)" }}>
          {stepCard.title}
        </p>
        <p className="text-[11.5px] text-stone-600 mt-0.5 leading-snug">{stepCard.body}</p>
      </div>

      {!split && (
        <div className="mt-3 space-y-2.5">
          <div>
            <label htmlFor="split-pct" className="block text-[11px] font-semibold text-stone-600 mb-1">
              Your share: {percent}%
            </label>
            <input
              id="split-pct"
              type="range"
              min={1}
              max={99}
              value={percent}
              onChange={(e) => setPercent(Number(e.target.value))}
              className="w-full accent-[var(--club-accent)]"
            />
          </div>
          {others.length > 1 && (
            <select
              value={responderId}
              onChange={(e) => setResponderId(e.target.value)}
              aria-label="Split with which guardian"
              className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-900"
            >
              <option value="">Split with…</option>
              {others.map((g) => (
                <option key={g.userId} value={g.userId}>{g.name}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={propose}
            disabled={busy || !responderId}
            className="pbtn-accent w-full text-sm font-semibold px-4 py-2.5 rounded-xl disabled:opacity-50"
          >
            {busy ? "Sending…" : `Send to ${bName}`}
          </button>
        </div>
      )}

      {split && (
        <div className="flex gap-2 mt-3">
          {split.status === "PENDING_GUARDIAN" && split.viewerIsResponder ? (
            <>
              <button
                type="button"
                onClick={() => act("APPROVE")}
                disabled={busy}
                className="pbtn-accent flex-1 text-sm font-semibold px-4 py-2.5 rounded-xl disabled:opacity-50"
              >
                {busy ? "Working…" : "Approve my share"}
              </button>
              <button
                type="button"
                onClick={() => act("DECLINE")}
                disabled={busy}
                className="text-sm font-semibold px-3 py-2 rounded-xl border border-stone-300 text-stone-700 hover:bg-stone-50 disabled:opacity-50"
              >
                Decline
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => act("REVOKE")}
              disabled={busy}
              className="text-xs font-semibold px-3 py-2 rounded-xl border border-stone-300 text-stone-700 hover:bg-stone-50 disabled:opacity-50"
            >
              {busy ? "Working…" : split.status === "ACTIVE" ? "End this split" : "Withdraw proposal"}
            </button>
          )}
        </div>
      )}

      {msg && (
        <div className="mt-2.5 text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">{msg}</div>
      )}
      {error && (
        <div className="mt-2.5 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}
      <p className="text-[11px] text-stone-400 mt-2.5">
        Either guardian can start a purchase; each pays their own share with their own card —
        Guardian A can never use Guardian B&apos;s saved card.
      </p>
    </div>
  );
}
