"use client";

// ONE class on ONE day — the ONE editor for a class day (Branch 1 stage 3;
// Branch 3 made it the only one: time and note, coaches and roles, the three
// "which class days" scopes, call-outs and coverage, cancelling, and — for
// people with Financials — what each coach is paid for that day. There is no
// separate "Edit" and "Change coaches" any more: tap the class, edit here.
// Fed by GET /api/classes/[id]/staffing?date=; every action is one request to
// the stage-2 API and the server decides who may do what (`viewer`):
//   schedule manager  change coaches (three scopes → Review → Save), find a
//                     substitute, close a call-out, no-show, call out for a coach
//   coach, own row    "I can't make this class" (the class stays on) / undo
//   classes:edit      cancel the class day (reason, who is told, coach pay) /
//                     bring it back
// Opened from the staff Schedule, the staff profile, the Calendar and the
// Classes page, so a class day is changed the same way everywhere.
// Words live in lib/classStaffUi.ts. Times display 12-hour.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Sheet from "@/components/Sheet";
import { range12h, to12h } from "@/lib/time12";
import { fmtCents } from "@/lib/payLedger";
import { SUBSTITUTE_ROLE_NAME, fmtDayLong, type CancelAudience, type ChangeScope, type RichStaffRow } from "@/lib/classStaff";
import type { StaffingView } from "@/lib/classStaffApi";
import {
  OTHER_ROLE,
  ROLE_CHOICES,
  audienceOptions,
  cancelAuditParts,
  cancelConfirmLabel,
  coverageNotifySentence,
  families,
  fmtInstant,
  isLateNow,
  joinAnd,
  roleChoiceOf,
  rowState,
  scopeOptions,
  seedForScope,
  type AudienceCounts,
  type StateTone,
} from "@/lib/classStaffUi";

export type StaffOption = { id: string; name: string };

const btn =
  "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px] disabled:opacity-50";
const ghost = `${btn} border border-app-border text-text-primary hover:bg-app-bg`;
const primary = `${btn} bg-brand text-white hover:bg-brand-hover`;
const small =
  "inline-flex min-h-[44px] items-center justify-center rounded-lg border border-app-border px-3 text-[13px] text-text-primary hover:bg-app-bg md:min-h-[32px] disabled:opacity-50";
const field =
  "w-full min-h-[44px] rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary md:min-h-[36px]";
const radioRow = "flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border border-app-border px-3 py-2";

const TONE: Record<StateTone, React.CSSProperties> = {
  normal: { background: "var(--color-chip-surface)", color: "var(--color-chip-text)" },
  warn: { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" },
  late: { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" },
  covered: { background: "var(--color-pending-surface)", color: "var(--color-pending-text)" },
  noshow: { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" },
  canceled: { background: "var(--color-chip-surface)", color: "var(--color-chip-text)" },
};
const dangerBox = { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" };
const warnBox = { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" };
const okBox = { background: "var(--color-success-surface)", color: "var(--color-success-text)" };

type Pick = { userId: string; choice: string; other: string };
const roleOfPick = (p: { choice: string; other: string }): string | null =>
  p.choice === OTHER_ROLE ? p.other.trim() || null : p.choice || null;
const pickOf = (userId: string, roleName: string | null): Pick => {
  const choice = roleChoiceOf(roleName);
  return { userId, choice, other: choice === OTHER_ROLE ? roleName ?? "" : "" };
};

type Preview = {
  changed: boolean;
  plan: { heading: string; lines: string[] };
  summary: string[];
  needsAcknowledge: boolean;
};
type CancelPreview = { counts: AudienceCounts; defaultAudience: CancelAudience; canSetPaid: boolean };

/** One coach's pay for this class day (GET /api/classes/sessions/[id]/pay). */
type PayRow = {
  staffRowId: string; userId: string; name: string; roleLabel: string; kind: string; status: string;
  planCents: number | null; planName: string | null; planNote: string | null;
  overrideCents: number | null; overrideReason: string | null; overrideByName: string | null; overrideAt: string | null;
  matchRegular: { name: string; cents: number } | null;
  locked: boolean; lockedWhy: string | null; payable: boolean; canEdit: boolean;
  history: { at: string; byName: string; action: "set" | "cleared"; cents: number | null; reason: string | null }[];
};
type DayPay = { onLedger: boolean; ledgerStart: string | null; rows: PayRow[] };
type DetailScope = "occurrence" | "following" | "series";
const DETAIL_SCOPES: { value: DetailScope; label: string; hint: string }[] = [
  { value: "occurrence", label: "Just this day", hint: "Only this one date" },
  { value: "following", label: "This day and after", hint: "This date and every later class day" },
  { value: "series", label: "Every week", hint: "The class itself — future class days move to the new time" },
];

type Mode =
  | { k: "main" }
  | { k: "details" }
  | { k: "pay"; row: PayRow }
  | { k: "edit" }
  | { k: "review"; preview: Preview }
  | { k: "fill"; row: RichStaffRow }
  | { k: "close"; row: RichStaffRow }
  | { k: "noshow"; row: RichStaffRow }
  | { k: "calloutFor"; row: RichStaffRow }
  | { k: "calloutSelf" }
  | { k: "cancel" }
  | { k: "uncancel" };

type Answer = { ok: boolean; status: number; data: Record<string, unknown> };
async function send(url: string, body?: unknown, method: "POST" | "PATCH" | "PUT" = "POST"): Promise<Answer> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "Couldn't reach the server. Check your connection and try again." } };
  }
}
const errorText = (a: Answer, fallback: string) => (typeof a.data.error === "string" ? a.data.error : fallback);
const firstName = (name: string) => name.split(" ")[0] || name;

export default function ClassDaySheet({
  classId,
  date,
  onClose,
  onChanged,
  staffOptions,
  start,
  addUserId,
}: {
  classId: string;
  /** YYYY-MM-DD */
  date: string;
  onClose: () => void;
  /** Something was saved — the opener refreshes its own list. The sheet stays open. */
  onChanged?: (message: string) => void;
  /** Who can be picked as a coach. Loaded here when the opener has no list. */
  staffOptions?: StaffOption[];
  /** "edit" = go straight to the coach editor (schedule managers). */
  start?: "edit";
  /** With start "edit": this person is ticked in the editor to begin with. */
  addUserId?: string;
}) {
  const [view, setView] = useState<StaffingView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ k: "main" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async (): Promise<StaffingView | null> => {
    try {
      const res = await fetch(`/api/classes/${classId}/staffing?date=${date}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoadError(typeof data?.error === "string" ? data.error : "Couldn't load this class day.");
        return null;
      }
      setLoadError(null);
      setView(data as StaffingView);
      return data as StaffingView;
    } catch {
      setLoadError("Couldn't reach the server. Check your connection and try again.");
      return null;
    }
  }, [classId, date]);

  // ── who can be picked ─────────────────────────────────────────────────────
  const [fetchedStaff, setFetchedStaff] = useState<StaffOption[] | null>(null);
  const canManage = !!view?.viewer.canManage;
  const needStaff = canManage && !staffOptions;
  useEffect(() => {
    if (!needStaff) return;
    let live = true;
    fetch("/api/settings/schedule", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d?.options?.staff) setFetchedStaff(d.options.staff as StaffOption[]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [needStaff]);
  const options: StaffOption[] = useMemo(() => {
    const base = [...(staffOptions ?? fetchedStaff ?? [])];
    // Anyone already on the day stays pickable even if the list doesn't have them.
    for (const r of view?.day.rows ?? []) if (!base.some((o) => o.id === r.userId)) base.push({ id: r.userId, name: r.name });
    for (const r of view?.rules ?? []) if (!base.some((o) => o.id === r.userId)) base.push({ id: r.userId, name: r.name });
    return base;
  }, [staffOptions, fetchedStaff, view]);

  // ── coach editor ──────────────────────────────────────────────────────────
  const [scope, setScope] = useState<ChangeScope>("OCCURRENCE");
  const [picks, setPicks] = useState<Pick[]>([]);
  const [ack, setAck] = useState(false);

  const seed = useCallback(
    (v: StaffingView, sc: ChangeScope): Pick[] =>
      seedForScope({ scope: sc, date, classDays: v.class.daysOfWeek, rules: v.rules, dayRows: v.day.rows }).map((p) => pickOf(p.userId, p.roleName)),
    [date],
  );
  function openEditor(v: StaffingView, add?: string) {
    const first = seed(v, "OCCURRENCE");
    const withAdd = add && !first.some((p) => p.userId === add) ? [...first, pickOf(add, null)] : first;
    setScope("OCCURRENCE");
    setPicks(withAdd);
    setAck(false);
    setError(null);
    setNote(null);
    setMode({ k: "edit" });
  }
  function chooseScope(sc: ChangeScope) {
    if (sc === scope) return;
    setScope(sc);
    if (!view) return;
    // Show who is on it for THAT choice, with only what the manager changed
    // carried over (people ticked, unticked, or given another role). The old
    // choice's whole list is not carried: a one-day substitute must not become
    // a weekly coach just because the scope was switched, and saving without
    // touching anything changes nothing at any scope.
    const from = seed(view, scope);
    const to = seed(view, sc);
    const was = new Map(from.map((p) => [p.userId, p]));
    const unticked = new Set(from.filter((p) => !picks.some((x) => x.userId === p.userId)).map((p) => p.userId));
    const next = to
      .filter((p) => !unticked.has(p.userId))
      .map((p) => {
        const cur = picks.find((x) => x.userId === p.userId);
        const old = was.get(p.userId);
        const roleChanged = cur && (old ? cur.choice !== old.choice || cur.other !== old.other : cur.choice !== "");
        return cur && roleChanged ? { ...p, choice: cur.choice, other: cur.other } : p;
      });
    for (const p of picks) if (!was.has(p.userId) && !next.some((x) => x.userId === p.userId)) next.push(p);
    setPicks(next);
  }
  function togglePick(userId: string) {
    setPicks((cur) => (cur.some((p) => p.userId === userId) ? cur.filter((p) => p.userId !== userId) : [...cur, pickOf(userId, null)]));
  }
  function patchPick(userId: string, patch: Partial<Pick>) {
    setPicks((cur) => cur.map((p) => (p.userId === userId ? { ...p, ...patch } : p)));
  }
  const staffingBody = (acknowledge: boolean) => ({
    scope,
    date,
    staff: picks.map((p) => ({ userId: p.userId, roleName: roleOfPick(p) })),
    ...(acknowledge ? { acknowledgeConflicts: true } : {}),
  });

  // First load; `start: "edit"` opens the editor once the day is known.
  const started = useRef(false);
  useEffect(() => {
    let live = true;
    load().then((v) => {
      if (!live || !v || started.current) return;
      started.current = true;
      if (start === "edit" && v.viewer.canManage && v.day.switched && !v.day.canceled) openEditor(v, addUserId);
    });
    return () => {
      live = false;
    };
    // openEditor only reads its arguments; start/addUserId are fixed for the life of the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // ── substitute / call-out / cancel forms ──────────────────────────────────
  const [subId, setSubId] = useState("");
  const [subRole, setSubRole] = useState<{ choice: string; other: string }>({ choice: SUBSTITUTE_ROLE_NAME, other: "" });
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [reason, setReason] = useState("");
  const [audience, setAudience] = useState<CancelAudience>("BOOKED");
  const [paid, setPaid] = useState(false);
  const [cancelInfo, setCancelInfo] = useState<CancelPreview | null>(null);

  // ── time & note ───────────────────────────────────────────────────────────
  const [dScope, setDScope] = useState<DetailScope>("occurrence");
  const [dStart, setDStart] = useState("");
  const [dEnd, setDEnd] = useState("");
  const [dNote, setDNote] = useState("");

  // ── pay for this day (Financials only) ────────────────────────────────────
  const [pay, setPay] = useState<DayPay | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payReason, setPayReason] = useState("");
  const [showHistory, setShowHistory] = useState<string | null>(null);
  const paySessionId = view?.viewer.canSeePay ? view.day.sessionId : null;
  const loadPay = useCallback(async () => {
    if (!paySessionId) {
      setPay(null);
      return;
    }
    try {
      const res = await fetch(`/api/classes/sessions/${paySessionId}/pay`, { cache: "no-store" });
      setPay(res.ok ? ((await res.json()) as DayPay) : null);
    } catch {
      setPay(null);
    }
  }, [paySessionId]);
  useEffect(() => {
    loadPay();
  }, [loadPay, view]);

  function go(next: Mode) {
    setError(null);
    setNote(null);
    setConflicts(null);
    setAck(false);
    setReason("");
    setMode(next);
  }
  /** After a successful write: say so, tell the opener, re-read the day. */
  async function done(message: string) {
    setNote(message);
    setMode({ k: "main" });
    onChanged?.(message);
    await load();
  }
  /** One request; a failure shows the server's own words. true = it worked. */
  async function act(run: () => Promise<Answer>, fallback: string): Promise<Answer | null> {
    setBusy(true);
    setError(null);
    const a = await run();
    setBusy(false);
    if (a.ok) return a;
    if (a.status === 409 && a.data.code === "STAFF_CONFLICT") {
      setConflicts(Array.isArray(a.data.summary) ? (a.data.summary as string[]) : []);
      setAck(false);
      return null;
    }
    setError(errorText(a, fallback));
    return null;
  }

  const day = view?.day ?? null;
  const viewer = view?.viewer ?? null;
  const sessionId = day?.sessionId ?? null;
  const className = view?.class.name ?? "Class day";
  const when = day ? `${fmtDayLong(date)} · ${range12h(day.startTime, day.endTime)}` : fmtDayLong(date);
  const liveDay = !!day && day.switched && day.exists && !day.canceled;
  // "When" lines (called out at, canceled at) read on the CLUB's clock, like the class times next to them.
  const clubTz = view?.class.timezone ?? undefined;

  function openDetails() {
    if (!day) return;
    setDScope("occurrence");
    setDStart(day.startTime);
    setDEnd(day.endTime);
    setDNote(day.note ?? "");
    go({ k: "details" });
  }
  async function saveDetails() {
    if (!day) return;
    if (!dStart || !dEnd) return setError("Choose a start and an end time.");
    if (dEnd <= dStart) return setError("The end time has to be after the start time.");
    const body: Record<string, unknown> = { date, scope: dScope };
    if (dStart !== day.startTime) body.startTime = dStart;
    if (dEnd !== day.endTime) body.endTime = dEnd;
    if (dScope !== "series") body.note = dNote.trim() ? dNote.trim() : null;
    const a = await act(() => send(`/api/classes/${classId}/occurrence`, body), "Couldn't save the time or note.");
    if (a) await done(`${className} updated — saved.`);
  }
  function openPay(row: PayRow) {
    setPayAmount(row.overrideCents !== null ? (row.overrideCents / 100).toFixed(2) : "");
    setPayReason(row.overrideCents !== null ? row.overrideReason ?? "" : "");
    go({ k: "pay", row });
  }
  async function savePay(row: PayRow, clear: boolean) {
    let amount: number | null = null;
    if (!clear) {
      const t = payAmount.trim().replace(/[$,]/g, "");
      if (t === "" || !/^\d*(\.\d{0,2})?$/.test(t) || t === ".") return setError("Enter the amount to pay for this class day.");
      amount = Number(t);
      if (!payReason.trim()) return setError("Say why this class day is paid differently.");
    }
    const a = await act(
      () => send(`/api/classes/session-staff/${row.staffRowId}/pay-override`, { amount, reason: clear ? null : payReason.trim() }, "PUT"),
      "Couldn't save the pay for this class day.",
    );
    if (!a) return;
    await done(clear ? `${row.name} is back on their pay plan for this class day — saved.` : `${row.name} is paid ${fmtCents(Math.round((amount ?? 0) * 100))} for this class day — saved.`);
  }

  async function review() {
    const a = await act(() => send(`/api/classes/${classId}/staffing/preview`, staffingBody(false)), "Couldn't check that change.");
    if (!a) return;
    setAck(false);
    setConflicts(null);
    setMode({ k: "review", preview: a.data as unknown as Preview });
  }
  async function saveCoaches() {
    const a = await act(() => send(`/api/classes/${classId}/staffing`, staffingBody(ack)), "Couldn't save the coaches.");
    if (a) await done(`Coaches updated for ${className} — saved.`);
  }
  async function fill(row: RichStaffRow) {
    if (!row.id || !subId) return;
    const a = await act(
      () => send(`/api/classes/session-staff/${row.id}/fill`, { substituteUserId: subId, roleName: roleOfPick(subRole), ...(ack ? { acknowledgeConflicts: true } : {}) }),
      "Couldn't assign the substitute.",
    );
    if (a) await done(`${options.find((o) => o.id === subId)?.name ?? "The substitute"} now covers for ${row.name} — saved. Both have been told.`);
  }
  async function rowAction(row: RichStaffRow, path: string, body: unknown, message: string, fallback: string) {
    if (!row.id) return;
    const a = await act(() => send(`/api/classes/session-staff/${row.id}/${path}`, body), fallback);
    if (a) await done(message);
  }
  async function callOut(forRow: RichStaffRow | null) {
    if (!sessionId) return;
    const a = await act(
      () => send(`/api/classes/sessions/${sessionId}/call-out`, { reason: reason.trim() || null, ...(forRow ? { userId: forRow.userId } : {}) }),
      "Couldn't record the call-out.",
    );
    if (!a) return;
    const late = a.data.late === true ? " It is marked as a late call-out." : "";
    await done(forRow ? `${forRow.name} is called out of ${className} — it now needs coverage.${late}` : `You're called out of ${className}. It now needs coverage.${late}`);
  }
  async function openCancel() {
    if (!sessionId || !view) return;
    go({ k: "cancel" });
    setCancelInfo(null);
    setPaid(false);
    setAudience((view.defaults.classCancelNotifyDefault as CancelAudience) ?? "BOOKED");
    try {
      const res = await fetch(`/api/classes/sessions/${sessionId}/cancel-preview`, { cache: "no-store" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof d?.error === "string" ? d.error : "Couldn't count who would be told.");
        return;
      }
      setCancelInfo({ counts: d.counts, defaultAudience: d.defaultAudience, canSetPaid: !!d.canSetPaid });
      setAudience(d.defaultAudience as CancelAudience);
    } catch {
      setError("Couldn't count who would be told.");
    }
  }
  async function cancelDay() {
    if (!sessionId) return;
    const a = await act(
      () => send(`/api/classes/sessions/${sessionId}/cancel`, { reason: reason.trim(), notifyAudience: audience, ...(paid ? { paid: true } : {}) }),
      "Couldn't cancel this class day.",
    );
    if (!a) return;
    const n = typeof a.data.notifiedCount === "number" ? a.data.notifiedCount : 0;
    await done(`${className} is canceled for ${fmtDayLong(date)}. ${n > 0 ? `${families(n)} emailed.` : "Nobody was emailed."}`);
  }
  async function uncancel() {
    if (!sessionId) return;
    const a = await act(() => send(`/api/classes/sessions/${sessionId}/uncancel`), "Couldn't bring this class back.");
    if (a) await done(`${className} is back on for ${fmtDayLong(date)}. Families were not emailed again.`);
  }
  async function setCancelPay(next: boolean) {
    if (!sessionId) return;
    const a = await act(() => send(`/api/classes/sessions/${sessionId}/cancel-pay`, { paid: next }, "PATCH"), "Couldn't change the pay choice.");
    if (a) await done(next ? "Coaches will be paid for this canceled class day — saved." : "Coaches will not be paid for this canceled class day — saved.");
  }

  // ── pieces ────────────────────────────────────────────────────────────────
  const errorBox = error && (
    <p role="alert" className="mt-3 rounded-lg px-3 py-2 text-[13px]" style={dangerBox}>
      {error}
    </p>
  );
  const conflictBox = (conflicts ?? (mode.k === "review" ? mode.preview.summary : null)) as string[] | null;
  const needsAck = !!conflictBox && conflictBox.length > 0;
  const conflictBlock = needsAck && (
    <div className="mt-3 rounded-lg px-3 py-2.5 text-[13px]" style={warnBox}>
      <p className="font-medium">Check before you assign</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {conflictBox!.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      <label className="mt-2 flex min-h-[44px] cursor-pointer items-center gap-2 font-medium">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        Assign anyway
      </label>
    </div>
  );
  const roleSelect = (value: { choice: string; other: string }, onChange: (patch: { choice?: string; other?: string }) => void, label: string) => (
    <div className="flex flex-wrap gap-2">
      <select aria-label={label} value={value.choice} onChange={(e) => onChange({ choice: e.target.value })} className={`${field} sm:w-auto sm:min-w-[220px]`}>
        {ROLE_CHOICES.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      {value.choice === OTHER_ROLE && (
        <input
          aria-label={`${label} — type the role`}
          value={value.other}
          onChange={(e) => onChange({ other: e.target.value })}
          maxLength={60}
          placeholder="Type the role"
          className={`${field} sm:w-auto sm:flex-1`}
        />
      )}
    </div>
  );

  let title = className;
  let body: React.ReactNode = null;
  let footer: React.ReactNode = (
    <button type="button" onClick={onClose} className={ghost}>
      Close
    </button>
  );
  const back = (
    <button type="button" onClick={() => go({ k: "main" })} disabled={busy} className={ghost}>
      Back
    </button>
  );

  if (!view || !day || !viewer) {
    body = loadError ? (
      <div>
        <p role="alert" className="rounded-lg px-3 py-2 text-[13px]" style={dangerBox}>
          {loadError}
        </p>
        <button type="button" onClick={() => load()} className={`${ghost} mt-3`}>
          Try again
        </button>
      </div>
    ) : (
      <p className="py-6 text-center text-[13px] text-text-muted">Loading this class day…</p>
    );
  } else if (mode.k === "main") {
    const rows = day.rows.map((r) => ({ r, st: rowState(r) })).filter((x): x is { r: RichStaffRow; st: NonNullable<ReturnType<typeof rowState>> } => !!x.st);
    const canEditCoaches = viewer.canManage && day.switched && !day.canceled && (day.exists || day.runsOnThisDay);
    // Days before the new scheduling started are shown as recorded — nothing to edit here.
    const canEditDetails = day.switched && (viewer.canManage && !day.canceled && (day.exists || day.runsOnThisDay));
    const payRows = pay?.rows ?? [];
    body = (
      <div className="space-y-4">
        {note && (
          <p role="status" className="rounded-lg px-3 py-2 text-[13px]" style={okBox}>
            {note}
          </p>
        )}
        {loadError && (
          <p role="alert" className="rounded-lg px-3 py-2 text-[13px]" style={dangerBox}>
            {loadError}
          </p>
        )}
        {!view.switchedOn ? (
          <p className="rounded-lg border border-app-border px-3 py-2 text-[13px] text-text-muted">New coach scheduling is off for this club — shown as recorded.</p>
        ) : !day.switched ? (
          <p className="rounded-lg border border-app-border px-3 py-2 text-[13px] text-text-muted">Before the new scheduling started — shown as recorded then.</p>
        ) : !day.exists ? (
          <p className="rounded-lg border border-app-border px-3 py-2 text-[13px] text-text-muted">
            {day.runsOnThisDay
              ? "This class day isn't generated yet. Class days are created automatically each night for the weeks ahead."
              : "This class doesn't run on this day."}
          </p>
        ) : null}

        {day.canceled && day.cancel && (
          <div className="rounded-lg px-3 py-2.5 text-[13px]" style={dangerBox}>
            <p className="font-medium">This class day is canceled</p>
            <p className="mt-1">{cancelAuditParts(day.cancel, clubTz).join(" · ")}</p>
            {day.switched && (viewer.canCancel || viewer.canSetCancelPay) && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {viewer.canSetCancelPay && (
                  <div role="group" aria-label="Coach pay for this day" className="inline-flex overflow-hidden rounded-lg border border-app-border bg-surface">
                    {[false, true].map((v) => (
                      <button
                        key={String(v)}
                        type="button"
                        disabled={busy || day.cancel!.paid === v}
                        aria-pressed={day.cancel!.paid === v}
                        onClick={() => setCancelPay(v)}
                        className={`min-h-[44px] px-3 text-[13px] md:min-h-[32px] ${day.cancel!.paid === v ? "bg-brand font-medium text-white" : "text-text-primary hover:bg-app-bg"}`}
                      >
                        {v ? "Coaches paid" : "Coaches not paid"}
                      </button>
                    ))}
                  </div>
                )}
                {viewer.canCancel && (
                  <button type="button" disabled={busy} onClick={() => go({ k: "uncancel" })} className={`${small} bg-surface`}>
                    Bring this class back
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <section aria-label="When" className="rounded-lg border border-app-border px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">When</p>
              <p className="text-[14px] text-text-primary">{fmtDayLong(date)} · {range12h(day.startTime, day.endTime)}</p>
              {day.note && <p className="mt-0.5 text-[13px] text-text-muted">Note for this day: {day.note}</p>}
            </div>
            {canEditDetails && (
              <button type="button" disabled={busy} onClick={openDetails} className={small}>
                {day.note ? "Change time or note" : "Change time or add a note"}
              </button>
            )}
          </div>
        </section>

        <section aria-label="Coaches">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Coaches</p>
            {canEditCoaches && (
              <button type="button" disabled={busy} onClick={() => openEditor(view)} className={small}>
                Change coaches
              </button>
            )}
          </div>
          {rows.length === 0 ? (
            <p className="text-[13px] text-text-muted">Nobody is assigned to this class day.</p>
          ) : (
            <ul className="divide-y divide-app-border rounded-lg border border-app-border">
              {rows.map(({ r, st }) => {
                const manage = viewer.canManage && liveDay && !!r.id;
                const mineRow = r.userId === viewer.userId;
                return (
                  <li key={r.id ?? r.userId} className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-[14px] font-medium text-text-primary">{r.name}</span>
                      <span className="rounded-full px-2 py-0.5 text-xs" style={TONE.normal}>
                        {r.roleLabel}
                      </span>
                      <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={TONE[st.tone]}>
                        {st.label}
                      </span>
                    </div>
                    {r.calledOutAt && r.status !== "SCHEDULED" && (
                      <p className="mt-1 text-xs text-text-muted">
                        Called out {fmtInstant(r.calledOutAt, clubTz)}
                        {r.calledOutByName && r.calledOutByUserId !== r.userId ? ` (recorded by ${r.calledOutByName})` : ""}
                        {r.calloutReason ? ` — “${r.calloutReason}”` : ""}
                      </p>
                    )}
                    {manage && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {r.status === "NEEDS_COVERAGE" && (
                          <>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setSubId("");
                                setSubRole({ choice: SUBSTITUTE_ROLE_NAME, other: "" });
                                go({ k: "fill", row: r });
                              }}
                              className={`${small} border-transparent bg-brand font-medium text-white hover:bg-brand-hover`}
                            >
                              Find a substitute
                            </button>
                            <button type="button" disabled={busy} onClick={() => go({ k: "close", row: r })} className={small}>
                              No replacement needed
                            </button>
                            {!mineRow && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => rowAction(r, "undo-call-out", {}, `${r.name} is back on ${className} — saved.`, "Couldn't undo the call-out.")}
                                className={small}
                              >
                                Undo call-out
                              </button>
                            )}
                          </>
                        )}
                        {r.status === "SCHEDULED" && !day.hasEnded && !mineRow && (
                          <button type="button" disabled={busy} onClick={() => go({ k: "calloutFor", row: r })} className={small}>
                            Record a call-out for them
                          </button>
                        )}
                        {r.status === "SCHEDULED" && day.hasStarted && (
                          <button type="button" disabled={busy} onClick={() => go({ k: "noshow", row: r })} className={small}>
                            Mark no-show
                          </button>
                        )}
                        {r.status === "NO_SHOW" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => rowAction(r, "clear-no-show", {}, `${r.name} is no longer marked as a no-show — saved.`, "Couldn't undo the no-show.")}
                            className={small}
                          >
                            Undo no-show
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {(viewer.canCallOut || viewer.canUndoCallOut) && (
          <section aria-label="Your class" className="rounded-lg border border-app-border px-3 py-2.5">
            {viewer.canCallOut ? (
              <>
                <p className="text-[13px] text-text-muted">You are coaching this class day.</p>
                <button type="button" disabled={busy} onClick={() => go({ k: "calloutSelf" })} className={`${ghost} mt-2`}>
                  I can&apos;t make this class
                </button>
              </>
            ) : (
              <>
                <p className="text-[13px] font-medium" style={{ color: "var(--color-warn-text)" }}>
                  Needs coverage — waiting for a schedule manager
                </p>
                <p className="mt-0.5 text-[13px] text-text-muted">You called out of this class day. Until someone covers it you can change your mind.</p>
                {viewer.myRowId && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      const a = await act(() => send(`/api/classes/session-staff/${viewer.myRowId}/undo-call-out`), "Couldn't undo your call-out.");
                      if (a) await done(`You're back on ${className} — saved.`);
                    }}
                    className={`${ghost} mt-2`}
                  >
                    Undo, I can make it
                  </button>
                )}
              </>
            )}
          </section>
        )}

        {pay && payRows.length > 0 && (
          <section aria-label="Pay for this day">
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">Pay for this day</p>
            {!pay.onLedger ? (
              <p className="rounded-lg border border-app-border px-3 py-2 text-[13px] text-text-muted">
                {pay.ledgerStart ? `This class day is before the pay ledger started (${pay.ledgerStart}), so it is not paid from here.` : "The pay ledger has not been started for this club."}
              </p>
            ) : (
              <ul className="divide-y divide-app-border rounded-lg border border-app-border">
                {payRows.map((r) => {
                  const over = r.overrideCents !== null;
                  return (
                    <li key={r.staffRowId} className="px-3 py-2.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <span className="text-[14px] font-medium text-text-primary">{r.name} <span className="font-normal text-text-muted">· {r.roleLabel}</span></span>
                        <span className="text-[14px] font-semibold text-text-primary">
                          {!r.payable ? "Not paid" : over ? fmtCents(r.overrideCents) : r.planCents !== null ? fmtCents(r.planCents) : "Needs review"}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[13px] text-text-muted">
                        {!r.payable
                          ? "Not coaching this class day."
                          : over
                            ? `Set for this day${r.overrideByName ? ` by ${r.overrideByName}` : ""}${r.overrideAt ? `, ${fmtInstant(r.overrideAt, clubTz)}` : ""}${r.overrideReason ? ` — “${r.overrideReason}”` : ""}. ${r.planCents !== null ? `Their plan would pay ${fmtCents(r.planCents)}.` : "No pay plan covers it."}`
                            : r.planCents !== null
                              ? `${r.planNote ?? `From their pay plan “${r.planName}”`}.`
                              : `${r.planNote}. Set the pay for this day, or add a pay plan.`}
                        {r.locked ? ` ${r.lockedWhy} — locked.` : ""}
                      </p>
                      {(r.canEdit || r.history.length > 0) && (
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          {r.canEdit && (
                            <button type="button" disabled={busy} onClick={() => openPay(r)} className={small}>
                              {over ? "Change pay for this day" : "Set pay for this day"}
                            </button>
                          )}
                          {r.canEdit && over && (
                            <button type="button" disabled={busy} onClick={() => savePay(r, true)} className={small}>
                              Back to their plan
                            </button>
                          )}
                          {r.history.length > 0 && (
                            <button type="button" onClick={() => setShowHistory(showHistory === r.staffRowId ? null : r.staffRowId)} className={small} aria-expanded={showHistory === r.staffRowId}>
                              {showHistory === r.staffRowId ? "Hide history" : `History (${r.history.length})`}
                            </button>
                          )}
                        </div>
                      )}
                      {showHistory === r.staffRowId && (
                        <ul className="mt-1.5 space-y-0.5 text-xs text-text-muted">
                          {r.history.map((h, i) => (
                            <li key={i}>
                              {fmtInstant(h.at, clubTz)} · {h.byName} {h.action === "set" ? `set it to ${fmtCents(h.cents)}` : "put it back to the plan"}
                              {h.reason ? ` — “${h.reason}”` : ""}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-1 text-xs text-text-muted">A class day is paid once it has ended. Setting the pay here changes this one day only — no pay plan is changed.</p>
          </section>
        )}

        {viewer.canCancel && liveDay && (
          <section aria-label="Cancel" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-app-border px-3 py-2.5">
            <p className="text-[13px] text-text-muted">Not running this day?</p>
            <button type="button" disabled={busy} onClick={openCancel} className={ghost}>
              Cancel this class day
            </button>
          </section>
        )}
        {errorBox}
      </div>
    );
  } else if (mode.k === "details") {
    title = `Time and note — ${className}`;
    body = (
      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">Which class days?</legend>
          {(day.hasEnded ? DETAIL_SCOPES.slice(0, 1) : DETAIL_SCOPES).map((sc) => (
            <label key={sc.value} className={radioRow}>
              <input type="radio" name="detail-scope" className="mt-1" checked={dScope === sc.value} onChange={() => setDScope(sc.value)} />
              <span>
                <span className="block text-[14px] text-text-primary">{sc.label}</span>
                <span className="block text-xs text-text-muted">{sc.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label htmlFor="detail-start" className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-muted">Start</label>
            <input id="detail-start" type="time" value={dStart} onChange={(e) => setDStart(e.target.value)} className={field} />
            <p className="mt-0.5 text-xs text-text-muted">{dStart ? to12h(dStart) : ""}</p>
          </div>
          <div>
            <label htmlFor="detail-end" className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-muted">End</label>
            <input id="detail-end" type="time" value={dEnd} onChange={(e) => setDEnd(e.target.value)} className={field} />
            <p className="mt-0.5 text-xs text-text-muted">{dEnd ? to12h(dEnd) : ""}</p>
          </div>
        </div>
        {dScope !== "series" ? (
          <div>
            <label htmlFor="detail-note" className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-muted">Note for this day</label>
            <textarea id="detail-note" value={dNote} onChange={(e) => setDNote(e.target.value)} rows={2} maxLength={2000}
              className="w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary" placeholder="e.g. Use the back room today" />
          </div>
        ) : (
          <p className="text-xs text-text-muted">Changes the class itself. Future class days move to the new time; bookings and one-day changes are kept.</p>
        )}
        <p className="text-xs text-text-muted">Coaches, cancelling and pay are changed from the previous screen.</p>
        {errorBox}
      </div>
    );
    footer = (
      <>
        {back}
        <button type="button" onClick={saveDetails} disabled={busy} className={primary}>
          {busy ? "Saving…" : "Save"}
        </button>
      </>
    );
  } else if (mode.k === "pay") {
    const row = mode.row;
    title = `Pay for this day — ${firstName(row.name)}`;
    body = (
      <div className="space-y-4">
        <p className="text-[13px] text-text-primary">
          What {row.name} is paid for {className} on {fmtDayLong(date)} only. Their pay plan is not changed.
        </p>
        <p className="rounded-lg border border-app-border px-3 py-2 text-[13px] text-text-muted">
          {row.planCents !== null ? `Their plan${row.planName ? ` “${row.planName}”` : ""} would pay ${fmtCents(row.planCents)}${row.planNote ? ` (${row.planNote.toLowerCase()})` : ""}.` : `${row.planNote}.`}
        </p>
        <div>
          <label htmlFor="pay-amount" className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-muted">Pay for this day</label>
          <div className="relative max-w-[220px]">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[14px] text-text-muted">$</span>
            <input id="pay-amount" type="text" inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="0.00" className={`${field} pl-7`} />
          </div>
        </div>
        {row.matchRegular && (
          <button
            type="button"
            className={ghost}
            onClick={() => {
              setPayAmount((row.matchRegular!.cents / 100).toFixed(2));
              if (!payReason.trim()) setPayReason(`Paid ${row.matchRegular!.name}'s rate for covering`);
            }}
          >
            Match {row.matchRegular.name}&apos;s rate ({fmtCents(row.matchRegular.cents)})
          </button>
        )}
        <div>
          <label htmlFor="pay-reason" className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-muted">Why</label>
          <input id="pay-reason" value={payReason} onChange={(e) => setPayReason(e.target.value)} maxLength={500} placeholder="e.g. Ran the class alone" className={field} />
          <p className="mt-1 text-xs text-text-muted">Saved with your name and the time.</p>
        </div>
        {errorBox}
      </div>
    );
    footer = (
      <>
        {back}
        <button type="button" onClick={() => savePay(row, false)} disabled={busy} className={primary}>
          {busy ? "Saving…" : "Set pay for this day"}
        </button>
      </>
    );
  } else if (mode.k === "edit") {
    title = `Change coaches — ${className}`;
    const scopes = day.hasEnded ? scopeOptions(date).slice(0, 1) : scopeOptions(date);
    // "Every class day" makes every day the same list. Coaches who are on only
    // some weekdays start unticked there — say so before Review, by name.
    const someDaysOnly =
      scope === "ALL_FUTURE"
        ? Array.from(
            new Map(
              view.rules
                .filter((r) => (r.effectiveTo === null || r.effectiveTo >= date) && !picks.some((p) => p.userId === r.userId))
                .map((r) => [r.userId, r.name]),
            ).values(),
          )
        : [];
    body = (
      <div className="space-y-4">
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">Who coaches</legend>
          {options.length === 0 ? (
            <p className="text-[13px] text-text-muted">Loading staff…</p>
          ) : (
            <ul className="divide-y divide-app-border rounded-lg border border-app-border">
              {options.map((o) => {
                const p = picks.find((x) => x.userId === o.id);
                return (
                  <li key={o.id} className="px-3 py-1.5">
                    <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-[14px] text-text-primary">
                      <input type="checkbox" checked={!!p} onChange={() => togglePick(o.id)} />
                      {o.name}
                    </label>
                    {p && <div className="pb-2 pl-7">{roleSelect(p, (patch) => patchPick(o.id, patch), `Role for ${o.name}`)}</div>}
                  </li>
                );
              })}
            </ul>
          )}
          {picks.length === 0 && options.length > 0 && <p className="mt-1.5 text-xs text-text-muted">Nobody ticked — the class would have no coach.</p>}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">Which class days?</legend>
          {scopes.map((s) => (
            <label key={s.value} className={radioRow}>
              <input type="radio" name="coach-scope" className="mt-1" checked={scope === s.value} onChange={() => chooseScope(s.value)} />
              <span>
                <span className="block text-[14px] text-text-primary">{s.label}</span>
                <span className="block text-xs text-text-muted">{s.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {someDaysOnly.length > 0 && (
          <p role="note" className="rounded-lg px-3 py-2 text-[13px]" style={warnBox}>
            {joinAnd(someDaysOnly)} {someDaysOnly.length === 1 ? "is" : "are"} on this class only some days and {someDaysOnly.length === 1 ? "is" : "are"} not ticked.
            “Every class day” gives every day the same coaches, so anyone left unticked comes off all of them. To change one weekday only, choose “{scopes[1]?.label}”.
          </p>
        )}
        {errorBox}
      </div>
    );
    footer = (
      <>
        {back}
        <button type="button" onClick={review} disabled={busy} className={primary}>
          {busy ? "Checking…" : "Review"}
        </button>
      </>
    );
  } else if (mode.k === "review") {
    title = `Review — ${className}`;
    const p = mode.preview;
    body = (
      <div>
        <p className="text-[14px] font-medium text-text-primary">{p.plan.heading}</p>
        {p.changed ? (
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-text-primary">
            {p.plan.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-[13px] text-text-muted">Nothing would change — these are the coaches already on it.</p>
        )}
        {p.changed && conflictBlock}
        {p.changed && <p className="mt-3 text-xs text-text-muted">The coaches added or taken off are told in the app when you save.</p>}
        {errorBox}
      </div>
    );
    footer = (
      <>
        <button type="button" onClick={() => { setError(null); setConflicts(null); setMode({ k: "edit" }); }} disabled={busy} className={ghost}>
          Back
        </button>
        <button type="button" onClick={saveCoaches} disabled={busy || !p.changed || (needsAck && !ack)} className={primary}>
          {busy ? "Saving…" : "Save"}
        </button>
      </>
    );
  } else if (mode.k === "fill") {
    const row = mode.row;
    title = `Find a substitute for ${firstName(row.name)}`;
    const onDay = new Set(day.rows.filter((r) => r.status === "SCHEDULED" || r.userId === row.userId).map((r) => r.userId));
    const subs = options.filter((o) => !onDay.has(o.id));
    body = (
      <div className="space-y-3">
        <p className="text-[13px] text-text-muted">
          {row.name} stays on record as called out. The substitute gets their own spot on this class day, and both are told.
        </p>
        <div>
          <label htmlFor="sub-pick" className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-muted">Substitute</label>
          <select id="sub-pick" value={subId} onChange={(e) => { setSubId(e.target.value); setConflicts(null); setAck(false); }} className={field}>
            <option value="">Choose a staff member…</option>
            {subs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-muted">Role for this day</p>
          {roleSelect(subRole, (patch) => setSubRole((cur) => ({ ...cur, ...patch })), "Role for the substitute")}
        </div>
        {conflictBlock}
        {errorBox}
      </div>
    );
    footer = (
      <>
        {back}
        <button type="button" onClick={() => fill(row)} disabled={busy || !subId || (needsAck && !ack)} className={primary}>
          {busy ? "Saving…" : "Assign substitute"}
        </button>
      </>
    );
  } else if (mode.k === "close") {
    const row = mode.row;
    title = "No replacement needed?";
    body = (
      <div>
        <p className="text-[13px] text-text-primary">
          {row.name} comes off this class day and nobody replaces them. The class runs with the coaches who are left, and {firstName(row.name)} is not paid for it.
        </p>
        {errorBox}
      </div>
    );
    footer = (
      <>
        {back}
        <button
          type="button"
          disabled={busy}
          onClick={() => rowAction(row, "close", {}, `${className} runs without a replacement for ${row.name} — saved.`, "Couldn't close the coverage request.")}
          className={primary}
        >
          {busy ? "Saving…" : "No replacement needed"}
        </button>
      </>
    );
  } else if (mode.k === "noshow") {
    const row = mode.row;
    title = `Mark ${firstName(row.name)} as a no-show?`;
    body = (
      <div>
        <p className="text-[13px] text-text-primary">
          {row.name} is recorded as not turning up for this class day and is not paid for it. They are told in the app. You can undo this.
        </p>
        {errorBox}
      </div>
    );
    footer = (
      <>
        {back}
        <button
          type="button"
          disabled={busy}
          onClick={() => rowAction(row, "no-show", {}, `${row.name} is marked as a no-show — saved.`, "Couldn't mark the no-show.")}
          className={primary}
        >
          {busy ? "Saving…" : "Mark no-show"}
        </button>
      </>
    );
  } else if (mode.k === "calloutSelf" || mode.k === "calloutFor") {
    const forRow = mode.k === "calloutFor" ? mode.row : null;
    const late = isLateNow(day.startsAt, Date.now());
    title = forRow ? `Record a call-out for ${firstName(forRow.name)}` : "I can't make this class";
    body = (
      <div className="space-y-3">
        <p className="text-[13px] text-text-primary">{coverageNotifySentence(view.defaults.coverageNotify)}</p>
        {late && (
          <p className="rounded-lg px-3 py-2 text-[13px] font-medium" style={dangerBox}>
            This will be marked as a late call-out — the class starts in under 2 hours.
          </p>
        )}
        <div>
          <label htmlFor="callout-reason" className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-muted">Reason (optional)</label>
          <textarea id="callout-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500}
            className="w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary" placeholder="e.g. Sick today" />
        </div>
        <p className="text-xs text-text-muted">Only a schedule manager can put someone else on. {forRow ? "They" : "You"} can be put back while nobody has covered it.</p>
        {errorBox}
      </div>
    );
    footer = (
      <>
        {back}
        <button type="button" disabled={busy} onClick={() => callOut(forRow)} className={primary}>
          {busy ? "Saving…" : forRow ? "Record call-out" : "Call out of this class"}
        </button>
      </>
    );
  } else if (mode.k === "cancel") {
    title = `Cancel ${className}?`;
    const opts = audienceOptions(cancelInfo?.counts);
    body = (
      <div className="space-y-4">
        <p className="text-[13px] text-text-primary">
          Only {fmtDayLong(date)} is canceled. It comes off the member schedule, and the coaches on it are told in the app.
        </p>
        <div>
          <label htmlFor="cancel-reason" className="mb-1 block text-xs font-medium uppercase tracking-wide text-text-muted">Reason</label>
          <textarea id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={1000}
            className="w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary" placeholder="e.g. Gym closed for the holiday" />
          <p className="mt-1 text-xs text-text-muted">Included in the email to families.</p>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">Who should be told?</legend>
          {!cancelInfo && !error && <p className="text-xs text-text-muted">Counting…</p>}
          {opts.map((o) => (
            <label key={o.value} className={radioRow}>
              <input type="radio" name="cancel-audience" className="mt-1" checked={audience === o.value} onChange={() => setAudience(o.value)} />
              <span>
                <span className="block text-[14px] text-text-primary">{o.label}</span>
                <span className="block text-xs text-text-muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {cancelInfo?.canSetPaid && (
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-muted">Coach pay for this day</legend>
            {[false, true].map((v) => (
              <label key={String(v)} className={radioRow}>
                <input type="radio" name="cancel-pay" className="mt-1" checked={paid === v} onChange={() => setPaid(v)} />
                <span>
                  <span className="block text-[14px] text-text-primary">{v ? "Paid anyway" : "Not paid (default)"}</span>
                  <span className="block text-xs text-text-muted">
                    {v ? "The coaches on this day are still paid for it." : "A canceled class day is not paid."}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {errorBox}
      </div>
    );
    footer = (
      <>
        <button type="button" onClick={() => go({ k: "main" })} disabled={busy} className={ghost}>
          Keep the class
        </button>
        <button type="button" disabled={busy || !reason.trim() || !cancelInfo} onClick={cancelDay} className={`${btn} bg-red-600 text-white hover:bg-red-700`}>
          {busy ? "Canceling…" : cancelConfirmLabel(audience, cancelInfo?.counts)}
        </button>
      </>
    );
  } else if (mode.k === "uncancel") {
    title = `Bring ${className} back?`;
    const told = day.cancel?.notifiedCount ?? 0;
    body = (
      <div>
        <p className="text-[13px] text-text-primary">
          {fmtDayLong(date)} goes back on the schedule and the coaches are told in the app. Families are not emailed again automatically
          {told > 0 ? ` — ${families(told)} ${told === 1 ? "was" : "were"} told it was canceled, so let them know it is back on.` : "."}
        </p>
        {day.cancel?.paid && <p className="mt-2 text-[13px] text-text-muted">The “coaches paid” choice no longer applies once the class is back on.</p>}
        {errorBox}
      </div>
    );
    footer = (
      <>
        {back}
        <button type="button" disabled={busy} onClick={uncancel} className={primary}>
          {busy ? "Saving…" : "Bring this class back"}
        </button>
      </>
    );
  }

  return (
    <Sheet open onClose={() => !busy && onClose()} title={title} description={when} footer={footer} width={520}>
      {body}
    </Sheet>
  );
}
