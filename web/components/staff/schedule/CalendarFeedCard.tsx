"use client";

// "Subscribe to my schedule" (Branch 3) — a coach's personal calendar link.
// The coach sees the three ways to use it (Apple Calendar, Google Calendar,
// copy the link) and can replace it or turn it off. An owner / staff:full
// looking at someone else's profile sees only WHETHER a link exists and can
// replace or turn it off — never the link itself (it opens that coach's
// schedule to whoever holds it). The feed carries no pay.
import { useCallback, useEffect, useState } from "react";
import { CalendarPlus, Copy } from "lucide-react";

type Urls = { ics: string; webcal: string; google: string };
type Choices = { classes: boolean; privates: boolean; events: boolean };
const KINDS: { key: keyof Choices; label: string; hint: string }[] = [
  { key: "classes", label: "Classes", hint: "Your practices — regular, one-day and substitute" },
  { key: "privates", label: "Private lessons", hint: "Confirmed lessons you coach" },
  { key: "events", label: "Events", hint: "Events you are assigned to" },
];
const ALL: Choices = { classes: true, privates: true, events: true };
type Status = {
  enabled: boolean; createdAt: string | null; rotatedAt: string | null; lastAccessedAt: string | null;
  urls: Urls | null; viewer: { isSelf: boolean; canManage: boolean };
  choices?: Choices;
};

const btn = "inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px] disabled:opacity-50";
const outline = `${btn} border border-app-border text-text-primary hover:bg-app-bg`;

function when(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function CalendarFeedCard({ staffId, firstName, self }: { staffId: string; firstName: string; self: boolean }) {
  const [st, setSt] = useState<Status | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<"regenerate" | "off" | null>(null);
  // Before the link exists: what to put on it. After: the saved choice.
  const [draft, setDraft] = useState<Choices>(ALL);

  const load = useCallback(async () => {
    const res = await fetch(`/api/staff/${staffId}/calendar-feed`, { cache: "no-store" });
    if (res.status === 403 || res.status === 404) return setHidden(true);
    if (!res.ok) return setMsg({ kind: "err", text: "Couldn't load the calendar link." });
    const d: Status = await res.json();
    setSt(d);
    if (d.choices) setDraft(d.choices);
  }, [staffId]);
  useEffect(() => { load(); }, [load]);

  async function call(method: "POST" | "DELETE", action?: "create" | "regenerate") {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/staff/${staffId}/calendar-feed`, {
        method,
        headers: action ? { "Content-Type": "application/json" } : undefined,
        body: action ? JSON.stringify(action === "create" ? { action, choices: draft } : { action }) : undefined,
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return setMsg({ kind: "err", text: d.error || "That didn't save. Try again." });
      setConfirm(null);
      await load();
      setMsg({
        kind: "ok",
        text: method === "DELETE" ? "The calendar link is off. Calendars that used it will stop updating."
          : action === "regenerate" ? (self ? "New link ready. The old one no longer works — subscribe again with the new one." : `Done. ${firstName}'s old link no longer works; they can get the new one from their own profile.`)
          : "Your calendar link is ready.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(key: keyof Choices) {
    const next = { ...draft, [key]: !draft[key] };
    if (!next.classes && !next.privates && !next.events) {
      return setMsg({ kind: "err", text: "Keep at least one on. To stop syncing altogether, use Turn off." });
    }
    setDraft(next);
    setMsg(null);
    if (!st?.enabled) return; // saved when the link is set up
    setBusy(true);
    try {
      const res = await fetch(`/api/staff/${staffId}/calendar-feed`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDraft(draft);
        return setMsg({ kind: "err", text: d.error || "That didn't save. Try again." });
      }
      setMsg({ kind: "ok", text: "Saved. Your calendar picks this up the next time it checks — same link, nothing to redo." });
    } finally {
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setMsg({ kind: "ok", text: "Link copied. Paste it into your calendar app's “subscribe” or “add by URL” box." });
    } catch {
      setMsg({ kind: "err", text: "Couldn't copy. Press and hold the link below to copy it." });
    }
  }

  if (hidden) return null;
  const whose = self ? "your" : `${firstName}'s`;

  return (
    <section className="rounded-xl border border-app-border bg-surface p-4 sm:p-5" aria-label="Subscribe to my schedule">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold text-text-primary">
        <CalendarPlus className="h-4 w-4 text-text-muted" aria-hidden />
        {self ? "Subscribe to my schedule" : `${firstName}'s calendar link`}
      </h2>
      <p className="mt-1 text-[12.5px] text-text-muted">
        {self
          ? "Put your classes, private lessons and events — whichever you choose — on your phone's calendar. It updates by itself — a class you are taken off or that is cancelled disappears. It shows only your own schedule, never pay."
          : `A private link ${firstName} can add to their phone's calendar. Only ${firstName} can see the link. You can replace it or turn it off — for example if a phone is lost.`}
      </p>

      {msg && (
        <p role="status" className="mt-3 rounded-lg px-3 py-2 text-[13px]"
          style={msg.kind === "ok" ? { background: "var(--color-success-surface)", color: "var(--color-success-text)" } : { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>
          {msg.text}
        </p>
      )}

      {st && (st.viewer.isSelf ? (
        <fieldset className="mt-3" disabled={busy}>
          <legend className="text-[13px] font-medium text-text-primary">What to sync</legend>
          <div className="mt-1.5 grid gap-1.5 sm:grid-cols-3">
            {KINDS.map((k) => (
              <label key={k.key} className="flex min-h-[44px] cursor-pointer items-start gap-2 rounded-lg border border-app-border px-3 py-2 hover:bg-app-bg">
                <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={draft[k.key]} onChange={() => toggle(k.key)} />
                <span>
                  <span className="block text-[13px] font-medium text-text-primary">{k.label}</span>
                  <span className="block text-[12px] text-text-muted">{k.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-1.5 text-[12px] text-text-muted">Pick one or all. Already tracking privates or events somewhere else? Leave them off here.</p>
        </fieldset>
      ) : st.enabled && st.choices ? (
        <p className="mt-2 text-[12.5px] text-text-muted">
          Syncs: {KINDS.filter((k) => st.choices![k.key]).map((k) => k.label.toLowerCase()).join(", ")}. Only {firstName} can change this.
        </p>
      ) : null)}

      {!st ? (
        !msg && <p className="mt-3 text-[13px] text-text-muted">Loading…</p>
      ) : !st.enabled ? (
        self ? (
          <button type="button" disabled={busy} onClick={() => call("POST", "create")} className={`${btn} mt-3 bg-brand text-white hover:opacity-90`}>
            Set up my calendar link
          </button>
        ) : (
          <p className="mt-3 text-[13px] text-text-muted">{firstName} has not set up a calendar link.</p>
        )
      ) : (
        <>
          {st.urls && (
            <>
              <div className="mt-3 flex flex-wrap gap-2">
                <a href={st.urls.webcal} className={`${btn} bg-brand text-white hover:opacity-90`}>Apple Calendar</a>
                <a href={st.urls.google} target="_blank" rel="noopener noreferrer" className={outline}>Google Calendar</a>
                <button type="button" onClick={() => copy(st.urls!.ics)} className={outline}>
                  <Copy className="h-3.5 w-3.5" aria-hidden /> Copy calendar link
                </button>
              </div>
              <p className="mt-2 break-all rounded-lg border border-app-border bg-app-bg px-2.5 py-2 text-[12px] text-text-muted" aria-label="Your calendar link">{st.urls.ics}</p>
              <p className="mt-2 text-[12.5px] text-text-muted">
                Anyone with this link can see your schedule, so keep it to yourself. Calendar apps check for changes on their own timetable — usually within a few hours, Google can take up to a day.
              </p>
            </>
          )}
          <p className="mt-2 text-[12.5px] text-text-muted">
            {self ? "Link" : "A link is"} on{when(st.rotatedAt ?? st.createdAt) ? ` since ${when(st.rotatedAt ?? st.createdAt)}` : ""}
            {st.lastAccessedAt ? ` · last checked by a calendar ${when(st.lastAccessedAt)}` : " · no calendar has used it yet"}.
          </p>
          {confirm ? (
            <div className="mt-3 rounded-lg border px-3 py-2.5" style={{ background: "var(--color-warn-surface)", borderColor: "var(--color-warn-border)", color: "var(--color-warn-text)" }}>
              <p className="text-[13px]">
                {confirm === "regenerate"
                  ? `Make a new link? The old one stops working right away, and any calendar using it stops updating until ${self ? "you subscribe" : `${firstName} subscribes`} again.`
                  : `Turn ${whose} calendar link off? Any calendar using it stops updating.`}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" disabled={busy} onClick={() => (confirm === "regenerate" ? call("POST", "regenerate") : call("DELETE"))} className={`${btn} bg-brand text-white hover:opacity-90`}>
                  {confirm === "regenerate" ? "Yes, make a new link" : "Yes, turn it off"}
                </button>
                <button type="button" disabled={busy} onClick={() => setConfirm(null)} className={outline}>Keep it</button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => setConfirm("regenerate")} className={outline}>Get a new link</button>
              <button type="button" disabled={busy} onClick={() => setConfirm("off")} className={outline}>Turn off</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
