"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Save, X, Trash2, Users, RefreshCw } from "lucide-react";
import type { AudienceFilter, AudienceRule, Op } from "@/lib/audienceFilters";

// Owner-facing labels for the parseable field ids. Keep in sync with
// lib/audienceFilters.ts AUDIENCE_FIELDS. Fields marked as "future"
// still parse through but produce no results — surfaced greyed with an
// explanatory tooltip so we don't hide the roadmap.
const FIELD_DEFS: Array<{
  id: string;
  label: string;
  ops: Array<{ op: string; label: string; kind: "enum" | "text" | "bool" | "number" }>;
  choices?: { valueKey: string; labels: (v: string) => string };
  future?: string;
}> = [
  { id: "membershipStatus", label: "Member status",
    ops: [{ op: "in", label: "is one of", kind: "enum" }] },
  { id: "membershipId", label: "Membership plan",
    ops: [{ op: "eq", label: "is", kind: "text" }, { op: "true", label: "has any plan", kind: "bool" }, { op: "false", label: "has no plan", kind: "bool" }] },
  { id: "membershipEndsWithinDays", label: "Membership ends within (days)",
    ops: [{ op: "lte", label: "≤", kind: "number" }] },
  { id: "lastAttendedDaysAgo", label: "Last attended (days ago)",
    ops: [{ op: "gte", label: "at least N days ago", kind: "number" }, { op: "lte", label: "within last N days", kind: "number" }] },
  { id: "neverAttended", label: "Attendance",
    ops: [{ op: "true", label: "has never attended", kind: "bool" }, { op: "false", label: "has attended", kind: "bool" }] },
  { id: "programClassId", label: "Program (recurring class)",
    ops: [{ op: "eq", label: "attended class", kind: "text" }] },
  { id: "ageYears", label: "Age (years)",
    ops: [{ op: "gte", label: "≥", kind: "number" }, { op: "lte", label: "≤", kind: "number" }] },
  { id: "isMinor", label: "Minor status",
    ops: [{ op: "true", label: "is a minor", kind: "bool" }, { op: "false", label: "is an adult", kind: "bool" }] },
  { id: "migrationStatus", label: "Migration status",
    ops: [{ op: "in", label: "is one of", kind: "enum" }] },
  { id: "hasCompletedMigration", label: "Migration completed",
    ops: [{ op: "true", label: "yes", kind: "bool" }, { op: "false", label: "no", kind: "bool" }] },
  { id: "invitationSent", label: "Invitation email sent",
    ops: [{ op: "true", label: "sent", kind: "bool" }, { op: "false", label: "never sent", kind: "bool" }] },
  { id: "paymentPastDue", label: "Payment past due",
    ops: [{ op: "true", label: "yes", kind: "bool" }, { op: "false", label: "no", kind: "bool" }] },
  { id: "registeredForEventId", label: "Registered for event",
    ops: [{ op: "eq", label: "is", kind: "text" }] },
  { id: "tag", label: "Has tag",
    ops: [{ op: "eq", label: "contains", kind: "text" }] },
  { id: "accountRole", label: "Account role",
    ops: [{ op: "eq", label: "is", kind: "enum" }] },
  { id: "relationshipType", label: "Relationship type",
    ops: [{ op: "eq", label: "is", kind: "text" }] },
  { id: "locationId", label: "Location", future: "Coming with Phase 4.5 — location assignment model.",
    ops: [{ op: "eq", label: "is", kind: "text" }] },
  { id: "coachUserId", label: "Coach", future: "Coming with Phase 4.5 — coach assignment model.",
    ops: [{ op: "eq", label: "is", kind: "text" }] },
];

const ENUM_CHOICES: Record<string, string[]> = {
  membershipStatus: ["ACTIVE", "PROSPECT", "INACTIVE", "PAUSED"],
  migrationStatus: ["IMPORTED", "INVITED", "ACTIVATED", "COMPLETED", "FAILED", "NEEDS_REVIEW"],
  accountRole: ["ATHLETE", "ADULT", "PARENT"],
};

interface AudienceRow {
  id: string;
  name: string;
  description: string | null;
  filters: AudienceFilter;
  isDynamic: boolean;
  frozenMemberIds: string[] | null;
  estimatedCount: number | null;
  estimatedAt: string | null;
  archivedAt: string | null;
}

export default function AudiencesPage() {
  const [audiences, setAudiences] = useState<AudienceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<AudienceRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/marketing-audiences${showArchived ? "?archived=1" : ""}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setAudiences(data.audiences);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [showArchived]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl">
      <div className="mb-6">
        <Link href="/dashboard/communication/campaigns" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Communications
        </Link>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Audiences</h1>
          <p className="text-sm text-text-muted max-w-2xl">
            Reusable recipient groups. Dynamic audiences re-evaluate at send time — a new
            member who now matches will get the message, someone who no longer matches
            won&apos;t. Static audiences freeze the exact list when you save them.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="text-xs px-3 py-2 rounded-lg border border-app-border hover:bg-app-bg"
          >
            {showArchived ? "Hide archived" : "Show archived"}
          </button>
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg bg-brand text-white hover:bg-brand-hover font-medium"
          >
            <Plus className="h-4 w-4" strokeWidth={2} /> New audience
          </button>
        </div>
      </div>

      {err && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{err}</div>
      )}

      {loading ? (
        <div className="text-sm text-text-muted p-8 text-center">Loading…</div>
      ) : audiences.length === 0 ? (
        <div className="text-sm text-text-muted p-8 text-center bg-surface rounded-xl border border-app-border">
          No audiences yet. Create one to save a recipient filter you&apos;ll reuse across sends.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {audiences.map((a) => (
            <div key={a.id} className={`bg-surface rounded-xl border p-4 flex flex-col gap-2 ${a.archivedAt ? "opacity-60 border-app-border/60" : "border-app-border"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <h3 className="text-sm font-semibold text-text-primary truncate">{a.name}</h3>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${a.isDynamic ? "bg-lime-accent/20 text-charcoal" : "bg-app-bg text-text-muted"}`}>
                      {a.isDynamic ? "Dynamic" : "Static"}
                    </span>
                    {a.archivedAt && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-app-bg text-text-muted">Archived</span>}
                  </div>
                  <p className="text-xs text-text-muted mt-1 line-clamp-2">{a.description || `${a.filters.rules?.length ?? 0} rules`}</p>
                </div>
              </div>
              <div className="text-xs text-text-muted flex items-center gap-1">
                <Users className="h-3 w-3" strokeWidth={2} />
                <span className="text-text-primary font-medium">{a.estimatedCount ?? "?"}</span>
                <span>recipients{a.estimatedAt ? ` · last checked ${new Date(a.estimatedAt).toLocaleDateString()}` : ""}</span>
              </div>
              <div className="mt-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setEditing(a)}
                  className="text-xs px-2.5 py-1.5 rounded-md border border-app-border hover:bg-app-bg"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const res = await fetch(`/api/marketing-audiences/${a.id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ archived: !a.archivedAt }),
                    });
                    if (res.ok) load();
                  }}
                  className="text-xs px-2.5 py-1.5 rounded-md border border-app-border hover:bg-app-bg"
                >
                  {a.archivedAt ? "Restore" : "Archive"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <AudienceEditor
          audience={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {creating && (
        <AudienceEditor
          audience={null}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); load(); }}
        />
      )}
    </div>
  );
}

function AudienceEditor({
  audience,
  onClose,
  onSaved,
}: {
  audience: AudienceRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = audience === null;
  const [name, setName] = useState(audience?.name ?? "");
  const [description, setDescription] = useState(audience?.description ?? "");
  const [isDynamic, setIsDynamic] = useState(audience?.isDynamic ?? true);
  const [match, setMatch] = useState<"ALL" | "ANY">(audience?.filters.match ?? "ALL");
  const [rules, setRules] = useState<AudienceRule[]>(audience?.filters.rules ?? []);
  const [preview, setPreview] = useState<{ count: number; sample: Array<{ id: string; firstName: string; lastName: string; email: string | null; isMinor: boolean }> } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const filterSnapshot = useMemo(() => ({ match, rules }), [match, rules]);

  // Debounced preview — recount whenever filter changes.
  useEffect(() => {
    let alive = true;
    setPreviewing(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/marketing-audiences/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filters: filterSnapshot, sampleLimit: 10 }),
        });
        if (!alive) return;
        if (res.ok) setPreview(await res.json());
        else setPreview({ count: 0, sample: [] });
      } catch { /* ignore */ } finally {
        if (alive) setPreviewing(false);
      }
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [filterSnapshot]);

  async function save() {
    setErr(null);
    setSaving(true);
    try {
      if (!name.trim()) throw new Error("Name is required");
      const payload = { name, description: description || null, filters: filterSnapshot, isDynamic };
      const res = isNew
        ? await fetch("/api/marketing-audiences", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch(`/api/marketing-audiences/${audience!.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function updateRule(i: number, patch: Partial<AudienceRule>) {
    setRules((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }

  function removeRule(i: number) {
    setRules((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addRule() {
    const def = FIELD_DEFS[0];
    setRules((prev) => [...prev, { field: def.id, op: def.ops[0].op as Op, value: "" }]);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="bg-app-bg rounded-t-2xl sm:rounded-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 z-10 bg-surface border-b border-app-border px-4 py-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-text-primary truncate">
              {isNew ? "New audience" : `Edit — ${audience!.name}`}
            </h2>
            <p className="text-xs text-text-muted mt-0.5">
              {previewing ? "Recounting…" : `${preview?.count ?? 0} recipients match right now`}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-md border border-app-border hover:bg-app-bg inline-flex items-center gap-1">
              <X className="h-3 w-3" strokeWidth={2} /> Cancel
            </button>
            <button type="button" onClick={save} disabled={saving} className="text-xs px-3 py-1.5 rounded-md bg-brand text-white hover:bg-brand-hover inline-flex items-center gap-1 disabled:opacity-50">
              <Save className="h-3 w-3" strokeWidth={2} /> {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-muted uppercase tracking-wider mb-1">Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Active middle-schoolers who missed 2 weeks" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted uppercase tracking-wider mb-1">Description</label>
              <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional — for your own notes" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-muted uppercase tracking-wider mb-1">Combine rules</label>
              <select value={match} onChange={(e) => setMatch(e.target.value as "ALL" | "ANY")} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                <option value="ALL">Match ALL rules (AND)</option>
                <option value="ANY">Match ANY rule (OR)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted uppercase tracking-wider mb-1">Type</label>
              <div className="flex items-center gap-3 py-1.5">
                <label className="text-sm flex items-center gap-1.5">
                  <input type="radio" checked={isDynamic} onChange={() => setIsDynamic(true)} /> Dynamic
                </label>
                <label className="text-sm flex items-center gap-1.5">
                  <input type="radio" checked={!isDynamic} onChange={() => setIsDynamic(false)} /> Static (freeze list now)
                </label>
              </div>
            </div>
          </div>

          {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wider">Rules</p>
              <button type="button" onClick={addRule} className="text-xs text-brand hover:underline inline-flex items-center gap-1">
                <Plus className="h-3 w-3" strokeWidth={2} /> Add rule
              </button>
            </div>
            {rules.length === 0 && (
              <div className="text-xs text-text-muted p-4 bg-surface rounded-lg border border-dashed border-app-border text-center">
                No rules yet — matches nothing. Add a rule to see recipients.
              </div>
            )}
            {rules.map((r, i) => (
              <RuleRow key={i} rule={r} onChange={(patch) => updateRule(i, patch)} onRemove={() => removeRule(i)} />
            ))}
          </div>

          <div className="bg-surface border border-app-border rounded-xl p-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wider inline-flex items-center gap-1">
                <RefreshCw className={`h-3 w-3 ${previewing ? "animate-spin" : ""}`} strokeWidth={2} /> Preview
              </p>
              <span className="text-xs text-text-muted">{preview?.count ?? 0} matching members</span>
            </div>
            {preview?.sample.length ? (
              <ul className="text-xs text-text-primary space-y-1">
                {preview.sample.map((m) => (
                  <li key={m.id}>
                    {m.firstName} {m.lastName}
                    {m.isMinor && <span className="text-[10px] ml-1.5 text-text-muted">(minor)</span>}
                    {m.email && <span className="text-text-muted"> · {m.email}</span>}
                  </li>
                ))}
                {preview.count > preview.sample.length && (
                  <li className="text-text-muted">…and {preview.count - preview.sample.length} more</li>
                )}
              </ul>
            ) : (
              <p className="text-xs text-text-muted">No matches for the current rules.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RuleRow({ rule, onChange, onRemove }: { rule: AudienceRule; onChange: (p: Partial<AudienceRule>) => void; onRemove: () => void }) {
  const def = FIELD_DEFS.find((f) => f.id === rule.field) ?? FIELD_DEFS[0];
  const opDef = def.ops.find((o) => o.op === rule.op) ?? def.ops[0];
  const enumChoices = ENUM_CHOICES[def.id];

  return (
    <div className="flex flex-wrap items-center gap-2 p-2 bg-surface rounded-lg border border-app-border">
      <select
        value={rule.field}
        onChange={(e) => {
          const newDef = FIELD_DEFS.find((f) => f.id === e.target.value)!;
          onChange({ field: newDef.id, op: newDef.ops[0].op as Op, value: "" });
        }}
        className="text-xs px-2 py-1.5 border border-app-border rounded-md bg-surface"
      >
        {FIELD_DEFS.map((f) => (
          <option key={f.id} value={f.id}>{f.label}{f.future ? " (soon)" : ""}</option>
        ))}
      </select>
      <select
        value={rule.op}
        onChange={(e) => onChange({ op: e.target.value as Op })}
        className="text-xs px-2 py-1.5 border border-app-border rounded-md bg-surface"
      >
        {def.ops.map((o) => (
          <option key={o.op} value={o.op}>{o.label}</option>
        ))}
      </select>

      {opDef.kind === "bool" ? null : opDef.kind === "enum" && enumChoices ? (
        opDef.op === "in" ? (
          <div className="flex flex-wrap gap-1">
            {enumChoices.map((c) => {
              const arr: string[] = Array.isArray(rule.value) ? rule.value as string[] : [];
              const active = arr.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    const next = active ? arr.filter((v) => v !== c) : [...arr, c];
                    onChange({ value: next });
                  }}
                  className={`text-xs px-2 py-1 rounded-md border ${active ? "bg-charcoal text-white border-charcoal" : "border-app-border text-text-primary hover:bg-app-bg"}`}
                >
                  {c}
                </button>
              );
            })}
          </div>
        ) : (
          <select value={String(rule.value ?? "")} onChange={(e) => onChange({ value: e.target.value })} className="text-xs px-2 py-1.5 border border-app-border rounded-md bg-surface">
            <option value="">Choose…</option>
            {enumChoices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )
      ) : opDef.kind === "number" ? (
        <input type="number" value={String(rule.value ?? "")} onChange={(e) => onChange({ value: e.target.value === "" ? "" : Number(e.target.value) })} className="text-xs px-2 py-1.5 border border-app-border rounded-md w-24 bg-surface" />
      ) : (
        <input type="text" value={String(rule.value ?? "")} onChange={(e) => onChange({ value: e.target.value })} placeholder="value" className="text-xs px-2 py-1.5 border border-app-border rounded-md flex-1 min-w-[8rem] bg-surface" />
      )}

      {def.future && <span className="text-[10px] text-orange-accent">{def.future}</span>}

      <button type="button" onClick={onRemove} className="text-xs p-1.5 text-text-muted hover:text-red-600 ml-auto" aria-label="Remove rule">
        <Trash2 className="h-3 w-3" strokeWidth={2} />
      </button>
    </div>
  );
}
