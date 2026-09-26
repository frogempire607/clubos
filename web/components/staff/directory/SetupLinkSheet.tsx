"use client";

// B21 — "Setup link" from the Staff directory, in a Sheet instead of
// window.alert/window.prompt. Uses the existing POST /api/staff/<id>/setup-link.
import { useEffect, useState } from "react";
import Sheet from "@/components/Sheet";

type Target = { id: string; firstName: string; email: string };

export default function SetupLinkSheet({ target, onClose }: { target: Target | null; onClose: () => void }) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ok"; url: string; emailed: boolean }
  >({ kind: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setState({ kind: "loading" });
    setCopied(false);
    (async () => {
      const res = await fetch(`/api/staff/${target.id}/setup-link`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (cancelled) return;
      if (!res.ok || !d.setupUrl) {
        setState({ kind: "error", message: typeof d.error === "string" ? d.error : "Couldn't create a setup link." });
      } else {
        setState({ kind: "ok", url: d.setupUrl, emailed: !!d.emailed });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 text-[13.5px] font-medium md:min-h-[36px]";
  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      title={`Setup link for ${target?.firstName ?? ""}`}
      description="A fresh one-time link. It works for 14 days; any older link stops working."
      footer={
        <>
          {state.kind === "ok" && (
            <button type="button" onClick={() => copy(state.url)} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
              {copied ? "Copied" : "Copy link"}
            </button>
          )}
          <button type="button" onClick={onClose} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
            Done
          </button>
        </>
      }
    >
      {state.kind === "loading" && <p className="text-[13px] text-text-muted">Creating a link…</p>}
      {state.kind === "error" && (
        <p role="alert" className="text-[13px]" style={{ color: "var(--color-danger-text)" }}>{state.message}</p>
      )}
      {state.kind === "ok" && (
        <div className="space-y-3">
          <p className="text-[13px] text-text-muted">
            {state.emailed
              ? `Emailed to ${target?.email}. Copy it too in case the email doesn't arrive.`
              : `The email didn't send. Copy this link and send it to ${target?.firstName} yourself.`}
          </p>
          <div className="break-all rounded-lg border border-app-border bg-app-bg p-3 font-mono text-[12.5px] text-text-primary">{state.url}</div>
        </div>
      )}
    </Sheet>
  );
}
