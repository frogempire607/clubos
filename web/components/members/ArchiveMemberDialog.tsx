"use client";

// Confirmation path for archiving a member.
//
// The old flow was a one-line window.confirm. Archiving touches payments,
// guardian access, approvals and a login, so the dialog states what happens,
// what is kept, and requires the member's name typed back.

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

interface Preflight {
  member: { id: string; fullName: string };
  blocks: { code: string; message: string }[];
  warnings: string[];
  preserved: string[];
  confirmationPhrase: string;
}

export function ArchiveMemberDialog({
  memberId,
  onClose,
  onArchived,
}: {
  memberId: string;
  onClose: () => void;
  onArchived: (msg: string) => void;
}) {
  const [data, setData] = useState<Preflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/members/${memberId}/archive-preflight`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? "Could not load");
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [memberId]);

  const blocked = (data?.blocks.length ?? 0) > 0;
  const ready = !!data && !blocked && typed.trim().toLowerCase() === data.confirmationPhrase.toLowerCase();

  async function archive() {
    if (!data) return;
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/members/${memberId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmName: typed }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      setError(typeof d?.error === "string" ? d.error : "Could not archive.");
      return;
    }
    onArchived(
      `${data.member.fullName} archived.` +
        (d.closedApprovals ? ` ${d.closedApprovals} pending approval(s) closed.` : ""),
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-lg border border-app-border max-h-[95vh] flex flex-col">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold text-text-primary">
            Archive {data?.member.fullName ?? "member"}
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none" aria-label="Close">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4 text-sm">
          {!data && !error && <div className="text-text-muted">Checking what&apos;s attached…</div>}
          {error && <div className="text-red-600">{error}</div>}

          {data && blocked && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={2} />
                <div>{data.blocks[0].message}</div>
              </div>
            </div>
          )}

          {data && !blocked && (
            <>
              <div className="bg-app-bg/40 border border-app-border rounded-lg p-4">
                <div className="font-medium text-text-primary mb-1">This is reversible.</div>
                <div className="text-text-muted">
                  They stop appearing in the roster, billing and messaging. An owner can restore them.
                </div>
              </div>

              {data.warnings.length > 0 && (
                <div>
                  <div className="font-medium text-text-primary mb-1">What changes</div>
                  <ul className="list-disc pl-5 space-y-1 text-text-muted">
                    {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              {data.preserved.length > 0 && (
                <div>
                  <div className="font-medium text-text-primary mb-1">What is kept</div>
                  <ul className="list-disc pl-5 space-y-1 text-text-muted">
                    {data.preserved.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-text-muted uppercase tracking-wider mb-1">
                  Type <span className="font-mono normal-case text-text-primary">{data.confirmationPhrase}</span> to confirm
                </label>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface"
                  placeholder={data.confirmationPhrase}
                  autoComplete="off"
                />
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-app-border flex items-center justify-between gap-2 shrink-0 pb-[max(env(safe-area-inset-bottom),1rem)]">
          <button onClick={onClose} className="px-4 py-2 border border-app-border rounded-lg text-sm hover:bg-app-bg">
            Cancel
          </button>
          <button
            onClick={archive}
            disabled={!ready || busy}
            className="px-4 py-2 rounded-lg text-sm font-medium border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            {busy ? "Archiving…" : "Archive member"}
          </button>
        </div>
      </div>
    </div>
  );
}
