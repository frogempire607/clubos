"use client";

// Staff/owner discount dropdown — the ONE picker every staff-assisted payment
// surface uses. Data comes from /api/discounts/eligible (billing:view);
// ineligible rows render disabled with their reason so staff can see WHY a
// code isn't offered. The math block below is a client-side PREVIEW ONLY —
// every save/charge path re-resolves the code and recomputes the price
// server-side (lib/staffPayments.ts); nothing here is trusted.

import { useEffect, useState } from "react";

export type EligibleDiscount = {
  id: string;
  code: string;
  name: string;
  type: "PERCENT" | "FIXED";
  value: number;
  amountLabel: string; // "10% off" | "$50.00 off"
  appliesTo: string[];
  expiresAt: string | null;
  active: boolean;
  eligible: boolean;
  reason: string | null;
  usesLeft: number | null;
};

/** Client-side preview math mirroring lib/discounts discountedPrice (PERCENT /
 *  FIXED, clamped at 0). Display only — the server recomputes. */
export function previewDiscountMath(
  d: Pick<EligibleDiscount, "type" | "value">,
  originalPrice: number,
): { amountOff: number; finalPrice: number } {
  const original = Math.max(0, Math.round(originalPrice * 100) / 100);
  const cut = d.type === "PERCENT" ? (original * d.value) / 100 : d.value;
  const finalPrice = Math.max(0, Math.round((original - cut) * 100) / 100);
  const amountOff = Math.round((original - finalPrice) * 100) / 100;
  return { amountOff, finalPrice };
}

/** Fetch the eligible-discount list for an item. Shared by the picker and by
 *  read-only summaries (e.g. the billing card's discount row). */
export function useEligibleDiscounts(itemType: string, membershipId?: string | null) {
  const [discounts, setDiscounts] = useState<EligibleDiscount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams({ itemType });
    if (membershipId) qs.set("membershipId", membershipId);
    fetch(`/api/discounts/eligible?${qs.toString()}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (r.ok && Array.isArray(d.discounts)) setDiscounts(d.discounts as EligibleDiscount[]);
        else setError(typeof d.error === "string" ? d.error : "Could not load discounts.");
      })
      .catch(() => { if (alive) setError("Could not load discounts."); });
    return () => { alive = false; };
  }, [itemType, membershipId]);
  return { discounts, error };
}

const fmtExpiry = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : null;

export default function StaffDiscountPicker({
  itemType,
  membershipId,
  value,
  onChange,
  originalPrice,
  passProcessingFees = false,
  label = "Discount",
}: {
  itemType: string;
  membershipId?: string | null;
  value: string | null;
  onChange: (code: string | null, resolved: EligibleDiscount | null) => void;
  originalPrice: number;
  passProcessingFees?: boolean;
  label?: string;
}) {
  const { discounts, error } = useEligibleDiscounts(itemType, membershipId);

  const selected = value ? discounts?.find((d) => d.code === value) ?? null : null;
  const math = selected ? previewDiscountMath(selected, originalPrice) : null;
  // A stored code that no longer appears in the list (deleted / renamed) still
  // needs to be visible so staff can see it and clear it.
  const orphaned = !!value && !!discounts && !discounts.some((d) => d.code === value);

  return (
    <div className="block text-xs text-text-muted">
      <span>{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => {
          const code = e.target.value || null;
          onChange(code, code ? discounts?.find((d) => d.code === code) ?? null : null);
        }}
        className="mt-1 w-full border border-app-border rounded-lg px-2 py-1.5 text-sm bg-surface text-text-primary"
      >
        <option value="">No discount</option>
        {orphaned && <option value={value!}>{value} (no longer available)</option>}
        {(discounts ?? []).map((d) => (
          <option key={d.id} value={d.code} disabled={!d.eligible}>
            {d.name} ({d.code}) — {d.amountLabel}
            {d.expiresAt ? ` · expires ${fmtExpiry(d.expiresAt)}` : ""}
            {!d.eligible && d.reason ? ` — ${d.reason}` : ""}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
      {selected && math && (
        <div className="mt-1.5 border border-app-border rounded-lg px-2.5 py-1.5 text-xs">
          <div className="flex justify-between text-text-muted">
            <span>Original price</span>
            <span>${Math.max(0, originalPrice).toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-text-muted">
            <span>Discount ({selected.amountLabel})</span>
            <span>−${math.amountOff.toFixed(2)}</span>
          </div>
          <div className="flex justify-between font-semibold text-text-primary border-t border-app-border mt-1 pt-1">
            <span>Final price</span>
            <span>${math.finalPrice.toFixed(2)}</span>
          </div>
          <p className="text-[11px] text-text-muted mt-1">
            Preview only — the exact amount is recomputed server-side when saved.
            {passProcessingFees ? " Card payments add the processing fee on the final price." : ""}
          </p>
        </div>
      )}
    </div>
  );
}
