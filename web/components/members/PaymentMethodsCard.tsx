"use client";

// Payment methods for one member — moved out of the retired "Advanced
// billing" page (2026-09-28) so it lives beside the Membership panel on the
// profile's Memberships tab (and on Migration setup while a member is still
// collecting a card to activate).
//
//   · the saved methods, named the way the family knows them ("Cash App Pay",
//     "Visa ···· 4242") when the lookup supplies a `label`, else brand/last4
//   · Add method / Replace… — a Stripe-hosted page; cards are never typed here
//   · Make default / Remove — each behind a confirm that says what it does
//   · a collapsed "Stripe details" disclosure: customer + subscription ids and
//     "Sync from Stripe", for support tickets and reconciliation
//
// Data: GET /api/members/[id]/billing-admin (payment methods, read live from
// Stripe) and GET /api/members/[id]/billing-details (ids). Nothing here
// charges anyone.

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CreditCard, RefreshCw } from "lucide-react";
import Sheet from "@/components/Sheet";

type PaymentMethod = {
  ref: string;
  type: string;
  /** Added by the payment-methods worker: "Cash App Pay", "Link (sam@x.com)", … */
  label?: string | null;
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

type AdminSlice = {
  paymentMethods: PaymentMethod[];
  stripeReadError: boolean;
  hasPendingCharge: boolean;
  /** Optional: "last paid with" when the billing read supplies it. */
  lastPaidWith?: string | { label?: string | null; at?: string | null } | null;
};

type Details = {
  stripe: {
    connected: boolean;
    customers: { role: "SETUP" | "MEMBER"; id: string }[];
    subscriptions: { id: string; label: string; status: string; stripeStatus: string | null; stripeSubscriptionId: string; syncable: boolean }[];
  };
};

const titleCase = (s: string) => s.split(/[_\s]+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

/** The name staff see: the lookup's own label first, then brand ···· last4. */
export function paymentMethodName(pm: Pick<PaymentMethod, "label" | "type" | "brand" | "last4" | "linkEmail">): string {
  if (pm.label) return pm.label;
  if (pm.type === "link") return `Link${pm.linkEmail ? ` (${pm.linkEmail})` : ""}`;
  return `${titleCase(pm.brand || "Card")}${pm.last4 ? ` ···· ${pm.last4}` : ""}`;
}

type Confirm =
  | { kind: "REPLACE" }
  | { kind: "DEFAULT"; pm: PaymentMethod }
  | { kind: "REMOVE"; pm: PaymentMethod };

const BTN = "inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-app-border px-3 text-xs text-text-primary hover:bg-app-bg disabled:opacity-50 md:min-h-[36px]";

export default function PaymentMethodsCard({
  memberId,
  canManage = true,
  returnTo = "profile",
  className = "",
  onChanged,
}: {
  memberId: string;
  /** billing:full — Add/Replace/Make default/Remove/Sync. View-only otherwise. */
  canManage?: boolean;
  /** Where Stripe's card page sends staff back. */
  returnTo?: "profile" | "migration";
  className?: string;
  onChanged?: () => void;
}) {
  const search = useSearchParams();
  const [admin, setAdmin] = useState<AdminSlice | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/members/${memberId}/billing-admin`)
      .then(async (r) => {
        if (r.status === 403) { setForbidden(true); return null; }
        return r.ok ? r.json() : null;
      })
      .then((d) => { if (d) setAdmin(d as AdminSlice); })
      .catch(() => {});
    fetch(`/api/members/${memberId}/billing-details`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setDetails(d as Details); })
      .catch(() => {});
  }, [memberId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (search.get("card_saved")) {
      setMsg(search.get("intent") === "REPLACE"
        ? "Replacement card collected. It becomes the charged method only after you make it the default below."
        : "Card saved. It may take a few seconds to appear — refresh if needed.");
    } else if (search.get("card_canceled")) {
      setMsg("Card entry was canceled — nothing was saved.");
    }
  }, [search]);

  const changed = () => { load(); onChanged?.(); };

  async function openStripe(intent: "ADD" | "REPLACE") {
    setBusy(true);
    const r = await fetch(`/api/members/${memberId}/payment-methods/setup`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ intent, returnTo }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    setConfirm(null);
    if (r.ok && d.url) window.open(d.url, "_blank");
    else setMsg(typeof d.error === "string" ? d.error : "Could not open the Stripe page.");
  }

  async function act(kind: "DEFAULT" | "REMOVE", pm: PaymentMethod) {
    setBusy(true);
    const path = kind === "DEFAULT" ? "make-default" : "remove";
    const r = await fetch(`/api/members/${memberId}/payment-methods/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref: pm.ref, confirm: true }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    setConfirm(null);
    const name = paymentMethodName(pm);
    if (!r.ok) { setMsg(typeof d.error === "string" ? d.error : kind === "DEFAULT" ? "Could not make it the default." : "Removal blocked."); return; }
    setMsg(kind === "DEFAULT"
      ? `${d.method || name} is now the default${d.liveSubscriptionsRepointed ? ` — ${d.liveSubscriptionsRepointed} live subscription(s) repointed` : ""}.`
      : `${d.removed || name} removed.`);
    changed();
  }

  async function sync(subscriptionId: string) {
    setSyncing(subscriptionId);
    const r = await fetch(`/api/members/${memberId}/billing-admin/actions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sync_stripe", confirm: true, subscriptionId }),
    });
    const d = await r.json().catch(() => ({}));
    setSyncing(null);
    setMsg(typeof d.message === "string" ? d.message : typeof d.error === "string" ? d.error : r.ok ? "Synced." : "Sync failed.");
    if (r.ok) changed();
  }

  if (forbidden) return null;

  const methods = admin?.paymentMethods ?? [];
  const lastPaid = admin?.lastPaidWith
    ? typeof admin.lastPaidWith === "string" ? admin.lastPaidWith : admin.lastPaidWith.label ?? null
    : null;

  return (
    <div id="payment-methods" className={`scroll-mt-20 rounded-xl border border-app-border bg-surface p-5 ${className}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Payment methods</h2>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => openStripe("ADD")} className={BTN}>
              <CreditCard className="h-3.5 w-3.5" /> Add method
            </button>
            {methods.length > 0 && (
              <button type="button" disabled={busy} onClick={() => setConfirm({ kind: "REPLACE" })} className={BTN}>
                Replace…
              </button>
            )}
          </div>
        )}
      </div>

      {msg && (
        <div className="mb-3 flex justify-between gap-3 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-text-primary">
          <span>{msg}</span>
          <button type="button" className="inline-flex min-h-[44px] items-center text-xs text-text-muted md:min-h-0" onClick={() => setMsg(null)}>Dismiss</button>
        </div>
      )}

      {admin === null ? (
        <p className="text-sm text-text-muted">Loading payment methods…</p>
      ) : (
        <>
          {admin.stripeReadError && (
            <p className="mb-2 text-xs text-[var(--color-warn-text)]">Stripe couldn&apos;t be reached — payment methods may be incomplete. Refresh to retry.</p>
          )}
          {lastPaid && <p className="mb-2 text-xs text-text-muted">Last paid with <strong className="text-text-primary">{lastPaid}</strong></p>}
          {methods.length === 0 ? (
            <p className="text-sm text-text-muted">
              No saved payment method. {canManage ? <>Use <strong>Add method</strong> to open a secure Stripe page — cards are never typed into AthletixOS.</> : null}
            </p>
          ) : (
            <ul className="space-y-2">
              {methods.map((pm) => {
                const exp = pm.expMonth && pm.expYear ? `${String(pm.expMonth).padStart(2, "0")}/${String(pm.expYear).slice(-2)}` : null;
                return (
                  <li key={pm.ref} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-app-border px-3 py-2">
                    <div className="min-w-0 text-sm">
                      <span className="font-medium text-text-primary">{paymentMethodName(pm)}</span>
                      {exp && <span className="text-xs text-text-muted"> · exp {exp}</span>}
                      {pm.cardholder && <span className="text-xs text-text-muted"> · {pm.cardholder}</span>}
                      <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-text-muted">
                        {pm.customerName || pm.customerEmail ? <span>Owner: {pm.customerName || pm.customerEmail}</span> : null}
                        {pm.isDefault && <span className="font-medium text-brand">Default</span>}
                        {pm.isCapturedForActivation && (
                          <span className="font-medium text-brand">
                            {admin.hasPendingCharge ? "Will be charged when the pending activation completes" : "On file for future billing"}
                          </span>
                        )}
                        {pm.backsLiveSubscription && <span className="font-medium text-[var(--color-warn-text)]">Pays a live membership</span>}
                        {pm.customerRole === "LEGACY" && <span>Older Stripe customer</span>}
                      </div>
                    </div>
                    {canManage && (
                      <div className="flex gap-2">
                        {!pm.isCapturedForActivation && !pm.isDefault && (
                          <button type="button" disabled={busy} onClick={() => setConfirm({ kind: "DEFAULT", pm })} className={BTN}>Make default</button>
                        )}
                        <button type="button" disabled={busy} onClick={() => setConfirm({ kind: "REMOVE", pm })} className={`${BTN} text-red-600`}>Remove</button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {details && (details.stripe.customers.length > 0 || details.stripe.subscriptions.length > 0) && (
        <details className="mt-3 rounded-lg border border-app-border px-3 py-2">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-xs font-medium text-text-primary md:min-h-0">Stripe details</summary>
          <dl className="mt-2 space-y-1.5 text-xs">
            {details.stripe.customers.map((c) => (
              <div key={c.id} className="flex flex-wrap justify-between gap-2">
                <dt className="text-text-muted">{c.role === "SETUP" ? "Customer (billing)" : "Customer (portal)"}</dt>
                <dd className="break-all font-mono text-text-primary">{c.id}</dd>
              </div>
            ))}
            {details.stripe.subscriptions.map((s) => (
              <div key={s.id} className="rounded-lg bg-app-bg px-2.5 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <dt className="text-text-muted">{s.label} · {s.status}{s.stripeStatus && s.stripeStatus !== s.status ? ` (Stripe: ${s.stripeStatus})` : ""}</dt>
                  {canManage && s.syncable && (
                    <button type="button" onClick={() => sync(s.id)} disabled={syncing === s.id} className={BTN}>
                      <RefreshCw className={`h-3 w-3 ${syncing === s.id ? "animate-spin" : ""}`} /> Sync from Stripe
                    </button>
                  )}
                </div>
                <dd className="mt-0.5 break-all font-mono text-text-primary">{s.stripeSubscriptionId}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-text-muted">Sync pulls what Stripe is actually charging onto the membership. It never charges anyone.</p>
        </details>
      )}

      <Sheet
        open={!!confirm}
        onClose={() => { if (!busy) setConfirm(null); }}
        title={
          confirm?.kind === "REPLACE" ? "Collect a new card?"
            : confirm?.kind === "DEFAULT" ? `Make ${paymentMethodName(confirm.pm)} the default?`
            : confirm?.kind === "REMOVE" ? `Remove ${paymentMethodName(confirm.pm)}?`
            : ""
        }
        footer={
          <>
            <button type="button" onClick={() => setConfirm(null)} disabled={busy} className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-app-border px-4 text-sm text-text-primary hover:bg-app-bg">Cancel</button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!confirm) return;
                if (confirm.kind === "REPLACE") openStripe("REPLACE");
                else act(confirm.kind, confirm.pm);
              }}
              className={`inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 text-sm text-white disabled:opacity-50 ${confirm?.kind === "REMOVE" ? "bg-red-600 hover:bg-red-700" : "bg-brand hover:bg-brand-hover"}`}
            >
              {busy ? "Working…" : confirm?.kind === "REPLACE" ? "Open Stripe page" : confirm?.kind === "DEFAULT" ? "Make default" : "Remove"}
            </button>
          </>
        }
      >
        <p className="text-sm text-text-primary">
          {confirm?.kind === "REPLACE" && "Opens a secure Stripe page to collect a new card. The current card keeps being charged until you make the new one the default."}
          {confirm?.kind === "DEFAULT" && "This becomes the customer default, any live membership charges it from the next payment, and so does a pending activation or offer."}
          {confirm?.kind === "REMOVE" && "Removal is blocked automatically if a live or pending membership still charges this method. Payment history is never deleted."}
        </p>
      </Sheet>
    </div>
  );
}
