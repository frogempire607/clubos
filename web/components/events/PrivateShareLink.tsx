"use client";

// The event's PRIVATE share link: /e/s-<token>. Create it, copy it, make a new
// one (the old link stops working), or turn it off. Used by the editor's "Who
// signs up" card and the event row's ⋯ menu; both talk to
// /api/events/[id]/share-link, which is the only place the token is ever
// returned (events:edit). Renders nothing for staff who can't edit events.

import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import Sheet from "@/components/Sheet";
import { copyText } from "@/components/events/PublicLinkBox";

type Link = { token: string; path: string } | null;

export const PRIVATE_LINK_HINT =
  "Only people you send this to can see and register for the event. It doesn't appear on your public page.";

export default function PrivateShareLink({ eventId }: { eventId: string }) {
  const [state, setState] = useState<"loading" | "ready" | "hidden">("loading");
  const [link, setLink] = useState<Link>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<null | "rotate" | "off">(null);

  useEffect(() => {
    let live = true;
    setState("loading");
    fetch(`/api/events/${eventId}/share-link`)
      .then(async (r) => {
        if (!live) return;
        if (r.status === 401 || r.status === 403 || r.status === 404) return setState("hidden");
        if (!r.ok) { setError("Couldn't load the private link."); return setState("ready"); }
        const d = await r.json().catch(() => ({}));
        setLink(d.link ?? null);
        setState("ready");
      })
      .catch(() => { if (live) { setError("Couldn't load the private link."); setState("ready"); } });
    return () => { live = false; };
  }, [eventId]);

  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(t); }, [copied]);

  async function call(method: "POST" | "DELETE", body?: unknown) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/events/${eventId}/share-link`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setError(typeof d.error === "string" ? d.error : "That didn't work. Try again.");
      else setLink(d.link ?? null);
    } catch {
      setError("That didn't work. Check your connection and try again.");
    }
    setBusy(false);
    setConfirm(null);
  }

  if (state === "hidden") return null;

  const url = link ? `${typeof window !== "undefined" ? window.location.origin : ""}${link.path}` : "";
  const quiet = "inline-flex items-center justify-center min-h-[44px] px-3 rounded-lg border border-app-border text-xs font-medium text-text-primary hover:bg-app-bg disabled:opacity-50";

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-text-primary">Private share link</p>
      {state === "loading" ? (
        <p className="text-xs text-text-muted">Loading…</p>
      ) : link ? (
        <>
          <div className="flex items-center gap-2 rounded-xl border border-app-border bg-surface px-3 py-2">
            <input
              readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Private share link"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] font-mono text-text-primary outline-none"
            />
            <button
              type="button"
              onClick={async () => { if (await copyText(url)) setCopied(true); }}
              className={`shrink-0 inline-flex items-center gap-1 min-h-[44px] px-3 rounded-lg text-xs font-medium ${copied ? "bg-lime-accent/25 text-text-primary" : "bg-brand text-white hover:bg-brand-hover"}`}
            >
              {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
            </button>
            <a href={url} target="_blank" rel="noreferrer" aria-label="Open the private link" className="shrink-0 inline-flex items-center justify-center w-11 h-11 rounded-lg border border-app-border text-text-muted hover:text-text-primary hover:bg-app-bg">
              <ExternalLink size={14} />
            </a>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => setConfirm("rotate")} className={quiet}>Make a new link</button>
            <button type="button" disabled={busy} onClick={() => setConfirm("off")} className={quiet}>Turn off</button>
          </div>
        </>
      ) : (
        <button type="button" disabled={busy} onClick={() => call("POST")} className={quiet}>
          {busy ? "Creating…" : "Create private link"}
        </button>
      )}
      <p className="text-xs text-text-muted">{PRIVATE_LINK_HINT}</p>
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}

      <Sheet
        open={confirm !== null}
        onClose={() => { if (!busy) setConfirm(null); }}
        title={confirm === "off" ? "Turn off the private link?" : "Make a new private link?"}
        description={
          confirm === "off"
            ? "The link stops working right away. People who already registered keep their spot."
            : "The old link stops working right away. Anyone you already sent it to will need the new one. People who already registered keep their spot."
        }
        footer={
          <>
            <button type="button" disabled={busy} onClick={() => setConfirm(null)} className="min-h-[44px] px-4 rounded-lg border border-app-border text-sm font-medium text-text-primary hover:bg-app-bg disabled:opacity-50">
              Keep this link
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => (confirm === "off" ? call("DELETE") : call("POST", { rotate: true }))}
              className="min-h-[44px] px-4 rounded-lg bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
            >
              {busy ? "Working…" : confirm === "off" ? "Turn off" : "Make a new link"}
            </button>
          </>
        }
      />
    </div>
  );
}
