"use client";

// Portal — "Auto-renew" for every membership this adult pays for (2026-09-28).
//
// Julian: a parent should be able to choose, from their own profile, whether
// ANY of their family's memberships auto-renews. Each row states, in dates,
// what is true now and what the switch would do:
//
//   How you pay: Cash App Pay · next charge Oct 27 · $164.64
//   On: renews every month on the 27th for $164.64.
//
// Flipping the switch opens a confirm (components/Sheet) that repeats the
// consequence — "Auto-renew off: your membership ends Nov 20, 2026, after your
// 3-month commitment. You won't be charged after that." — before anything
// changes. Every sentence comes from the server (lib/autoRenewCopy), which uses
// the same stop-date rule as the write, so the promise and the result match.

import { useCallback, useEffect, useState } from "react";
import Sheet from "@/components/Sheet";
import { Avatar, AccentButton, GhostButton } from "@/components/member/ui";

type Row = {
  subscriptionId: string;
  memberId: string;
  name: string;
  isSelf: boolean;
  plan: string;
  billing: "CARD" | "OFFLINE";
  autoRenew: boolean;
  amount: number;
  howYouPay: string;
  copy: {
    offSentence: string;
    onSentence: string;
    currentSentence: string;
    canToggle: boolean;
    blockedReason: string | null;
    stopsOn: string | null;
    commitmentEndsOn: string | null;
  };
};

export default function AutoRenewCard() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [pending, setPending] = useState<{ row: Row; to: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/member/auto-renew")
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((d) => setRows(Array.isArray(d.rows) ? d.rows : []))
      .catch(() => setRows([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function confirm() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/member/subscriptions/${pending.row.subscriptionId}/auto-renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoRenew: pending.to }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setError(typeof d.error === "string" ? d.error : "That didn't go through. Nothing changed.");
      return;
    }
    setDone(typeof d.message === "string" ? d.message : pending.to ? pending.row.copy.onSentence : pending.row.copy.offSentence);
    setPending(null);
    load();
  }

  if (!rows || rows.length === 0) return null;

  return (
    <div className="pcard p-5">
      <h2 className="text-sm font-semibold text-stone-900">Auto-renew</h2>
      <p className="text-[12px] text-stone-500 mt-0.5 mb-1">
        Choose whether each membership keeps going after its current term. Turning it off never ends a
        commitment early.
      </p>

      {rows.map((row) => (
        <div key={row.subscriptionId} className="py-3 border-t border-stone-100 first:border-t-0 first:pt-2">
          <div className="flex items-start gap-2.5">
            <Avatar name={row.name} size={28} />
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-stone-900 truncate">{row.name}</p>
              <p className="text-[12px] text-stone-500">{row.plan}</p>
              <p className="text-[12px] text-stone-700 mt-1">{row.howYouPay}</p>
              <p className="text-[12px] text-stone-700 mt-1">{row.copy.currentSentence}</p>
              {!row.copy.canToggle && row.copy.blockedReason && (
                <p className="text-[12px] text-stone-500 mt-1">{row.copy.blockedReason}</p>
              )}
            </div>
            {/* 44px tap target around a compact switch. */}
            <button
              type="button"
              role="switch"
              aria-checked={row.autoRenew}
              aria-label={`Auto-renew for ${row.name === "You" ? "your" : `${row.name}'s`} membership`}
              disabled={!row.copy.canToggle && row.autoRenew}
              onClick={() => { setError(null); setDone(null); setPending({ row, to: !row.autoRenew }); }}
              className="shrink-0 inline-flex h-11 min-w-[44px] items-center justify-center rounded-lg disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--club-accent-ring)]"
            >
              <span
                className={`relative block w-[38px] h-[22px] rounded-full transition-colors ${row.autoRenew ? "bg-[var(--club-accent)]" : "bg-stone-300"}`}
              >
                <span
                  className="absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow-sm transition-[left]"
                  style={{ left: row.autoRenew ? 18 : 2 }}
                />
              </span>
            </button>
          </div>
        </div>
      ))}

      {done && (
        <div className="mt-3 text-[12px] text-stone-700 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">{done}</div>
      )}

      <Sheet
        open={!!pending}
        onClose={() => { if (!busy) setPending(null); }}
        title={pending?.to ? "Turn auto-renew on?" : "Turn auto-renew off?"}
        description={pending ? `${pending.row.name === "You" ? "Your" : `${pending.row.name}'s`} ${pending.row.plan}` : undefined}
        footer={
          <>
            <GhostButton onClick={() => setPending(null)} disabled={busy} className="min-h-[44px]">Keep as is</GhostButton>
            <AccentButton onClick={confirm} disabled={busy} className="min-h-[44px]">
              {busy ? "Saving…" : pending?.to ? "Turn on" : "Turn off"}
            </AccentButton>
          </>
        }
      >
        {pending && (
          <div className="space-y-2">
            <p className="text-sm text-text-primary">{pending.to ? pending.row.copy.onSentence : pending.row.copy.offSentence}</p>
            <p className="text-[13px] text-text-muted">{pending.row.howYouPay}</p>
            <p className="text-[13px] text-text-muted">Your club is told about the change. You can switch it back any time before it ends.</p>
            {error && <p className="text-[13px] text-red-700 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
          </div>
        )}
      </Sheet>
    </div>
  );
}
