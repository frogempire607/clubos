"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Search, RotateCcw, X, History, Trash2 } from "lucide-react";

interface OptOutRow {
  id: string;
  email: string;
  userId: string | null;
  scope: "MARKETING" | "TRANSACTIONAL" | "ALL";
  source: string | null;
  createdAt: string;
  updatedAt: string;
  auditCounts: { subscribes: number; unsubscribes: number };
}

interface AuditRow {
  id: string;
  email: string;
  scope: string;
  action: string;
  source: string;
  actorUserId: string | null;
  actorRole: string | null;
  context: Record<string, unknown> | null;
  createdAt: string;
}

export default function UnsubscribesPage() {
  const [rows, setRows] = useState<OptOutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<AuditRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const url = search
        ? `/api/emails/opt-outs?search=${encodeURIComponent(search)}`
        : "/api/emails/opt-outs";
      const res = await fetch(url);
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load");
      const data = await res.json();
      setRows(data.optOuts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  async function updateScope(email: string, scope: OptOutRow["scope"]) {
    const res = await fetch("/api/emails/opt-outs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, scope, note: "Changed via admin unsubscribe list" }),
    });
    if (!res.ok) setError((await res.json()).error ?? "Update failed");
    load();
  }

  async function resubscribe(email: string) {
    if (!confirm(`Resubscribe ${email}? They will receive marketing email again.`)) return;
    const res = await fetch("/api/emails/opt-outs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, note: "Resubscribed via admin unsubscribe list" }),
    });
    if (!res.ok) setError((await res.json()).error ?? "Failed");
    load();
  }

  async function openHistory(email: string) {
    setHistoryFor(email);
    setHistoryLoading(true);
    setHistoryRows([]);
    try {
      const res = await fetch(`/api/emails/opt-outs/history?email=${encodeURIComponent(email)}`);
      if (res.ok) {
        const data = await res.json();
        setHistoryRows(data.history);
      }
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl">
      <div className="mb-6">
        <Link href="/dashboard/communication/campaigns" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Communications
        </Link>
      </div>

      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-text-primary mb-1">Unsubscribes</h1>
        <p className="text-sm text-text-muted max-w-2xl">
          Every address on this list is opted out of marketing (default),
          transactional, or all non-essential email from your club. Members
          who opted themselves out via a footer link are labeled UNSUBSCRIBE_LINK.
          Every change here writes an audit row.
        </p>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" strokeWidth={2} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by email"
            className="w-full pl-9 pr-3 py-2 text-sm border border-app-border rounded-lg bg-surface"
          />
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-text-muted p-8 text-center">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-text-muted p-8 text-center bg-surface rounded-xl border border-app-border">
          No opt-outs {search ? "match this search." : "yet."}
        </div>
      ) : (
        <div className="bg-surface rounded-xl border border-app-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-app-bg border-b border-app-border">
                <tr>
                  <Th>Email</Th>
                  <Th>Scope</Th>
                  <Th>Source</Th>
                  <Th>Last change</Th>
                  <Th>Audit</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-app-border">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <Td>
                      <div className="font-mono text-text-primary">{r.email}</div>
                    </Td>
                    <Td>
                      <select
                        value={r.scope}
                        onChange={(e) => updateScope(r.email, e.target.value as OptOutRow["scope"])}
                        className={`text-xs px-2 py-1 rounded-md border ${
                          r.scope === "ALL" ? "border-red-200 bg-red-50 text-red-700"
                          : r.scope === "TRANSACTIONAL" ? "border-orange-accent/40 bg-orange-accent/10 text-charcoal"
                          : "border-app-border bg-surface text-text-primary"
                        }`}
                      >
                        <option value="MARKETING">Marketing only</option>
                        <option value="TRANSACTIONAL">Transactional</option>
                        <option value="ALL">All non-essential</option>
                      </select>
                    </Td>
                    <Td className="text-text-muted text-xs">{r.source ?? "—"}</Td>
                    <Td className="text-text-muted text-xs">{new Date(r.updatedAt).toLocaleString()}</Td>
                    <Td>
                      <button
                        onClick={() => openHistory(r.email)}
                        className="text-xs px-2 py-1 rounded-md border border-app-border hover:bg-app-bg inline-flex items-center gap-1"
                      >
                        <History className="h-3 w-3" strokeWidth={2} />
                        {r.auditCounts.subscribes + r.auditCounts.unsubscribes} events
                      </button>
                    </Td>
                    <Td>
                      <button
                        onClick={() => resubscribe(r.email)}
                        className="text-xs px-2 py-1 rounded-md border border-app-border hover:bg-app-bg text-brand inline-flex items-center gap-1"
                        title="Remove from opt-out list"
                      >
                        <RotateCcw className="h-3 w-3" strokeWidth={2} /> Resubscribe
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {historyFor && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
          <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="px-6 py-4 border-b border-app-border flex items-center justify-between shrink-0">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-text-primary truncate">Preference history</h2>
                <p className="text-xs text-text-muted font-mono truncate">{historyFor}</p>
              </div>
              <button onClick={() => setHistoryFor(null)} className="text-text-muted hover:text-text-primary p-1" aria-label="Close">
                <X className="h-4 w-4" strokeWidth={2} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {historyLoading ? (
                <div className="text-sm text-text-muted">Loading…</div>
              ) : historyRows.length === 0 ? (
                <div className="text-sm text-text-muted">No audit rows yet.</div>
              ) : (
                <ul className="space-y-2">
                  {historyRows.map((h) => (
                    <li key={h.id} className="text-sm p-3 rounded-lg bg-app-bg/40 border border-app-border">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                          h.action === "SUBSCRIBE"
                            ? "bg-lime-accent/25 text-charcoal"
                            : "bg-red-100 text-red-700"
                        }`}>
                          {h.action === "SUBSCRIBE" ? "Resubscribed" : "Unsubscribed"} — {h.scope}
                        </span>
                        <span className="text-[11px] text-text-muted">{new Date(h.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="text-xs text-text-muted">
                        via {h.source}
                        {h.actorRole && h.actorRole !== "ANONYMOUS" && <> · by {h.actorRole.toLowerCase()}</>}
                        {h.context && Object.keys(h.context).length > 0 && (
                          <> · {Object.entries(h.context).map(([k, v]) => `${k}=${String(v)}`).join(", ")}</>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="text-left text-xs font-medium text-text-muted uppercase tracking-wider px-4 py-2">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2 ${className ?? ""}`}>{children}</td>;
}
