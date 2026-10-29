"use client";

// "Paid by" — 2026-10-29. Who pays for an athlete: a parent, or a coach who
// pays for a whole team (Jason Reynolds). Any account in the club; paying
// grants no portal access. One step can set it for every athlete that account
// is linked to. "Coach / team payer" keeps the team from counting as siblings.
// Writes through the billing-admin action `set_payer`; nothing is charged and
// running memberships aren't repriced.

import { useEffect, useState } from "react";
import Sheet from "@/components/Sheet";

type Result = { id: string; name: string; email: string };
type Linked = { id: string; name: string; alreadyPaidBy: boolean; relationship: string | null };

const BTN = "inline-flex min-h-[44px] items-center justify-center rounded-lg border border-app-border px-4 text-sm text-text-primary hover:bg-app-bg disabled:opacity-50";
const BTNP = "inline-flex min-h-[44px] items-center justify-center rounded-lg bg-brand px-4 text-sm text-white hover:bg-brand-hover disabled:opacity-50";

export default function PaidBySheet({
  memberId, firstName, current, onClose, onDone,
}: {
  memberId: string;
  firstName: string;
  current: { userId: string; name: string } | null;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [chosen, setChosen] = useState<Result | null>(current ? { id: current.userId, name: current.name, email: "" } : null);
  const [linked, setLinked] = useState<Linked[]>([]);
  const [also, setAlso] = useState<Set<string>>(new Set());
  const [coach, setCoach] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(() => {
      fetch(`/api/members/${memberId}/payer?q=${encodeURIComponent(q.trim())}`)
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((d) => setResults(d.results ?? []))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, memberId]);

  useEffect(() => {
    if (!chosen) { setLinked([]); return; }
    fetch(`/api/members/${memberId}/payer?forUserId=${encodeURIComponent(chosen.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        const list: Linked[] = d.athletes ?? [];
        setLinked(list);
        // Everyone they're linked to and nobody else pays for yet, pre-ticked.
        setAlso(new Set(list.filter((a) => !a.alreadyPaidBy).map((a) => a.id)));
        // Default for "coach, not family": already labelled coach; or not this
        // athlete's guardian at all; or no family label and linked to athletes
        // from more than one family. A labelled parent defaults to family.
        const rel = (d.relationshipToThis as string | null) ?? null;
        const familyWord = !!rel && /parent|mother|father|guardian|grand|step|aunt|uncle/i.test(rel);
        setCoach(!!d.isCoachHere || !d.linkedHere || (!familyWord && !!d.looksLikeTeam));
      })
      .catch(() => {});
  }, [chosen, memberId]);

  async function save(payerUserId: string | null) {
    setBusy(true); setErr("");
    const r = await fetch(`/api/members/${memberId}/billing-admin/actions`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "set_payer", confirm: true, payerUserId,
        alsoMemberIds: payerUserId ? Array.from(also) : [],
        payerIsCoach: payerUserId ? coach : false,
      }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setErr(typeof d.error === "string" ? d.error : "That didn't work — nothing was changed."); return; }
    onDone(d.message ?? "Saved.");
  }

  return (
    <Sheet open onClose={() => { if (!busy) onClose(); }} title="Paid by" description={`Who pays for ${firstName}`}
      footer={<>
        {current && <button type="button" className={`${BTN} mr-auto`} disabled={busy} onClick={() => save(null)}>Clear</button>}
        <button type="button" className={BTN} disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className={BTNP} disabled={busy || !chosen} onClick={() => chosen && save(chosen.id)}>{busy ? "Saving…" : "Save"}</button>
      </>}>
      <p className="text-sm text-text-muted">A parent, or a coach paying for a team. Paying doesn&apos;t give portal access — parents stay the guardians. Nothing is charged here.</p>

      {chosen ? (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-app-border px-3 py-2">
          <div className="min-w-0 text-sm"><span className="font-medium text-text-primary">{chosen.name}</span>{chosen.email && <span className="text-xs text-text-muted"> · {chosen.email}</span>}</div>
          <button type="button" className="inline-flex min-h-[44px] items-center text-xs text-brand hover:underline md:min-h-0" onClick={() => { setChosen(null); setQ(""); }}>Change</button>
        </div>
      ) : (
        <div className="mt-3">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email"
            className="w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand" />
          <ul className="mt-2 space-y-1">
            {results.map((u) => (
              <li key={u.id}>
                <button type="button" onClick={() => setChosen(u)} className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg border border-app-border px-3 text-left text-sm hover:bg-app-bg">
                  <span className="font-medium text-text-primary">{u.name}</span><span className="truncate text-xs text-text-muted">{u.email}</span>
                </button>
              </li>
            ))}
            {q.trim().length >= 2 && results.length === 0 && <li className="text-xs text-text-muted">No account matches. They need a portal account first — add them as a guardian or send an invite.</li>}
          </ul>
        </div>
      )}

      {chosen && (
        <>
          <label className="mt-3 flex items-start gap-2 text-sm text-text-primary">
            <input type="checkbox" className="mt-1" checked={coach} onChange={(e) => setCoach(e.target.checked)} />
            <span><b>Coach / team payer, not family.</b> <span className="text-text-muted">The athletes they pay for won&apos;t count as siblings for the sibling discount. Brothers still get it through their own parent.</span></span>
          </label>
          {linked.length > 0 && (
            <div className="mt-3">
              <p className="text-xs font-medium uppercase tracking-wider text-text-muted">Also set for</p>
              <ul className="mt-1 space-y-1">
                {linked.map((a) => (
                  <li key={a.id}>
                    <label className="flex min-h-[44px] items-center gap-2 text-sm text-text-primary md:min-h-0">
                      <input type="checkbox" checked={also.has(a.id)} onChange={(e) => {
                        const n = new Set(also); if (e.target.checked) n.add(a.id); else n.delete(a.id); setAlso(n);
                      }} />
                      {a.name}
                      <span className="text-xs text-text-muted">{a.alreadyPaidBy ? "· already paid by them" : a.relationship ? `· ${a.relationship}` : ""}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </Sheet>
  );
}
