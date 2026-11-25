// An event's refund policy as the family reads it. The words come from
// lib/eventRefundPolicy; nothing here decides anything.

import { NON_REFUNDABLE_CHECKBOX, type RefundPolicyView } from "@/lib/eventRefundPolicy";

export default function RefundPolicyLines({ view }: { view: RefundPolicyView }) {
  return (
    <div className="space-y-1">
      {view.lines.map((l, i) => (
        <p key={l} className={`text-sm whitespace-pre-line ${i === 0 ? "font-medium text-stone-900" : "text-stone-700"}`}>{l}</p>
      ))}
    </div>
  );
}

/** Required before paying when there are no refunds; the server checks it too. */
export function NonRefundableCheckbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2.5 p-3 min-h-11 rounded-lg bg-stone-50 border border-stone-200 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 flex-shrink-0" />
      <span className="text-sm text-stone-900">{NON_REFUNDABLE_CHECKBOX}</span>
    </label>
  );
}
