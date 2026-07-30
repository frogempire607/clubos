"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Download, RotateCcw } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { MEMBER_FIELDS, TRANSACTION_FIELDS } from "@/lib/reportsImports";

type BatchStatus =
  | "DRAFT" | "VALIDATING" | "AWAITING_REVIEW" | "COMMITTING"
  | "COMPLETED" | "FAILED" | "ROLLED_BACK";

type Batch = {
  id: string; kind: "MEMBERS" | "TRANSACTIONS"; status: BatchStatus;
  sourceLabel: string | null; fileName: string; rowCount: number;
  createdCount: number; matchedCount: number; mergedCount: number;
  skippedCount: number; errorCount: number; reviewCount: number;
  startedAt: string | null; completedAt: string | null;
  rolledBackAt: string | null; rollbackExpiresAt: string | null;
  columnMap: Record<string, string | null> & { __dateFormat?: "MDY" | "DMY" | "YMD" };
};

const STEPS = [
  { step: 2, label: "Match columns" },
  { step: 3, label: "Check for problems" },
  { step: 4, label: "Preview" },
  { step: 5, label: "Review matches" },
  { step: 6, label: "Confirm" },
  { step: 7, label: "Done" },
] as const;

export default function WizardPage({ params }: { params: Promise<{ batchId: string }> }) {
  const router = useRouter();
  const search = useSearchParams();
  const [batchId, setBatchId] = useState<string | null>(null);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [step, setStep] = useState<number>(Number(search.get("step") ?? "2"));

  useEffect(() => {
    params.then((p) => setBatchId(p.batchId));
  }, [params]);

  const loadBatch = useCallback(async () => {
    if (!batchId) return;
    const res = await fetch(`/api/reports/imports/${batchId}`);
    if (res.ok) {
      const d = await res.json();
      setBatch(d.batch);
    }
  }, [batchId]);
  useEffect(() => { if (batchId) loadBatch(); }, [batchId, loadBatch]);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("step", String(step));
    router.replace(`/dashboard/reports/imports/${batchId}?${params}`, { scroll: false });
  }, [step, batchId, router]);

  if (!batchId || !batch) {
    return <div className="p-8"><SkeletonList rows={5} /></div>;
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
      <Link href="/dashboard/reports/imports" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary mb-3">
        <ArrowLeft size={13} /> Back to imports
      </Link>
      <PageHeader
        title={`Import: ${batch.fileName}`}
        description={`${batch.kind === "MEMBERS" ? "Members" : "Transactions"} · ${batch.rowCount.toLocaleString()} row${batch.rowCount === 1 ? "" : "s"}${batch.sourceLabel ? ` · from ${batch.sourceLabel}` : ""}`}
      />

      <StepRail step={step} onGoTo={(s) => setStep(s)} />

      <div className="mt-5">
        {step === 2 && <StepMatch batch={batch} onNext={() => setStep(3)} onReload={loadBatch} />}
        {step === 3 && <StepProblems batch={batch} onBack={() => setStep(2)} onNext={() => setStep(4)} onReload={loadBatch} />}
        {step === 4 && <StepPreview batch={batch} onBack={() => setStep(3)} onNext={() => setStep(5)} />}
        {step === 5 && <StepReview batch={batch} onBack={() => setStep(4)} onNext={() => setStep(6)} />}
        {step === 6 && <StepConfirm batch={batch} onBack={() => setStep(5)} onNext={() => setStep(7)} onReload={loadBatch} />}
        {step === 7 && <StepDone batch={batch} onReload={loadBatch} />}
      </div>
    </div>
  );
}

function StepRail({ step, onGoTo }: { step: number; onGoTo: (s: number) => void }) {
  return (
    <div className="bg-surface border border-app-border rounded-lg p-1.5 overflow-x-auto">
      <div className="flex gap-1 min-w-[600px]">
        {STEPS.map((s, i) => {
          const isCurrent = s.step === step;
          const isDone = s.step < step;
          return (
            <button
              key={s.step}
              onClick={() => onGoTo(s.step)}
              className={`flex-1 min-w-[110px] flex items-center gap-2 px-3 py-2 rounded min-h-[44px] text-left ${
                isCurrent ? "bg-app-bg font-semibold text-text-primary" : "text-text-muted hover:text-text-primary"
              }`}
            >
              <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-semibold ${
                isCurrent ? "bg-brand text-white" :
                isDone ? "bg-lime-accent text-charcoal" :
                "bg-app-bg text-text-muted border border-app-border"
              }`}>
                {isDone ? <Check size={12} strokeWidth={3} /> : i + 2}
              </span>
              <span className="text-xs sm:text-sm">{s.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Footer({ back, next, nextLabel, disabled }: { back?: () => void; next?: () => void; nextLabel?: string; disabled?: boolean }) {
  return (
    <div className="border-t border-app-border mt-6 pt-4 flex items-center justify-between">
      {back ? (
        <button onClick={back} className="h-11 min-h-[44px] px-4 border border-app-border rounded-lg text-sm text-text-primary hover:bg-app-bg">
          ← Back
        </button>
      ) : <span />}
      {next && (
        <button
          onClick={next}
          disabled={disabled}
          className="h-11 min-h-[44px] px-4 rounded-lg bg-brand text-white text-sm font-semibold hover:bg-brand-hover disabled:opacity-50 inline-flex items-center gap-1"
        >
          {nextLabel ?? "Next"} <ArrowRight size={14} strokeWidth={2.25} />
        </button>
      )}
    </div>
  );
}

// ── STEP 2: Match columns ───────────────────────────────────────────
function StepMatch({ batch, onNext, onReload }: { batch: Batch; onNext: () => void; onReload: () => void }) {
  const [map, setMap] = useState<Record<string, string | null>>({});
  const [dateFormat, setDateFormat] = useState<"MDY" | "DMY" | "YMD">("MDY");
  const [saving, setSaving] = useState(false);
  const fields = batch.kind === "MEMBERS" ? MEMBER_FIELDS : TRANSACTION_FIELDS;
  const [samples, setSamples] = useState<Array<Record<string, string | null>>>([]);
  const [headers, setHeaders] = useState<string[]>([]);

  useEffect(() => {
    fetch(`/api/reports/imports/${batch.id}/preview?limit=20`).then((r) => r.json()).then((d) => {
      setSamples(d.rows.map((r: { rawData: Record<string, string | null> }) => r.rawData));
      const hdrs = d.rows[0] ? Object.keys(d.rows[0].rawData as Record<string, unknown>) : [];
      setHeaders(hdrs);
      const existingMap: Record<string, string | null> = {};
      for (const h of hdrs) {
        const v = batch.columnMap[h];
        existingMap[h] = typeof v === "string" ? v : null;
      }
      setMap(existingMap);
      const df = batch.columnMap.__dateFormat;
      if (df === "MDY" || df === "DMY" || df === "YMD") setDateFormat(df);
    });
  }, [batch.id, batch.columnMap]);

  async function save(nextAfter: boolean) {
    setSaving(true);
    await fetch(`/api/reports/imports/${batch.id}/mapping`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columnMap: map, dateFormat }),
    });
    setSaving(false);
    onReload();
    if (nextAfter) onNext();
  }

  return (
    <div>
      <div className="bg-surface border border-app-border rounded-xl p-4 mb-3">
        <p className="text-sm text-text-primary mb-1">Map each CSV column to a field.</p>
        <p className="text-xs text-text-muted">Columns left as "Ignored" won't be imported. Dates read as <span className="font-mono font-semibold">{dateFormat}</span> — switch if that looks wrong.</p>
        <div className="mt-3 flex items-center gap-2">
          <label className="text-xs font-medium text-text-muted">Date format:</label>
          {(["MDY", "DMY", "YMD"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setDateFormat(f)}
              className={`text-xs px-3 py-1 rounded ${dateFormat === f ? "bg-charcoal text-white" : "bg-app-bg text-text-muted"}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="bg-surface border border-app-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-text-muted uppercase tracking-wide border-b border-app-border">
              <th className="text-left py-2 pl-4 pr-3">Your column</th>
              <th className="text-left py-2 pr-3">Example</th>
              <th className="text-left py-2 pr-3">Imports as</th>
            </tr>
          </thead>
          <tbody>
            {headers.map((h) => {
              const example = samples.find((r) => r[h] != null && String(r[h]).trim().length > 0)?.[h] ?? "";
              const selected = map[h] ?? null;
              return (
                <tr key={h} className="border-b border-app-border last:border-0">
                  <td className="py-2 pl-4 pr-3 font-mono text-xs text-text-primary">{h}</td>
                  <td className="py-2 pr-3 text-xs text-text-muted truncate max-w-[240px]">{example}</td>
                  <td className="py-2 pr-3">
                    <select
                      value={selected ?? ""}
                      onChange={(e) => setMap({ ...map, [h]: e.target.value || null })}
                      className="h-10 min-h-[44px] px-3 border border-app-border rounded text-sm bg-surface"
                    >
                      <option value="">— Ignored —</option>
                      {fields.map((f) => (
                        <option key={f.key} value={f.key}>{f.label}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Footer next={() => save(true)} disabled={saving} nextLabel={saving ? "Saving…" : "Save and continue"} />
    </div>
  );
}

// ── STEP 3: Check for problems ─────────────────────────────────────
function StepProblems({ batch, onBack, onNext, onReload }: { batch: Batch; onBack: () => void; onNext: () => void; onReload: () => void }) {
  const [data, setData] = useState<{ readyCount: number; errorCount: number; errorGroups: Array<{ kind: string; count: number; sampleRowNumbers: number[] }>; warnings: Array<{ kind: string; count: number }> } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const res = await fetch(`/api/reports/imports/${batch.id}/validate`, { method: "POST" });
      if (res.ok) setData(await res.json());
      setLoading(false);
      onReload();
    })();
  }, [batch.id, onReload]);

  if (loading || !data) return <SkeletonList rows={5} />;

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <StatCard label="Ready" value={data.readyCount} accent="ok" />
        <StatCard label="Errors" value={data.errorCount} accent={data.errorCount > 0 ? "warn" : "ok"} />
        <StatCard label="Warnings" value={data.warnings.length} accent="neutral" />
        <StatCard label="Total" value={batch.rowCount} accent="neutral" />
      </div>
      {data.errorCount > 0 && (
        <div className="bg-surface border border-orange-accent/30 rounded-xl p-4 mb-3">
          <p className="text-sm font-semibold text-text-primary mb-3">Errors — these rows can't be imported</p>
          <ul className="space-y-2 mb-3">
            {data.errorGroups.map((g, i) => (
              <li key={i} className="text-xs text-text-primary">
                <span className="font-semibold">{g.count}× </span>
                {g.kind} <span className="text-text-muted">(rows: {g.sampleRowNumbers.join(", ")}{g.count > 3 ? ", …" : ""})</span>
              </li>
            ))}
          </ul>
          <a
            href={`/api/reports/imports/${batch.id}/errors.csv`}
            className="inline-flex items-center gap-1 h-10 min-h-[44px] px-3 border border-app-border rounded-lg text-xs text-text-primary hover:bg-app-bg"
          >
            <Download size={12} /> Download errors CSV
          </a>
          <p className="text-[11px] text-text-muted mt-2">Fix and re-upload only the errored rows.</p>
        </div>
      )}
      {data.warnings.length > 0 && (
        <div className="bg-surface border border-app-border rounded-xl p-4">
          <p className="text-sm font-semibold text-text-primary mb-3">Warnings — rows import flagged</p>
          <ul className="space-y-1 text-xs text-text-muted">
            {data.warnings.map((w, i) => (
              <li key={i}>• {w.count}× {w.kind}</li>
            ))}
          </ul>
        </div>
      )}
      <Footer back={onBack} next={onNext} nextLabel={`Continue with ${data.readyCount} row${data.readyCount === 1 ? "" : "s"}`} disabled={data.readyCount === 0} />
    </div>
  );
}

// ── STEP 4: Preview ─────────────────────────────────────────────────
function StepPreview({ batch, onBack, onNext }: { batch: Batch; onBack: () => void; onNext: () => void }) {
  const [data, setData] = useState<{ rows: Array<{ id: string; rowNumber: number; rawData: Record<string, string | null>; outcome: string }>; summary: Record<string, number> } | null>(null);
  useEffect(() => {
    fetch(`/api/reports/imports/${batch.id}/preview?limit=50`).then((r) => r.json()).then(setData);
  }, [batch.id]);
  if (!data) return <SkeletonList rows={5} />;
  const headers = data.rows[0] ? Object.keys(data.rows[0].rawData) : [];
  return (
    <div>
      <div className="mb-3 text-xs text-text-muted">
        First {data.rows.length} rows — exactly as they'll be stored.
      </div>
      <div className="bg-surface border border-app-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] text-text-muted uppercase border-b border-app-border">
              <th className="text-left py-2 pl-3 pr-2 sticky left-0 bg-app-bg">#</th>
              <th className="text-left py-2 pr-3 sticky left-8 bg-app-bg">Outcome</th>
              {headers.map((h) => (
                <th key={h} className="text-left py-2 pr-3 font-mono">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.id} className="border-b border-app-border last:border-0">
                <td className="py-2 pl-3 pr-2 sticky left-0 bg-surface text-text-muted tabular-nums">{r.rowNumber}</td>
                <td className="py-2 pr-3 sticky left-8 bg-surface">
                  <OutcomeBadge outcome={r.outcome} />
                </td>
                {headers.map((h) => (
                  <td key={h} className="py-2 pr-3 text-xs text-text-primary truncate max-w-[200px]">{r.rawData[h] ?? "—"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Footer back={onBack} next={onNext} />
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const cls =
    outcome === "MATCHED" ? "bg-brand/20 text-brand" :
    outcome === "CREATED" ? "bg-lime-accent/30 text-charcoal" :
    outcome === "PENDING_REVIEW" ? "bg-orange-accent/20 text-orange-accent" :
    outcome === "EXCLUDED" ? "bg-red-100 text-red-700" :
    outcome === "SKIPPED" ? "bg-app-bg text-text-muted" :
    outcome === "MERGED" ? "bg-brand/20 text-brand" :
    "bg-app-bg text-text-muted";
  return <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded ${cls}`}>{outcome.replace("_", " ")}</span>;
}

// ── STEP 5: Review matches ─────────────────────────────────────────
function StepReview({ batch, onBack, onNext }: { batch: Batch; onBack: () => void; onNext: () => void }) {
  const [data, setData] = useState<{ items: Array<{ rowId: string; rowNumber: number; input: Record<string, string | null>; candidates: Array<{ memberId: string; signal: string; reason: string; member: { firstName: string; lastName: string; email: string | null } | null }>; confidence: string | null }>; total: number; reviewed: number; note?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/reports/imports/${batch.id}/review`);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, [batch.id]);
  useEffect(() => { load(); }, [load]);

  async function decide(rowId: string, outcome: string, targetId?: string) {
    await fetch(`/api/reports/imports/${batch.id}/review/${rowId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome, targetId }),
    });
    load();
  }

  async function bulk(outcome: "SKIPPED" | "CREATED") {
    if (!data) return;
    await Promise.all(data.items.map((it) => fetch(`/api/reports/imports/${batch.id}/review/${it.rowId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome }),
    })));
    load();
  }

  if (loading || !data) return <SkeletonList rows={5} />;

  if (data.note) {
    return (
      <div>
        <div className="bg-surface border border-app-border rounded-xl p-6 text-sm text-text-primary">
          <p>{data.note}</p>
        </div>
        <Footer back={onBack} next={onNext} />
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs text-text-muted">{data.items.length} row{data.items.length === 1 ? "" : "s"} need your call. Reviewed: {data.reviewed}.</p>
        <div className="flex gap-2">
          <button onClick={() => bulk("CREATED")} className="h-10 min-h-[44px] px-3 border border-app-border rounded text-xs text-text-primary hover:bg-app-bg">Keep all separate</button>
          <button onClick={() => bulk("SKIPPED")} className="h-10 min-h-[44px] px-3 border border-app-border rounded text-xs text-text-primary hover:bg-app-bg">Ignore all</button>
        </div>
      </div>
      {data.items.length === 0 ? (
        <div className="bg-surface border border-app-border rounded-xl p-6 text-sm text-text-muted">
          Nothing to review. Every row was auto-matched or auto-created.
        </div>
      ) : (
        <ul className="space-y-3">
          {data.items.map((item) => (
            <li key={item.rowId} className="bg-surface border border-app-border rounded-xl overflow-hidden">
              <div className="px-4 py-2 border-b border-app-border bg-app-bg text-xs text-text-muted">
                Row {item.rowNumber} · Confidence: <span className="font-semibold text-text-primary">{item.confidence}</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-app-border">
                <div className="p-4">
                  <p className="text-[11px] uppercase tracking-wide font-semibold text-text-muted mb-2">From your file</p>
                  <MemberSummary data={item.input} />
                </div>
                <div className="p-4 bg-app-bg/40">
                  <p className="text-[11px] uppercase tracking-wide font-semibold text-text-muted mb-2">Already in AthletixOS ({item.candidates.length})</p>
                  <ul className="space-y-2">
                    {item.candidates.map((c) => (
                      <li key={c.memberId} className="border border-app-border rounded-lg p-2 bg-surface">
                        <p className="text-xs text-text-muted mb-1">{c.signal} · {c.reason}</p>
                        <MemberSummary data={{
                          firstName: c.member?.firstName ?? null,
                          lastName: c.member?.lastName ?? null,
                          email: c.member?.email ?? null,
                        }} />
                        <div className="mt-2 flex gap-1 flex-wrap">
                          <button onClick={() => decide(item.rowId, "MATCHED", c.memberId)} className="h-9 min-h-[44px] sm:min-h-9 px-2 rounded bg-brand text-white text-xs font-semibold">Same person — add history</button>
                          <button onClick={() => decide(item.rowId, "MERGED", c.memberId)} className="h-9 min-h-[44px] sm:min-h-9 px-2 rounded border border-app-border text-text-primary text-xs">Merge</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="px-4 py-2 border-t border-app-border flex flex-wrap gap-2 bg-app-bg/50">
                <button onClick={() => decide(item.rowId, "CREATED")} className="h-9 min-h-[44px] sm:min-h-9 px-3 rounded border border-app-border text-xs text-text-primary hover:bg-surface">Create as separate person</button>
                <button onClick={() => decide(item.rowId, "SKIPPED")} className="h-9 min-h-[44px] sm:min-h-9 px-3 rounded border border-app-border text-xs text-text-primary hover:bg-surface">Keep both, don't link</button>
                <button onClick={() => decide(item.rowId, "EXCLUDED")} className="h-9 min-h-[44px] sm:min-h-9 px-3 rounded border border-app-border text-xs text-red-700 hover:bg-red-50">Skip this row</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Footer back={onBack} next={onNext} disabled={data.items.length > 0} nextLabel={data.items.length > 0 ? `${data.items.length} to review` : "Continue"} />
    </div>
  );
}

function MemberSummary({ data }: { data: Record<string, string | null> }) {
  return (
    <div>
      <p className="text-sm font-medium text-text-primary">{[data.firstName, data.lastName].filter(Boolean).join(" ") || "Unknown"}</p>
      {data.email && <p className="text-[11px] text-text-muted">{data.email}</p>}
      {data.phone && <p className="text-[11px] text-text-muted">{data.phone}</p>}
      {data.dateOfBirth && <p className="text-[11px] text-text-muted">DOB {data.dateOfBirth}</p>}
      {data.externalMemberId && <p className="text-[11px] text-text-muted">Legacy ID {data.externalMemberId}</p>}
    </div>
  );
}

// ── STEP 6: Confirm ────────────────────────────────────────────────
function StepConfirm({ batch, onBack, onNext, onReload }: { batch: Batch; onBack: () => void; onNext: () => void; onReload: () => void }) {
  const [committing, setCommitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ created: number; matched: number; merged: number; skipped: number } | null>(null);

  async function commit() {
    setCommitting(true);
    setErr(null);
    const res = await fetch(`/api/reports/imports/${batch.id}/commit`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setCommitting(false);
    onReload();
    if (!res.ok) { setErr(typeof d.error === "string" ? d.error : "Commit failed"); return; }
    setSummary({ created: d.created ?? 0, matched: d.matched ?? 0, merged: d.merged ?? 0, skipped: d.skipped ?? 0 });
    onNext();
  }

  return (
    <div>
      <div className="bg-surface border border-app-border rounded-xl p-5 space-y-3">
        <p className="text-sm text-text-primary font-semibold">Ready to commit</p>
        <ul className="text-xs text-text-muted space-y-1">
          <li>• {batch.reviewCount} row{batch.reviewCount === 1 ? "" : "s"} will be written to your database.</li>
          <li>• No emails will be sent. Imported people are not invited, not billed, not added to campaigns.</li>
          <li>• Reports will update immediately.</li>
          <li>• You can roll back this import for 30 days.</li>
        </ul>
        {err && <p className="text-xs text-red-600">{err}</p>}
        <button
          onClick={commit}
          disabled={committing}
          className="h-11 min-h-[44px] px-4 bg-brand text-white rounded-lg text-sm font-semibold hover:bg-brand-hover disabled:opacity-50"
        >
          {committing ? "Committing…" : "Commit import"}
        </button>
        {summary && (
          <div className="mt-3 grid grid-cols-4 gap-3 text-xs">
            <StatCard label="Created" value={summary.created} accent="ok" />
            <StatCard label="Matched" value={summary.matched} accent="ok" />
            <StatCard label="Merged" value={summary.merged} accent="ok" />
            <StatCard label="Skipped" value={summary.skipped} accent="neutral" />
          </div>
        )}
      </div>
      <Footer back={onBack} />
    </div>
  );
}

// ── STEP 7: Done ───────────────────────────────────────────────────
function StepDone({ batch, onReload }: { batch: Batch; onReload: () => void }) {
  const [log, setLog] = useState<{ rows: Array<{ id: string; rowNumber: number; outcome: string; reason: string | null; matchSignal: string | null; decidedBy: string | null }>; total: number } | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackMsg, setRollbackMsg] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filter) params.set("outcome", filter);
    fetch(`/api/reports/imports/${batch.id}/log?${params}`).then((r) => r.json()).then(setLog);
  }, [batch.id, filter]);

  async function rollback() {
    if (!confirm("Roll back this import? Members without activity are removed; members with activity are downgraded. Historical records + imported transactions are removed.")) return;
    setRollingBack(true);
    setRollbackMsg(null);
    const res = await fetch(`/api/reports/imports/${batch.id}/rollback`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setRollingBack(false);
    if (!res.ok) { setRollbackMsg(typeof d.error === "string" ? d.error : "Rollback failed"); return; }
    setRollbackMsg(`Rollback complete: removed ${d.removedMembers} members, downgraded ${d.downgradedMembers}, removed ${d.removedTx} transactions, removed ${d.removedHistorical} historical records.`);
    onReload();
  }

  return (
    <div>
      <div className="bg-lime-accent/15 border border-lime-accent/40 rounded-xl p-5 mb-4">
        <p className="text-sm font-semibold text-text-primary mb-2">Import complete</p>
        <ul className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
          <StatCard label="Created" value={batch.createdCount} accent="ok" />
          <StatCard label="Matched" value={batch.matchedCount} accent="ok" />
          <StatCard label="Merged" value={batch.mergedCount} accent="ok" />
          <StatCard label="Skipped" value={batch.skippedCount} accent="neutral" />
          <StatCard label="Errors" value={batch.errorCount} accent={batch.errorCount > 0 ? "warn" : "ok"} />
        </ul>
        <p className="text-[11px] text-text-muted mt-3">
          Rollback available until {batch.rollbackExpiresAt ? new Date(batch.rollbackExpiresAt).toLocaleDateString() : "—"}.
        </p>
      </div>

      {batch.status === "COMPLETED" && (
        <div className="mb-4">
          <button
            onClick={rollback}
            disabled={rollingBack}
            className="h-11 min-h-[44px] inline-flex items-center gap-1 px-3 border border-red-300 text-red-700 rounded-lg text-sm hover:bg-red-50"
          >
            <RotateCcw size={14} /> {rollingBack ? "Rolling back…" : "Roll back this import"}
          </button>
          {rollbackMsg && <p className="text-xs text-text-primary mt-2">{rollbackMsg}</p>}
        </div>
      )}

      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="text-xs font-semibold text-text-primary uppercase tracking-wide">Audit log</p>
        <div className="flex gap-1 flex-wrap">
          {["", "CREATED", "MATCHED", "MERGED", "SKIPPED", "EXCLUDED"].map((f) => (
            <button
              key={f || "all"}
              onClick={() => setFilter(f)}
              className={`text-[11px] px-2 py-1 rounded ${filter === f ? "bg-charcoal text-white" : "bg-app-bg text-text-muted"}`}
            >
              {f || "All"}
            </button>
          ))}
          <a
            href={`/api/reports/imports/${batch.id}/log?format=csv`}
            className="text-[11px] px-2 py-1 rounded bg-app-bg text-text-muted flex items-center gap-1"
          >
            <Download size={11} /> CSV
          </a>
        </div>
      </div>

      {log == null ? (
        <SkeletonList rows={5} />
      ) : (
        <div className="bg-surface border border-app-border rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-text-muted uppercase border-b border-app-border">
                <th className="text-left py-2 pl-3 pr-2">Row</th>
                <th className="text-left py-2 pr-3">Outcome</th>
                <th className="text-left py-2 pr-3">Signal</th>
                <th className="text-left py-2 pr-3">Reason</th>
                <th className="text-left py-2 pr-3">Decided by</th>
              </tr>
            </thead>
            <tbody>
              {log.rows.map((r) => (
                <tr key={r.id} className="border-b border-app-border last:border-0">
                  <td className="py-2 pl-3 pr-2 tabular-nums text-text-muted">{r.rowNumber}</td>
                  <td className="py-2 pr-3"><OutcomeBadge outcome={r.outcome} /></td>
                  <td className="py-2 pr-3 text-xs text-text-muted">{r.matchSignal ?? "—"}</td>
                  <td className="py-2 pr-3 text-xs text-text-primary">{r.reason ?? "—"}</td>
                  <td className="py-2 pr-3 text-xs text-text-muted">{r.decidedBy ?? "System"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {log.total > log.rows.length && (
            <div className="px-3 py-2 border-t border-app-border text-xs text-text-muted">
              Showing {log.rows.length} of {log.total} rows. Use filter chips or download CSV for more.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent: "ok" | "warn" | "neutral" }) {
  const cls =
    accent === "warn" ? "text-red-700" :
    accent === "ok" ? "text-green-700" :
    "text-text-primary";
  return (
    <div className="border border-app-border rounded-lg p-3">
      <p className="text-[10px] text-text-muted uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${cls}`}>{value}</p>
    </div>
  );
}
