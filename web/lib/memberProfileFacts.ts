// B6 — pure helpers behind the member profile's Overview cards and the phone
// fact grid. No Prisma, no React: the GET route and the page both import this,
// and scripts/member-profile-b6-tests.ts pins the behaviour.

// ─────────────────────────────────────────────────────────────────────────────
// Recent activity (§1c left column)
// ─────────────────────────────────────────────────────────────────────────────

export type ActivityKind = "attendance" | "payment" | "subscription" | "invitation" | "document";
export type ActivityTone = "ok" | "warn" | "danger" | "muted" | "brand";

export type ActivityItem = {
  /** Unique across kinds — prefix with the kind so two tables can't collide. */
  id: string;
  kind: ActivityKind;
  /** One line, already worded for staff. */
  text: string;
  /** ISO timestamp of when it HAPPENED. */
  at: string;
  tone: ActivityTone;
};

export const RECENT_ACTIVITY_LIMIT = 8;

/**
 * Merge per-source lists (each already bounded) into one newest-first list.
 * Drops rows with an unparseable date rather than sorting them to an arbitrary
 * end, de-duplicates by id, and breaks ties by id so the order is stable
 * between two loads of the same data.
 */
export function mergeRecentActivity(lists: ReadonlyArray<ReadonlyArray<ActivityItem>>, limit = RECENT_ACTIVITY_LIMIT): ActivityItem[] {
  const seen = new Set<string>();
  const all: { item: ActivityItem; t: number }[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.id)) continue;
      const t = Date.parse(item.at);
      if (!Number.isFinite(t)) continue;
      seen.add(item.id);
      all.push({ item, t });
    }
  }
  all.sort((a, b) => b.t - a.t || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  return all.slice(0, Math.max(0, limit)).map((x) => x.item);
}

function money(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  return (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Attendance statuses that mean the person was in the room. */
export const PRESENT_STATUSES = ["PRESENT", "LATE", "TRIAL", "DROP_IN"] as const;

export function attendanceActivityText(status: string, className: string | null): { text: string; tone: ActivityTone } {
  const where = className || "a session";
  if (status === "ABSENT") return { text: `Marked absent · ${where}`, tone: "muted" };
  if (status === "TRIAL") return { text: `Trial class · ${where}`, tone: "brand" };
  if (status === "DROP_IN") return { text: `Dropped in · ${where}`, tone: "ok" };
  if (status === "LATE") return { text: `Checked in late · ${where}`, tone: "ok" };
  return { text: `Checked in · ${where}`, tone: "ok" };
}

export function transactionActivityText(t: {
  status: string;
  type?: string | null;
  amount: number | string;
  description?: string | null;
}): { text: string; tone: ActivityTone } {
  const what = t.description?.trim() ? ` · ${t.description.trim()}` : "";
  const amt = money(Math.abs(Number(t.amount)));
  switch (t.status) {
    case "SUCCEEDED":
      return t.type === "REFUND"
        ? { text: `Refunded ${amt}${what}`, tone: "muted" }
        : { text: `Paid ${amt}${what}`, tone: "ok" };
    case "PENDING":
      return { text: `${amt} due${what}`, tone: "warn" };
    case "FAILED":
      return { text: `Payment failed · ${amt}${what}`, tone: "danger" };
    case "REFUNDED":
      return { text: `Refunded ${amt}${what}`, tone: "muted" };
    default:
      return { text: `${amt}${what}`, tone: "muted" };
  }
}

const SUB_KIND_WORDS: Record<string, string> = {
  CREATED: "Membership created",
  ACTIVATED: "Membership started",
  PAUSED: "Membership paused",
  RESUMED: "Membership resumed",
  CANCELED: "Membership canceled",
  EXPIRED: "Membership ended",
  PLAN_CHANGED: "Plan changed",
  REACTIVATED: "Membership reactivated",
};

export function subscriptionActivityText(e: { kind: string; fromPlan?: string | null; toPlan?: string | null }): {
  text: string;
  tone: ActivityTone;
} {
  const base = SUB_KIND_WORDS[e.kind] ?? `Membership ${e.kind.toLowerCase().replace(/_/g, " ")}`;
  let detail = "";
  if (e.kind === "PLAN_CHANGED" && (e.fromPlan || e.toPlan)) detail = ` · ${e.fromPlan ?? "—"} → ${e.toPlan ?? "—"}`;
  else if (e.toPlan) detail = ` · ${e.toPlan}`;
  else if (e.fromPlan) detail = ` · ${e.fromPlan}`;
  const tone: ActivityTone =
    e.kind === "CANCELED" || e.kind === "EXPIRED" ? "danger" : e.kind === "PAUSED" ? "warn" : "brand";
  return { text: base + detail, tone };
}

export function invitationActivityText(d: {
  sentToEmail: string;
  recipientKind?: string | null;
  bouncedAt?: string | Date | null;
  openedAt?: string | Date | null;
}): { text: string; tone: ActivityTone } {
  const who = d.recipientKind === "GUARDIAN" ? ` (guardian)` : "";
  if (d.bouncedAt) return { text: `Invitation bounced · ${d.sentToEmail}${who}`, tone: "danger" };
  if (d.openedAt) return { text: `Invitation sent and opened · ${d.sentToEmail}${who}`, tone: "brand" };
  return { text: `Invitation sent · ${d.sentToEmail}${who}`, tone: "brand" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Relative dates
// ─────────────────────────────────────────────────────────────────────────────

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday", "4 days ago", "3 wk ago", then a calendar date. */
export function relativeDay(iso: string | Date | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (!Number.isFinite(d.getTime())) return "—";
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days < 0) return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 28) return `${Math.floor(days / 7)} wk ago`;
  return d.toLocaleDateString(
    "en-US",
    d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Attendance (3 figures)
// ─────────────────────────────────────────────────────────────────────────────

/** The two window starts the Attendance card counts from. */
export function attendanceWindows(now: Date = new Date()): { monthStart: Date; since30: Date } {
  return {
    monthStart: new Date(now.getFullYear(), now.getMonth(), 1),
    since30: new Date(now.getTime() - 30 * 86_400_000),
  };
}

export type AttendanceFigures = {
  thisMonth: number;
  last30: number;
  allTime: number;
  lastAttendedAt: string | null;
};

/**
 * Figures from a list of attendance rows. The GET route counts in the database
 * (the list it ships is capped); this is the same rule for the capped list, used
 * when the server figures are absent. Absences never count as attendance.
 */
export function attendanceFigures(
  rows: ReadonlyArray<{ status: string; at: string | Date }>,
  now: Date = new Date(),
): AttendanceFigures {
  const { monthStart, since30 } = attendanceWindows(now);
  let thisMonth = 0;
  let last30 = 0;
  let allTime = 0;
  let last: number | null = null;
  for (const r of rows) {
    if (!(PRESENT_STATUSES as readonly string[]).includes(r.status)) continue;
    const t = (typeof r.at === "string" ? new Date(r.at) : r.at).getTime();
    if (!Number.isFinite(t) || t > now.getTime()) continue;
    allTime++;
    if (t >= monthStart.getTime()) thisMonth++;
    if (t >= since30.getTime()) last30++;
    if (last == null || t > last) last = t;
  }
  return { thisMonth, last30, allTime, lastAttendedAt: last == null ? null : new Date(last).toISOString() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phone 2×2 fact grid (§1j)
// ─────────────────────────────────────────────────────────────────────────────

export type Fact = { label: string; value: string; tone: ActivityTone };

export function deriveFactGrid(
  input: {
    balanceOwed: number | null | undefined;
    requiredDocs: number;
    missingDocs: number;
    lastAttendedAt: string | null | undefined;
    migrationStatus: string | null | undefined;
    meter?: { applicable: boolean; step: number; total: number } | null;
  },
  now: Date = new Date(),
): Fact[] {
  const owed = Number(input.balanceOwed ?? 0);
  const balance: Fact =
    owed > 0
      ? { label: "Balance", value: `${money(owed)} owed`, tone: "danger" }
      : { label: "Balance", value: "Nothing owed", tone: "ok" };

  const waiver: Fact =
    input.missingDocs > 0
      ? { label: "Waiver", value: `${input.missingDocs} missing`, tone: "danger" }
      : input.requiredDocs > 0
        ? { label: "Waiver", value: "Signed", tone: "ok" }
        : { label: "Waiver", value: "None required", tone: "muted" };

  const lastSeen: Fact = input.lastAttendedAt
    ? { label: "Last seen", value: relativeDay(input.lastAttendedAt, now), tone: "muted" }
    : { label: "Last seen", value: "Never", tone: "muted" };

  let migration: Fact;
  if (!input.migrationStatus) migration = { label: "Migration", value: "Not imported", tone: "muted" };
  else if (input.migrationStatus === "COMPLETED" || (input.meter?.applicable && input.meter.step >= input.meter.total))
    migration = { label: "Migration", value: "Complete", tone: "ok" };
  else if (input.meter?.applicable)
    migration = { label: "Migration", value: `Step ${input.meter.step} of ${input.meter.total}`, tone: "warn" };
  else migration = { label: "Migration", value: titleCase(input.migrationStatus), tone: "warn" };

  return [balance, waiver, lastSeen, migration];
}

function titleCase(s: string): string {
  const w = s.replace(/_/g, " ").toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Staff notes attribution (§1c "Staff notes — staff-only, attributed")
// ─────────────────────────────────────────────────────────────────────────────
//
// Member.notes is one text column, and a schema change is out of scope. So each
// note added from the profile is stamped with a trailing line
//     — Julian R, Sep 26, 2026
// and prepended (newest first). The server stamps it from the SESSION, never
// from a name the client sends. Text written before this existed has no stamp
// and renders as one unattributed entry at the end.

const STAMP_RE = /^— (.+), ([A-Z][a-z]{2} \d{1,2}, \d{4})$/gm;

/** "Julian Ramirez" → "Julian R". A single name stays as typed. */
export function staffShortName(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Staff";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}`;
}

export function noteStamp(staffName: string | null | undefined, now: Date = new Date()): string {
  const date = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  // A name containing ", Mmm d, yyyy" would confuse the parser; commas in a
  // person's name are not worth keeping for that risk.
  return `— ${staffShortName(staffName).replace(/,/g, "")}, ${date}`;
}

/** Prepend an attributed entry. Blank text leaves the notes untouched. */
export function appendAttributedNote(
  existing: string | null | undefined,
  text: string,
  staffName: string | null | undefined,
  now: Date = new Date(),
): string {
  const body = text.replace(/\r\n/g, "\n").trim();
  const prev = (existing ?? "").trim();
  if (!body) return prev;
  const entry = `${body}\n${noteStamp(staffName, now)}`;
  return prev ? `${entry}\n\n${prev}` : entry;
}

export type NoteEntry = { text: string; by: string | null; on: string | null };

export function parseAttributedNotes(notes: string | null | undefined): NoteEntry[] {
  const src = (notes ?? "").replace(/\r\n/g, "\n");
  if (!src.trim()) return [];
  const out: NoteEntry[] = [];
  let cursor = 0;
  STAMP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STAMP_RE.exec(src)) !== null) {
    const text = src.slice(cursor, m.index).trim();
    if (text) out.push({ text, by: m[1], on: m[2] });
    cursor = m.index + m[0].length;
  }
  const tail = src.slice(cursor).trim();
  if (tail) out.push({ text: tail, by: null, on: null });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payments tab → Reports P&L for the transaction's month
// ─────────────────────────────────────────────────────────────────────────────

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** /dashboard/reports P&L scoped to the calendar month containing `iso`. */
export function pnlMonthHref(iso: string | Date): string | null {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (!Number.isFinite(d.getTime())) return null;
  const from = new Date(d.getFullYear(), d.getMonth(), 1);
  const to = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `/dashboard/reports?tab=pnl&range=custom&from=${ymd(from)}&to=${ymd(to)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration progress card — which recorded event evidences which step
// ─────────────────────────────────────────────────────────────────────────────
//
// Same mapping the 4.5.8 drawer uses, plus step 2: the triage route writes a
// NOTE "Information reviewed by <staff>" when someone marks a member reviewed.

export type MigrationEventLike = { type: string; message: string | null; createdAt: string; actor: string | null };

const STEP_EVIDENCE_TYPES: Record<number, string[]> = {
  1: ["IMPORTED"],
  3: ["ACTIVATION_SENT", "REMINDER_SENT", "REGISTRATION_LINK_SENT"],
  5: ["ACTIVATED"],
  7: ["COMPLETED"],
};

/** The most recent event that evidences step `index` (1-based), or null. */
export function migrationStepEvidence(
  events: ReadonlyArray<MigrationEventLike>,
  index: number,
): { at: string; actor: string | null } | null {
  let best: MigrationEventLike | null = null;
  for (const e of events) {
    const hit =
      (STEP_EVIDENCE_TYPES[index] ?? []).includes(e.type) ||
      (index === 2 && e.type === "NOTE" && /^Information reviewed\b/.test(e.message ?? ""));
    if (!hit) continue;
    if (!best || Date.parse(e.createdAt) > Date.parse(best.createdAt)) best = e;
  }
  return best ? { at: best.createdAt, actor: best.actor } : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Family & access — account-holder role chips ("Pays · Books · Signs")
// ─────────────────────────────────────────────────────────────────────────────

export function accountHolderRoles(g: { canPay: boolean; canBook: boolean; canSignWaivers: boolean }): string[] {
  return [g.canPay ? "Pays" : null, g.canBook ? "Books" : null, g.canSignWaivers ? "Signs" : null].filter(
    (x): x is string => !!x,
  );
}
