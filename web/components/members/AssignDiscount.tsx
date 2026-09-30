"use client";

// The Assign sheet's discount block (B3 × B13). It renders the server's quote
// (GET /api/members/[id]/membership/assign-quote) — the sibling discount or
// group rate pre-applied when the family qualifies, a "Don't apply" switch, and
// the club's staff discount codes. It never computes a price of its own; every
// assign path recomputes the same quote at commit.

import { useEffect, useState } from "react";
import type { AssignQuote } from "@/lib/membershipAssignQuote";
import { useEligibleDiscounts } from "@/components/StaffDiscountPicker";

export type { AssignQuote };

/** Fetch the quote for the sheet's current inputs (debounced). `key` is the
 *  inputs the returned quote belongs to, so a stale quote is never committed. */
export function useAssignQuote(memberId: string, input: { membershipId: string; optionId: string; override: string; code: string | null; applyFamily: boolean; method: "CARD" | "CASH" | "OFFER" } | null) {
  const key = input ? JSON.stringify(input) : "";
  const [state, setState] = useState<{ key: string; quote: AssignQuote | null; error: string | null }>({ key: "", quote: null, error: null });
  useEffect(() => {
    if (!input) return;
    let alive = true;
    const qs = new URLSearchParams({ membershipId: input.membershipId, optionId: input.optionId, applyFamily: input.applyFamily ? "1" : "0", method: input.method });
    if (input.override !== "") qs.set("priceOverride", input.override);
    if (input.code && input.override === "") qs.set("discountCode", input.code);
    const t = setTimeout(() => {
      fetch(`/api/members/${memberId}/membership/assign-quote?${qs.toString()}`)
        .then(async (r) => {
          const d = await r.json().catch(() => ({}));
          if (!alive) return;
          if (r.ok && d.quote) setState({ key, quote: d.quote as AssignQuote, error: null });
          else setState({ key, quote: null, error: typeof d.error === "string" ? d.error : "Couldn't price this membership." });
        })
        .catch(() => { if (alive) setState({ key, quote: null, error: "Couldn't price this membership." }); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId, key]);
  const fresh = !!input && state.key === key;
  return { quote: fresh ? state.quote : null, error: fresh ? state.error : null, loading: !!input && !fresh };
}

const selectCls = "w-full min-h-[44px] sm:min-h-0 px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary disabled:opacity-60";

export default function AssignDiscount({
  quote, loading, error, membershipId, code, onCode, applyFamily, onApplyFamily, overrideTyped,
}: {
  quote: AssignQuote | null;
  loading: boolean;
  error: string | null;
  membershipId: string;
  code: string | null;
  onCode: (code: string | null) => void;
  applyFamily: boolean;
  onApplyFamily: (v: boolean) => void;
  overrideTyped: boolean;
}) {
  const { discounts, error: listError } = useEligibleDiscounts("MEMBERSHIP", membershipId);
  const autos = quote ? quote.candidates.filter((c) => c.source !== "CODE") : [];
  const codeCand = quote?.candidates.find((c) => c.source === "CODE") ?? null;
  const orphaned = !!code && !!discounts && !discounts.some((d) => d.code === code);

  return (
    <div className="mt-3" aria-live="polite">
      <span className="block text-xs font-medium text-text-primary mb-1">Discount</span>
      {error && <p className="text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-2.5 py-1.5">{error}</p>}
      {loading && !quote && <p className="text-[12px] text-text-muted">Checking the family and group discounts…</p>}

      {autos.map((c) => (
        <div key={c.source + c.title} className={`rounded-xl border px-3 py-2 mb-1.5 ${c.status === "APPLIED" ? "border-brand/40 bg-brand/5" : "border-app-border"}`}>
          <p className={`text-[12.5px] leading-[1.45] ${c.status === "APPLIED" ? "text-text-primary font-medium" : "text-text-muted line-through decoration-1"}`}>{c.line}</p>
          {c.note && <p className="text-[12px] text-text-muted mt-0.5">{c.note}</p>}
        </div>
      ))}
      {quote && quote.autoAvailable && !overrideTyped && (
        <label className="flex items-center gap-2 text-sm text-text-primary min-h-[44px] sm:min-h-0 sm:py-1">
          <input type="checkbox" className="w-[18px] h-[18px]" checked={!applyFamily} onChange={(e) => onApplyFamily(!e.target.checked)} />
          <span>Don&apos;t apply the {autos.some((a) => a.source === "SIBLING") ? "sibling discount" : "group rate"} to this membership</span>
        </label>
      )}
      {quote?.familyNote && <p className="text-[12px] text-text-muted mt-1">{quote.familyNote}</p>}

      <label className="block mt-2">
        <span className="block text-[12px] text-text-muted mb-1">Discount code</span>
        <select className={selectCls} value={code ?? ""} disabled={overrideTyped} onChange={(e) => onCode(e.target.value || null)}>
          <option value="">No code</option>
          {orphaned && <option value={code!}>{code} (no longer available)</option>}
          {(discounts ?? []).map((d) => (
            <option key={d.id} value={d.code} disabled={!d.eligible}>
              {d.name} ({d.code}) — {d.amountLabel}{!d.eligible && d.reason ? ` — ${d.reason}` : ""}
            </option>
          ))}
        </select>
      </label>
      {listError && <p className="text-[12px] text-red-700 mt-1">{listError}</p>}
      {overrideTyped && <p className="text-[12px] text-text-muted mt-1">A typed price wins over every discount — clear it to use a discount.</p>}
      {quote?.codeError && <p className="text-[12px] text-red-700 mt-1">That code can&apos;t be used here: {quote.codeError}</p>}
      {codeCand && (
        <div className={`rounded-xl border px-3 py-2 mt-1.5 ${codeCand.status === "APPLIED" ? "border-brand/40 bg-brand/5" : "border-app-border"}`}>
          <p className={`text-[12.5px] leading-[1.45] ${codeCand.status === "APPLIED" ? "text-text-primary font-medium" : "text-text-muted line-through decoration-1"}`}>{codeCand.line}</p>
          {codeCand.note && <p className="text-[12px] text-text-muted mt-0.5">{codeCand.note}</p>}
        </div>
      )}
      {quote?.overrideNote && <p className="text-[12px] text-text-muted mt-1">{quote.overrideNote}</p>}
      {quote && !quote.applied && quote.override == null && autos.length === 0 && !codeCand && !quote.familyNote && (
        <p className="text-[12px] text-text-muted">No family or group discount applies to this membership.</p>
      )}
    </div>
  );
}
