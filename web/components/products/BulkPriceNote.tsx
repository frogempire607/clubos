"use client";

// Bulk pricing on the buy screens: the "2+ $35 each" rows, the active one
// marked, and a nudge toward the next break. Pure display — the server
// re-prices every checkout (unitPriceAtQuantity).

import type { QtyBreak } from "@/lib/productSettings";

const money = (n: number) => `$${n.toFixed(2)}`;

export default function BulkPriceNote({ breaks, unit, quantity, onPick }: { breaks: QtyBreak[]; unit: number; quantity: number; onPick?: (qty: number) => void }) {
  const useful = breaks.filter((b) => b.price < unit);
  if (useful.length === 0) return null;
  let active: QtyBreak | null = null;
  for (const b of useful) if (quantity >= b.minQty) active = b;
  const next = useful.find((b) => b.minQty > quantity) ?? null;
  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm">
      <div className="text-[11px] font-semibold uppercase tracking-[.05em] text-stone-500 mb-1.5">Buy more, save</div>
      <div className="flex flex-wrap gap-1.5">
        {useful.map((b) => {
          const on = active?.minQty === b.minQty;
          return (
            <button key={b.minQty} type="button" onClick={() => onPick?.(b.minQty)} disabled={!onPick}
              className={`px-2.5 py-1 rounded-full border text-[12.5px] ${on ? "border-stone-900 bg-stone-900 text-white" : "border-stone-300 bg-white text-stone-800"}`}>
              {b.minQty}+ · {money(b.price)} each
            </button>
          );
        })}
      </div>
      {active ? (
        <p className="text-[12px] text-emerald-700 mt-1.5">You save {money((unit - active.price) * quantity)} with {active.minQty}+ pricing.</p>
      ) : next ? (
        <p className="text-[12px] text-stone-500 mt-1.5">Add {next.minQty - quantity} more to pay {money(next.price)} each.</p>
      ) : null}
    </div>
  );
}
