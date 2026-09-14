"use client";

// ─── "No active membership" confirmation ─────────────────────────────────────
//
// The 409 body from POST /api/attendance. The SERVER decides whether a trial
// can be granted, so this panel never offers an option the check-in would then
// refuse.
export type NoMembershipPrompt = {
  memberFirstName: string;
  status: string;
  message: string;
  trial: {
    available: boolean;
    name: string;
    days: number;
    renewable: boolean;
    unavailableReason: string | null;
  };
};

const STATUS_VERB: Record<string, string> = { PRESENT: "present", LATE: "late" };

/**
 * The billing decision, asked once, at the moment it is still cheap to make.
 *
 * Three options and a way out. "Mark {status} anyway" is a real option, not a
 * discouraged one — a coach must always be able to write down who was in the
 * room, and a membership question is not a reason to turn a child away at the
 * door. What it must not be is SILENT, which is what it was.
 */
export default function NoMembershipPanel({
  prompt,
  dropInPrice,
  showDropIn,
  busy,
  emailReceipt,
  onEmailReceiptChange,
  onTrial,
  onDropIn,
  onAnyway,
  onCancel,
  error,
}: {
  prompt: NoMembershipPrompt;
  dropInPrice: number | null;
  showDropIn: boolean;
  busy: boolean;
  emailReceipt: boolean;
  onEmailReceiptChange: (v: boolean) => void;
  onTrial: () => void;
  onDropIn: () => void;
  onAnyway: () => void;
  onCancel: () => void;
  error?: string;
}) {
  const first = prompt.memberFirstName;
  const verb = STATUS_VERB[prompt.status] ?? "present";
  const { trial } = prompt;

  return (
    <div className="mt-2 pt-2 border-t border-app-border space-y-2">
      <p className="text-sm font-medium text-text-primary">No active membership</p>
      <p className="text-xs text-text-muted">
        {first} isn&apos;t on a membership. Marking them {verb} records the session and bills nothing.
      </p>

      {trial.available ? (
        <div className="space-y-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={onTrial}
            className="w-full text-left px-2 py-1.5 rounded border border-app-border hover:bg-app-bg disabled:opacity-50"
          >
            <span className="block text-xs font-medium text-text-primary">Start {trial.name}</span>
            <span className="block text-[11px] text-text-muted">
              {trial.days} day{trial.days === 1 ? "" : "s"} free, active like a membership, then it ends on
              its own.
              {trial.renewable ? "" : " One per client — it can't be renewed later."}
            </span>
          </button>
          <label className="flex items-center gap-1.5 text-[11px] text-text-muted pl-2">
            <input
              type="checkbox"
              checked={emailReceipt}
              onChange={(e) => onEmailReceiptChange(e.target.checked)}
              className="w-3.5 h-3.5 accent-brand"
            />
            Email a trial receipt
          </label>
        </div>
      ) : (
        trial.unavailableReason && (
          <p className="text-[11px] text-text-muted bg-app-bg border border-app-border rounded px-2 py-1">
            {trial.unavailableReason}
          </p>
        )
      )}

      {showDropIn && (
        <button
          type="button"
          disabled={busy}
          onClick={onDropIn}
          className="w-full text-left px-2 py-1.5 rounded border border-app-border hover:bg-app-bg disabled:opacity-50"
        >
          <span className="block text-xs font-medium text-text-primary">
            {/* THIS class's drop-in price, or no price at all — never a default. */}
            Charge a drop-in{dropInPrice == null ? "" : ` — $${fmtMoney(dropInPrice)}`}
          </span>
          <span className="block text-[11px] text-text-muted">
            Take the payment now: cash, card, comp or invoice.
          </span>
        </button>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={onAnyway}
        className="w-full text-left px-2 py-1.5 rounded border border-app-border hover:bg-app-bg disabled:opacity-50"
      >
        <span className="block text-xs font-medium text-text-primary">
          {busy ? "Recording…" : `Mark ${verb} anyway`}
        </span>
        <span className="block text-[11px] text-text-muted">
          No charge. {first} stays in &ldquo;Attending, no active membership&rdquo; until they&apos;re on a
          plan.
        </span>
      </button>

      {error && <p className="text-red-600 text-xs">{error}</p>}

      <button
        type="button"
        onClick={onCancel}
        className="text-[11px] text-text-muted hover:text-text-primary underline"
      >
        Cancel
      </button>
    </div>
  );
}

const fmtMoney = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
