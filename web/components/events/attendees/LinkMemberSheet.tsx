"use client";

// Link a public signup to an existing club member. Suggestions are exact-name
// matches (case/space-insensitive) among the club's members; staff can search
// for anyone else. Nothing links until staff pick someone AND confirm.
//   GET  /api/events/[id]/registrations/[regId]/link-member?q=
//   POST /api/events/[id]/registrations/[regId]/link-member { memberId }

import { useEffect, useState } from "react";
import Sheet from "@/components/Sheet";

type Candidate = {
  id: string;
  name: string;
  status: string;
  dateOfBirth: string | null;
  hasEmail: boolean;
  guardianName: string | null;
  alreadyRegistered: boolean;
};

const btn = "min-h-11 px-4 rounded-[10px] text-[14px] font-semibold disabled:opacity-50";
const field = "w-full min-h-11 px-3 py-2 border border-app-border rounded-[10px] text-[14px] bg-surface text-text-primary";

function detailLine(c: Candidate): string {
  const bits = [c.status === "PROSPECT" ? "Prospect" : c.status.charAt(0) + c.status.slice(1).toLowerCase()];
  if (c.dateOfBirth) bits.push(`born ${c.dateOfBirth}`);
  if (c.guardianName) bits.push(`guardian ${c.guardianName}`);
  bits.push(c.hasEmail ? "has an email" : "no email on file");
  return bits.join(" · ");
}

export default function LinkMemberSheet({
  eventId,
  registrationId,
  name,
  onClose,
  onDone,
}: {
  eventId: string;
  registrationId: string;
  name: string;
  onClose: () => void;
  onDone: (msg: { ok: boolean; text: string }) => void;
}) {
  const base = `/api/events/${eventId}/registrations/${registrationId}/link-member`;
  const [suggestions, setSuggestions] = useState<Candidate[] | null>(null);
  const [results, setResults] = useState<Candidate[]>([]);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    fetch(base)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) return setErr(typeof d.error === "string" ? d.error : "Couldn't load members.");
        setSuggestions(d.suggestions ?? []);
      })
      .catch(() => alive && setErr("Couldn't load members."));
    return () => { alive = false; };
  }, [base]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      fetch(`${base}?q=${encodeURIComponent(term)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive && d) setResults(d.results ?? []); })
        .catch(() => undefined);
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, base]);

  async function link() {
    if (!picked) return;
    setBusy(true);
    setErr("");
    const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memberId: picked.id }) });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setErr(typeof d.message === "string" ? d.message : typeof d.error === "string" ? d.error : "Couldn't link them.");
    onDone({
      ok: true,
      text: `${name}'s registration is now linked to ${picked.name}.${d.booking === "created" || d.booking === "reconfirmed" ? " They're on the roster and can be checked in." : ""}`,
    });
  }

  function row(c: Candidate) {
    const on = picked?.id === c.id;
    return (
      <li key={c.id}>
        <button
          type="button"
          disabled={c.alreadyRegistered}
          onClick={() => setPicked(c)}
          aria-pressed={on}
          className={`w-full min-h-11 text-left px-3 py-2 rounded-[10px] border ${on ? "border-brand bg-prospect-surface" : "border-app-border"} disabled:opacity-50`}
        >
          <span className="block text-[14px] font-semibold text-text-primary">{c.name}</span>
          <span className="block text-[12px] text-text-muted">
            {c.alreadyRegistered ? "Already registered for this event" : detailLine(c)}
          </span>
        </button>
      </li>
    );
  }

  const footer = picked ? (
    <>
      <button type="button" onClick={() => setPicked(null)} className={`${btn} border border-app-border text-text-primary`}>Back</button>
      <button type="button" onClick={link} disabled={busy} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
        {busy ? "Linking…" : `Link to ${picked.name}`}
      </button>
    </>
  ) : (
    <button type="button" onClick={onClose} className={`${btn} border border-app-border text-text-primary`}>Cancel</button>
  );

  return (
    <Sheet
      open
      onClose={onClose}
      title={picked ? `Link ${name} to ${picked.name}?` : `Link ${name} to a member`}
      description={
        picked
          ? "This registration, its payments and its check-in will belong to that member. Their member record isn't changed."
          : "They signed up through the public link, so no member record was matched. Pick the member this is."
      }
      width={560}
      footer={footer}
    >
      {picked ? (
        <p className="text-[14px] text-text-primary">{detailLine(picked)}</p>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="text-[12px] font-semibold text-text-primary mb-1">Same name in your club</div>
            {suggestions == null ? (
              <p className="text-[12.5px] text-text-muted">Looking…</p>
            ) : suggestions.length === 0 ? (
              <p className="text-[12.5px] text-text-muted">No member named exactly “{name}”. Search below.</p>
            ) : (
              <ul className="space-y-1.5">{suggestions.map(row)}</ul>
            )}
          </div>
          <div>
            <label className="block text-[12px] font-semibold text-text-primary mb-1" htmlFor="link-search">Search members</label>
            <input id="link-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a first or last name" className={field} />
            {results.length > 0 && <ul className="space-y-1.5 mt-2">{results.map(row)}</ul>}
            {q.trim().length >= 2 && results.length === 0 && <p className="text-[12.5px] text-text-muted mt-1">No matches yet.</p>}
          </div>
        </div>
      )}
      {err && <p className="mt-3 text-[12.5px] rounded-[10px] px-3 py-2 bg-danger-surface text-danger-text border border-danger-border">{err}</p>}
    </Sheet>
  );
}
