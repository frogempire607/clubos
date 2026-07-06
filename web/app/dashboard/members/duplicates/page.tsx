"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

type DupMember = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  guardianEmail: string | null;
  guardianName: string | null;
  dateOfBirth: string | null;
  isMinor: boolean;
  status: string;
  hasLogin: boolean;
  migrationStatus: string | null;
  createdAt: string;
  counts: { memberships: number; attendance: number; bookings: number; payments: number };
};
type DupGroup = { reason: string; suggestedPrimaryId: string; members: DupMember[] };

// A record with none of this data is clearly a junk duplicate that can be
// removed outright; anything with data must be MERGED (which preserves it).
function hasNoData(m: DupMember): boolean {
  return (
    !m.hasLogin &&
    m.counts.memberships === 0 &&
    m.counts.attendance === 0 &&
    m.counts.bookings === 0 &&
    m.counts.payments === 0
  );
}

const groupKey = (g: DupGroup) => g.members.map((m) => m.id).sort().join("|");

export default function DuplicatesPage() {
  const [groups, setGroups] = useState<DupGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  // Which record the owner chose to keep, per group (overrides the suggestion).
  const [primaryPick, setPrimaryPick] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/members/duplicates")
      .then((r) => (r.ok ? r.json() : { groups: [] }))
      .then((d) => { setGroups(d.groups || []); setLoading(false); })
      .catch(() => { setGroups([]); setLoading(false); });
  }, []);
  useEffect(() => { load(); }, [load]);

  async function merge(winnerId: string, winnerName: string, loser: DupMember) {
    if (!confirm(
      `Merge "${loser.name}" INTO "${winnerName}"?\n\n` +
      `All of ${loser.name}'s history (memberships, attendance, payments, documents, ` +
      `messages, family links) moves to ${winnerName}. The duplicate is archived — ` +
      `soft-deleted and reversible. Nothing is charged.`,
    )) return;
    setBusy(loser.id); setMsg("");
    try {
      const res = await fetch("/api/members/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winnerId, loserId: loser.id }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(d.error || "Merge failed."); setBusy(null); return; }
      setMsg(`Merged ${loser.name} into ${winnerName}.`);
      setBusy(null);
      load();
    } catch {
      setMsg("Merge failed — please try again.");
      setBusy(null);
    }
  }

  async function remove(m: DupMember) {
    if (!confirm(
      `Remove "${m.name}"?\n\n` +
      `This archives the duplicate (soft delete — reversible) and frees its login slot. ` +
      `Only offered for records with no memberships, attendance, bookings or payments. ` +
      `Nothing is charged. To keep a record's data, use Merge instead.`,
    )) return;
    setBusy(m.id); setMsg("");
    try {
      const res = await fetch(`/api/members/${m.id}`, { method: "DELETE" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(d.error || "Remove failed."); setBusy(null); return; }
      setMsg(`Removed ${m.name}.`);
      setBusy(null);
      load();
    } catch {
      setMsg("Remove failed — please try again.");
      setBusy(null);
    }
  }

  const fmtDob = (d: string | null) =>
    d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "—";

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <Link href="/dashboard/members/migration" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Back to migration
      </Link>
      <h1 className="text-2xl font-semibold text-text-primary mt-3">Review duplicates</h1>
      <p className="text-sm text-text-muted mt-1 max-w-2xl">
        Likely duplicate members, grouped by matching email, name&nbsp;+&nbsp;date of birth,
        or phone&nbsp;+&nbsp;last name. Siblings are never grouped. Pick which record to
        <strong className="text-text-primary"> Keep</strong>, then merge the others into it —
        the duplicate is archived (reversible) and <strong className="text-text-primary">nothing is charged</strong>.
        Empty junk records can be removed outright.
      </p>

      {msg && (
        <div className="mt-4 text-sm rounded-lg border border-app-border bg-app-bg px-3 py-2 text-text-primary">{msg}</div>
      )}

      {loading ? (
        <p className="mt-8 text-sm text-text-muted">Scanning your members…</p>
      ) : groups.length === 0 ? (
        <div className="mt-8 rounded-xl border border-app-border bg-surface p-8 text-center">
          <p className="text-text-primary font-medium">No duplicates found 🎉</p>
          <p className="text-sm text-text-muted mt-1">Every member looks unique.</p>
        </div>
      ) : (
        <div className="mt-6 space-y-5">
          {groups.map((g) => {
            const gk = groupKey(g);
            const primaryId = primaryPick[gk] ?? g.suggestedPrimaryId;
            const primary = g.members.find((m) => m.id === primaryId) || g.members[0];
            return (
              <div key={gk} className="rounded-xl border border-app-border bg-surface p-5">
                <div className="text-xs uppercase tracking-wide text-text-muted mb-3">
                  {g.members.length} records · matched on {g.reason}
                </div>
                <div className="space-y-2">
                  {g.members.map((m) => {
                    const isPrimary = m.id === primary.id;
                    return (
                      <div
                        key={m.id}
                        className={`flex items-start justify-between gap-3 rounded-lg border p-3 ${isPrimary ? "border-lime-accent/50 bg-lime-accent/5" : "border-app-border"}`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Link href={`/dashboard/members/${m.id}`} className="font-medium text-text-primary hover:underline">{m.name}</Link>
                            {isPrimary && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-lime-accent/25 text-text-primary font-semibold">Keep</span>}
                            {m.isMinor && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-app-bg text-text-muted">Minor</span>}
                            {m.hasLogin && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-brand/10 text-brand">Has login</span>}
                          </div>
                          <div className="text-xs text-text-muted mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                            {m.email && <span>{m.email}</span>}
                            {m.phone && <span>{m.phone}</span>}
                            <span>DOB {fmtDob(m.dateOfBirth)}</span>
                            {m.guardianEmail && <span>Guardian: {m.guardianEmail}</span>}
                          </div>
                          <div className="text-[11px] text-text-muted mt-1">
                            {m.counts.memberships} memberships · {m.counts.attendance} attendance · {m.counts.bookings} bookings · {m.counts.payments} payments · {m.status.toLowerCase()}
                          </div>
                        </div>
                        {!isPrimary && (
                          <div className="flex flex-col items-end gap-1.5 shrink-0">
                            <button
                              onClick={() => setPrimaryPick((p) => ({ ...p, [gk]: m.id }))}
                              disabled={busy === m.id}
                              className="text-xs px-3 py-1.5 rounded-lg border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50"
                              title="Keep this record as the main account instead"
                            >
                              Keep this one
                            </button>
                            <button
                              onClick={() => merge(primary.id, primary.name, m)}
                              disabled={busy === m.id}
                              className="text-xs px-3 py-1.5 rounded-lg bg-text-primary text-white hover:opacity-90 disabled:opacity-50"
                            >
                              {busy === m.id ? "Merging…" : `Merge into ${primary.name.split(" ")[0]}`}
                            </button>
                            {hasNoData(m) && (
                              <button
                                onClick={() => remove(m)}
                                disabled={busy === m.id}
                                className="text-xs px-3 py-1.5 rounded-lg border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50"
                                title="Archive this empty duplicate (reversible)"
                              >
                                {busy === m.id ? "Removing…" : "Remove"}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
