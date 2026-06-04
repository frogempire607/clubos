"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import ExportMenu from "@/components/ExportMenu";
import PageHeader from "@/components/PageHeader";
import { SkeletonList } from "@/components/LoadingSkeleton";

// ─── Types ────────────────────────────────────────────────────────────────────

type ClassSession = {
  id: string;
  date: string;
  startsAt: string;
  endsAt: string;
  canceled: boolean;
  recurringClass: { name: string; capacity: number | null };
  _count: { attendance: number };
};

type Event = {
  id: string;
  name: string;
  type: string;
  startsAt: string;
  endsAt: string;
  capacity: number | null;
  location: { name: string } | null;
  _count: { bookings: number };
};

type AttendanceRecord = {
  id: string;
  memberId: string;
  status: string;
  checkedInAt: string | null;
  notes: string | null;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    isMinor: boolean;
    guardianName: string | null;
    status: string;
  };
};

type Member = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  isMinor: boolean;
  guardianName: string | null;
  status: string;
};

const STATUS_CONFIG: Record<string, { label: string; bg: string; fg: string }> = {
  PRESENT: { label: "Present", bg: "var(--color-success)", fg: "#1F1F23" },
  ABSENT: { label: "Absent", fg: "var(--color-muted)", bg: "var(--color-bg)" },
  LATE: { label: "Late", bg: "var(--color-warning)", fg: "#fff" },
  TRIAL: { label: "Trial", bg: "var(--color-primary)", fg: "#fff" },
  DROP_IN: { label: "Drop-In", bg: "var(--color-primary)", fg: "#fff" },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Class sessions store the owner's wall-clock as that clock time in UTC
// (see lib/classSessions.ts / lib/datetime.ts) — render with UTC.
function fmtTime(iso: string) {
  const date = new Date(iso);
  const h = date.getUTCHours();
  const m = date.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

// Events are true instants (datetime-local round-tripped through ISO) —
// render in the viewer's local timezone, NOT UTC.
function fmtTimeLocal(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

function fmtDateHeader(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ─── Pricing types ────────────────────────────────────────────────────────────

type PricingOption =
  | { type: "member" | "nonmember" | "dropin"; price: number }
  | { type: "membership"; membershipId: string };

type AcceptedMembership = { id: string; name: string };

// ─── Quick Add Member Form ────────────────────────────────────────────────────

function QuickAddForm({
  sessionId,
  classId,
  pricingOptions,
  acceptedMemberships,
  onAdded,
}: {
  sessionId: string;
  classId: string | null;
  pricingOptions: PricingOption[];
  acceptedMemberships: AcceptedMembership[];
  onAdded: () => void;
}) {
  const [step, setStep] = useState<"search" | "add-new">("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Member[]>([]);
  const [allMembers, setAllMembers] = useState<Member[]>([]);
  const [saving, setSaving] = useState(false);
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [isMinor, setIsMinor] = useState(false);
  const [guardianName, setGuardianName] = useState("");
  const [error, setError] = useState("");
  const [registeringId, setRegisteringId] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<"CASH" | "COMP" | "INVOICE">("CASH");
  const [payStatus, setPayStatus] = useState<"DROP_IN" | "TRIAL" | "PRESENT">("DROP_IN");
  const [payNotes, setPayNotes] = useState("");

  const memberPrice    = pricingOptions.find((o) => o.type === "member")    as { type: "member"; price: number } | undefined;
  const nonMemberPrice = pricingOptions.find((o) => o.type === "nonmember") as { type: "nonmember"; price: number } | undefined;
  const dropInPrice    = pricingOptions.find((o) => o.type === "dropin")    as { type: "dropin"; price: number } | undefined;
  const acceptsMembership = acceptedMemberships.length > 0;
  const hasAnyPricing = !!(memberPrice || nonMemberPrice || dropInPrice || acceptsMembership);

  async function register(memberId: string, pricingType: "MEMBER" | "NON_MEMBER" | "DROP_IN" | "MEMBERSHIP") {
    if (!classId) return;
    setSaving(true);
    setError("");
    const res = await fetch(`/api/classes/${classId}/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId, classSessionId: sessionId, pricingType }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(data.error?.toString?.() || "Failed to register member");
      return;
    }
    if (data.coveredByMembership) {
      setRegisteringId(null);
      setQuery("");
      setResults([]);
      onAdded();
      return;
    }
    if (data.url) {
      window.open(data.url, "_blank");
      setRegisteringId(null);
      return;
    }
    setError("Unexpected response");
  }

  function openPay(memberId: string) {
    if (payingId === memberId) { setPayingId(null); return; }
    const def = nonMemberPrice?.price ?? dropInPrice?.price ?? memberPrice?.price ?? 0;
    setPayAmount(def ? String(def) : "");
    setPayMethod("CASH");
    setPayStatus("DROP_IN");
    setPayNotes("");
    setError("");
    setRegisteringId(null);
    setPayingId(memberId);
  }

  // Cash / comp / invoice — no Stripe. Records attendance + an internal
  // transaction so it shows in reports under the right channel.
  async function recordPay(memberId: string) {
    if (!sessionId) return;
    setSaving(true);
    setError("");
    const res = await fetch("/api/attendance/charge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classSessionId: sessionId,
        memberId,
        status: payStatus,
        paymentMethod: payMethod,
        amount: payMethod === "COMP" ? Number(payAmount || 0) : Number(payAmount || 0),
        notes: payNotes || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setError(typeof data.error === "string" ? data.error : "Could not record payment"); return; }
    setPayingId(null);
    setQuery("");
    setResults([]);
    onAdded();
  }

  useEffect(() => {
    fetch("/api/members")
      .then((r) => r.json())
      .then((d) => setAllMembers(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const q = query.toLowerCase();
    setResults(
      allMembers
        .filter(
          (m) =>
            `${m.firstName} ${m.lastName}`.toLowerCase().includes(q) ||
            (m.email ?? "").toLowerCase().includes(q)
        )
        .slice(0, 8)
    );
  }, [query, allMembers]);

  async function checkIn(memberId: string, status = "PRESENT") {
    setSaving(true);
    await fetch("/api/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSessionId: sessionId, memberId, status }),
    });
    setSaving(false);
    setQuery("");
    setResults([]);
    onAdded();
  }

  async function createAndCheckIn(e: React.FormEvent) {
    e.preventDefault();
    if (!newFirst || !newLast) { setError("Name is required."); return; }
    setSaving(true);
    setError("");

    const res = await fetch("/api/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: newFirst,
        lastName: newLast,
        phone: newPhone || null,
        isMinor,
        guardianName: isMinor ? guardianName : null,
        status: "PROSPECT",
      }),
    });
    if (!res.ok) {
      setError("Failed to create member.");
      setSaving(false);
      return;
    }
    const member = await res.json();
    await checkIn(member.id, "TRIAL");
    setStep("search");
    setNewFirst(""); setNewLast(""); setNewPhone(""); setIsMinor(false); setGuardianName("");
  }

  if (step === "add-new") {
    return (
      <form onSubmit={createAndCheckIn} className="space-y-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-text-primary">New Member (Quick Add)</span>
          <button type="button" onClick={() => setStep("search")} className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-muted">
            <ArrowLeft className="h-3 w-3" strokeWidth={2} /> Back
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            required
            placeholder="First name"
            value={newFirst}
            onChange={(e) => setNewFirst(e.target.value)}
            className="border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <input
            required
            placeholder="Last name"
            value={newLast}
            onChange={(e) => setNewLast(e.target.value)}
            className="border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        <input
          placeholder="Phone"
          value={newPhone}
          onChange={(e) => setNewPhone(e.target.value)}
          className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
        />
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={isMinor} onChange={(e) => setIsMinor(e.target.checked)} className="rounded" />
          <span className="text-sm text-text-primary">Minor / under 18</span>
        </label>
        {isMinor && (
          <input
            placeholder="Guardian name"
            value={guardianName}
            onChange={(e) => setGuardianName(e.target.value)}
            className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
        )}
        {error && <p className="text-red-600 text-xs">{error}</p>}
        <button
          type="submit"
          disabled={saving}
          className="w-full px-4 py-2 bg-brand text-white text-sm rounded-lg hover:bg-brand-hover disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add as Trial & Check In"}
        </button>
      </form>
    );
  }

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search members to add…"
        className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand mb-2"
      />
      {results.length > 0 && (
        <div className="space-y-1 mb-2">
          {results.map((m) => (
            <div
              key={m.id}
              className="px-3 py-2 rounded-lg hover:bg-app-bg border border-app-border"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-text-primary">
                    {m.firstName} {m.lastName}
                    {m.isMinor && <span className="ml-1.5 text-xs text-brand">(minor)</span>}
                  </div>
                  {m.isMinor && m.guardianName && (
                    <div className="text-xs text-text-muted">Guardian: {m.guardianName}</div>
                  )}
                </div>
                <div className="flex gap-1.5 flex-wrap justify-end">
                  <button
                    disabled={saving}
                    onClick={() => checkIn(m.id, "PRESENT")}
                    className="px-2 py-1 text-xs rounded bg-lime-accent text-text-primary hover:bg-lime-accent"
                  >
                    Present
                  </button>
                  <button
                    disabled={saving}
                    onClick={() => checkIn(m.id, "TRIAL")}
                    className="px-2 py-1 text-xs rounded bg-brand/10 text-brand hover:bg-brand"
                  >
                    Trial
                  </button>
                  {hasAnyPricing && classId && (
                    <button
                      disabled={saving}
                      onClick={() => setRegisteringId(registeringId === m.id ? null : m.id)}
                      className="px-2 py-1 text-xs rounded border border-app-border text-text-primary hover:bg-app-bg"
                    >
                      {registeringId === m.id ? "Cancel" : "Register (card)"}
                    </button>
                  )}
                  {classId && (
                    <button
                      disabled={saving}
                      onClick={() => openPay(m.id)}
                      className="px-2 py-1 text-xs rounded border border-app-border text-text-primary hover:bg-app-bg"
                    >
                      {payingId === m.id ? "Cancel" : "Cash / Comp"}
                    </button>
                  )}
                </div>
              </div>
              {registeringId === m.id && hasAnyPricing && classId && (
                <div className="mt-2 pt-2 border-t border-app-border space-y-1.5">
                  {acceptsMembership && (
                    <button
                      disabled={saving}
                      onClick={() => register(m.id, "MEMBERSHIP")}
                      className="w-full text-left px-2 py-1.5 text-xs rounded border border-brand/40 bg-brand/5 text-text-primary hover:bg-brand/10"
                    >
                      <span className="font-medium">Use accepted membership</span>
                      <span className="block text-[10px] text-text-muted">
                        Free if active on: {acceptedMemberships.map((a) => a.name).join(", ")}
                      </span>
                    </button>
                  )}
                  {memberPrice && (
                    <button
                      disabled={saving}
                      onClick={() => register(m.id, "MEMBER")}
                      className="w-full text-left px-2 py-1.5 text-xs rounded border border-app-border text-text-primary hover:bg-app-bg"
                    >
                      Member · ${memberPrice.price.toFixed(2)}
                    </button>
                  )}
                  {nonMemberPrice && (
                    <button
                      disabled={saving}
                      onClick={() => register(m.id, "NON_MEMBER")}
                      className="w-full text-left px-2 py-1.5 text-xs rounded border border-app-border text-text-primary hover:bg-app-bg"
                    >
                      Non-member · ${nonMemberPrice.price.toFixed(2)}
                    </button>
                  )}
                  {dropInPrice && (
                    <button
                      disabled={saving}
                      onClick={() => register(m.id, "DROP_IN")}
                      className="w-full text-left px-2 py-1.5 text-xs rounded border border-app-border text-text-primary hover:bg-app-bg"
                    >
                      Drop-in · ${dropInPrice.price.toFixed(2)}
                    </button>
                  )}
                  {error && <p className="text-red-600 text-xs">{error}</p>}
                </div>
              )}
              {payingId === m.id && classId && (
                <div className="mt-2 pt-2 border-t border-app-border space-y-2">
                  <div className="grid grid-cols-3 gap-1.5">
                    {(["CASH", "COMP", "INVOICE"] as const).map((pm) => (
                      <button
                        key={pm}
                        type="button"
                        onClick={() => setPayMethod(pm)}
                        className={`px-2 py-1 text-[11px] rounded border ${
                          payMethod === pm ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-muted"
                        }`}
                      >
                        {pm === "CASH" ? "Cash" : pm === "COMP" ? "Comp / Free" : "Invoice"}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <input
                      type="number" min="0" step="0.01"
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                      placeholder={payMethod === "COMP" ? "Value (optional)" : "Amount"}
                      className="border border-app-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand"
                    />
                    <select
                      value={payStatus}
                      onChange={(e) => setPayStatus(e.target.value as "DROP_IN" | "TRIAL" | "PRESENT")}
                      className="border border-app-border rounded-lg px-2 py-1.5 text-xs bg-white"
                    >
                      <option value="DROP_IN">Drop-in</option>
                      <option value="TRIAL">Trial</option>
                      <option value="PRESENT">Present</option>
                    </select>
                  </div>
                  <input
                    value={payNotes}
                    onChange={(e) => setPayNotes(e.target.value)}
                    placeholder="Notes (optional)"
                    className="w-full border border-app-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                  <button
                    disabled={saving}
                    onClick={() => recordPay(m.id)}
                    className="w-full px-2 py-1.5 text-xs rounded bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
                  >
                    {saving
                      ? "Saving…"
                      : payMethod === "COMP"
                        ? "Record comped attendance"
                        : payMethod === "INVOICE"
                          ? "Record as unpaid invoice"
                          : `Record cash payment${payAmount ? ` · $${Number(payAmount).toFixed(2)}` : ""}`}
                  </button>
                  {error && <p className="text-red-600 text-xs">{error}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <button
        onClick={() => setStep("add-new")}
        className="w-full px-3 py-2 border border-dashed border-app-border rounded-lg text-xs text-text-muted hover:border-app-border hover:text-text-primary transition-colors"
      >
        + Add a brand-new member
      </button>
    </div>
  );
}

// ─── Attendance Panel ─────────────────────────────────────────────────────────

function AttendancePanel({
  sessionId,
  sessionName,
  onClose,
}: {
  sessionId: string;
  sessionName: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    session: ClassSession & {
      recurringClass: { id: string; name: string; capacity: number | null };
    };
    attendance: AttendanceRecord[];
    pricingOptions: PricingOption[];
    acceptedMemberships: AcceptedMembership[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/attendance/${sessionId}`);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  async function setStatus(memberId: string, status: string) {
    setUpdating(memberId);
    await fetch("/api/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSessionId: sessionId, memberId, status }),
    });
    setUpdating(null);
    load();
  }

  const attendance = data?.attendance ?? [];
  const filtered = filter
    ? attendance.filter(
        (r) =>
          `${r.member.firstName} ${r.member.lastName}`.toLowerCase().includes(filter.toLowerCase())
      )
    : attendance;

  const counts = Object.keys(STATUS_CONFIG).reduce(
    (acc, k) => ({ ...acc, [k]: attendance.filter((r) => r.status === k).length }),
    {} as Record<string, number>
  );

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="w-[480px] bg-white shadow-2xl flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-app-border flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-text-primary">{sessionName}</h2>
            <button onClick={onClose} className="text-text-muted hover:text-text-muted text-xl leading-none">×</button>
          </div>
          {/* Accepted memberships */}
          {(data?.acceptedMemberships?.length ?? 0) > 0 && (
            <div className="mb-2 text-xs text-text-muted">
              <span className="font-medium text-text-primary">Accepted memberships:</span>{" "}
              {data!.acceptedMemberships.map((m) => m.name).join(", ")}
            </div>
          )}
          {/* Status summary */}
          <div className="flex gap-2 flex-wrap">
            {Object.entries(STATUS_CONFIG).map(([k, v]) => (
              <span
                key={k}
                style={{ background: v.bg, color: v.fg }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
              >
                {v.label}: {counts[k] ?? 0}
              </span>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-text-muted text-center py-12">Loading roster…</p>
          ) : (
            <>
              {/* Search */}
              <div className="px-4 pt-4 pb-2">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter attendees…"
                  className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>

              {/* Attendance list */}
              {filtered.length === 0 && !showAdd ? (
                <div className="text-center py-8 text-text-muted text-sm px-4">
                  {filter ? "No attendees match your filter." : "No one checked in yet. Use the form below to add members."}
                </div>
              ) : (
                <div className="divide-y divide-app-border">
                  {filtered.map((rec) => {
                    const s = STATUS_CONFIG[rec.status] ?? STATUS_CONFIG.PRESENT;
                    return (
                      <div key={rec.id} className="px-4 py-3">
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <div className="text-sm font-medium text-text-primary">
                              {rec.member.firstName} {rec.member.lastName}
                              {rec.member.isMinor && (
                                <span className="ml-1.5 text-xs text-brand">(minor)</span>
                              )}
                            </div>
                            {rec.member.isMinor && rec.member.guardianName && (
                              <div className="text-xs text-text-muted">
                                Guardian: {rec.member.guardianName}
                              </div>
                            )}
                            {rec.checkedInAt && (
                              <div className="text-xs text-text-muted">
                                Checked in {new Date(rec.checkedInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </div>
                            )}
                          </div>
                          <span
                            style={{ background: s.bg, color: s.fg }}
                            className="text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0"
                          >
                            {s.label}
                          </span>
                        </div>
                        {/* Status buttons */}
                        <div className="flex gap-1.5 flex-wrap">
                          {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                            <button
                              key={k}
                              disabled={updating === rec.member.id}
                              onClick={() => setStatus(rec.member.id, k)}
                              style={
                                rec.status === k
                                  ? { background: v.bg, color: v.fg, borderColor: v.fg + "55" }
                                  : {}
                              }
                              className={`px-2.5 py-1 text-xs rounded border transition-all ${
                                rec.status === k
                                  ? "font-medium border-current"
                                  : "border-app-border text-text-muted hover:border-app-border"
                              }`}
                            >
                              {v.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Add member section */}
              <div className="px-4 py-4 border-t border-app-border mt-2">
                {showAdd ? (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-medium text-text-primary uppercase tracking-wide">Add Member</span>
                      <button onClick={() => setShowAdd(false)} className="text-xs text-text-muted hover:text-text-muted">
                        Hide
                      </button>
                    </div>
                    <QuickAddForm
                      sessionId={sessionId}
                      classId={data?.session.recurringClass.id ?? null}
                      pricingOptions={data?.pricingOptions ?? []}
                      acceptedMemberships={data?.acceptedMemberships ?? []}
                      onAdded={() => { load(); }}
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => setShowAdd(true)}
                    className="w-full px-4 py-2.5 border border-app-border rounded-lg text-sm text-text-muted hover:bg-app-bg hover:border-app-border font-medium"
                  >
                    + Add Member to Session
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Schedule Item ────────────────────────────────────────────────────────────

function ScheduleItem({
  label,
  sublabel,
  timeRange,
  checkedIn,
  capacity,
  type,
  onClick,
  active,
}: {
  label: string;
  sublabel?: string;
  timeRange: string;
  checkedIn: number;
  capacity: number | null;
  type: "class" | "event";
  onClick: () => void;
  active: boolean;
}) {
  const pct = capacity ? Math.min(100, Math.round((checkedIn / capacity) * 100)) : null;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3.5 rounded-xl border transition-all ${
        active
          ? "border-brand bg-brand text-white"
          : "border-app-border bg-white hover:border-app-border hover:bg-app-bg"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={`text-sm font-medium truncate ${active ? "text-white" : "text-text-primary"}`}>{label}</div>
          {sublabel && (
            <div className={`text-xs mt-0.5 truncate ${active ? "text-text-muted" : "text-text-muted"}`}>{sublabel}</div>
          )}
          <div className={`text-xs mt-1 ${active ? "text-text-muted" : "text-text-muted"}`}>{timeRange}</div>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className={`text-sm font-semibold ${active ? "text-white" : "text-text-primary"}`}>
            {checkedIn}
            {capacity ? <span className={`font-normal text-xs ml-0.5 ${active ? "text-text-muted" : "text-text-muted"}`}>/{capacity}</span> : ""}
          </div>
          {pct !== null && (
            <div className={`text-xs mt-0.5 ${active ? "text-text-muted" : "text-text-muted"}`}>{pct}%</div>
          )}
          <span
            className={`inline-block mt-1 text-xs px-1.5 py-0.5 rounded ${
              type === "class"
                ? active ? "bg-charcoal-hover text-text-muted" : "bg-brand/10 text-brand"
                : active ? "bg-charcoal-hover text-text-muted" : "bg-app-bg text-text-muted"
            }`}
          >
            {type === "class" ? "Class" : "Event"}
          </span>
        </div>
      </div>
    </button>
  );
}

function QrGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3zM21 14v3M17 21h4M14 21h0" />
    </svg>
  );
}

// ─── Main Page (inner, needs useSearchParams) ─────────────────────────────────

function AttendancePageInner() {
  const searchParams = useSearchParams();
  const initialDate = searchParams.get("date") ?? todayStr();
  const initialSession = searchParams.get("session") ?? null;

  const [date, setDate] = useState(initialDate);
  const [classSessions, setClassSessions] = useState<ClassSession[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSession, setSelectedSession] = useState<{ id: string; name: string } | null>(
    null
  );

  const load = useCallback(async (d: string) => {
    setLoading(true);
    const res = await fetch(`/api/attendance?date=${d}`);
    if (res.ok) {
      const data = await res.json();
      setClassSessions(data.classSessions ?? []);
      setEvents(data.events ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(date); }, [date, load]);

  // Auto-open session from URL param
  useEffect(() => {
    if (initialSession && classSessions.length > 0) {
      const s = classSessions.find((cs) => cs.id === initialSession);
      if (s) setSelectedSession({ id: s.id, name: s.recurringClass.name });
    }
  }, [initialSession, classSessions]);

  const isToday = date === todayStr();
  const totalItems = classSessions.length + events.length;

  return (
    <div className="flex h-full">
      {/* Main content */}
      <div className="flex-1 p-4 sm:p-6 lg:p-8 max-w-2xl">
        <PageHeader
          title="Attendance"
          description="Check in members for today's classes and events"
          actions={<ExportMenu baseUrl="/api/export/attendance" label="Export" />}
        />

        {/* Date navigation */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => setDate(addDays(date, -1))}
            aria-label="Previous day"
            className="p-2 border border-app-border rounded-lg hover:bg-app-bg text-text-muted"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
          </button>
          <div className="flex-1 text-center">
            <div className="font-semibold text-text-primary">{fmtDateHeader(date)}</div>
            {isToday && (
              <div className="text-xs text-lime-accent font-medium">Today</div>
            )}
          </div>
          <button
            onClick={() => setDate(addDays(date, 1))}
            aria-label="Next day"
            className="p-2 border border-app-border rounded-lg hover:bg-app-bg text-text-muted"
          >
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </button>
          {!isToday && (
            <button
              onClick={() => setDate(todayStr())}
              className="px-3 py-1.5 border border-app-border rounded-lg text-sm text-text-muted hover:bg-app-bg"
            >
              Today
            </button>
          )}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border border-app-border rounded-lg px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>

        {/* Session list */}
        {loading ? (
          <div className="text-center py-16 text-text-muted text-sm">Loading schedule…</div>
        ) : totalItems === 0 ? (
          <div className="text-center py-20 border border-dashed border-app-border rounded-xl">
            <div className="text-text-muted text-4xl mb-3">◫</div>
            <p className="text-text-muted font-medium mb-1">No sessions scheduled</p>
            <p className="text-text-muted text-sm">
              {isToday
                ? "No classes or events are scheduled for today."
                : "No classes or events are scheduled for this date."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {classSessions.map((s) => (
              <div key={s.id} className="flex items-stretch gap-2">
                <div className="flex-1 min-w-0">
                  <ScheduleItem
                    label={s.recurringClass.name}
                    timeRange={`${fmtTime(s.startsAt)} – ${fmtTime(s.endsAt)}`}
                    checkedIn={s._count.attendance}
                    capacity={s.recurringClass.capacity}
                    type="class"
                    active={selectedSession?.id === s.id}
                    onClick={() =>
                      setSelectedSession(
                        selectedSession?.id === s.id
                          ? null
                          : { id: s.id, name: s.recurringClass.name }
                      )
                    }
                  />
                </div>
                <button
                  type="button"
                  title="Open sign-in / QR kiosk"
                  onClick={() => window.open(`/kiosk/${s.id}`, "_blank")}
                  className="flex-shrink-0 px-3 rounded-xl border border-app-border bg-white hover:bg-app-bg text-text-muted hover:text-text-primary flex items-center justify-center"
                  aria-label="Open QR kiosk"
                >
                  <QrGlyph />
                </button>
              </div>
            ))}
            {events.map((ev) => (
              <div key={ev.id} className="flex items-stretch gap-2">
                <div className="flex-1 min-w-0">
                  <ScheduleItem
                    label={ev.name}
                    sublabel={ev.location?.name}
                    timeRange={`${fmtTimeLocal(ev.startsAt)} – ${fmtTimeLocal(ev.endsAt)}`}
                    checkedIn={ev._count.bookings}
                    capacity={ev.capacity}
                    type="event"
                    active={false}
                    onClick={() => {
                      window.location.href = `/dashboard/events?event=${ev.id}`;
                    }}
                  />
                </div>
                <button
                  type="button"
                  title="Open sign-in / QR kiosk"
                  onClick={() => window.open(`/kiosk/${ev.id}`, "_blank")}
                  className="flex-shrink-0 px-3 rounded-xl border border-app-border bg-white hover:bg-app-bg text-text-muted hover:text-text-primary flex items-center justify-center"
                  aria-label="Open QR kiosk"
                >
                  <QrGlyph />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Hint */}
        {totalItems > 0 && (
          <p className="text-xs text-text-muted text-center mt-4">
            Click a class session to open the attendance roster →
          </p>
        )}
      </div>

      {/* Attendance panel slide-over */}
      {selectedSession && (
        <AttendancePanel
          sessionId={selectedSession.id}
          sessionName={selectedSession.name}
          onClose={() => setSelectedSession(null)}
        />
      )}
    </div>
  );
}

// ─── Export (wrapped in Suspense for useSearchParams) ─────────────────────────

export default function AttendancePage() {
  return (
    <Suspense
      fallback={
        <div className="p-4 sm:p-6 lg:p-8 max-w-2xl">
          <div className="bg-white rounded-xl border border-app-border">
            <SkeletonList rows={4} />
          </div>
        </div>
      }
    >
      <AttendancePageInner />
    </Suspense>
  );
}
