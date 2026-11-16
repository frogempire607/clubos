"use client";

// "Delete my account" — the same dialog for members, parents, staff and owners.
//
// Everything the person reads here comes from GET /api/account/deletion, which
// is built by lib/accountDeletion.ts: what is removed, what the club keeps and
// why, and anything that has to be said first (children with no other
// guardian, a membership whose card is still being charged). Both app stores
// require this to be in the app, easy to find, and a real deletion.

import { useEffect, useState } from "react";
import Sheet from "@/components/Sheet";
import { signOutEverywhere } from "@/lib/signOutEverywhere";
import { deletionConfirmed, type AccountDeletionPlan } from "@/lib/accountDeletion";

export default function DeleteAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [plan, setPlan] = useState<AccountDeletionPlan | null>(null);
  const [loadError, setLoadError] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPlan(null); setLoadError(""); setTyped(""); setError(""); setDone(false);
    fetch("/api/account/deletion", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok || !d?.plan) setLoadError(typeof d?.error === "string" ? d.error : "We couldn't load this just now.");
        else setPlan(d.plan as AccountDeletionPlan);
      })
      .catch(() => { if (alive) setLoadError("No connection. Check your signal and try again."); });
    return () => { alive = false; };
  }, [open]);

  async function confirmDelete() {
    if (busy || !deletionConfirmed(typed)) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/account/deletion", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof d.error === "string" ? d.error : "Your account was not deleted. Please try again.");
        setBusy(false);
        return;
      }
      // Deleted. Say so plainly, then sign this device out.
      setDone(true);
      setTimeout(() => { void signOutEverywhere({ callbackUrl: "/login" }); }, 1800);
    } catch {
      setError("No connection — your account was not deleted. Try again.");
      setBusy(false);
    }
  }

  const list = (items: string[]) => (
    <ul className="mt-1.5 list-disc space-y-1.5 pl-5 text-[13px] leading-snug text-text-primary">
      {items.map((t) => <li key={t}>{t}</li>)}
    </ul>
  );

  return (
    <Sheet
      open={open}
      onClose={busy || done ? () => undefined : onClose}
      dismissable={!busy && !done}
      title={done ? "Your account has been deleted" : "Delete your account"}
      width={520}
      footer={
        done || !plan || !plan.allowed ? (
          !done && (
            <button type="button" onClick={onClose} className="min-h-[44px] rounded-lg border border-app-border px-4 text-sm font-medium text-text-primary hover:bg-app-bg">
              Close
            </button>
          )
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={busy} className="min-h-[44px] rounded-lg border border-app-border px-4 text-sm font-medium text-text-primary hover:bg-app-bg disabled:opacity-50">
              Keep my account
            </button>
            <button
              type="button"
              onClick={confirmDelete}
              disabled={busy || !deletionConfirmed(typed)}
              className="min-h-[44px] rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
            >
              {busy ? "Deleting…" : "Delete my account"}
            </button>
          </>
        )
      }
    >
      {done ? (
        <p className="text-sm text-text-primary">You are being signed out. Thank you for using the club portal.</p>
      ) : loadError ? (
        <p role="alert" className="text-sm text-red-600">{loadError}</p>
      ) : !plan ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading">
          <div className="h-3 w-3/4 animate-pulse rounded bg-app-bg" />
          <div className="h-3 w-full animate-pulse rounded bg-app-bg" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-app-bg" />
        </div>
      ) : !plan.allowed ? (
        <p className="text-sm text-text-primary">{plan.blockedReason}</p>
      ) : (
        <div className="space-y-4">
          <section>
            <h3 className="text-[13px] font-semibold text-text-primary">Removed now</h3>
            {list(plan.removed)}
          </section>
          <section>
            <h3 className="text-[13px] font-semibold text-text-primary">Kept by the club</h3>
            {list(plan.kept)}
          </section>
          <section className="rounded-lg border border-app-border bg-app-bg p-3">
            <h3 className="text-[13px] font-semibold text-text-primary">Before you confirm</h3>
            {list(plan.consequences)}
          </section>
          <label className="block">
            <span className="text-[13px] text-text-primary">Type <strong>delete</strong> to confirm</span>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="mt-1.5 min-h-[44px] w-full rounded-lg border border-app-border bg-surface px-3 text-[16px] text-text-primary focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </label>
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        </div>
      )}
    </Sheet>
  );
}
