// Phase 4.5.7 — the migration funnel, the progress bar, and the cut-over
// advisory.
//
// Every segment is a FILTER, not a statistic. That is the difference between
// this and the eight KPI tiles it replaces: a number an owner cannot act on is
// a number they learn to ignore.

"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, AlertTriangle } from "lucide-react";

export type FunnelPayload = {
  capped: boolean;
  total: number;
  segments: { step: number; label: string; count: number; subline: string | null }[] | null;
  progress: { complete: number; inSetup: number; invitedNoResponse: number; notInvited: number } | null;
  queue: { needsYou: number; waitingOnMember: number; inSetup: number; done: number; blocked: number } | null;
  advisory: {
    total: number;
    complete: number;
    notYetConfirmed: number;
    safeToCancel: boolean;
    headline: string;
  } | null;
};

export function MigrationFunnel({
  activeStep,
  onPickStep,
}: {
  activeStep: number | null;
  onPickStep: (step: number | null) => void;
}) {
  const [data, setData] = useState<FunnelPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/members/migration/funnel")
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not load the funnel");
        return r.json();
      })
      .then((d: FunnelPayload) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not load the funnel"));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="rounded-xl border border-app-border bg-surface p-4 text-[13px] text-text-muted">{error}</div>
    );
  }
  if (!data) {
    return <div className="h-[132px] animate-pulse rounded-xl border border-app-border bg-app-bg" />;
  }
  if (data.capped || !data.segments || !data.progress) {
    return (
      <div className="rounded-xl border border-app-border bg-surface p-4 text-[13px] text-text-muted">
        {data.total.toLocaleString()} imported members — too many to summarise live. Use the queue filters below.
      </div>
    );
  }

  const { segments, progress, advisory } = data;
  const barTotal = Math.max(1, progress.complete + progress.inSetup + progress.invitedNoResponse + progress.notInvited);
  const bars = [
    { key: "complete", label: "Complete", value: progress.complete, color: "var(--color-success)" },
    { key: "inSetup", label: "In setup", value: progress.inSetup, color: "var(--color-brand)" },
    { key: "invitedNoResponse", label: "Invited, no response", value: progress.invitedNoResponse, color: "var(--color-orange-accent)" },
    { key: "notInvited", label: "Not invited", value: progress.notInvited, color: "var(--color-border)" },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* ── The seven segments ─────────────────────────────────────────────
          One joined strip, not seven cards: the shared border is what makes it
          read as a single sequence you are moving people along. */}
      <div className="overflow-x-auto">
        <div className="flex min-w-max rounded-[10px] border border-app-border bg-surface md:min-w-0">
          {segments.map((s, i) => {
            const active = activeStep === s.step;
            const last = i === segments.length - 1;
            return (
              <button
                key={s.step}
                onClick={() => onPickStep(active ? null : s.step)}
                aria-pressed={active}
                className={`relative min-w-[132px] flex-1 px-3 py-2.5 text-left transition-colors hover:bg-app-bg ${
                  i === 0 ? "rounded-l-[10px]" : ""
                } ${last ? "rounded-r-[10px]" : ""} ${active ? "ring-2 ring-inset ring-brand" : ""}`}
                style={{
                  borderLeft: i === 0 ? undefined : "1px solid var(--color-border)",
                  // Step 7 is the destination — tint it so the eye lands there.
                  background: last ? "rgba(163,230,53,.10)" : undefined,
                }}
              >
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-text-muted">
                  {s.step} · {s.label}
                </div>
                <div className="mt-0.5 text-[22px] font-semibold leading-none tabular-nums text-text-primary">
                  {s.count.toLocaleString()}
                </div>
                <div className="mt-1 h-[14px] text-[11px]" style={{ color: "var(--color-warn-text)" }}>
                  {s.subline ?? ""}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Where everyone actually is ─────────────────────────────────── */}
      <div>
        <div className="flex h-1.5 overflow-hidden rounded-full bg-app-bg">
          {bars.map((b) =>
            b.value > 0 ? (
              <div key={b.key} style={{ width: `${(b.value / barTotal) * 100}%`, background: b.color }} title={`${b.label}: ${b.value}`} />
            ) : null,
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-text-muted">
          {bars.map((b) => (
            <span key={b.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: b.color }} />
              {b.label} <span className="tabular-nums text-text-primary">{b.value.toLocaleString()}</span>
            </span>
          ))}
        </div>
      </div>

      {/* ── "When can I cancel my old software?" ────────────────────────── */}
      {advisory && (
        <div
          className="flex items-start gap-2.5 rounded-[10px] border p-3"
          style={
            advisory.safeToCancel
              ? { background: "var(--color-success-surface)", borderColor: "rgba(63,98,18,.25)" }
              : { background: "var(--color-warn-surface)", borderColor: "rgba(180,83,9,.22)" }
          }
        >
          {advisory.safeToCancel ? (
            <ShieldCheck className="mt-px h-4 w-4 shrink-0" style={{ color: "var(--color-success-text)" }} />
          ) : (
            <AlertTriangle className="mt-px h-4 w-4 shrink-0" style={{ color: "var(--color-warn-text)" }} />
          )}
          <div>
            <div
              className="text-[13px] font-semibold"
              style={{ color: advisory.safeToCancel ? "var(--color-success-text)" : "var(--color-warn-text)" }}
            >
              When can I stop paying for my previous system?
            </div>
            <p className="mt-0.5 text-[12.5px] text-text-primary">{advisory.headline}</p>
            <p className="mt-1 text-[11.5px] text-text-muted">
              Nobody is charged in AthletixOS until they activate, so running both for a few weeks costs you the old
              subscription and nothing here.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
