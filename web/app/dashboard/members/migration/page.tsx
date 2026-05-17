"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

// ── CSV parser (handles quoted cells / embedded commas / CRLF) ───────────────
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { cur.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      cur.push(field); field = "";
      if (cur.some((x) => x.trim() !== "")) rows.push(cur);
      cur = [];
    } else field += c;
  }
  if (field !== "" || cur.length) { cur.push(field); if (cur.some((x) => x.trim() !== "")) rows.push(cur); }
  return rows;
}

// Target fields the wizard can map to. `athleteName` makes first/last optional.
const FIELDS: { key: string; label: string; group: string }[] = [
  { key: "athleteName", label: "Athlete name (full)", group: "Identity" },
  { key: "firstName", label: "First name", group: "Identity" },
  { key: "lastName", label: "Last name", group: "Identity" },
  { key: "email", label: "Email", group: "Contact" },
  { key: "phone", label: "Phone", group: "Contact" },
  { key: "dateOfBirth", label: "Date of birth", group: "Profile" },
  { key: "gender", label: "Gender", group: "Profile" },
  { key: "status", label: "Status", group: "Profile" },
  { key: "tags", label: "Tags", group: "Profile" },
  { key: "notes", label: "Notes", group: "Profile" },
  { key: "guardianName", label: "Guardian name", group: "Guardian" },
  { key: "guardianEmail", label: "Guardian email", group: "Guardian" },
  { key: "guardianPhone", label: "Guardian phone", group: "Guardian" },
  { key: "membershipName", label: "Membership name", group: "Membership" },
  { key: "membershipPrice", label: "Membership price", group: "Membership" },
  { key: "billingFrequency", label: "Billing frequency", group: "Membership" },
  { key: "nextBillingDate", label: "Next billing date", group: "Membership" },
  { key: "membershipStartDate", label: "Membership start date", group: "Membership" },
  { key: "commitmentEndDate", label: "Commitment end date", group: "Membership" },
  { key: "legacyMemberId", label: "Legacy member ID", group: "Legacy" },
  { key: "skip", label: "— Don't import —", group: "" },
];

function autoMap(header: string): string {
  const h = header.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!h) return "skip";
  if (h.includes("guardian") && h.includes("name")) return "guardianName";
  if (h.includes("guardian") && h.includes("email")) return "guardianEmail";
  if (h.includes("guardian") && h.includes("phone")) return "guardianPhone";
  if ((h.includes("parent") || h.includes("guardian")) && !h.includes("email") && !h.includes("phone")) return "guardianName";
  if (h.includes("firstname") || h === "first" || h === "fname") return "firstName";
  if (h.includes("lastname") || h === "last" || h === "lname" || h === "surname") return "lastName";
  if (h.includes("athletename") || h.includes("membername") || h === "name" || h === "fullname" || h === "player") return "athleteName";
  if (h.includes("email")) return "email";
  if (h.includes("phone") || h === "mobile" || h === "cell") return "phone";
  if (h.includes("dob") || h.includes("birth")) return "dateOfBirth";
  if (h.includes("gender") || h === "sex") return "gender";
  if (h.includes("status") || h.includes("active")) return "status";
  if (h.includes("tag")) return "tags";
  if (h.includes("note") || h.includes("comment")) return "notes";
  if (h.includes("nextbill") || (h.includes("next") && h.includes("bill")) || h.includes("nextpayment") || h.includes("renew")) return "nextBillingDate";
  if (h.includes("commitment") || (h.includes("contract") && h.includes("end")) || h.includes("expir")) return "commitmentEndDate";
  if ((h.includes("membership") || h.includes("plan")) && (h.includes("price") || h.includes("rate") || h.includes("amount") || h.includes("fee"))) return "membershipPrice";
  if (h.includes("membership") || h.includes("plan") || h.includes("package")) return "membershipName";
  if (h.includes("frequency") || h.includes("interval") || h.includes("cycle") || h.includes("period")) return "billingFrequency";
  if ((h.includes("start") && (h.includes("member") || h.includes("join"))) || h === "startdate" || h === "joindate") return "membershipStartDate";
  if (h.includes("legacy") && h.includes("id")) return "legacyMemberId";
  if (h.includes("memberid") || h === "id") return "legacyMemberId";
  return "skip";
}

function looksLikeDate(s: string) {
  if (!s.trim()) return true; // blank is fine, not invalid
  if (!isNaN(new Date(s).getTime()) && /\d{4}/.test(s)) return true;
  return /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(s.trim());
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Stats = {
  total: number; imported: number; invited: number; activated: number;
  completed: number; needsReview: number; paymentRequired: number;
  missingContact: number; activationEmailsSent: number;
};
type Row = {
  id: string; firstName: string; lastName: string; email: string | null; phone: string | null;
  isMinor: boolean; guardianName: string | null; guardianEmail: string | null;
  legacySource: string | null; legacyMembershipName: string | null;
  legacyMembershipPrice: string | number | null; legacyBillingFrequency: string | null;
  billingAnchorDate: string | null; commitmentEndDate: string | null;
  migrationStatus: string; approvalStatus: string | null; paymentSetupStatus: string | null;
  requestedBillingDate: string | null;
  activationEmailSentAt: string | null; activationEmailSendCount: number;
  activatedAt: string | null; migrationCompletedAt: string | null; importedAt: string | null;
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "imported", label: "Imported" },
  { key: "invited", label: "Invited" },
  { key: "activated", label: "Activated" },
  { key: "payment_required", label: "Payment Required" },
  { key: "completed", label: "Completed" },
  { key: "needs_review", label: "Failed / Needs Review" },
];

const STATUS_STYLE: Record<string, string> = {
  IMPORTED: "bg-app-bg text-text-muted",
  INVITED: "bg-brand/10 text-brand",
  ACTIVATED: "bg-orange-accent/15 text-text-primary",
  COMPLETED: "bg-lime-accent/25 text-text-primary",
  NEEDS_REVIEW: "bg-red-50 text-red-700",
  FAILED: "bg-red-50 text-red-700",
};

export default function MigrationPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [totalInFilter, setTotalInFilter] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [historyFor, setHistoryFor] = useState<Row | null>(null);
  const [drawerFor, setDrawerFor] = useState<Row | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ filter, q, page: String(page), pageSize: "25" });
    fetch(`/api/members/migration?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setStats(d.stats);
          setRows(d.members);
          setPageCount(d.pageCount || 1);
          setTotalInFilter(d.totalInFilter || 0);
        }
        setLoading(false);
      });
  }, [filter, q, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSelected(new Set()); }, [filter, page]);

  async function sendBulk(scope: "selected" | "all_pending", reminder: boolean) {
    setBusy(true);
    setMsg("");
    let totalSent = 0, totalFailed = 0, guard = 0;
    // Loop batches until the server reports nothing remaining.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await fetch("/api/members/migration/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          scope === "selected"
            ? { scope: "selected", memberIds: [...selected], reminder }
            : { scope: "all_pending", reminder },
        ),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(typeof d.error === "string" ? d.error : "Send failed"); break; }
      totalSent += d.sent || 0;
      totalFailed += d.failed || 0;
      setMsg(`Sending… ${totalSent} sent${totalFailed ? `, ${totalFailed} failed` : ""}${d.remaining ? ` · ${d.remaining} queued` : ""}`);
      if (!d.remaining || scope === "selected" || ++guard > 50) break;
    }
    setBusy(false);
    setMsg(`Done — ${totalSent} ${reminder ? "reminder" : "activation"} email(s) sent${totalFailed ? `, ${totalFailed} failed` : ""}.`);
    setSelected(new Set());
    load();
  }

  async function resendOne(id: string) {
    setBusy(true);
    const res = await fetch(`/api/members/migration/${id}/resend`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    setMsg(res.ok ? "Reminder sent." : typeof d.error === "string" ? d.error : "Could not send");
    load();
  }

  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div className="p-8 max-w-7xl">
      <div className="mb-2 flex items-center gap-2 text-sm text-text-muted">
        <Link href="/dashboard/members" className="hover:text-text-primary">Members</Link>
        <span>/</span>
        <span className="text-text-primary">Import / Migrate</span>
      </div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Member Migration</h1>
          <p className="text-sm text-text-muted mt-1">
            Switch to AthletixOS without interrupting anyone's membership. Import your roster,
            send activation links, and members continue billing on their existing date.
          </p>
        </div>
        <button
          onClick={() => setShowImport(true)}
          className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover transition flex-shrink-0"
        >
          Import / Migrate Members
        </button>
      </div>

      {/* Owner guidance */}
      <div className="bg-brand/5 border border-brand/20 rounded-xl p-4 mb-6 text-sm text-text-primary">
        <p className="font-semibold mb-1.5">Before you switch — a few things to know</p>
        <ul className="space-y-1 text-text-muted text-[13px] list-disc pl-5">
          <li>Don't cancel your old system until most members have activated. Recommended overlap: <strong className="text-text-primary">2–4 weeks</strong>.</li>
          <li>Imported members are <strong className="text-text-primary">never charged automatically</strong>.</li>
          <li>Members are billed only after they add a payment method and their billing date arrives.</li>
          <li>Billing continues on each member's existing date — not on import day.</li>
        </ul>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3 mb-6">
        {[
          { label: "Imported", value: stats?.total },
          { label: "Emails sent", value: stats?.activationEmailsSent },
          { label: "Invited", value: stats?.invited },
          { label: "Activated", value: stats?.activated },
          { label: "Completed", value: stats?.completed },
          { label: "Payment req.", value: stats?.paymentRequired },
          { label: "Needs review", value: stats?.needsReview },
          { label: "Missing email", value: stats?.missingContact },
        ].map((s) => (
          <div key={s.label} className="bg-surface border border-app-border rounded-xl p-3">
            <p className="text-[11px] uppercase tracking-wider text-text-muted">{s.label}</p>
            <p className="text-2xl font-semibold text-text-primary mt-1">{loading ? "—" : s.value ?? 0}</p>
          </div>
        ))}
      </div>

      {/* Filters + search */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => { setFilter(f.key); setPage(1); }}
            className={`text-xs px-3 py-1.5 rounded-full border transition ${
              filter === f.key ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-muted hover:bg-app-bg"
            }`}
          >
            {f.label}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder="Search name, email, legacy ID…"
          className="ml-auto text-sm px-3 py-1.5 border border-app-border rounded-lg bg-surface w-64"
        />
      </div>

      {/* Bulk actions */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          onClick={() => sendBulk("selected", false)}
          disabled={busy || selected.size === 0}
          className="text-xs px-3 py-1.5 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
        >
          Send Activation Links ({selected.size})
        </button>
        <button
          onClick={() => sendBulk("all_pending", true)}
          disabled={busy}
          className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50"
        >
          Send reminders to all pending
        </button>
        {msg && <span className="text-xs text-text-muted">{msg}</span>}
      </div>

      {/* Table */}
      <div className="bg-surface border border-app-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted border-b border-app-border bg-app-bg/40">
                <th className="px-3 py-2.5 w-8">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={() =>
                      setSelected(allOnPageSelected ? new Set() : new Set(rows.map((r) => r.id)))
                    }
                  />
                </th>
                <th className="px-3 py-2.5 font-medium">Member</th>
                <th className="px-3 py-2.5 font-medium">Membership</th>
                <th className="px-3 py-2.5 font-medium">Next billing</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Emails</th>
                <th className="px-3 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-text-muted">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-10 text-center text-text-muted">
                  No migrated members yet. Use “Import / Migrate Members” to begin.
                </td></tr>
              ) : rows.map((r) => {
                const noEmail = !r.email && !r.guardianEmail;
                return (
                  <tr key={r.id} className="border-b border-app-border last:border-0 align-top">
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        onChange={() => setSelected((p) => {
                          const n = new Set(p);
                          n.has(r.id) ? n.delete(r.id) : n.add(r.id);
                          return n;
                        })}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <p className="text-text-primary font-medium">{r.firstName} {r.lastName}</p>
                      <p className="text-xs text-text-muted">
                        {r.email || r.guardianEmail || <span className="text-red-600">No email on file</span>}
                        {r.isMinor && <span className="ml-1">· minor</span>}
                      </p>
                      {r.legacySource && <p className="text-[10px] text-text-muted">from {r.legacySource}</p>}
                    </td>
                    <td className="px-3 py-3 text-text-muted text-xs">
                      {r.legacyMembershipName || "—"}
                      {r.legacyMembershipPrice != null && (
                        <span> · ${Number(r.legacyMembershipPrice).toFixed(2)}{r.legacyBillingFrequency ? `/${r.legacyBillingFrequency.toLowerCase()}` : ""}</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-text-muted text-xs">
                      {r.billingAnchorDate ? new Date(r.billingAnchorDate).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-3">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[r.migrationStatus] || "bg-app-bg text-text-muted"}`}>
                        {r.migrationStatus?.replace("_", " ")}
                      </span>
                      {r.approvalStatus === "PENDING_APPROVAL" && (
                        <span className="block mt-1 text-[10px] px-2 py-0.5 rounded-full font-medium bg-orange-accent/20 text-text-primary">
                          Needs approval
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs text-text-muted">
                      {r.activationEmailSendCount > 0
                        ? <>{r.activationEmailSendCount}× · {r.activationEmailSentAt ? new Date(r.activationEmailSentAt).toLocaleDateString() : ""}</>
                        : "—"}
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      {r.approvalStatus === "PENDING_APPROVAL" ? (
                        <button
                          onClick={() => setDrawerFor(r)}
                          className="text-xs px-2 py-1 bg-brand text-white rounded-lg hover:bg-brand-hover"
                        >
                          Review &amp; approve
                        </button>
                      ) : (
                        <button
                          onClick={() => setDrawerFor(r)}
                          disabled={r.migrationStatus === "COMPLETED"}
                          className="text-xs px-2 py-1 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-40"
                        >
                          Set up
                        </button>
                      )}
                      <button
                        onClick={() => resendOne(r.id)}
                        disabled={busy || noEmail || r.migrationStatus === "COMPLETED"}
                        className="text-xs px-2 py-1 ml-1 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-40"
                      >
                        Resend
                      </button>
                      <button
                        onClick={() => setHistoryFor(r)}
                        className="text-xs px-2 py-1 ml-1 text-text-muted hover:text-text-primary"
                      >
                        History
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-3 text-xs text-text-muted">
        <span>{totalInFilter} member(s)</span>
        <div className="flex items-center gap-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
            className="px-2 py-1 border border-app-border rounded disabled:opacity-40">Prev</button>
          <span>Page {page} / {pageCount}</span>
          <button onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={page >= pageCount}
            className="px-2 py-1 border border-app-border rounded disabled:opacity-40">Next</button>
        </div>
      </div>

      {showImport && <ImportWizard onClose={() => setShowImport(false)} onDone={() => { setShowImport(false); load(); }} />}
      {historyFor && <HistoryDrawer row={historyFor} onClose={() => setHistoryFor(null)} />}
      {drawerFor && (
        <MigrationDrawer
          memberId={drawerFor.id}
          onClose={() => setDrawerFor(null)}
          onChanged={() => { setDrawerFor(null); load(); }}
        />
      )}
    </div>
  );
}

// ── Set up / Review & approve a single migrating member ──────────────────────
type Detail = {
  id: string; firstName: string; lastName: string; email: string | null; guardianEmail: string | null;
  legacySource: string | null; legacyMembershipName: string | null;
  legacyMembershipPrice: string | number | null; legacyBillingFrequency: string | null;
  billingAnchorDate: string | null; commitmentEndDate: string | null;
  migrationStatus: string; approvalStatus: string | null; paymentSetupStatus: string | null;
  migrationMembershipId: string | null;
  activationEditableFields: Record<string, boolean> | null;
  requestedBillingDate: string | null; requestedBillingNote: string | null; activationNote: string | null;
};
const EDITABLE_KEYS: { key: string; label: string }[] = [
  { key: "phone", label: "Phone number" },
  { key: "email", label: "Email address" },
  { key: "billingDateRequest", label: "Request a different billing date" },
  { key: "notes", label: "Leave a note / comment" },
];
function dInput(iso: string | null | undefined) {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

function MigrationDrawer({ memberId, onClose, onChanged }: { memberId: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const [memberships, setMemberships] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);

  const [planId, setPlanId] = useState("");
  const [anchor, setAnchor] = useState("");
  const [endDate, setEndDate] = useState("");
  const [editable, setEditable] = useState<Record<string, boolean>>({
    phone: true, email: false, billingDateRequest: true, notes: true,
  });
  const [approveDate, setApproveDate] = useState("");

  useEffect(() => {
    Promise.all([
      fetch(`/api/members/migration/${memberId}`).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/memberships").then((r) => (r.ok ? r.json() : [])),
    ]).then(([detail, mships]) => {
      if (detail?.member) {
        const m: Detail = detail.member;
        setD(m);
        setActivationUrl(detail.activationUrl || null);
        setPlanId(m.migrationMembershipId || "");
        setAnchor(dInput(m.billingAnchorDate));
        setEndDate(dInput(m.commitmentEndDate));
        setApproveDate(dInput(m.requestedBillingDate || m.billingAnchorDate));
        if (m.activationEditableFields) {
          setEditable({
            phone: m.activationEditableFields.phone ?? true,
            email: m.activationEditableFields.email ?? false,
            billingDateRequest: m.activationEditableFields.billingDateRequest ?? true,
            notes: m.activationEditableFields.notes ?? true,
          });
        }
      }
      setMemberships(Array.isArray(mships) ? mships.map((x: { id: string; name: string }) => ({ id: x.id, name: x.name })) : []);
      setLoading(false);
    });
  }, [memberId]);

  async function saveSetup() {
    setSaving(true); setMsg("");
    const res = await fetch(`/api/members/migration/${memberId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        migrationMembershipId: planId || null,
        billingAnchorDate: anchor || null,
        commitmentEndDate: endDate || null,
        activationEditableFields: editable,
      }),
    });
    const r = await res.json().catch(() => ({}));
    setSaving(false);
    setMsg(res.ok ? "Saved." : typeof r.error === "string" ? r.error : "Save failed");
    if (res.ok) onChanged();
  }

  async function approve(acceptRequested: boolean) {
    if (!confirm("Approve this member? Billing will be scheduled on the agreed date — they are not charged today.")) return;
    setSaving(true); setMsg("");
    const res = await fetch(`/api/members/migration/${memberId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        acceptRequested ? { acceptRequestedDate: true } : { billingAnchorDate: approveDate || null },
      ),
    });
    const r = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setMsg(typeof r.error === "string" ? r.error : "Approval failed"); return; }
    onChanged();
  }

  function copyLink() {
    if (!activationUrl) return;
    navigator.clipboard.writeText(activationUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const pending = d?.approvalStatus === "PENDING_APPROVAL";

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-surface rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto border border-app-border" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <h2 className="text-base font-semibold text-text-primary">
            {pending ? "Review & approve" : "Set up migration"}{d ? ` · ${d.firstName} ${d.lastName}` : ""}
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-5">
          {loading || !d ? (
            <p className="text-sm text-text-muted text-center py-8">Loading…</p>
          ) : (
            <>
              {pending && (
                <div className="bg-orange-accent/10 border border-orange-accent/30 rounded-lg p-4 space-y-2">
                  <p className="text-sm font-semibold text-text-primary">Client submitted — awaiting your approval</p>
                  <p className="text-xs text-text-muted">
                    Payment method on file: <strong>{d.paymentSetupStatus === "COMPLETE" ? "Yes ✓" : "Not yet"}</strong>.
                    Billing has NOT started. Approving schedules the first charge on the date below.
                  </p>
                  {d.requestedBillingDate && (
                    <p className="text-xs text-text-primary">
                      Requested billing date: <strong>{new Date(d.requestedBillingDate).toLocaleDateString()}</strong>
                      {d.requestedBillingNote ? ` — “${d.requestedBillingNote}”` : ""}
                    </p>
                  )}
                  {d.activationNote && (
                    <p className="text-xs text-text-primary">Note from client: “{d.activationNote}”</p>
                  )}
                  <div className="flex flex-wrap items-end gap-2 pt-1">
                    <div>
                      <label className="block text-[11px] text-text-muted mb-1">Approve billing on</label>
                      <input type="date" value={approveDate} onChange={(e) => setApproveDate(e.target.value)}
                        className="inp" style={{ width: 160 }} />
                    </div>
                    <button onClick={() => approve(false)} disabled={saving}
                      className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50">
                      {saving ? "Approving…" : "Approve & schedule billing"}
                    </button>
                    {d.requestedBillingDate && (
                      <button onClick={() => approve(true)} disabled={saving}
                        className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50">
                        Accept requested date
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Membership this continues</label>
                <select value={planId} onChange={(e) => setPlanId(e.target.value)} className="inp">
                  <option value="">— Use imported plan ({d.legacyMembershipName || "none"}) —</option>
                  {memberships.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <p className="text-[11px] text-text-muted mt-1">
                  Imported: {d.legacyMembershipName || "—"}
                  {d.legacyMembershipPrice != null ? ` · $${Number(d.legacyMembershipPrice).toFixed(2)}` : ""}
                  {d.legacyBillingFrequency ? ` / ${d.legacyBillingFrequency.toLowerCase()}` : ""}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Next billing date</label>
                  <input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} className="inp" />
                  <p className="text-[11px] text-text-muted mt-1">First Stripe charge (old cycle or edit it)</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">End / commitment date</label>
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="inp" />
                  <p className="text-[11px] text-text-muted mt-1">Optional — matches prior contract</p>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Client can edit during activation</label>
                <div className="space-y-1.5">
                  {EDITABLE_KEYS.map((f) => (
                    <label key={f.key} className="flex items-center gap-2 text-sm text-text-primary">
                      <input
                        type="checkbox"
                        checked={!!editable[f.key]}
                        onChange={(e) => setEditable((p) => ({ ...p, [f.key]: e.target.checked }))}
                      />
                      {f.label}
                    </label>
                  ))}
                </div>
              </div>

              {activationUrl && (
                <div className="bg-app-bg border border-app-border rounded-lg p-3">
                  <p className="text-xs font-medium text-text-primary mb-1">Activation link</p>
                  <div className="flex items-center gap-2">
                    <input readOnly value={activationUrl} className="inp text-xs" />
                    <button onClick={copyLink} className="text-xs px-3 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover whitespace-nowrap">
                      {copied ? "Copied!" : "Copy"}
                    </button>
                  </div>
                  <p className="text-[11px] text-text-muted mt-1">
                    Share this directly if email isn&apos;t configured — it works the same as the emailed link.
                  </p>
                </div>
              )}

              {msg && <p className="text-sm text-text-muted">{msg}</p>}

              <div className="flex gap-2 justify-end border-t border-app-border pt-4">
                <button onClick={onClose} className="text-sm px-4 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">Close</button>
                <button onClick={saveSetup} disabled={saving} className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50">
                  {saving ? "Saving…" : "Save setup"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Reminder / audit history drawer ──────────────────────────────────────────
function HistoryDrawer({ row, onClose }: { row: Row; onClose: () => void }) {
  const [events, setEvents] = useState<{ id: string; type: string; message: string | null; createdAt: string }[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch(`/api/members/migration/${row.id}/resend`)
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((d) => { setEvents(d.events || []); setLoading(false); });
  }, [row.id]);
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-end z-50" onClick={onClose}>
      <div className="bg-surface h-full w-full max-w-md border-l border-app-border overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{row.firstName} {row.lastName}</h2>
            <p className="text-xs text-text-muted">Migration history</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6">
          {loading ? (
            <p className="text-sm text-text-muted">Loading…</p>
          ) : events.length === 0 ? (
            <p className="text-sm text-text-muted">No history yet.</p>
          ) : (
            <div className="space-y-3">
              {events.map((e) => (
                <div key={e.id} className="border-l-2 border-brand/40 pl-3">
                  <p className="text-xs font-semibold text-text-primary">{e.type.replace(/_/g, " ")}</p>
                  {e.message && <p className="text-xs text-text-muted">{e.message}</p>}
                  <p className="text-[10px] text-text-muted mt-0.5">{new Date(e.createdAt).toLocaleString()}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Import wizard ────────────────────────────────────────────────────────────
function ImportWizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "map" | "review" | "done">("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [data, setData] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [legacySource, setLegacySource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ created: number; skipped: number; failed: number; needsReview: number; errors: string[] } | null>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parseCSV(ev.target?.result as string);
      if (parsed.length < 2) { setError("CSV needs a header row and at least one member row."); return; }
      setHeaders(parsed[0]);
      setData(parsed.slice(1));
      const am: Record<number, string> = {};
      parsed[0].forEach((h, i) => { am[i] = autoMap(h); });
      setMapping(am);
      setError("");
      setStep("map");
    };
    reader.readAsText(file);
  }

  function buildRows() {
    return data.map((row) => {
      const o: Record<string, string> = {};
      headers.forEach((_, i) => {
        const f = mapping[i];
        if (f && f !== "skip") o[f] = (row[i] || "").trim();
      });
      return o;
    }).filter((o) => o.athleteName || o.firstName || o.lastName);
  }

  const mappedKeys = new Set(Object.values(mapping));
  const hasName = mappedKeys.has("athleteName") || mappedKeys.has("firstName") || mappedKeys.has("lastName");

  // ── Review warnings ──
  const built = buildRows();
  const emailCount = new Map<string, number>();
  const nameCount = new Map<string, number>();
  built.forEach((m) => {
    const em = (m.email || "").toLowerCase();
    if (em) emailCount.set(em, (emailCount.get(em) || 0) + 1);
    const nm = ((m.athleteName || `${m.firstName || ""} ${m.lastName || ""}`).trim()).toLowerCase();
    if (nm) nameCount.set(nm, (nameCount.get(nm) || 0) + 1);
  });
  const warnings = {
    missingEmail: built.filter((m) => !m.email && !m.guardianEmail).length,
    invalidEmail: built.filter((m) => m.email && !EMAIL_RE.test(m.email)).length,
    dupEmail: [...emailCount.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0),
    dupName: [...nameCount.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0),
    invalidDate: built.filter((m) =>
      [m.dateOfBirth, m.nextBillingDate, m.membershipStartDate, m.commitmentEndDate].some((d) => d && !looksLikeDate(d)),
    ).length,
    inactive: built.filter((m) => /cancel|inactive|expired|frozen|former/i.test(m.status || "")).length,
    missingMembership: built.filter((m) => !m.membershipName).length,
    possibleFamilies: built.filter((m) => m.guardianEmail && [...built].some((o) => o !== m && o.guardianEmail && o.guardianEmail.toLowerCase() === m.guardianEmail!.toLowerCase())).length,
  };

  async function doImport() {
    setBusy(true);
    setError("");
    const members = built.map((m) => ({
      athleteName: m.athleteName || undefined,
      firstName: m.firstName || undefined,
      lastName: m.lastName || undefined,
      email: m.email || undefined,
      phone: m.phone || undefined,
      dateOfBirth: m.dateOfBirth || undefined,
      gender: m.gender || undefined,
      status: m.status || undefined,
      tags: m.tags || undefined,
      notes: m.notes || undefined,
      guardianName: m.guardianName || undefined,
      guardianEmail: m.guardianEmail || undefined,
      guardianPhone: m.guardianPhone || undefined,
      membershipName: m.membershipName || undefined,
      membershipPrice: m.membershipPrice || undefined,
      billingFrequency: m.billingFrequency || undefined,
      nextBillingDate: m.nextBillingDate || undefined,
      membershipStartDate: m.membershipStartDate || undefined,
      commitmentEndDate: m.commitmentEndDate || undefined,
      legacyMemberId: m.legacyMemberId || undefined,
      isMinor: !!(m.guardianName || m.guardianEmail),
    }));
    const res = await fetch("/api/members/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members, migration: true, legacySource: legacySource || undefined }),
    });
    const d = await res.json();
    setBusy(false);
    if (!res.ok) { setError(typeof d.error === "string" ? d.error : "Import failed"); return; }
    setResult(d);
    setStep("done");
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <h2 className="text-lg font-semibold text-text-primary">Import / Migrate Members</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6">
          <div className="flex gap-2 mb-6">
            {["Upload", "Map columns", "Review", "Done"].map((s, i) => {
              const idx = ["upload", "map", "review", "done"].indexOf(step);
              return (
                <div key={s} className="flex items-center gap-2 flex-1">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${idx >= i ? "bg-brand text-white" : "bg-app-bg text-text-muted"}`}>{i + 1}</div>
                  <span className={`text-xs ${idx >= i ? "text-text-primary" : "text-text-muted"}`}>{s}</span>
                </div>
              );
            })}
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {step === "upload" && (
            <div className="text-center py-8">
              <p className="text-sm text-text-muted mb-1">Upload a CSV exported from your previous club software.</p>
              <p className="text-xs text-text-muted mb-5">Only an athlete name is required. Everything else is optional and mapped on the next step.</p>
              <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
              <button onClick={() => fileRef.current?.click()} className="text-sm px-5 py-2.5 bg-brand text-white rounded-lg hover:bg-brand-hover">Choose CSV file</button>
            </div>
          )}

          {step === "map" && (
            <div>
              <div className="mb-4">
                <label className="block text-sm font-medium text-text-primary mb-1">Previous software (optional)</label>
                <input value={legacySource} onChange={(e) => setLegacySource(e.target.value)}
                  placeholder="e.g. Jackrabbit, Mindbody, spreadsheet"
                  className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface" />
              </div>
              <p className="text-sm font-medium text-text-primary mb-2">Map your columns</p>
              <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                {headers.map((h, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="text-xs text-text-muted w-44 truncate" title={h}>{h || `Column ${i + 1}`}</span>
                    <select
                      value={mapping[i] || "skip"}
                      onChange={(e) => setMapping((p) => ({ ...p, [i]: e.target.value }))}
                      className="flex-1 px-2 py-1.5 border border-app-border rounded-lg text-sm bg-surface"
                    >
                      {FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                    <span className="text-[10px] text-text-muted w-28 truncate">{data[0]?.[i] || ""}</span>
                  </div>
                ))}
              </div>
              {!hasName && <p className="text-xs text-red-600 mt-3">Map at least one of: Athlete name, First name, or Last name.</p>}
              <div className="flex justify-end gap-2 mt-5">
                <button onClick={() => setStep("upload")} className="text-sm px-4 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">Back</button>
                <button disabled={!hasName} onClick={() => setStep("review")} className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50">Review</button>
              </div>
            </div>
          )}

          {step === "review" && (
            <div>
              <p className="text-sm font-medium text-text-primary mb-2">{built.length} member(s) ready to import</p>
              <div className="grid grid-cols-2 gap-2 mb-4">
                {[
                  ["Missing email", warnings.missingEmail, "amber"],
                  ["Invalid email", warnings.invalidEmail, "amber"],
                  ["Duplicate emails", warnings.dupEmail, "amber"],
                  ["Duplicate names", warnings.dupName, "muted"],
                  ["Invalid dates", warnings.invalidDate, "amber"],
                  ["Inactive / canceled", warnings.inactive, "muted"],
                  ["Missing membership", warnings.missingMembership, "muted"],
                  ["Possible families", warnings.possibleFamilies, "brand"],
                ].map(([label, n]) => (
                  <div key={label as string} className="flex items-center justify-between bg-app-bg/50 border border-app-border rounded-lg px-3 py-2">
                    <span className="text-xs text-text-muted">{label}</span>
                    <span className={`text-sm font-semibold ${Number(n) > 0 ? "text-text-primary" : "text-text-muted"}`}>{n as number}</span>
                  </div>
                ))}
              </div>
              <div className="bg-brand/5 border border-brand/20 rounded-lg p-3 mb-4 text-xs text-text-muted">
                Warnings won't block the import — rows with issues are flagged as <strong className="text-text-primary">Needs review</strong> so nobody is lost.
                No one is charged and no Stripe billing starts from this import.
              </div>
              <div className="overflow-x-auto border border-app-border rounded-lg mb-4">
                <table className="w-full text-xs">
                  <thead><tr className="bg-app-bg/40 text-text-muted text-left">
                    <th className="px-2 py-1.5">Name</th><th className="px-2 py-1.5">Email</th>
                    <th className="px-2 py-1.5">Membership</th><th className="px-2 py-1.5">Next bill</th>
                  </tr></thead>
                  <tbody>
                    {built.slice(0, 6).map((m, i) => (
                      <tr key={i} className="border-t border-app-border">
                        <td className="px-2 py-1.5 text-text-primary">{m.athleteName || `${m.firstName || ""} ${m.lastName || ""}`.trim()}</td>
                        <td className="px-2 py-1.5 text-text-muted">{m.email || m.guardianEmail || "—"}</td>
                        <td className="px-2 py-1.5 text-text-muted">{m.membershipName || "—"}</td>
                        <td className="px-2 py-1.5 text-text-muted">{m.nextBillingDate || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setStep("map")} className="text-sm px-4 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg">Back</button>
                <button disabled={busy || built.length === 0} onClick={doImport} className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50">
                  {busy ? "Importing…" : `Import ${built.length} member(s)`}
                </button>
              </div>
            </div>
          )}

          {step === "done" && result && (
            <div className="text-center py-6">
              <p className="text-3xl mb-2">✓</p>
              <p className="text-base font-semibold text-text-primary mb-1">Import complete</p>
              <p className="text-sm text-text-muted mb-4">
                {result.created} imported · {result.needsReview} need review · {result.skipped} skipped · {result.failed} failed
              </p>
              {result.errors.length > 0 && (
                <div className="text-left bg-app-bg/50 border border-app-border rounded-lg p-3 max-h-40 overflow-y-auto mb-4">
                  {result.errors.slice(0, 50).map((e, i) => <p key={i} className="text-xs text-text-muted">{e}</p>)}
                </div>
              )}
              <p className="text-xs text-text-muted mb-4">
                Next: select members and use “Send Activation Links”. Imported members are not charged until they activate.
              </p>
              <button onClick={onDone} className="text-sm px-5 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover">Go to migration dashboard</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
