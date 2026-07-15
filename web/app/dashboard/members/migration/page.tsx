"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import MembersTabs from "@/components/MembersTabs";

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
type CustomFieldDef = { id: string; label: string; required: boolean };

const FIELDS: { key: string; label: string; group: string }[] = [
  { key: "athleteName", label: "Athlete name (full)", group: "Identity" },
  { key: "firstName", label: "First name", group: "Identity" },
  { key: "lastName", label: "Last name", group: "Identity" },
  { key: "email", label: "Email", group: "Contact" },
  { key: "phone", label: "Phone", group: "Contact" },
  { key: "dateOfBirth", label: "Date of birth", group: "Profile" },
  { key: "gender", label: "Gender", group: "Profile" },
  { key: "streetAddress", label: "Street address", group: "Address" },
  { key: "city", label: "City", group: "Address" },
  { key: "state", label: "State / Region", group: "Address" },
  { key: "zipCode", label: "Zip code", group: "Address" },
  { key: "status", label: "Status", group: "Profile" },
  { key: "isMinor", label: "Minor (yes/no)", group: "Profile" },
  { key: "tags", label: "Tags", group: "Profile" },
  { key: "notes", label: "Notes", group: "Profile" },
  { key: "guardianName", label: "Guardian name", group: "Guardian" },
  { key: "guardianEmail", label: "Guardian email", group: "Guardian" },
  { key: "guardianPhone", label: "Guardian phone", group: "Guardian" },
  { key: "guardianRelationship", label: "Guardian relationship", group: "Guardian" },
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
  if ((h.includes("guardian") || h.includes("parent")) && h.includes("relation")) return "guardianRelationship";
  if ((h.includes("parent") || h.includes("guardian")) && !h.includes("email") && !h.includes("phone")) return "guardianName";
  if (h.includes("firstname") || h === "first" || h === "fname") return "firstName";
  if (h.includes("lastname") || h === "last" || h === "lname" || h === "surname") return "lastName";
  if (h.includes("athletename") || h.includes("membername") || h === "name" || h === "fullname" || h === "player") return "athleteName";
  if (h.includes("email")) return "email";
  if (h.includes("phone") || h === "mobile" || h === "cell") return "phone";
  if (h.includes("dob") || h.includes("birth")) return "dateOfBirth";
  if (h.includes("gender") || h === "sex") return "gender";
  if (h.includes("street") || h === "address" || h.includes("addressline") || h.includes("address1")) return "streetAddress";
  if (h === "city" || h.includes("town")) return "city";
  if (h === "state" || h === "province" || h === "region") return "state";
  if (h.includes("zip") || h.includes("postal")) return "zipCode";
  if (h.includes("minor") || h.includes("under18")) return "isMinor";
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
  // Derived server-side: an owner/staff already configured this member's setup
  // (plan/option/override/final-paid) or invited them. Drives the "Set up ✓"
  // badge + "Edit setup" label so staff don't repeat someone else's work.
  setupComplete: boolean;
  // Latest Set-up drawer save: staffer's name + when (from the migration event
  // log). null when setup was implied (e.g. invite sent) rather than configured.
  setupBy: string | null;
  setupAt: string | null;
  // Billing-control triage + derived readiness (server-side, DB facts only).
  migrationGroup: string | null;
  migrationFinalAction: string | null;
  migrationGroupNote: string | null;
  migrationFinalBillingDate: string | null;
  hasCapturedCard: boolean;
  resolvedPrice: number | null;
  resolvedPeriod: string | null;
  readiness: string;
  readinessLabel: string;
  readinessReasons: string[];
  reactivationStatus: string | null;
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "legacy", label: "From old system" },
  { key: "not_invited", label: "Not invited" },
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

// Operational triage states (planning only — never charge/mutate Stripe).
// The one-time Group A/B/C planning shorthand is deprecated and hidden; rows
// still carrying a letter group simply show no state chip.
const GROUP_FILTERS = [
  { key: "", label: "All states" },
  { key: "LEAVE_ALONE", label: "Leave alone" },
  { key: "FUTURE_FOLLOW_UP", label: "Follow-up" },
  { key: "NEEDS_PAYMENT_METHOD", label: "Needs card" },
  { key: "none", label: "Unclassified" },
];
// Deprecated letter groups render as nothing in the UI/exports.
const groupDisplay = (g: string | null) => (!g || g === "A" || g === "B" || g === "C" ? "" : g.replace(/_/g, " "));
const READINESS_FILTERS = [
  { key: "", label: "Any readiness" },
  { key: "READY", label: "Ready" },
  { key: "WAITING_OWNER", label: "Waiting on owner" },
  { key: "WAITING_CLIENT", label: "Waiting on client" },
  { key: "HOLD", label: "Hold" },
  { key: "LEAVE_ALONE", label: "Active / leave alone" },
];
const READINESS_STYLE: Record<string, string> = {
  READY: "bg-lime-accent/25 text-text-primary",
  WAITING_OWNER: "bg-orange-accent/20 text-text-primary",
  WAITING_CLIENT: "bg-brand/10 text-brand",
  HOLD: "bg-red-50 text-red-700",
  LEAVE_ALONE: "bg-app-bg text-text-muted",
};

export default function MigrationPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [group, setGroup] = useState("");
  const [readiness, setReadiness] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [totalInFilter, setTotalInFilter] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showMembershipImport, setShowMembershipImport] = useState(false);
  const [historyFor, setHistoryFor] = useState<Row | null>(null);
  const [drawerFor, setDrawerFor] = useState<Row | null>(null);
  const [showFamilies, setShowFamilies] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  // id → family signals so a "select all" send can group by family exactly like
  // the server (one invite per guardian) without re-fetching. Populated as rows
  // load and as select-all sweeps every page.
  const metaRef = useRef<Map<string, { isMinor: boolean; guardianEmail: string | null }>>(new Map());

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ filter, q, page: String(page), pageSize: "25" });
    if (group) params.set("group", group);
    if (readiness) params.set("readiness", readiness);
    fetch(`/api/members/migration?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setStats(d.stats);
          setRows(d.members);
          setPageCount(d.pageCount || 1);
          setTotalInFilter(d.totalInFilter || 0);
          for (const m of (d.members ?? []) as Row[]) {
            metaRef.current.set(m.id, { isMinor: m.isMinor, guardianEmail: m.guardianEmail });
          }
        }
        setLoading(false);
      });
  }, [filter, q, page, group, readiness]);

  useEffect(() => { load(); }, [load]);
  // Clear selection when the underlying set changes (filter/search) — but NOT on
  // page changes, so a selection can span every page ("select all matching").
  useEffect(() => { setSelected(new Set()); }, [filter, q, group, readiness]);

  // Send activation links to an explicit set of member ids (selection or a
  // family group). The server collapses each family to ONE guardian email, but
  // only within a single request — so we group by family client-side and send
  // family-sized chunks. This never splits a family across requests (which would
  // double-email a guardian) and never exceeds the server's per-request family
  // cap, so a whole-filter "select all" of any size sends correctly.
  async function postSend(memberIds: string[], reminder: boolean) {
    if (memberIds.length === 0) return;
    setBusy(true);
    setMsg("");
    const FAM_PER_CHUNK = 120; // server caps at 150 families/request — leave headroom
    const famGroups = new Map<string, string[]>();
    for (const id of memberIds) {
      const m = metaRef.current.get(id);
      const key = m && m.isMinor && m.guardianEmail ? `g:${m.guardianEmail.toLowerCase()}` : `m:${id}`;
      const list = famGroups.get(key) ?? [];
      list.push(id);
      famGroups.set(key, list);
    }
    const families = [...famGroups.values()];
    let sent = 0, covered = 0, failed = 0;
    for (let i = 0; i < families.length; i += FAM_PER_CHUNK) {
      const chunkIds = families.slice(i, i + FAM_PER_CHUNK).flat();
      const res = await fetch("/api/members/migration/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "selected", memberIds: chunkIds, reminder }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(typeof d.error === "string" ? d.error : "Send failed"); setBusy(false); return; }
      sent += d.sent || 0;
      covered += d.membersInvited || 0;
      failed += d.failed || 0;
      setMsg(`Sending… ${sent} sent${covered ? ` · ${covered} sibling(s) covered` : ""}${failed ? ` · ${failed} failed` : ""}`);
    }
    setBusy(false);
    setMsg(`Done — ${sent} ${reminder ? "reminder" : "activation"} email(s) sent${covered ? ` · ${covered} sibling(s) covered` : ""}${failed ? ` · ${failed} failed` : ""}.`);
    setSelected(new Set());
    load();
  }

  // "Send reminders to all pending" — server resolves the target set itself and
  // batches, looping until nothing remains.
  async function sendAllPending(reminder: boolean) {
    setBusy(true);
    setMsg("");
    let totalSent = 0, totalFailed = 0, guard = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await fetch("/api/members/migration/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "all_pending", reminder }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(typeof d.error === "string" ? d.error : "Send failed"); break; }
      totalSent += d.sent || 0;
      totalFailed += d.failed || 0;
      setMsg(`Sending… ${totalSent} sent${totalFailed ? `, ${totalFailed} failed` : ""}${d.remaining ? ` · ${d.remaining} queued` : ""}`);
      if (!d.remaining || ++guard > 50) break;
    }
    setBusy(false);
    setMsg(`Done — ${totalSent} ${reminder ? "reminder" : "activation"} email(s) sent${totalFailed ? `, ${totalFailed} failed` : ""}.`);
    setSelected(new Set());
    load();
  }

  // Pull every id matching the current filter + search across ALL pages so the
  // owner can act on the whole set, not just the 25 visible. Mirrors the PDF
  // export's paged sweep and records family meta for a correct grouped send.
  async function selectAllMatching() {
    setSelectingAll(true);
    const ids: string[] = [];
    for (let p = 1; p <= 200; p++) {
      const params = new URLSearchParams({ filter, q, page: String(p), pageSize: "100" });
      const res = await fetch(`/api/members/migration?${params}`);
      if (!res.ok) break;
      const d = await res.json();
      const batch: Row[] = d.members ?? [];
      for (const m of batch) {
        ids.push(m.id);
        metaRef.current.set(m.id, { isMinor: m.isMinor, guardianEmail: m.guardianEmail });
      }
      if (batch.length === 0 || p >= (d.pageCount ?? 1)) break;
    }
    setSelected(new Set(ids));
    setSelectingAll(false);
  }

  async function resendOne(id: string) {
    setBusy(true);
    const res = await fetch(`/api/members/migration/${id}/resend`, { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    setMsg(res.ok ? "Reminder sent." : typeof d.error === "string" ? d.error : "Could not send");
    load();
  }

  // Pull the WHOLE current-filter roster (all pages) for exports.
  async function fetchAllPages(): Promise<Row[]> {
    const all: Row[] = [];
    for (let p = 1; p <= 60; p++) {
      const params = new URLSearchParams({ filter, q, page: String(p), pageSize: "100" });
      if (group) params.set("group", group);
      if (readiness) params.set("readiness", readiness);
      const res = await fetch(`/api/members/migration?${params}`);
      if (!res.ok) break;
      const d = await res.json();
      const batch: Row[] = d.members ?? [];
      all.push(...batch);
      if (batch.length === 0 || p >= (d.pageCount ?? 1)) break;
    }
    return all;
  }

  // Export the reviewed plan as CSV — the owner's sign-off sheet for the
  // billing migration (group, readiness, dates, notes). Client-side; nothing
  // leaves the browser.
  async function downloadCsv() {
    setPdfBusy(true);
    setMsg("");
    try {
      const all = await fetchAllPages();
      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = [
        "Name", "Minor", "Contact", "Plan", "Price", "Frequency", "Owner state", "Final action",
        "Final billing date", "Readiness", "Readiness notes", "Saved card", "Status", "Approval",
        "Reactivation", "Triage note",
      ];
      const lines = [header.join(",")].concat(
        all.map((r) =>
          [
            `${r.firstName} ${r.lastName}`.trim(),
            r.isMinor ? "yes" : "",
            r.email || r.guardianEmail || "",
            r.legacyMembershipName || "",
            r.resolvedPrice != null ? r.resolvedPrice.toFixed(2) : "",
            r.resolvedPeriod || r.legacyBillingFrequency || "",
            groupDisplay(r.migrationGroup),
            r.migrationFinalAction || "",
            r.migrationFinalBillingDate
              ? new Date(r.migrationFinalBillingDate).toLocaleDateString()
              : r.billingAnchorDate
                ? new Date(r.billingAnchorDate).toLocaleDateString()
                : "",
            r.readinessLabel || "",
            (r.readinessReasons || []).join("; "),
            r.hasCapturedCard ? "yes" : "no",
            r.migrationStatus || "",
            r.approvalStatus || "",
            r.reactivationStatus || "",
            r.migrationGroupNote || "",
          ].map(esc).join(","),
        ),
      );
      const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `migration-plan-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      setMsg(`Exported ${all.length} member(s).`);
    } catch {
      setMsg("Could not build the CSV. Please try again.");
    } finally {
      setPdfBusy(false);
    }
  }

  // Export the WHOLE current-filter roster (all pages) as a PDF the owner can
  // keep or hand off during migration. Client-side via jsPDF + autoTable (both
  // already bundled) — no server route, no data leaves the owner's browser.
  async function downloadPdf() {
    setPdfBusy(true);
    setMsg("");
    try {
      const all: Row[] = await fetchAllPages();
      let clubName = "Your club";
      try {
        const info = await fetch("/api/club/info").then((r) => (r.ok ? r.json() : null));
        if (info?.name && typeof info.name === "string") clubName = info.name;
      } catch { /* fall back to generic title */ }

      const { jsPDF } = await import("jspdf");
      const autoTable = (await import("jspdf-autotable")).default;
      const doc = new jsPDF({ orientation: "landscape" });
      const filterLabel = FILTERS.find((f) => f.key === filter)?.label ?? "All";

      doc.setFontSize(16);
      doc.setTextColor(17, 17, 17);
      doc.text(`${clubName} — Migration summary`, 14, 16);
      doc.setFontSize(10);
      doc.setTextColor(120, 120, 120);
      doc.text(
        `${all.length} member(s) · Filter: ${filterLabel}${q ? ` · Search: "${q}"` : ""} · Generated ${new Date().toLocaleDateString()}`,
        14,
        22,
      );

      autoTable(doc, {
        startY: 28,
        head: [["Name", "Contact", "Plan", "Price", "Final billing", "State", "Readiness", "Status", "Notes"]],
        body: all.map((r) => [
          `${r.firstName} ${r.lastName}`.trim() + (r.isMinor ? " (minor)" : ""),
          r.email || r.guardianEmail || "—",
          r.legacyMembershipName || "—",
          r.resolvedPrice != null
            ? `$${r.resolvedPrice.toFixed(2)}${(r.resolvedPeriod || r.legacyBillingFrequency) ? `/${(r.resolvedPeriod || r.legacyBillingFrequency)!.toLowerCase()}` : ""}`
            : r.legacyMembershipPrice != null
              ? `$${Number(r.legacyMembershipPrice).toFixed(2)}${r.legacyBillingFrequency ? `/${r.legacyBillingFrequency.toLowerCase()}` : ""}`
              : "—",
          r.migrationFinalBillingDate
            ? new Date(r.migrationFinalBillingDate).toLocaleDateString()
            : r.billingAnchorDate
              ? new Date(r.billingAnchorDate).toLocaleDateString()
              : "—",
          groupDisplay(r.migrationGroup) || "—",
          r.readinessLabel || "—",
          (r.migrationStatus?.replace("_", " ") ?? "—") +
            (r.approvalStatus === "PENDING_APPROVAL" ? " · needs approval" : ""),
          r.migrationGroupNote || "",
        ]),
        styles: { fontSize: 8, cellPadding: 2, overflow: "linebreak" },
        headStyles: { fillColor: [31, 31, 35], textColor: [255, 255, 255] },
        columnStyles: { 1: { cellWidth: 55 } },
      });

      doc.save(`migration-summary-${new Date().toISOString().slice(0, 10)}.pdf`);
      setMsg(`Downloaded ${all.length} member(s).`);
    } catch {
      setMsg("Could not build the PDF. Please try again.");
    } finally {
      setPdfBusy(false);
    }
  }

  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someOnPageSelected = rows.some((r) => selected.has(r.id));
  const moreThanPage = totalInFilter > rows.length;
  const allMatchingSelected = totalInFilter > 0 && selected.size >= totalInFilter;

  return (
    <div className="p-8 max-w-7xl">
      <MembersTabs />
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
        <div className="flex gap-2 flex-shrink-0">
          <button
            onClick={() => setShowMembershipImport(true)}
            className="text-sm px-4 py-2 border border-app-border text-text-primary rounded-lg hover:bg-app-bg transition"
          >
            Match Memberships CSV
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="text-sm px-4 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover transition"
          >
            Import / Migrate Members
          </button>
        </div>
      </div>

      {/* Two-step import — members first, then (optionally) match their memberships */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        <div className="bg-surface border border-app-border rounded-xl p-4 flex flex-col">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-5 h-5 rounded-full bg-brand text-white text-xs font-semibold flex items-center justify-center flex-shrink-0">1</span>
            <p className="text-sm font-semibold text-text-primary">Import all your clients</p>
          </div>
          <p className="text-[13px] text-text-muted flex-1">
            Upload your <strong className="text-text-primary">full roster</strong> in one CSV — active or not.
            Map any columns you have: contact info, address, guardian details, and your custom fields.
            You can also include each member&apos;s membership, price &amp; billing date here. Everyone comes
            in as a Prospect and is <strong className="text-text-primary">never charged</strong> until they
            activate. One contact email/phone is enough; for a minor it&apos;s the guardian&apos;s.
          </p>
          <button
            onClick={() => setShowImport(true)}
            className="mt-3 self-start text-sm px-3 py-1.5 bg-brand text-white rounded-lg hover:bg-brand-hover"
          >
            Import / Migrate Members
          </button>
        </div>
        <div className="bg-surface border border-app-border rounded-xl p-4 flex flex-col">
          <div className="flex items-center gap-2 mb-1">
            <span className="w-5 h-5 rounded-full bg-brand/15 text-brand text-xs font-semibold flex items-center justify-center flex-shrink-0">2</span>
            <p className="text-sm font-semibold text-text-primary">Match memberships (separate file)</p>
          </div>
          <p className="text-[13px] text-text-muted flex-1">
            If your old system exports <strong className="text-text-primary">clients and memberships as
            separate files</strong>, upload the memberships CSV here. It matches each one (by email or
            name) to a client from step 1 and attaches their plan, price &amp; billing date so they keep
            their existing cycle.
          </p>
          <button
            onClick={() => setShowMembershipImport(true)}
            className="mt-3 self-start text-sm px-3 py-1.5 border border-app-border text-text-primary rounded-lg hover:bg-app-bg"
          >
            Match Memberships CSV
          </button>
        </div>
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
        <Link
          href="/dashboard/members/duplicates"
          className="text-xs px-3 py-1.5 rounded-full border border-brand/40 text-brand hover:bg-brand/5 font-medium"
        >
          Review duplicates
        </Link>
        <button
          onClick={downloadPdf}
          disabled={pdfBusy || loading}
          title="Download the full migrated roster (current filter) as a PDF."
          className="text-xs px-3 py-1.5 rounded-full border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50 font-medium"
        >
          {pdfBusy ? "Building PDF…" : "Download migration PDF"}
        </button>
        <button
          onClick={downloadCsv}
          disabled={pdfBusy || loading}
          title="Download the reviewed plan (current filter) as CSV — groups, readiness, dates, notes."
          className="text-xs px-3 py-1.5 rounded-full border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50 font-medium"
        >
          Export plan CSV
        </button>
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder="Search name, email, legacy ID…"
          className="ml-auto text-sm px-3 py-1.5 border border-app-border rounded-lg bg-surface w-64"
        />
      </div>

      {/* Triage group + readiness filters (planning layer — never charges) */}
      <div className="flex flex-wrap items-center gap-2 mb-4 -mt-2">
        {GROUP_FILTERS.map((f) => (
          <button
            key={f.key || "allg"}
            onClick={() => { setGroup(f.key); setPage(1); }}
            className={`text-xs px-3 py-1 rounded-full border transition ${
              group === f.key ? "border-charcoal bg-charcoal text-white" : "border-app-border text-text-muted hover:bg-app-bg"
            }`}
          >
            {f.label}
            {f.key && stats && (stats as unknown as { groups?: Record<string, number> }).groups?.[f.key] != null
              ? ` (${(stats as unknown as { groups: Record<string, number> }).groups[f.key]})`
              : ""}
          </button>
        ))}
        <span className="text-app-border">|</span>
        {READINESS_FILTERS.map((f) => (
          <button
            key={f.key || "allr"}
            onClick={() => { setReadiness(f.key); setPage(1); }}
            className={`text-xs px-3 py-1 rounded-full border transition ${
              readiness === f.key ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-muted hover:bg-app-bg"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Bulk actions */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          onClick={() => postSend([...selected], false)}
          disabled={busy || selected.size === 0}
          className="text-xs px-3 py-1.5 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
        >
          Send Activation Links ({selected.size})
        </button>
        <button
          onClick={() => sendAllPending(true)}
          disabled={busy}
          className="text-xs px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-50"
        >
          Send reminders to all pending
        </button>
        <button
          onClick={() => setShowFamilies((v) => !v)}
          className={`text-xs px-3 py-1.5 rounded-lg border transition ${
            showFamilies ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-primary hover:bg-app-bg"
          }`}
        >
          {showFamilies ? "Hide family groups" : "Family onboarding groups"}
        </button>
        {msg && <span className="text-xs text-text-muted">{msg}</span>}
      </div>

      {showFamilies && (
        <FamiliesPanel
          busy={busy}
          onSendFamily={async (childIds) => { await postSend(childIds, false); }}
        />
      )}

      {/* Select all across every page of the current filter (Gmail-style). */}
      {!loading && rows.length > 0 && (allMatchingSelected || (allOnPageSelected && moreThanPage)) && (
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs bg-brand/5 border border-brand/20 rounded-lg px-3 py-2 mb-3">
          {allMatchingSelected ? (
            <>
              <span className="text-text-primary">
                All <strong>{totalInFilter}</strong> member(s) matching “{FILTERS.find((f) => f.key === filter)?.label}” are selected.
              </span>
              <button
                onClick={() => setSelected(new Set())}
                className="underline text-brand hover:text-brand-hover font-medium"
              >
                Clear selection
              </button>
            </>
          ) : (
            <>
              <span className="text-text-primary">All <strong>{rows.length}</strong> on this page selected.</span>
              <button
                onClick={selectAllMatching}
                disabled={selectingAll}
                className="underline text-brand hover:text-brand-hover font-medium disabled:opacity-50"
              >
                {selectingAll ? "Selecting…" : `Select all ${totalInFilter} matching this filter`}
              </button>
            </>
          )}
        </div>
      )}

      {/* Table */}
      <div className="bg-surface border border-app-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-text-muted border-b border-app-border bg-app-bg/40">
                <th className="px-3 py-2.5 w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    ref={(el) => { if (el) el.indeterminate = someOnPageSelected && !allOnPageSelected; }}
                    checked={allOnPageSelected}
                    onChange={() =>
                      // Add/remove only this page's rows so selections on other
                      // pages survive (enables select-all across every page).
                      setSelected((prev) => {
                        const n = new Set(prev);
                        if (allOnPageSelected) rows.forEach((r) => n.delete(r.id));
                        else rows.forEach((r) => n.add(r.id));
                        return n;
                      })
                    }
                  />
                </th>
                <th className="px-3 py-2.5 font-medium">Member</th>
                <th className="px-3 py-2.5 font-medium">Membership</th>
                <th className="px-3 py-2.5 font-medium">Next billing</th>
                <th className="px-3 py-2.5 font-medium">State / readiness</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Emails</th>
                <th className="px-3 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-text-muted">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-text-muted">
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
                      {r.migrationFinalBillingDate
                        ? new Date(r.migrationFinalBillingDate).toLocaleDateString("en-US", { timeZone: "UTC" })
                        : r.billingAnchorDate
                          ? <span title="Imported anchor — no owner-approved final date yet">{new Date(r.billingAnchorDate).toLocaleDateString("en-US", { timeZone: "UTC" })}*</span>
                          : "—"}
                    </td>
                    <td className="px-3 py-3">
                      {groupDisplay(r.migrationGroup) && (
                        <span className="inline-flex items-center whitespace-nowrap text-[10px] px-2 py-0.5 rounded-full font-medium bg-charcoal text-white mr-1">
                          {groupDisplay(r.migrationGroup)}
                        </span>
                      )}
                      <span
                        className={`inline-flex items-center whitespace-nowrap text-[10px] px-2 py-0.5 rounded-full font-medium ${READINESS_STYLE[r.readiness] || "bg-app-bg text-text-muted"}`}
                        title={(r.readinessReasons || []).join("; ") || undefined}
                      >
                        {r.readinessLabel}
                      </span>
                      {r.reactivationStatus && (
                        <span className="inline-flex items-center whitespace-nowrap mt-1 text-[10px] px-2 py-0.5 rounded-full font-medium bg-brand/10 text-brand">
                          Offer {r.reactivationStatus.toLowerCase()}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <span className={`inline-flex items-center whitespace-nowrap text-[10px] px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[r.migrationStatus] || "bg-app-bg text-text-muted"}`}>
                        {r.migrationStatus?.replace("_", " ")}
                      </span>
                      {r.approvalStatus === "PENDING_APPROVAL" && (
                        <span className="inline-flex items-center whitespace-nowrap mt-1 text-[10px] px-2 py-0.5 rounded-full font-medium bg-orange-accent/20 text-text-primary">
                          Needs approval
                        </span>
                      )}
                      {/* Positive "already configured" signal so a second staffer
                          doesn't re-run setup. Hidden once fully COMPLETED (the
                          status pill already says so). */}
                      {r.setupComplete && r.migrationStatus !== "COMPLETED" && (
                        <span
                          className="inline-flex items-center whitespace-nowrap mt-1 text-[10px] px-2 py-0.5 rounded-full font-medium bg-lime-accent/25 text-text-primary"
                          title={
                            r.setupBy
                              ? `Set up by ${r.setupBy}${r.setupAt ? ` on ${new Date(r.setupAt).toLocaleDateString()}` : ""} — no need to redo it.`
                              : "An owner or staff member has already set up this member's plan/billing."
                          }
                        >
                          Set up ✓{r.setupBy ? ` · ${r.setupBy.split(" ")[0]}` : ""}
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
                          title={
                            r.setupComplete
                              ? r.setupBy
                                ? `Already set up by ${r.setupBy}${r.setupAt ? ` on ${new Date(r.setupAt).toLocaleDateString()}` : ""} — open to review or edit`
                                : "Already set up — open to review or edit"
                              : "Set up this member's plan & billing"
                          }
                          className="text-xs px-2 py-1 border border-app-border rounded-lg text-text-primary hover:bg-app-bg disabled:opacity-40"
                        >
                          {r.setupComplete ? "Edit setup" : "Set up"}
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
                      <Link
                        href={`/dashboard/members/${r.id}/billing`}
                        className="text-xs px-2 py-1 ml-1 text-brand hover:underline"
                        title="Open the billing control center — plan, dates, payment methods, reactivation."
                      >
                        Billing
                      </Link>
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
      {showMembershipImport && <MembershipImportWizard onClose={() => setShowMembershipImport(false)} onDone={() => { setShowMembershipImport(false); load(); }} />}
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

// ── Family onboarding groups — same guardian email = one family ──────────────
type FamilyChild = {
  id: string; firstName: string; lastName: string;
  migrationStatus: string; approvalStatus: string | null; emailsSent: number;
  membership: string | null; price: number | null; frequency: string | null;
};
type Family = {
  guardianEmail: string; guardianName: string | null;
  childCount: number; pendingCount: number; completedCount: number; children: FamilyChild[];
};

function FamiliesPanel({
  busy,
  onSendFamily,
}: {
  busy: boolean;
  onSendFamily: (childIds: string[]) => Promise<void>;
}) {
  const [families, setFamilies] = useState<Family[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/members/migration/families")
      .then((r) => (r.ok ? r.json() : { families: [] }))
      .then((d) => { setFamilies(d.families || []); setLoading(false); });
  }, []);

  const pendingIds = (f: Family) =>
    f.children.filter((c) => c.migrationStatus !== "COMPLETED").map((c) => c.id);

  return (
    <div className="bg-surface border border-app-border rounded-xl p-4 mb-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-sm font-semibold text-text-primary">Family onboarding</p>
          <p className="text-[13px] text-text-muted">
            Members sharing a guardian email are grouped. Send <strong>one invite per family</strong> — the
            guardian sets a password once and onboards every child in the same flow.
          </p>
        </div>
        {families.length > 0 && (
          <button
            onClick={() => onSendFamily(families.flatMap((f) => pendingIds(f)))}
            disabled={busy}
            className="text-xs px-3 py-1.5 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50 whitespace-nowrap flex-shrink-0"
          >
            Send one invite to every family
          </button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-text-muted py-4 text-center">Loading families…</p>
      ) : families.length === 0 ? (
        <p className="text-sm text-text-muted py-4 text-center">
          No same-email family groups detected yet. Import a roster where siblings share a guardian email.
        </p>
      ) : (
        <div className="space-y-2 max-h-[28rem] overflow-y-auto pr-1">
          {families.map((f) => {
            const pend = pendingIds(f);
            return (
              <div key={f.guardianEmail} className="border border-app-border rounded-lg p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">
                      {f.guardianName || "Guardian"}{" "}
                      <span className="text-text-muted font-normal">· {f.guardianEmail}</span>
                    </p>
                    <p className="text-[11px] text-text-muted">
                      {f.childCount} athlete{f.childCount === 1 ? "" : "s"} ·{" "}
                      {f.pendingCount} pending · {f.completedCount} done
                    </p>
                  </div>
                  <button
                    onClick={() => onSendFamily(pend)}
                    disabled={busy || pend.length === 0}
                    className="text-xs px-3 py-1.5 border border-brand text-brand rounded-lg hover:bg-brand/10 disabled:opacity-40 whitespace-nowrap flex-shrink-0"
                  >
                    {pend.length === 0 ? "All set up" : "Send one invite"}
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {f.children.map((c) => (
                    <span
                      key={c.id}
                      className={`text-[11px] px-2 py-0.5 rounded-full border ${
                        c.migrationStatus === "COMPLETED"
                          ? "border-lime-accent/40 bg-lime-accent/15 text-text-primary"
                          : c.approvalStatus === "PENDING_APPROVAL"
                            ? "border-orange-accent/40 bg-orange-accent/15 text-text-primary"
                            : "border-app-border text-text-muted"
                      }`}
                      title={c.membership ? `${c.membership}${c.price != null ? ` · $${c.price.toFixed(2)}` : ""}` : undefined}
                    >
                      {c.firstName} {c.lastName}
                      {c.migrationStatus === "COMPLETED" ? " ✓" : ""}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
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
  migrationPriceOverride: string | number | null;
  migrationDiscountNote: string | null;
  activationEditableFields: Record<string, boolean> | null;
  requestedBillingDate: string | null; requestedBillingNote: string | null; activationNote: string | null;
  requestedCancellationDate: string | null; requestedPaymentMethod: string | null;
  migrationSelectedOption: { label?: string; price?: number; billingPeriod?: string } | null;
  migrationFinalPeriodPaid: boolean;
};
const EDITABLE_KEYS: { key: string; label: string }[] = [
  { key: "phone", label: "Phone number" },
  { key: "email", label: "Email address" },
  { key: "billingDateRequest", label: "Request a different billing date" },
  { key: "cancellationDate", label: "Set a cancellation date" },
  { key: "paymentChoice", label: "Choose card / cash / check" },
  { key: "notes", label: "Leave a note / comment" },
];
function dInput(iso: string | null | undefined) {
  return iso ? new Date(iso).toISOString().slice(0, 10) : "";
}

function MigrationDrawer({ memberId, onClose, onChanged }: { memberId: string; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [activationUrl, setActivationUrl] = useState<string | null>(null);
  const [memberships, setMemberships] = useState<{ id: string; name: string; options: { label: string; price: number; billingPeriod: string }[] }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);

  const [planId, setPlanId] = useState("");
  const [selectedOptionLabel, setSelectedOptionLabel] = useState("");
  const [priceOverride, setPriceOverride] = useState("");
  const [discountNote, setDiscountNote] = useState("");
  const [anchor, setAnchor] = useState("");
  const [frequency, setFrequency] = useState("MONTHLY");
  const [endDate, setEndDate] = useState("");
  const [finalPeriodPaid, setFinalPeriodPaid] = useState(false);
  const [editable, setEditable] = useState<Record<string, boolean>>({
    phone: true, email: false, billingDateRequest: true, notes: true,
    cancellationDate: true, paymentChoice: true,
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
        setSelectedOptionLabel(m.migrationSelectedOption?.label || "");
        setPriceOverride(
          m.migrationPriceOverride != null ? String(m.migrationPriceOverride) : "",
        );
        setDiscountNote(m.migrationDiscountNote || "");
        setAnchor(dInput(m.billingAnchorDate));
        setFrequency(m.legacyBillingFrequency || "MONTHLY");
        setEndDate(dInput(m.commitmentEndDate));
        setFinalPeriodPaid(!!m.migrationFinalPeriodPaid);
        setApproveDate(dInput(m.requestedBillingDate || m.billingAnchorDate));
        if (m.activationEditableFields) {
          setEditable({
            phone: m.activationEditableFields.phone ?? true,
            email: m.activationEditableFields.email ?? false,
            billingDateRequest: m.activationEditableFields.billingDateRequest ?? true,
            notes: m.activationEditableFields.notes ?? true,
            cancellationDate: m.activationEditableFields.cancellationDate ?? true,
            paymentChoice: m.activationEditableFields.paymentChoice ?? true,
          });
        }
      }
      setMemberships(
        Array.isArray(mships)
          ? mships.map((x: { id: string; name: string; options?: string }) => {
              let options: { label: string; price: number; billingPeriod: string }[] = [];
              try {
                const o = JSON.parse(x.options || "[]");
                if (Array.isArray(o)) {
                  options = o
                    .filter((it) => it && typeof it.price === "number")
                    .map((it) => ({
                      label: String(it.label ?? "Membership"),
                      price: Number(it.price),
                      billingPeriod: String(it.billingPeriod || "MONTHLY"),
                    }));
                }
              } catch {
                /* options not JSON — leave empty */
              }
              return { id: x.id, name: x.name, options };
            })
          : [],
      );
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
        selectedOptionLabel: selectedOptionLabel || null,
        priceOverride: priceOverride.trim() === "" ? null : Number(priceOverride),
        discountNote: discountNote.trim() || null,
        billingAnchorDate: anchor || null,
        billingFrequency: frequency || null,
        commitmentEndDate: endDate || null,
        finalPeriodPaid,
        activationEditableFields: editable,
      }),
    });
    const r = await res.json().catch(() => ({}));
    setSaving(false);
    setMsg(res.ok ? "Saved." : typeof r.error === "string" ? r.error : "Save failed");
    if (res.ok) onChanged();
  }

  async function approve(acceptRequested: boolean, confirmImmediateCharge = false) {
    if (!confirmImmediateCharge && !confirm("Approve this member? Billing is scheduled on the agreed date — you'll get a separate, explicit confirmation if the date means charging immediately.")) return;
    setSaving(true); setMsg("");
    const res = await fetch(`/api/members/migration/${memberId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(acceptRequested ? { acceptRequestedDate: true } : { billingAnchorDate: approveDate || null }),
        ...(confirmImmediateCharge ? { confirmImmediateCharge: true } : {}),
      }),
    });
    const r = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      // The billing date is today/past: the server refuses to charge silently.
      // Surface an unmissable second confirmation with the exact amount.
      if (r.code === "IMMEDIATE_CHARGE_CONFIRM_REQUIRED") {
        const amount = typeof r.price === "number" ? `$${r.price.toFixed(2)}` : "the full cycle amount";
        if (confirm(`⚠ The billing date is today or already passed.\n\nApproving will charge ${amount} to the saved card RIGHT NOW, and the cycle renews from today.\n\nPrefer a future date? Cancel and set one above.\n\nCharge ${amount} immediately?`)) {
          await approve(acceptRequested, true);
        }
        return;
      }
      setMsg(typeof r.error === "string" ? r.error : "Approval failed");
      return;
    }
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
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={onClose}>
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto border border-app-border" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <h2 className="text-base font-semibold text-text-primary">
            {pending ? "Review & approve" : "Set up migration"}{d ? ` · ${d.firstName} ${d.lastName}` : ""}
          </h2>
          <div className="flex items-center gap-3">
            <Link
              href={`/dashboard/members/${memberId}/billing`}
              className="text-xs text-brand hover:underline whitespace-nowrap"
              title="Full billing control center — payment methods, triage, reactivation offer."
            >
              Billing center
            </Link>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
          </div>
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
                  {d.migrationSelectedOption?.label && (
                    <p className="text-xs text-text-primary">
                      Chose plan: <strong>{d.migrationSelectedOption.label}</strong>
                      {typeof d.migrationSelectedOption.price === "number"
                        ? ` — $${d.migrationSelectedOption.price.toFixed(2)}${d.migrationSelectedOption.billingPeriod ? ` / ${d.migrationSelectedOption.billingPeriod.toLowerCase()}` : ""}`
                        : ""}
                    </p>
                  )}
                  {d.requestedCancellationDate && (
                    <p className="text-xs text-text-primary">
                      Requested cancellation: <strong>{new Date(d.requestedCancellationDate).toLocaleDateString()}</strong>
                    </p>
                  )}
                  {d.requestedPaymentMethod && d.requestedPaymentMethod !== "CARD" && (
                    <p className="text-xs text-orange-accent font-medium">
                      Paying by {d.requestedPaymentMethod.toLowerCase()} — confirm payment before approving.
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

              {/* Purchase option under the chosen membership (Monthly / Upfront / 1 Year …) */}
              {(() => {
                const planOpts = memberships.find((m) => m.id === planId)?.options ?? [];
                if (!planId || planOpts.length === 0) return null;
                return (
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1">Purchase option</label>
                    <select value={selectedOptionLabel} onChange={(e) => setSelectedOptionLabel(e.target.value)} className="inp">
                      <option value="">— Default (first option) —</option>
                      {planOpts.map((o) => (
                        <option key={o.label} value={o.label}>
                          {o.label} — ${o.price.toFixed(2)} / {o.billingPeriod.toLowerCase()}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-text-muted mt-1">
                      Which option under this membership the client continues on. Set a custom price below if theirs differs.
                    </p>
                  </div>
                );
              })()}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">
                    Price override ($)
                  </label>
                  <input
                    type="number" min="0" step="0.01"
                    value={priceOverride}
                    onChange={(e) => setPriceOverride(e.target.value)}
                    placeholder="Leave blank to use plan price"
                    className="inp"
                  />
                  <p className="text-[11px] text-text-muted mt-1">
                    Set the exact recurring price (e.g. a discounted rate). Wins
                    over the plan &amp; imported price. The client sees this
                    amount on their activation page.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">
                    Discount note
                  </label>
                  <input
                    type="text"
                    value={discountNote}
                    onChange={(e) => setDiscountNote(e.target.value)}
                    placeholder="e.g. Founding member 20% off"
                    maxLength={200}
                    className="inp"
                  />
                  <p className="text-[11px] text-text-muted mt-1">Internal note — why the price differs.</p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Next billing date</label>
                  <input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} className="inp" />
                  <p className="text-[11px] text-text-muted mt-1">
                    Defaults to the imported date. If it has already passed when you approve, the member is charged right away and the cycle restarts from that charge.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Billing frequency</label>
                  <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className="inp">
                    <option value="WEEKLY">Weekly</option>
                    <option value="BIWEEKLY">Every 2 weeks</option>
                    <option value="MONTHLY">Monthly</option>
                    <option value="QUARTERLY">Quarterly</option>
                    <option value="SEMI_ANNUAL">Every 6 months</option>
                    <option value="ANNUAL">Annual</option>
                  </select>
                  <p className="text-[11px] text-text-muted mt-1">How often the membership renews</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">End / commitment date</label>
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="inp" />
                  <p className="text-[11px] text-text-muted mt-1">Optional — matches prior contract</p>
                </div>
              </div>

              <label className="flex items-start gap-2 text-sm text-text-primary bg-app-bg border border-app-border rounded-lg p-3">
                <input type="checkbox" checked={finalPeriodPaid} onChange={(e) => setFinalPeriodPaid(e.target.checked)} className="mt-0.5" />
                <span>
                  Final period already paid — no further billing
                  <span className="block text-[11px] text-text-muted font-normal mt-0.5">
                    For a member whose membership is ending: the activation link shows “active through {endDate ? new Date(endDate).toLocaleDateString() : "the end date above"}”, charges nothing, and creates no subscription. They can <strong>optionally save a card on file</strong> so re-enrolling later is one tap. Set the end / commitment date above.
                  </span>
                </span>
              </label>

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
  const [customFields, setCustomFields] = useState<CustomFieldDef[]>([]);
  const [dateFormat, setDateFormat] = useState<"auto" | "mdy" | "dmy" | "ymd">("mdy");

  useEffect(() => {
    fetch("/api/custom-fields")
      .then((r) => (r.ok ? r.json() : []))
      .then((fs) =>
        setCustomFields(
          Array.isArray(fs)
            ? fs.map((f: { id: string; label: string; required?: boolean }) => ({ id: f.id, label: f.label, required: !!f.required }))
            : [],
        ),
      )
      .catch(() => {});
  }, []);

  // Column mapper options: built-in fields + the club's custom fields + skip last.
  const mappingFields = [
    ...FIELDS.filter((f) => f.key !== "skip"),
    ...customFields.map((f) => ({ key: `custom:${f.id}`, label: `Custom: ${f.label}`, group: "Custom" })),
    FIELDS[FIELDS.length - 1],
  ];

  // Convert a date from the chosen format to ISO so the server can't misread
  // dd/mm as mm/dd. Unparseable values pass through untouched.
  function convertDate(raw: string): string {
    const v = (raw || "").trim();
    if (!v || dateFormat === "auto") return v;
    const m = v.match(/^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/);
    if (!m) return v;
    let day: number, month: number, year: number;
    if (dateFormat === "mdy") { month = +m[1]; day = +m[2]; year = +m[3]; }
    else if (dateFormat === "dmy") { day = +m[1]; month = +m[2]; year = +m[3]; }
    else { year = +m[1]; month = +m[2]; day = +m[3]; }
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return v;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

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
      parsed[0].forEach((h, i) => {
        let key = autoMap(h);
        if (key === "skip") {
          const lh = h.toLowerCase().replace(/\s+/g, "").replace(/_/g, "");
          const cf = customFields.find((f) => f.label.toLowerCase().replace(/\s+/g, "").replace(/_/g, "") === lh);
          if (cf) key = `custom:${cf.id}`;
        }
        am[i] = key;
      });
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
      dateOfBirth: m.dateOfBirth ? convertDate(m.dateOfBirth) : undefined,
      gender: m.gender || undefined,
      streetAddress: m.streetAddress || undefined,
      city: m.city || undefined,
      state: m.state || undefined,
      zipCode: m.zipCode || undefined,
      status: m.status || undefined,
      tags: m.tags || undefined,
      notes: m.notes || undefined,
      guardianName: m.guardianName || undefined,
      guardianEmail: m.guardianEmail || undefined,
      guardianPhone: m.guardianPhone || undefined,
      guardianRelationship: m.guardianRelationship || undefined,
      membershipName: m.membershipName || undefined,
      membershipPrice: m.membershipPrice || undefined,
      billingFrequency: m.billingFrequency || undefined,
      nextBillingDate: m.nextBillingDate ? convertDate(m.nextBillingDate) : undefined,
      membershipStartDate: m.membershipStartDate ? convertDate(m.membershipStartDate) : undefined,
      commitmentEndDate: m.commitmentEndDate ? convertDate(m.commitmentEndDate) : undefined,
      legacyMemberId: m.legacyMemberId || undefined,
      customFieldValues: Object.fromEntries(
        Object.entries(m)
          .filter(([k]) => k.startsWith("custom:"))
          .map(([k, v]) => [k.replace("custom:", ""), v]),
      ),
      // Honor an explicit Minor column when mapped; else infer from guardian info.
      isMinor: m.isMinor
        ? ["yes", "true", "minor", "y", "1", "under18", "under 18"].includes(m.isMinor.toLowerCase())
        : !!(m.guardianName || m.guardianEmail),
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
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto border border-app-border">
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
              <p className="text-xs text-text-muted mb-4">This is your <strong className="text-text-primary">whole roster</strong> — active or not. Only an athlete name is required; everything else is optional and mapped on the next step.</p>
              <div className="text-left max-w-md mx-auto mb-5 rounded-lg border border-app-border bg-app-bg p-3 text-[12px] text-text-muted space-y-1">
                <p className="font-medium text-text-primary">What to include</p>
                <p>• One email and one phone per person is enough.</p>
                <p>• For a minor, use the <strong className="text-text-primary">guardian&apos;s</strong> name + email — a single contact column is treated as the guardian&apos;s automatically.</p>
                <p>• Membership plan, price &amp; billing dates are optional columns — map them here to attach each member&apos;s plan automatically.</p>
              </div>
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
              <div className="mb-4">
                <label className="block text-sm font-medium text-text-primary mb-1">Date format in your file</label>
                <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as typeof dateFormat)}
                  className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
                  <option value="mdy">US — MM/DD/YYYY (e.g. 08/25/2015)</option>
                  <option value="dmy">International — DD/MM/YYYY (e.g. 25/08/2015)</option>
                  <option value="ymd">ISO — YYYY-MM-DD (e.g. 2015-08-25)</option>
                  <option value="auto">Let the system guess</option>
                </select>
                <p className="text-[11px] text-text-muted mt-1">Applies to date of birth, billing, start &amp; commitment dates.</p>
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
                      {mappingFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
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

// ── Membership matching wizard ───────────────────────────────────────────────
// Second-pass import: a CSV that carries membership/billing data and is
// MATCHED to existing members (legacy ID → email → unique full name) instead
// of creating anyone. Built for platforms that export people and billing as
// separate reports, and for clubs importing 1000s of profiles where only the
// active members carry a membership.

const MEMBERSHIP_FIELDS: { key: string; label: string }[] = [
  { key: "legacyMemberId",      label: "Legacy member ID (best match key)" },
  { key: "email",               label: "Email (match key)" },
  { key: "athleteName",         label: "Athlete name (full, match key)" },
  { key: "firstName",           label: "First name (match key)" },
  { key: "lastName",            label: "Last name (match key)" },
  { key: "membershipName",      label: "Membership name" },
  { key: "membershipPrice",     label: "Membership price" },
  { key: "billingFrequency",    label: "Billing frequency" },
  { key: "nextBillingDate",     label: "Next billing date" },
  { key: "membershipStartDate", label: "Membership start date" },
  { key: "commitmentEndDate",   label: "Commitment end date" },
  { key: "skip",                label: "— Don't import —" },
];

function MembershipImportWizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "map" | "done">("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [data, setData] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ updated: number; unmatched: number; failed: number; errors: string[] } | null>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parseCSV(ev.target?.result as string);
      if (parsed.length < 2) { setError("CSV needs a header row and at least one data row."); return; }
      setHeaders(parsed[0]);
      setData(parsed.slice(1));
      const am: Record<number, string> = {};
      parsed[0].forEach((h, i) => {
        const k = autoMap(h);
        am[i] = MEMBERSHIP_FIELDS.some((f) => f.key === k) ? k : "skip";
      });
      setMapping(am);
      setError("");
      setStep("map");
    };
    reader.readAsText(file);
  }

  const mappedKeys = new Set(Object.values(mapping));
  const hasMatchKey = ["legacyMemberId", "email", "athleteName", "firstName", "lastName"].some((k) => mappedKeys.has(k));
  const hasBillingData = ["membershipName", "membershipPrice", "billingFrequency", "nextBillingDate", "membershipStartDate", "commitmentEndDate"].some((k) => mappedKeys.has(k));

  function buildRows() {
    return data.map((row) => {
      const o: Record<string, string> = {};
      headers.forEach((_, i) => {
        const f = mapping[i];
        if (f && f !== "skip") o[f] = (row[i] || "").trim();
      });
      return o;
    }).filter((o) => o.legacyMemberId || o.email || o.athleteName || o.firstName || o.lastName);
  }

  async function doImport() {
    setBusy(true);
    setError("");
    const res = await fetch("/api/members/import/memberships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: buildRows() }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(typeof d.error === "string" ? d.error : "Import failed"); return; }
    setResult(d);
    setStep("done");
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-surface rounded-t-2xl sm:rounded-xl w-full max-w-3xl max-h-[92vh] overflow-y-auto border border-app-border">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface z-10">
          <h2 className="text-lg font-semibold text-text-primary">Match Memberships to Members</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6">
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-4">{error}</div>}

          {step === "upload" && (
            <div className="text-center py-8">
              <p className="text-sm text-text-muted mb-1">Upload a CSV with membership and billing info for members you already imported.</p>
              <p className="text-xs text-text-muted mb-5 max-w-md mx-auto">
                Each row is matched to an existing member by Legacy ID, email, or name — no new members are created.
                Matched members keep billing on their existing date and are never auto-charged.
              </p>
              <button onClick={() => fileRef.current?.click()} className="px-5 py-2.5 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
                Choose CSV file
              </button>
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
            </div>
          )}

          {step === "map" && (
            <div>
              <p className="text-sm text-text-muted mb-2">
                Map your CSV columns. You need at least one <strong>match key</strong> (Legacy ID, email, or name) and one membership field.
              </p>
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {headers.map((h, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-48 text-sm text-text-primary font-medium truncate flex-shrink-0">{h}</div>
                    <div className="text-text-muted text-xs flex-shrink-0">→</div>
                    <select value={mapping[i] || "skip"} onChange={(e) => setMapping({ ...mapping, [i]: e.target.value })} className="flex-1 px-3 py-1.5 border border-app-border rounded-lg text-sm bg-surface">
                      {MEMBERSHIP_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                    <div className="text-xs text-text-muted w-20 truncate flex-shrink-0">{data[0]?.[i] || ""}</div>
                  </div>
                ))}
              </div>
              {!hasMatchKey && (
                <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  Map at least one match key: Legacy member ID, Email, or a name column.
                </div>
              )}
              {hasMatchKey && !hasBillingData && (
                <div className="mt-3 text-sm text-orange-600 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                  Map at least one membership field (name, price, frequency, or a billing date) — otherwise there is nothing to attach.
                </div>
              )}
              <div className="flex gap-2 pt-4">
                <button onClick={() => setStep("upload")} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Back</button>
                <button
                  onClick={doImport}
                  disabled={busy || !hasMatchKey || !hasBillingData}
                  className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
                >
                  {busy ? "Matching…" : `Match ${buildRows().length} rows`}
                </button>
              </div>
            </div>
          )}

          {step === "done" && result && (
            <div>
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="bg-app-bg rounded-lg p-3 text-center">
                  <p className="text-2xl font-semibold text-text-primary">{result.updated}</p>
                  <p className="text-xs text-text-muted">Matched & updated</p>
                </div>
                <div className="bg-app-bg rounded-lg p-3 text-center">
                  <p className="text-2xl font-semibold text-text-primary">{result.unmatched}</p>
                  <p className="text-xs text-text-muted">Unmatched</p>
                </div>
                <div className="bg-app-bg rounded-lg p-3 text-center">
                  <p className="text-2xl font-semibold text-text-primary">{result.failed}</p>
                  <p className="text-xs text-text-muted">Failed</p>
                </div>
              </div>
              {result.errors.length > 0 && (
                <div className="max-h-48 overflow-y-auto text-xs text-text-muted bg-app-bg rounded-lg p-3 space-y-1 mb-4">
                  {result.errors.map((e, i) => <p key={i}>{e}</p>)}
                </div>
              )}
              <p className="text-xs text-text-muted mb-4">
                Matched members now show <strong>payment setup required</strong> and will bill on their imported date once they activate. Unmatched rows: add a Legacy ID or email column and re-run — already-matched members are simply updated again.
              </p>
              <button onClick={onDone} className="w-full px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">Done</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
