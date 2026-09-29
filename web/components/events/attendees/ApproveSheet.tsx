"use client";

// Approve — one registration or several — with what happens to each person's
// money stated BEFORE the button, per registration:
//   "Approving Colton charges their saved card $87.47 now."
// and, for a batch, the total that moves today:
//   "Charged now: $174.94 (2 people)"  →  [Approve 3 · charge $174.94 now]
//
// No approval fires without this sheet: the Attendees screen (single row and
// "Approve waiting") and the Approvals page both open it. Each approval is the
// existing POST /api/events/[id]/registrations/[regId]/approve, one per
// person, in order; the server does the same thing it always did — this sheet
// only makes sure the coach knows what that is.
//
// The sentences come from lib/registrationMoney (computed server-side on the
// same rows), never from this component.

import { useMemo, useState } from "react";
import Sheet from "@/components/Sheet";
import { approveBatchSummary, type RegistrationMoney } from "@/lib/registrationMoney";

export type ApproveItem = {
  eventId: string;
  registrationId: string;
  name: string;
  money: RegistrationMoney;
  /** Shown under the name when the sheet spans several events (Approvals page). */
  eventName?: string;
};

const btn = "min-h-11 px-4 rounded-[10px] text-[14px] font-semibold disabled:opacity-50";

export default function ApproveSheet({
  items,
  onClose,
  onDone,
}: {
  items: ApproveItem[];
  onClose: () => void;
  /** Called once every approval has been sent, with a message to show. */
  onDone: (msg: { ok: boolean; text: string }) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(items.filter((i) => i.money.approveEffect.kind !== "BLOCKED").map((i) => i.registrationId)),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const single = items.length === 1;
  const chosen = useMemo(() => items.filter((i) => picked.has(i.registrationId)), [items, picked]);
  const summary = approveBatchSummary(chosen);
  const blockedCount = items.filter((i) => i.money.approveEffect.kind === "BLOCKED").length;
  const blockedAll = blockedCount === items.length;

  async function approve() {
    setBusy(true);
    setErr("");
    const problems: string[] = [];
    let approved = 0;
    for (const it of chosen) {
      const res = await fetch(`/api/events/${it.eventId}/registrations/${it.registrationId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const why = typeof d.message === "string" ? d.message : typeof d.error === "string" ? d.error : "not approved";
        problems.push(`${it.name}: ${why}`);
        continue;
      }
      approved++;
      // The decision stands even when the money side didn't — said out loud.
      if (typeof d.chargeError === "string") problems.push(`${it.name} approved, but the card charge didn't go through: ${d.chargeError}`);
      if (typeof d.invoiceError === "string") problems.push(`${it.name} approved, but the payment link didn't send: ${d.invoiceError}`);
    }
    setBusy(false);
    if (single && approved === 0) {
      setErr(problems[0] ?? "That didn't go through.");
      return;
    }
    const head = single ? `${chosen[0]?.name ?? "They"} approved.` : `Approved ${approved} of ${chosen.length}.`;
    onDone({ ok: problems.length === 0, text: problems.length ? `${head} ${problems.join(" · ")}` : head });
  }

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const label = single
    ? summary.chargeNowCents > 0
      ? summary.buttonLabel.replace(/^Approve 1/, "Approve")
      : "Approve · nothing charged today"
    : summary.buttonLabel;

  const title = single ? `Approve ${items[0].name}?` : `Approve ${items.length} registrations?`;

  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      width={600}
      description={single ? items[0].money.registeredFor : "What happens to each person's money when you approve."}
      footer={
        <>
          <button type="button" onClick={onClose} className={`${btn} border border-app-border text-text-primary`}>Cancel</button>
          <button
            type="button"
            onClick={approve}
            disabled={busy || chosen.length === 0 || blockedAll}
            className={`${btn} bg-brand text-white hover:bg-brand-hover`}
          >
            {busy ? "Approving…" : label}
          </button>
        </>
      }
    >
      <ul className="divide-y divide-hairline">
        {items.map((it) => {
          const m = it.money;
          const blocked = m.approveEffect.kind === "BLOCKED";
          const charges = m.approveEffect.chargeNowCents > 0;
          return (
            <li key={it.registrationId} className="py-2.5 flex items-start gap-3">
              {!single && (
                <input
                  type="checkbox"
                  aria-label={`Include ${it.name}`}
                  checked={picked.has(it.registrationId)}
                  disabled={blocked}
                  onChange={() => toggle(it.registrationId)}
                  className="mt-1 h-4 w-4 flex-shrink-0"
                />
              )}
              <div className="min-w-0 flex-1">
                {!single && (
                  <div className="text-[14px] font-semibold text-text-primary">
                    {it.name}
                    {it.eventName ? <span className="font-normal text-text-muted"> · {it.eventName}</span> : null}
                  </div>
                )}
                <p className={`text-[14px] ${blocked ? "text-warn-text" : "text-text-primary"}`}>
                  {charges && (
                    <span className="inline-block mr-1.5 text-[12px] font-semibold px-2 py-0.5 rounded-full bg-prospect-surface text-prospect-text align-middle">Charges now</span>
                  )}
                  {m.approveEffect.sentence}
                </p>
                <p className="text-[12.5px] text-text-muted mt-0.5">
                  {m.methodLabel} · {m.amountLabel}
                  {!single && m.registeredFor ? ` · ${m.registeredFor}` : ""}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      {!single && (
        <p className="mt-3 text-[14px] font-semibold text-text-primary tabular-nums">
          {summary.chargedLine}
          {blockedCount > 0 ? <span className="font-normal text-text-muted"> · {blockedCount} can&apos;t be approved yet</span> : null}
        </p>
      )}
      {err && <p className="mt-3 text-[12.5px] rounded-[10px] px-3 py-2 bg-danger-surface text-danger-text border border-danger-border">{err}</p>}
    </Sheet>
  );
}
