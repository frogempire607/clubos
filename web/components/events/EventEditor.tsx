"use client";

// Event editor — B11 slice 2b. Replaces EventModal (the 1,350-line form that
// lived inside app/dashboard/events/page.tsx).
//
// Shape follows docs/improvement/design_handoff_event_editor/README.md:
//   phone   → full-height sheet, seven collapsible cards, each header a DERIVED
//             one-line summary of what is inside, fixed footer
//   desktop → the same cards in a 1fr / 316px grid with a live "What a family
//             sees" preview and a conflict panel on the right
//
// Everything stated twice is derived, not typed: one date range feeds the
// subtitle, the Schedule summary and the preview; one price set feeds the Money
// summary, the preview and the pay line. lib/eventPricingModel is the single
// source for the money words (FREE / FIXED / SPLIT), the exclusion rules and
// the bundle-sanity sentence, so the editor can never disagree with the API.
//
// What it posts is the SAME payload EventModal posted, plus the slice-2 fields
// (pricingModel, signupAccess, splitInvoiceWhen, sellIndividualSessions,
// sessions[].price, sessions[].id). The API writes both vocabularies.

import AutoDiscountsEditor, { autoDiscountsLine } from "@/components/events/AutoDiscountsEditor";
import { parseAutoDiscounts, type AutoDiscounts } from "@/lib/eventAutoDiscounts";
import { useEffect, useMemo, useState } from "react";
import ImageUpload from "@/components/ImageUpload";
import EventImageFocalPicker from "@/components/events/EventImageFocalPicker";
import PublicLinkBox from "@/components/events/PublicLinkBox";
import { validateRosterDef, rostersNamedInLabel } from "@/lib/eventRoster";
import { ESCALATION_SCHEDULE_DAYS, type EscalationSchedule } from "@/lib/eventPayments";
import {
  PARTICIPANT_FIELD_ID,
  categoryFieldsFromForm,
  fieldIdForKey,
} from "@/lib/eventCategories";
import {
  applyExclusions,
  bundleSanity,
  moneySummary,
  type PaymentMethod,
  type PricingModel,
  type SignupAccess,
  type SplitInvoiceWhen,
} from "@/lib/eventPricingModel";

// ── Types the page passes in (mirrors page.tsx; kept structural on purpose) ──

export type EditorBuiltInType = "CLASS" | "PRIVATE" | "CLINIC" | "CAMP" | "TOURNAMENT" | "OTHER";

export type EditorFormField = {
  id: string;
  label: string;
  type: "text" | "email" | "phone" | "textarea" | "select" | "checkbox";
  required: boolean;
  options?: string[];
  /** B16 slice 3 — asked again for each entry. */
  perEntry?: boolean;
};

export type EditorEventType = {
  id: string;
  name: string;
  defaultPolicy?: {
    requiresCoachApproval?: boolean;
    approvalPaymentIntent?: string;
    allowProposedChanges?: boolean;
    cancellationPolicyText?: string;
    categoryFields?: { key: string; label: string; options?: string[]; required?: boolean }[];
  } | null;
};

export type EditorSession = {
  id?: string;
  name: string | null;
  startsAt: string;
  endsAt: string;
  sortOrder: number;
  price?: number | string | null;
};

export type EditorEvent = {
  id: string;
  type: EditorBuiltInType;
  customEventTypeId: string | null;
  name: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number | null;
  memberPrice: number | null;
  nonMemberPrice: number | null;
  dropInFee: number | null;
  travelFee: number | null;
  publishAt: string | null;
  unpublishAt: string | null;
  visibility: string;
  purchaseAccess: string;
  pricingOptions?: { type: "membership"; membershipId: string }[] | null;
  sessions: EditorSession[];
  staffAssignments?: { user: { id: string; firstName: string; lastName: string } }[];
  _count?: { bookings: number; registrations?: number };
  imageUrl?: string | null;
  imagePositionX?: number;
  imagePositionY?: number;
  tournamentMode?: string | null;
  publicSlug?: string | null;
  publicRegistration?: boolean;
  publicFormIntro?: string | null;
  publicPricingOption?: string | null;
  registrationForm?: unknown;
  variableCostEnabled?: boolean;
  variableCostMode?: string | null;
  variableCostTotal?: number | string | null;
  variableCostEstimatedSignups?: number | null;
  variableCostEstimatedTotal?: number | string | null;
  invoiceScheduledAt?: string | null;
  paymentMethods?: string[] | null;
  autoChargeDate?: string | null;
  requirePaymentBeforeCheckin?: boolean;
  requiresCoachApproval?: boolean | null;
  approvalPaymentIntent?: string | null;
  allowProposedChanges?: boolean | null;
  responsibleCoachUserId?: string | null;
  holdSpotDuringReview?: boolean;
  allowMultipleEntries?: boolean;
  maxEntries?: number | null;
  additionalEntryPrice?: number | string | null;
  allowSameRosterTwice?: boolean;
  entriesOnPublicLink?: boolean;
  autoDiscounts?: unknown;
  cancellationPolicyText?: string | null;
  paymentDueBy?: string | null;
  escalationEnabled?: boolean | null;
  escalationAnchor?: string | null;
  escalationSchedule?: string | null;
  escalationCustomDays?: unknown;
  // slice 2
  pricingModel?: string | null;
  signupAccess?: string | null;
  splitInvoiceWhen?: string | null;
  sellIndividualSessions?: boolean | null;
};

export type EditorMembership = { id: string; name: string; active: boolean };
export type EditorStaff = { id: string; firstName: string; lastName: string };

// ── Small helpers ─────────────────────────────────────────────────────────────

function toLocalInput(d: Date) {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 16);
}
const money = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
const num = (s: string): number | null => (s.trim() === "" ? null : Number.isFinite(Number(s)) ? Number(s) : null);

function fmtRange(startsAt: string, endsAt: string): string {
  const s = new Date(startsAt), e = new Date(endsAt);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return "Dates not set";
  const sameDay = s.toDateString() === e.toDateString();
  const d = (x: Date) => x.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const t = (x: Date) => x.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return sameDay ? `${d(s)} · ${t(s)} – ${t(e)}` : `${d(s)} – ${d(e)}`;
}
function fmtSession(startsAt: string, endsAt: string): string {
  const s = new Date(startsAt), e = new Date(endsAt);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return "—";
  const day = s.toLocaleDateString("en-US", { weekday: "short" });
  const t = (x: Date) => x.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${day} ${t(s)} – ${t(e)}`;
}
const TYPE_LABEL: Record<string, string> = { CLINIC: "Clinic", CAMP: "Camp", TOURNAMENT: "Tournament", OTHER: "Other" };

// ── Primitive UI, sized for thumbs (44px targets on phone) ───────────────────

function Card({
  title, summary, open, onToggle, error, children,
}: { title: string; summary: string; open: boolean; onToggle: () => void; error?: boolean; children: React.ReactNode }) {
  return (
    <section className="bg-surface border border-app-border rounded-[14px] overflow-hidden flex-none">
      <button type="button" onClick={onToggle} className="w-full text-left px-4 py-3.5 flex items-start justify-between gap-3 min-h-[44px]">
        <span className="min-w-0">
          <span className="block text-[15px] leading-5 font-semibold text-text-primary">{title}</span>
          <span className={`block text-xs leading-4 mt-0.5 truncate ${error ? "text-red-600 font-medium" : "text-text-muted"}`}>{summary}</span>
        </span>
        <span className="text-[11px] font-medium text-brand shrink-0 mt-1">{open ? "Hide" : "Edit"}</span>
      </button>
      {open && <div className="px-4 pb-4 space-y-3.5">{children}</div>}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-primary mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-text-muted mt-1">{hint}</span>}
    </label>
  );
}
const input = "w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary min-h-[44px] md:min-h-0";

function Switch({ on, onChange, blocked, label, sub }: { on: boolean; onChange: (v: boolean) => void; blocked?: string | null; label: string; sub?: string }) {
  return (
    <button
      type="button"
      onClick={() => !blocked && onChange(!on)}
      className={`w-full flex items-center justify-between gap-3 text-left min-h-[44px] ${blocked ? "cursor-not-allowed" : ""}`}
      title={blocked ?? undefined}
    >
      <span className="min-w-0">
        <span className="block text-sm text-text-primary">{label}</span>
        {(blocked || sub) && <span className="block text-[11px] text-text-muted">{blocked ?? sub}</span>}
      </span>
      <span
        className="shrink-0 w-11 h-[26px] rounded-full transition-colors"
        style={{ background: blocked ? "#EFEFF2" : on ? "#6D5DF6" : "#D7D7DC" }}
      >
        <span className="block w-[22px] h-[22px] mt-0.5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.25)] transition-[margin]" style={{ marginLeft: on && !blocked ? 20 : 2 }} />
      </span>
    </button>
  );
}

function Choice<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; sub?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="space-y-1.5">
      {options.map((o) => {
        const sel = o.value === value;
        return (
          <button
            key={o.value} type="button" onClick={() => onChange(o.value)}
            className="w-full text-left px-3.5 py-3 rounded-xl border min-h-[44px]"
            style={sel ? { borderColor: "#6D5DF6", background: "rgba(109,93,246,.07)", color: "#5948E8" } : { borderColor: "var(--color-border, #E5E7EB)" }}
          >
            <span className={`block text-sm font-semibold ${sel ? "" : "text-text-primary"}`}>{o.label}</span>
            {o.sub && <span className="block text-[11.5px] text-text-muted">{o.sub}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Lock({ children }: { children: React.ReactNode }) {
  return <p className="text-[11.5px] text-text-muted border border-dashed border-app-border rounded-xl px-3 py-2.5">{children}</p>;
}
function Problem({ children }: { children: React.ReactNode }) {
  return <p className="text-[11.5px] font-medium rounded-xl px-3 py-2.5" style={{ background: "#FEF2F2", border: "1px solid rgba(185,28,28,.22)", color: "#B91C1C" }}>{children}</p>;
}

// ── The editor ────────────────────────────────────────────────────────────────

export default function EventEditor({
  event, clubEventTypes, memberships, staffList, onClose, onSaved, isCopy,
}: {
  event: EditorEvent | null;
  clubEventTypes: EditorEventType[];
  memberships: EditorMembership[];
  staffList: EditorStaff[];
  onClose: () => void;
  onSaved: () => void;
  /** B16 — opened on a fresh duplicate: say what to change first. */
  isCopy?: boolean;
}) {
  const isEdit = !!event;
  const ev = event;

  const defaultStart = new Date();
  defaultStart.setHours(defaultStart.getHours() + 1, 0, 0, 0);
  const defaultEnd = new Date(defaultStart);
  defaultEnd.setHours(defaultEnd.getHours() + 1);

  // ── Basics ──
  const initTypeKey = ev?.customEventTypeId
    ? `custom:${ev.customEventTypeId}`
    : ev?.type && ev.type !== "CLASS" && ev.type !== "PRIVATE" ? ev.type : "OTHER";
  const [typeKey, setTypeKey] = useState<string>(initTypeKey);
  const [tournamentMode, setTournamentMode] = useState<string>(ev?.tournamentMode || "");
  const [name, setName] = useState(ev?.name || "");
  const [description, setDescription] = useState(ev?.description || "");
  const [imageUrl, setImageUrl] = useState<string>(ev?.imageUrl || "");
  const [imagePositionX, setImagePositionX] = useState<number>(typeof ev?.imagePositionX === "number" ? ev.imagePositionX : 50);
  const [imagePositionY, setImagePositionY] = useState<number>(typeof ev?.imagePositionY === "number" ? ev.imagePositionY : 50);

  // ── Schedule ──
  const [startsAt, setStartsAt] = useState(ev ? toLocalInput(new Date(ev.startsAt)) : toLocalInput(defaultStart));
  const [endsAt, setEndsAt] = useState(ev ? toLocalInput(new Date(ev.endsAt)) : toLocalInput(defaultEnd));
  const [sessions, setSessions] = useState<EditorSession[]>(
    ev?.sessions?.length
      ? ev.sessions.map((s) => ({
          id: s.id, name: s.name, sortOrder: s.sortOrder,
          startsAt: toLocalInput(new Date(s.startsAt)), endsAt: toLocalInput(new Date(s.endsAt)),
          price: s.price == null ? null : Number(s.price),
        }))
      : [],
  );
  const [openSession, setOpenSession] = useState<number | null>(null);

  // ── Money ──
  const initialModel: PricingModel =
    (ev?.pricingModel as PricingModel | undefined) ??
    (ev?.variableCostEnabled ? "SPLIT" : (ev?.memberPrice || ev?.nonMemberPrice || ev?.dropInFee) ? "FIXED" : ev ? "FREE" : "FIXED");
  const [pricingModel, setPricingModel] = useState<PricingModel>(initialModel);
  const [memberPrice, setMemberPrice] = useState(ev?.memberPrice?.toString() || "");
  const [nonMemberPrice, setNonMemberPrice] = useState(ev?.nonMemberPrice?.toString() || "");
  const [sellSessions, setSellSessions] = useState<boolean>(!!ev?.sellIndividualSessions || (!!ev?.dropInFee && (ev?.sessions?.length ?? 0) > 1));
  const [travelFee, setTravelFee] = useState(ev?.travelFee?.toString() || "");
  const [varCostMode, setVarCostMode] = useState<string>(ev?.variableCostMode || "ESTIMATED");
  const [varCostTotal, setVarCostTotal] = useState<string>(ev?.variableCostTotal != null ? String(ev.variableCostTotal) : "");
  const [varCostEstSignups, setVarCostEstSignups] = useState<string>(ev?.variableCostEstimatedSignups != null ? String(ev.variableCostEstimatedSignups) : "");
  const [varCostEstTotal, setVarCostEstTotal] = useState<string>(ev?.variableCostEstimatedTotal != null ? String(ev.variableCostEstimatedTotal) : "");
  const [splitInvoiceWhen, setSplitInvoiceWhen] = useState<SplitInvoiceWhen>(
    (ev?.splitInvoiceWhen as SplitInvoiceWhen | undefined) ?? (ev?.invoiceScheduledAt ? "ON_DATE" : "AFTER_EVENT"),
  );
  const [invoiceScheduledAt, setInvoiceScheduledAt] = useState<string>(ev?.invoiceScheduledAt ? new Date(ev.invoiceScheduledAt).toISOString().slice(0, 10) : "");
  const [allowedMembershipIds, setAllowedMembershipIds] = useState<string[]>(
    (ev?.pricingOptions || []).filter((p) => p.type === "membership").map((p) => p.membershipId),
  );

  // ── How people pay ──
  const [payMethods, setPayMethods] = useState<PaymentMethod[]>(
    Array.isArray(ev?.paymentMethods) && ev.paymentMethods.length > 0 ? (ev.paymentMethods as PaymentMethod[]) : ["CARD"],
  );
  const [autoChargeDate, setAutoChargeDate] = useState<string>(ev?.autoChargeDate ? new Date(ev.autoChargeDate).toISOString().slice(0, 10) : "");
  const [requirePaymentBeforeCheckin, setRequirePaymentBeforeCheckin] = useState<boolean>(!!ev?.requirePaymentBeforeCheckin);

  // ── Who signs up ──
  const initialAccess: SignupAccess =
    (ev?.signupAccess as SignupAccess | undefined) ??
    (ev?.purchaseAccess === "STAFF_ONLY" || ev?.visibility === "STAFF_ONLY" ? "STAFF_ONLY" : ev?.publicRegistration ? "PUBLIC_LINK" : "MEMBERS");
  const [signupAccess, setSignupAccess] = useState<SignupAccess>(initialAccess);
  const [publicFormIntro, setPublicFormIntro] = useState<string>(ev?.publicFormIntro || "");
  const [publicPricingOption, setPublicPricingOption] = useState<string>(ev?.publicPricingOption || "");
  const initialForm: EditorFormField[] = Array.isArray(ev?.registrationForm) ? (ev!.registrationForm as EditorFormField[]) : [];
  const initialCategories = categoryFieldsFromForm(initialForm);
  const [formFields, setFormFields] = useState<EditorFormField[]>(initialForm.filter((f) => !categoryFieldsFromForm([f]).length));
  const [categories, setCategories] = useState<{ key: string; label: string; optionsText: string; required: boolean; perEntry?: boolean }[]>(
    initialCategories.map((c) => ({
      key: c.key, label: c.label, optionsText: c.options.join("\n"), required: c.required ?? true,
      perEntry: initialForm.some((f) => f.label === c.label && f.perEntry === true),
    })),
  );
  const [approvalMode, setApprovalMode] = useState<"" | "on" | "off">(ev?.requiresCoachApproval == null ? "" : ev.requiresCoachApproval ? "on" : "off");
  const [approvalIntent, setApprovalIntent] = useState<string>(ev?.approvalPaymentIntent || "");
  const [allowProposals, setAllowProposals] = useState<boolean>(!!ev?.allowProposedChanges);
  const [responsibleCoachUserId, setResponsibleCoachUserId] = useState<string>(ev?.responsibleCoachUserId || "");
  const [holdSpotDuringReview, setHoldSpotDuringReview] = useState<boolean>(!!ev?.holdSpotDuringReview);
  // B16 slice 3 — more than one entry per athlete.
  const [allowMultipleEntries, setAllowMultipleEntries] = useState<boolean>(!!ev?.allowMultipleEntries);
  const [maxEntries, setMaxEntries] = useState<string>(ev?.maxEntries != null ? String(ev.maxEntries) : "");
  const [extraEntryPriced, setExtraEntryPriced] = useState<boolean>(ev?.additionalEntryPrice != null);
  const [additionalEntryPrice, setAdditionalEntryPrice] = useState<string>(ev?.additionalEntryPrice != null ? String(ev.additionalEntryPrice) : "");
  const [allowSameRosterTwice, setAllowSameRosterTwice] = useState<boolean>(!!ev?.allowSameRosterTwice);
  const [entriesOnPublicLink, setEntriesOnPublicLink] = useState<boolean>(!!ev?.entriesOnPublicLink);
  // B3 slice 1 — sibling / group-rate discounts, applied at signup.
  const [autoDiscounts, setAutoDiscounts] = useState<AutoDiscounts>(() => parseAutoDiscounts(ev?.autoDiscounts));

  // ── B16: roster positions (columns = rosters, rows = positions) ──
  type RosterRowState = { id: string | null; label: string };
  // `rosters`: labels of the rosters this position is offered in; [] = all.
  type PositionRowState = { id: string | null; label: string; capacity: string; rosters: string[] };
  const [rosterCols, setRosterCols] = useState<RosterRowState[]>([]);
  const [rosterRows, setRosterRows] = useState<PositionRowState[]>([]);
  const [rosterDirty, setRosterDirty] = useState(false);
  const [rosterLoaded, setRosterLoaded] = useState(!isEdit);
  const [pasteRows, setPasteRows] = useState("");
  // Set by "Build the roster from your dropdowns": the saved question ids whose
  // answers place existing registrations on the new roster.
  const [backfillFrom, setBackfillFrom] = useState<{ rosterFieldId: string; positionFieldId: string } | null>(null);
  useEffect(() => {
    if (!isEdit || !ev?.id) return;
    let alive = true;
    fetch(`/api/events/${ev.id}/roster`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.definition) { if (alive) setRosterLoaded(true); return; }
        setRosterCols(d.definition.rosters.map((r: { id: string; label: string }) => ({ id: r.id, label: r.label })));
        const labelOf = new Map<string, string>(d.definition.rosters.map((r: { id: string; label: string }) => [r.id, r.label]));
        setRosterRows(d.definition.positions.map((p: { id: string; label: string; capacity: number | null; rosterIds?: string[] }) => ({
          id: p.id, label: p.label, capacity: p.capacity == null ? "" : String(p.capacity),
          rosters: (p.rosterIds ?? []).map((rid) => labelOf.get(rid)).filter((x): x is string => !!x),
        })));
        setRosterLoaded(true);
      })
      .catch(() => alive && setRosterLoaded(true));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const editRoster = (fn: () => void) => { fn(); setRosterDirty(true); };
  // Two dropdowns already on the form (e.g. Weight Class + Division) can become
  // the roster in one tap: the one with fewer choices becomes the columns.
  function rosterFromDropdowns() {
    const withOpts = categories.filter((c) => c.optionsText.split("\n").map((x) => x.trim()).filter(Boolean).length > 0);
    if (withOpts.length < 2) return;
    const [a, b] = withOpts;
    const opts = (c: typeof a) => c.optionsText.split("\n").map((x) => x.trim()).filter(Boolean);
    const [cols, rows] = opts(a).length <= opts(b).length ? [a, b] : [b, a];
    editRoster(() => {
      setRosterCols(opts(cols).map((label) => ({ id: null, label })));
      // "40 (K4 only)", "52 (K4/K6)" → offered only in the rosters they name.
      setRosterRows(opts(rows).map((label) => ({ id: null, label, capacity: "", rosters: rostersNamedInLabel(label, opts(cols)) })));
      setCategories((cs) => cs.filter((c) => c.key !== cols.key && c.key !== rows.key));
    });
    // Only questions that were already saved can have answers to carry over.
    const saved = new Set(initialCategories.map((c) => c.key));
    if (saved.has(cols.key) && saved.has(rows.key)) {
      setBackfillFrom({ rosterFieldId: fieldIdForKey(cols.key), positionFieldId: fieldIdForKey(rows.key) });
    }
  }

  // ── Capacity, dates & policy ──
  const [capacity, setCapacity] = useState(ev?.capacity?.toString() || "");
  const [paymentDueBy, setPaymentDueBy] = useState<string>(ev?.paymentDueBy ? new Date(ev.paymentDueBy).toISOString().slice(0, 10) : "");
  const [cancellationPolicyText, setCancellationPolicyText] = useState<string>(ev?.cancellationPolicyText || "");
  const [publishAt, setPublishAt] = useState(ev?.publishAt ? toLocalInput(new Date(ev.publishAt)) : "");
  const [unpublishAt, setUnpublishAt] = useState(ev?.unpublishAt ? toLocalInput(new Date(ev.unpublishAt)) : "");
  const [escalationEnabled, setEscalationEnabled] = useState<boolean>(!!ev?.escalationEnabled);
  const [escalationAnchor, setEscalationAnchor] = useState<string>(ev?.escalationAnchor || "registrationDeadline");
  const [escalationSchedule, setEscalationSchedule] = useState<string>(ev?.escalationSchedule || "DEFAULT_TOURNAMENT");
  const [escalationCustomDays, setEscalationCustomDays] = useState<string>(Array.isArray(ev?.escalationCustomDays) ? (ev!.escalationCustomDays as number[]).join(", ") : "");

  // ── Staff ──
  const [staffUserIds, setStaffUserIds] = useState<string[]>((ev?.staffAssignments || []).map((a) => a.user.id));

  const [open, setOpen] = useState<Record<string, boolean>>({ basics: !isEdit || !!isCopy, schedule: !isEdit || !!isCopy, money: !isEdit, pay: !!isCopy });
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // ── Derived, once ────────────────────────────────────────────────────────
  const isTournament = typeKey === "TOURNAMENT";
  const isCustom = typeKey.startsWith("custom:");
  const selectedCustomType = isCustom ? clubEventTypes.find((t) => t.id === typeKey.replace("custom:", "")) : undefined;
  const typePolicy = selectedCustomType?.defaultPolicy ?? null;
  const approvalAvailable = isTournament || !!typePolicy;
  const typeSaysApproval = typePolicy?.requiresCoachApproval === true;
  const approvalOn = approvalMode === "on" || (approvalMode === "" && typeSaysApproval);
  const chargeOnApproval = approvalOn && approvalIntent === "APPROVAL_CHARGE";

  const typeLabel = isCustom ? selectedCustomType?.name ?? "Custom" : TYPE_LABEL[typeKey] ?? "Event";
  const dateRange = fmtRange(startsAt, endsAt);
  const datesBad = new Date(endsAt).getTime() <= new Date(startsAt).getTime();
  const badSessions = sessions.filter((s) => new Date(s.endsAt).getTime() <= new Date(s.startsAt).getTime()).length;
  const sessionPrices = sessions.map((s) => (typeof s.price === "number" ? s.price : num(String(s.price ?? ""))));
  const mp = num(memberPrice), nmp = num(nonMemberPrice);
  const splitTotal = num(varCostTotal), splitHeads = num(varCostEstSignups);

  const exclusions = useMemo(
    () => applyExclusions({ pricingModel, signupAccess, paymentMethods: payMethods, chargeOnApproval, requiresCoachApproval: approvalOn }),
    [pricingModel, signupAccess, payMethods, chargeOnApproval, approvalOn],
  );
  const bundle = useMemo(() => (pricingModel === "FIXED" && sellSessions ? bundleSanity(sessionPrices, mp ?? nmp) : { kind: "NONE" as const }), [pricingModel, sellSessions, sessionPrices, mp, nmp]);
  const moneyLine = moneySummary({
    pricingModel, memberPrice: mp, nonMemberPrice: nmp, sellIndividualSessions: sellSessions, sessionPrices,
    splitTotal, splitExpectedSignups: splitHeads, splitInvoiceWhen,
  });
  const coveredNames = memberships.filter((m) => allowedMembershipIds.includes(m.id)).map((m) => m.name);
  const signedUp = (ev?._count?.registrations ?? ev?._count?.bookings ?? 0);

  const payLine = (() => {
    if (exclusions.paymentMethodsLocked) return pricingModel === "SPLIT" ? "invoiced after the event" : "nothing to collect";
    const parts: string[] = [];
    if (exclusions.paymentMethods.includes("CARD")) parts.push("card now");
    if (exclusions.paymentMethods.includes("AUTO_CARD")) parts.push(`saved card${autoChargeDate ? ` ${new Date(`${autoChargeDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : ""}`);
    if (exclusions.paymentMethods.includes("CASH")) parts.push("cash");
    if (exclusions.paymentMethods.includes("CHECK")) parts.push("check");
    if (requirePaymentBeforeCheckin) parts.push("check-in blocked until paid");
    return parts.join(" · ") || "no way to pay — pick one";
  })();
  const accessLine = [
    signupAccess === "MEMBERS" ? "Members" : signupAccess === "PUBLIC_LINK" ? "Members + public link" : "Staff adds people",
    approvalOn ? "coach approves" : null,
    categories.length + formFields.length > 0 ? `${categories.length + formFields.length} question${categories.length + formFields.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
  const capacityLine = [
    capacity ? `${capacity} spots` : "no cap",
    paymentDueBy ? `payment due ${new Date(`${paymentDueBy}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}` : null,
    publishAt ? "scheduled publish" : null,
  ].filter(Boolean).join(" · ");
  const staffLine = staffUserIds.length
    ? staffList.filter((s) => staffUserIds.includes(s.id)).map((s) => `${s.firstName} ${s.lastName}`).join(", ") + " · payroll follows the roster"
    : "Nobody assigned yet";
  const conflict = exclusions.conflict ?? (bundle.kind === "CHEAPER_A_LA_CARTE" ? bundle.sentence : null) ?? (datesBad ? "Ends before it starts." : null);

  const perHead = splitTotal != null && splitHeads ? splitTotal / splitHeads : null;
  const previewPrice = (() => {
    if (pricingModel === "FREE") return [{ label: "Price", value: "Free" }];
    if (pricingModel === "SPLIT") return [{ label: "Your share", value: perHead != null ? `≈ ${money(Math.round(perHead * 100) / 100)}` : "shared cost, invoiced after" }];
    const rows: { label: string; value: string }[] = [];
    if (mp != null) rows.push({ label: "Members", value: money(mp) });
    if (nmp != null) rows.push({ label: "Non-members", value: money(nmp) });
    const priced = sessionPrices.filter((p): p is number => typeof p === "number" && p > 0);
    if (sellSessions && priced.length) rows.push({ label: "Single session", value: `from ${money(Math.min(...priced))}` });
    return rows.length ? rows : [{ label: "Price", value: "not set" }];
  })();
  const cta = approvalOn ? "Request a spot" : pricingModel === "FIXED" && exclusions.paymentMethods.includes("CARD") ? "Sign up & pay" : "Sign up";

  // ── Mutators ──
  function setModel(m: PricingModel) {
    setPricingModel(m);
    if (m !== "FIXED") setSellSessions(false);
  }
  function setTournament(mode: string) {
    setTournamentMode(mode);
    // Handoff rule 2: attending sets the model to Split, hosting to Fixed.
    if (mode === "ATTEND") setModel("SPLIT");
    if (mode === "HOST") setModel("FIXED");
  }
  function addSession() {
    const lastEnd = sessions.length > 0 ? sessions[sessions.length - 1].endsAt : startsAt;
    const start = new Date(lastEnd); start.setMinutes(start.getMinutes() + 30);
    const end = new Date(start); end.setHours(end.getHours() + 1);
    setSessions([...sessions, { name: null, startsAt: toLocalInput(start), endsAt: toLocalInput(end), sortOrder: sessions.length, price: null }]);
    setOpenSession(sessions.length);
  }
  function updateSession(i: number, patch: Partial<EditorSession>) {
    setSessions((ss) => ss.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function removeSession(i: number) {
    setSessions((ss) => ss.filter((_, idx) => idx !== i));
    setOpenSession(null);
  }
  const togglePay = (m: PaymentMethod) => setPayMethods((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  const toggleMembership = (id: string) => setAllowedMembershipIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleStaff = (id: string) => setStaffUserIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  function addCategory(preset?: { key: string; label: string }) {
    setCategories((cs) => {
      const taken = new Set(cs.map((c) => c.key));
      let key = preset?.key ?? "category"; let n = 2;
      while (taken.has(key)) key = `${preset?.key ?? "category"}${n++}`;
      return [...cs, { key, label: preset?.label ?? "", optionsText: "", required: true }];
    });
  }

  // ── Submit — same payload EventModal sent, plus the slice-2 fields ──
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (datesBad) { setError(`Ends before it starts. Pick an end after ${new Date(startsAt).toLocaleString()}.`); setOpen((o) => ({ ...o, schedule: true })); return; }
    if (badSessions) { setError(`${badSessions} session${badSessions === 1 ? "" : "s"} end${badSessions === 1 ? "s" : ""} before it starts.`); setOpen((o) => ({ ...o, schedule: true })); return; }
    if (!exclusions.paymentMethodsLocked && exclusions.paymentMethods.length === 0) { setError("Pick at least one way to pay, or make the event free."); setOpen((o) => ({ ...o, pay: true })); return; }
    // Checked before the event is saved, so a bad roster never leaves a saved
    // event behind with no roster (and a second Save creating a duplicate).
    const rosterBody = {
      rosters: rosterCols.map((r) => ({ id: r.id, label: r.label })),
      positions: rosterRows.map((p) => ({
        id: p.id,
        label: p.label,
        capacity: p.capacity.trim() === "" ? null : Number(p.capacity),
        // Only labels of rosters still on the event; a renamed/removed roster drops out.
        rosters: p.rosters.filter((l) => rosterCols.some((r) => r.label.trim().toLowerCase() === l.trim().toLowerCase())),
      })),
    };
    if (rosterDirty) {
      const rc = validateRosterDef(rosterBody);
      if (!rc.ok) { setError(rc.error); setOpen((o) => ({ ...o, roster: true })); return; }
    }
    setSaving(true);
    const customEventTypeId = isCustom ? typeKey.replace("custom:", "") : null;
    const type = isCustom ? "OTHER" : (typeKey as EditorBuiltInType);
    const splitOn = pricingModel === "SPLIT";
    const body = {
      type, customEventTypeId, name,
      description: description || undefined,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      capacity: capacity ? parseInt(capacity) : null,
      // slice 2 vocabulary — the API derives the legacy columns from these
      pricingModel,
      signupAccess,
      splitInvoiceWhen: splitOn ? splitInvoiceWhen : null,
      sellIndividualSessions: pricingModel === "FIXED" && sellSessions,
      memberPrice: pricingModel === "FIXED" ? mp : null,
      nonMemberPrice: pricingModel === "FIXED" ? nmp : null,
      travelFee: travelFee ? parseFloat(travelFee) : null,
      publishAt: publishAt ? new Date(publishAt).toISOString() : null,
      unpublishAt: unpublishAt ? new Date(unpublishAt).toISOString() : null,
      allowMembershipPayment: allowedMembershipIds.length > 0,
      pricingOptions: allowedMembershipIds.map((membershipId) => ({ type: "membership", membershipId })),
      staffUserIds,
      imageUrl: imageUrl || null,
      imagePositionX, imagePositionY,
      tournamentMode: type === "TOURNAMENT" ? (tournamentMode || null) : null,
      publicFormIntro: publicFormIntro || null,
      publicPricingOption: publicPricingOption || null,
      registrationForm: [
        ...categories.filter((c) => c.label.trim()).map((c, i) => {
          const options = c.optionsText.split("\n").map((x) => x.trim()).filter(Boolean);
          return { id: i === 0 ? PARTICIPANT_FIELD_ID : fieldIdForKey(c.key), label: c.label.trim(), type: (options.length > 0 ? "select" : "text") as "select" | "text", required: c.required, options, ...(allowMultipleEntries && c.perEntry ? { perEntry: true } : {}) };
        }),
        ...formFields.filter((f) => f.label.trim() && !categoryFieldsFromForm([f]).length).map((f) => {
          const { perEntry, ...rest } = f;
          return { ...rest, label: f.label.trim(), ...(allowMultipleEntries && perEntry ? { perEntry: true } : {}) };
        }),
      ],
      variableCostEnabled: splitOn,
      variableCostMode: splitOn ? varCostMode : null,
      variableCostTotal: splitOn && varCostTotal ? parseFloat(varCostTotal) : null,
      variableCostEstimatedSignups: splitOn && varCostMode === "ESTIMATED" && varCostEstSignups ? parseInt(varCostEstSignups, 10) : null,
      variableCostEstimatedTotal: splitOn && varCostMode === "OFFICIAL" && varCostEstTotal ? parseFloat(varCostEstTotal) : null,
      invoiceScheduledAt: splitOn && splitInvoiceWhen === "ON_DATE" && invoiceScheduledAt ? new Date(`${invoiceScheduledAt}T12:00:00Z`).toISOString() : null,
      paymentMethods: exclusions.paymentMethodsLocked ? [] : exclusions.paymentMethods,
      autoChargeDate: exclusions.paymentMethods.includes("AUTO_CARD") && autoChargeDate ? new Date(`${autoChargeDate}T12:00:00Z`).toISOString() : null,
      requirePaymentBeforeCheckin,
      allowMultipleEntries,
      maxEntries: allowMultipleEntries && maxEntries ? Math.max(1, Math.min(20, parseInt(maxEntries, 10) || 1)) : null,
      additionalEntryPrice: allowMultipleEntries && extraEntryPriced && additionalEntryPrice !== "" ? Math.max(0, parseFloat(additionalEntryPrice) || 0) : null,
      allowSameRosterTwice: allowMultipleEntries ? allowSameRosterTwice : false,
      entriesOnPublicLink: allowMultipleEntries && signupAccess === "PUBLIC_LINK" ? entriesOnPublicLink : false,
      autoDiscounts: {
        ...(autoDiscounts.sibling ? { sibling: autoDiscounts.sibling } : {}),
        ...(autoDiscounts.group
          ? { group: { ...autoDiscounts.group, options: autoDiscounts.group.options.map((o) => o.trim()).filter(Boolean) } }
          : {}),
      },
      ...(approvalAvailable
        ? {
            requiresCoachApproval: approvalMode === "" ? null : approvalMode === "on",
            approvalPaymentIntent: approvalIntent || null,
            allowProposedChanges: approvalOn ? allowProposals : null,
            responsibleCoachUserId: responsibleCoachUserId || null,
            holdSpotDuringReview: approvalOn ? holdSpotDuringReview : false,
            cancellationPolicyText: cancellationPolicyText.trim() || null,
            paymentDueBy: paymentDueBy ? new Date(`${paymentDueBy}T12:00:00Z`).toISOString() : null,
            escalationEnabled: approvalOn ? escalationEnabled : null,
            escalationAnchor: escalationEnabled ? escalationAnchor : null,
            escalationSchedule: escalationEnabled ? escalationSchedule : null,
            escalationCustomDays: escalationEnabled && escalationSchedule === "CUSTOM"
              ? escalationCustomDays.split(",").map((d) => parseInt(d.trim(), 10)).filter((d) => Number.isFinite(d))
              : null,
          }
        : { cancellationPolicyText: cancellationPolicyText.trim() || null, paymentDueBy: paymentDueBy ? new Date(`${paymentDueBy}T12:00:00Z`).toISOString() : null }),
      sessions: sessions.map((s, i) => ({
        ...(s.id ? { id: s.id } : {}),
        name: s.name || null,
        startsAt: new Date(s.startsAt).toISOString(),
        endsAt: new Date(s.endsAt).toISOString(),
        sortOrder: i,
        price: pricingModel === "FIXED" && sellSessions ? sessionPrices[i] : null,
      })),
    };
    const res = await fetch(isEdit ? `/api/events/${ev!.id}` : "/api/events", {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setSaving(false);
      const data = await res.json().catch(() => ({}));
      setError(typeof data.error === "string" ? data.error : Array.isArray(data.error) ? data.error.map((x: { message?: string }) => x.message).join("; ") : "Save failed");
      return;
    }
    const saved = await res.json().catch(() => ({}));
    const savedId: string | undefined = isEdit ? ev!.id : saved?.id;
    if (rosterDirty && savedId) {
      const rr = await fetch(`/api/events/${savedId}/roster`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...rosterBody, ...(backfillFrom ? { backfillFrom } : {}) }),
      });
      if (!rr.ok) {
        setSaving(false);
        const d = await rr.json().catch(() => ({}));
        setError(`The event was saved, but the roster wasn't: ${typeof d.error === "string" ? d.error : "try again"}`);
        setOpen((o) => ({ ...o, roster: true }));
        if (!isEdit) onSaved(); // a new event exists now — don't let a second Save duplicate it
        return;
      }
    }
    setSaving(false);
    onSaved();
  }

  // ── Cards ─────────────────────────────────────────────────────────────────
  const cards = (
    <>
      {isCopy && (
        <div className="rounded-[14px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>This is a copy.</strong> Everything came over except people and money. Change the <strong>name</strong>, the{" "}
          <strong>dates</strong>{payMethods.includes("AUTO_CARD") ? <>, and the <strong>saved-card charge date</strong></> : null} before you share it —
          {signupAccess === "PUBLIC_LINK" ? " a new public link is made from the new name when you save." : " then save."}
        </div>
      )}
      <Card title="Basics" summary={`${typeLabel} · ${name || "untitled"}${imageUrl ? " · cover photo set" : ""}`} open={!!open.basics} onToggle={() => toggle("basics")}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} required className={input} placeholder="Summer Intensive" /></Field>
        <div>
          <span className="block text-xs font-medium text-text-primary mb-1">Type</span>
          <div className="flex flex-wrap gap-1.5">
            {(["CLINIC", "CAMP", "TOURNAMENT", "OTHER"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTypeKey(t)} className={`px-3 py-2 rounded-full text-xs border min-h-[36px] ${typeKey === t ? "border-brand bg-brand/10 text-brand font-medium" : "border-app-border text-text-primary"}`}>{TYPE_LABEL[t]}</button>
            ))}
            {clubEventTypes.map((t) => (
              <button key={t.id} type="button" onClick={() => setTypeKey(`custom:${t.id}`)} className={`px-3 py-2 rounded-full text-xs border min-h-[36px] ${typeKey === `custom:${t.id}` ? "border-brand bg-brand/10 text-brand font-medium" : "border-app-border text-text-primary"}`}>{t.name}</button>
            ))}
          </div>
          <p className="text-[11px] text-text-muted mt-1">Recurring classes live on the Classes page — they aren't an event.</p>
        </div>
        {isTournament && (
          <div className="rounded-xl bg-app-bg px-3 py-2.5">
            <p className="text-xs font-medium text-text-primary mb-1.5">Who is running it?</p>
            <Choice value={tournamentMode as "HOST" | "ATTEND" | ""} onChange={(v) => setTournament(v)} options={[
              { value: "HOST", label: "We're hosting", sub: "Collect registrations — fixed price" },
              { value: "ATTEND", label: "We're attending", sub: "Gather signups for a trip — the cost is split across everyone" },
            ]} />
          </div>
        )}
        <ImageUpload label="Cover photo" value={imageUrl} onChange={setImageUrl} shape="square" placeholder="Choose photo" />
        {imageUrl && <EventImageFocalPicker imageUrl={imageUrl} x={imagePositionX} y={imagePositionY} onChange={(nx, ny) => { setImagePositionX(nx); setImagePositionY(ny); }} />}
        <Field label="Description"><textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={input} /></Field>
      </Card>

      <Card
        title="Schedule & sessions"
        summary={datesBad || badSessions ? "Needs a fix — check the dates" : `${dateRange} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}${sellSessions && pricingModel === "FIXED" ? " · priced individually" : ""}`}
        error={datesBad || badSessions > 0}
        open={!!open.schedule} onToggle={() => toggle("schedule")}
      >
        <Field label="Starts"><input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required className={input} /></Field>
        <Field label="Ends">
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required className={input} style={datesBad ? { borderColor: "#B91C1C", boxShadow: "0 0 0 3px rgba(185,28,28,.12)" } : undefined} />
        </Field>
        {datesBad && <Problem>Ends before it starts. Pick an end after {new Date(startsAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.</Problem>}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-text-primary">Sessions</span>
            <button type="button" onClick={addSession} className="text-xs text-brand font-medium min-h-[36px]">+ Add session</button>
          </div>
          {sessions.length === 0 && <p className="text-[11px] text-text-muted">One block of time. Add sessions for a multi-day camp or a clinic series.</p>}
          <div className="divide-y" style={{ borderColor: "#F1F1F3" }}>
            {sessions.map((s, i) => {
              const bad = new Date(s.endsAt).getTime() <= new Date(s.startsAt).getTime();
              const expanded = openSession === i;
              return (
                <div key={s.id ?? i} className={`py-2.5 ${expanded ? "rounded-lg px-2 -mx-2" : ""}`} style={expanded ? { background: "#FAFAFB" } : undefined}>
                  {!expanded ? (
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[13.5px] font-medium text-text-primary truncate">{s.name || `Session ${i + 1}`}</p>
                        <p className="text-[11.5px] text-text-muted">
                          {fmtSession(s.startsAt, s.endsAt)} · <button type="button" onClick={() => setOpenSession(i)} className="text-brand">Edit time</button>
                        </p>
                      </div>
                      {pricingModel === "FIXED" && sellSessions && (
                        <span className="flex items-center gap-1 text-sm text-text-primary shrink-0">$
                          <input type="number" min="0" step="0.01" value={s.price ?? ""} onChange={(e) => updateSession(i, { price: e.target.value === "" ? null : Number(e.target.value) })} className="w-[58px] text-right px-1.5 py-1 border border-app-border rounded-md text-sm bg-surface" />
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <input value={s.name ?? ""} onChange={(e) => updateSession(i, { name: e.target.value || null })} placeholder={`Session ${i + 1}`} className={input} />
                        <button type="button" onClick={() => setOpenSession(null)} className="text-xs text-brand font-medium px-2 shrink-0">Done</button>
                      </div>
                      <Field label="Session starts"><input type="datetime-local" value={s.startsAt} onChange={(e) => updateSession(i, { startsAt: e.target.value })} className={input} /></Field>
                      <Field label="Session ends"><input type="datetime-local" value={s.endsAt} onChange={(e) => updateSession(i, { endsAt: e.target.value })} className={input} style={bad ? { borderColor: "#B91C1C" } : undefined} /></Field>
                      {bad && <p className="text-[11.5px] font-medium" style={{ color: "#B91C1C" }}>This session ends before it starts.</p>}
                      {pricingModel === "FIXED" && sellSessions && (
                        <Field label="Price for this session"><input type="number" min="0" step="0.01" value={s.price ?? ""} onChange={(e) => updateSession(i, { price: e.target.value === "" ? null : Number(e.target.value) })} className={input} /></Field>
                      )}
                      <button type="button" onClick={() => removeSession(i)} className="text-xs text-red-600 min-h-[36px]">Remove session</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {badSessions > 0 && <p className="text-[11.5px] font-medium mt-1" style={{ color: "#B91C1C" }}>{badSessions} session{badSessions === 1 ? "" : "s"} end{badSessions === 1 ? "s" : ""} before it starts.</p>}
        </div>
      </Card>

      <Card title="Money" summary={moneyLine} open={!!open.money} onToggle={() => toggle("money")}>
        <Choice value={pricingModel} onChange={setModel} options={[
          { value: "FREE", label: "Free", sub: "Nobody is charged" },
          { value: "FIXED", label: "Fixed price", sub: "A member and a non-member price; sessions can be sold on their own" },
          { value: "SPLIT", label: "Split a shared cost", sub: "Entry fees, hotel, travel — divided across everyone who signs up" },
        ]} />
        {pricingModel === "FIXED" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Member price"><input type="number" min="0" step="0.01" value={memberPrice} onChange={(e) => setMemberPrice(e.target.value)} className={input} /></Field>
              <Field label="Non-member"><input type="number" min="0" step="0.01" value={nonMemberPrice} onChange={(e) => setNonMemberPrice(e.target.value)} className={input} /></Field>
            </div>
            <Switch on={sellSessions} onChange={setSellSessions} label="Sell individual sessions" sub={sessions.length > 1 ? "Each session gets its own price in Schedule" : "Add at least two sessions first"} blocked={sessions.length > 1 ? null : "Add at least two sessions first"} />
            {bundle.kind === "CHEAPER_A_LA_CARTE" && <Problem>{bundle.sentence.charAt(0).toUpperCase() + bundle.sentence.slice(1)}.</Problem>}
            {bundle.kind === "SAVING" && <p className="text-[11.5px] text-text-muted">Buying the whole event saves {money(bundle.saving)} against the sessions bought one by one.</p>}
            <Field label="Travel fee (optional)" hint="Added once per registration."><input type="number" min="0" step="0.01" value={travelFee} onChange={(e) => setTravelFee(e.target.value)} className={input} /></Field>
          </>
        )}
        {pricingModel === "SPLIT" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Total cost"><input type="number" min="0" step="0.01" value={varCostTotal} onChange={(e) => setVarCostTotal(e.target.value)} className={input} /></Field>
              <Field label="Expected signups"><input type="number" min="1" step="1" value={varCostEstSignups} onChange={(e) => { setVarCostEstSignups(e.target.value); setVarCostMode("ESTIMATED"); }} className={input} /></Field>
            </div>
            <p className="text-[11.5px] text-text-primary bg-app-bg rounded-xl px-3 py-2">
              {perHead != null ? <>≈ <strong>{money(Math.round(perHead * 100) / 100)}</strong> each at {splitHeads} signups. The real share is worked out from who actually signs up.</> : "Enter the total and how many you expect, and the per-person share appears here."}
            </p>
            <div>
              <p className="text-xs font-medium text-text-primary mb-1.5">When does everyone get invoiced?</p>
              <Choice value={splitInvoiceWhen} onChange={setSplitInvoiceWhen} options={[
                { value: "AFTER_EVENT", label: "After the event", sub: "The day after it ends" },
                { value: "ON_DATE", label: "On a date I pick" },
              ]} />
              {splitInvoiceWhen === "ON_DATE" && <input type="date" value={invoiceScheduledAt} onChange={(e) => setInvoiceScheduledAt(e.target.value)} className={`${input} mt-2`} />}
            </div>
            <Lock>Member &amp; non-member prices are off while the cost is split — everyone pays their share, invoiced from the Attendees list.</Lock>
          </>
        )}
        {pricingModel === "FREE" && <Lock>This event is free. Nothing is collected and nobody is invoiced.</Lock>}
        {memberships.filter((m) => m.active).length > 0 && pricingModel !== "SPLIT" && (
          <div>
            <p className="text-xs font-medium text-text-primary mb-1">Memberships that cover it</p>
            <p className="text-[11px] text-text-muted mb-1.5">Those members pay $0 and skip payment entirely.</p>
            <div className="flex flex-wrap gap-1.5">
              {memberships.filter((m) => m.active).map((m) => (
                <button key={m.id} type="button" onClick={() => toggleMembership(m.id)} className={`px-3 py-2 rounded-full text-xs border min-h-[36px] ${allowedMembershipIds.includes(m.id) ? "border-brand bg-brand/10 text-brand font-medium" : "border-app-border text-text-primary"}`}>{m.name}</button>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card title="How people pay" summary={payLine} open={!!open.pay} onToggle={() => toggle("pay")}>
        {exclusions.paymentMethodsLocked ? (
          <Lock>{exclusions.paymentMethodsLocked}</Lock>
        ) : (
          <>
            {([
              ["CARD", "Card at signup", "Charged immediately; the spot is reserved once it clears."],
              ["AUTO_CARD", "Saved card, charged later", "Members with a card on file authorize it at signup."],
              ["CASH", "Cash at the event", "Registered now; staff records it at check-in."],
              ["CHECK", "Check at the event", "Registered now; staff records it at check-in."],
            ] as [PaymentMethod, string, string][]).map(([m, label, hint]) => {
              const blocked = m === "CARD" ? exclusions.cardDisabledReason : null;
              const on = payMethods.includes(m) && !blocked;
              return (
                <button key={m} type="button" onClick={() => !blocked && togglePay(m)} className="w-full text-left flex items-start gap-3 p-3 rounded-xl border min-h-[44px]" style={blocked ? { background: "#FAFAFB", borderColor: "#EFEFF2", cursor: "not-allowed" } : { borderColor: "var(--color-border, #E5E7EB)" }}>
                  <span className="w-6 h-6 rounded-[7px] shrink-0 flex items-center justify-center text-white text-sm" style={{ background: blocked ? "#F4F4F6" : on ? "#6D5DF6" : "transparent", border: on || blocked ? "none" : "1px solid #D7D7DC", color: blocked ? "#B6B8BE" : "#fff" }}>{on ? "✓" : ""}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text-primary">{label}</span>
                    <span className="block text-[11px] text-text-muted">{blocked ?? hint}</span>
                  </span>
                </button>
              );
            })}
            {exclusions.paymentMethods.includes("AUTO_CARD") && (
              <Field label="Charge saved cards on" hint="Leave blank to charge when a coach approves or at signup."><input type="date" value={autoChargeDate} onChange={(e) => setAutoChargeDate(e.target.value)} className={input} /></Field>
            )}
            <Switch on={requirePaymentBeforeCheckin} onChange={setRequirePaymentBeforeCheckin} label="Block check-in until paid" />
            <p className="text-[11.5px] text-text-muted">A family will see: {payLine}.</p>
          </>
        )}
      </Card>

      <Card title="Discounts" summary={autoDiscountsLine(autoDiscounts)} open={!!open.discounts} onToggle={() => toggle("discounts")}>
        <AutoDiscountsEditor value={autoDiscounts} onChange={setAutoDiscounts} />
      </Card>

      <Card title="Who signs up, and how" summary={accessLine} open={!!open.access} onToggle={() => toggle("access")}>
        <Choice value={signupAccess} onChange={setSignupAccess} options={[
          { value: "MEMBERS", label: "Members", sub: "Anyone with a portal login at the club" },
          { value: "PUBLIC_LINK", label: "Members + public link", sub: "A shareable page anyone can register from" },
          { value: "STAFF_ONLY", label: "Staff adds people", sub: "No self-booking" },
        ]} />
        {signupAccess === "PUBLIC_LINK" && (
          <div className="rounded-xl bg-app-bg px-3 py-2.5 space-y-2">
            {ev?.publicSlug ? (
              <div>
                <p className="text-[11px] font-medium text-text-primary mb-1">Public page — share this link</p>
                <PublicLinkBox slug={ev.publicSlug} />
              </div>
            ) : (
              <p className="text-[11.5px] text-text-muted">A link is created when you save.</p>
            )}
            <Field label="Intro on the public page (optional)"><textarea value={publicFormIntro} onChange={(e) => setPublicFormIntro(e.target.value)} rows={2} className={input} /></Field>
          </div>
        )}
        {exclusions.publicLinkLocked && <Lock>{exclusions.publicLinkLocked}</Lock>}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-text-primary">Signup questions</span>
            <span className="text-[11px] text-text-muted">{categories.length + formFields.length}</span>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {/* B16 slice 1 — question TYPES, not sport-named presets. The club
                writes its own wording. A dropdown is an entry category (a coach
                can propose changing the answer); the rest are plain questions. */}
            <button type="button" onClick={() => addCategory()} className="px-2.5 py-1.5 rounded-full text-[11px] border border-app-border text-text-primary">+ Dropdown</button>
            {([["text", "Short answer"], ["textarea", "Long answer"], ["checkbox", "Checkbox"], ["email", "Email"], ["phone", "Phone"]] as [EditorFormField["type"], string][]).map(([t, l]) => (
              <button key={t} type="button" onClick={() => setFormFields((f) => [...f, { id: `f${Date.now().toString(36)}`, label: "", type: t, required: false }])} className="px-2.5 py-1.5 rounded-full text-[11px] border border-app-border text-text-primary">+ {l}</button>
            ))}
          </div>
          {categories.map((c, i) => (
            <div key={c.key} className="rounded-lg border border-app-border p-2.5 mb-2 space-y-1.5">
              <span className="block text-[10px] uppercase tracking-wide text-text-muted">Dropdown</span>
              <div className="flex gap-2">
                <input value={c.label} onChange={(e) => setCategories((cs) => cs.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)))} placeholder="Question — e.g. Division" className={input} />
                <button type="button" onClick={() => setCategories((cs) => cs.filter((_, idx) => idx !== i))} className="text-xs text-red-600 px-2">Remove</button>
              </div>
              <textarea value={c.optionsText} onChange={(e) => setCategories((cs) => cs.map((x, idx) => (idx === i ? { ...x, optionsText: e.target.value } : x)))} rows={2} placeholder={"Choices — one per line"} className={input} />
              <div className="flex flex-wrap gap-x-4">
                <label className="flex items-center gap-2 text-xs text-text-primary"><input type="checkbox" checked={c.required} onChange={(e) => setCategories((cs) => cs.map((x, idx) => (idx === i ? { ...x, required: e.target.checked } : x)))} /> Required</label>
                {allowMultipleEntries && <label className="flex items-center gap-2 text-xs text-text-primary"><input type="checkbox" checked={!!c.perEntry} onChange={(e) => setCategories((cs) => cs.map((x, idx) => (idx === i ? { ...x, perEntry: e.target.checked } : x)))} /> Ask for each entry</label>}
              </div>
            </div>
          ))}
          {formFields.map((f, i) => (
            <div key={f.id} className="rounded-lg border border-app-border p-2.5 mb-2 space-y-1.5">
              <div className="flex gap-2">
                <input value={f.label} onChange={(e) => setFormFields((fs) => fs.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)))} placeholder="Question" className={input} />
                <select value={f.type} onChange={(e) => setFormFields((fs) => fs.map((x, idx) => (idx === i ? { ...x, type: e.target.value as EditorFormField["type"] } : x)))} className="px-2 py-2 border border-app-border rounded-lg text-xs bg-surface">
                  {([["text", "Short answer"], ["textarea", "Long answer"], ["checkbox", "Checkbox"], ["email", "Email"], ["phone", "Phone"], ["select", "Dropdown"]] as [string, string][]).map(([t, l]) => <option key={t} value={t}>{l}</option>)}
                </select>
                <button type="button" onClick={() => setFormFields((fs) => fs.filter((_, idx) => idx !== i))} className="text-xs text-red-600 px-2">Remove</button>
              </div>
              {f.type === "select" && <textarea value={(f.options ?? []).join("\n")} onChange={(e) => setFormFields((fs) => fs.map((x, idx) => (idx === i ? { ...x, options: e.target.value.split("\n") } : x)))} rows={2} placeholder="One choice per line" className={input} />}
              <div className="flex flex-wrap gap-x-4">
                <label className="flex items-center gap-2 text-xs text-text-primary"><input type="checkbox" checked={f.required} onChange={(e) => setFormFields((fs) => fs.map((x, idx) => (idx === i ? { ...x, required: e.target.checked } : x)))} /> Required</label>
                {allowMultipleEntries && <label className="flex items-center gap-2 text-xs text-text-primary"><input type="checkbox" checked={!!f.perEntry} onChange={(e) => setFormFields((fs) => fs.map((x, idx) => (idx === i ? { ...x, perEntry: e.target.checked } : x)))} /> Ask for each entry</label>}
              </div>
            </div>
          ))}
        </div>
        {approvalAvailable ? (
          <div className="rounded-xl border border-app-border p-3 space-y-2.5">
            <Switch on={approvalOn} onChange={(v) => setApprovalMode(v ? "on" : "off")} label="A coach approves each signup" sub={approvalMode === "" ? `Using the type default (${typeSaysApproval ? "on" : "off"})` : undefined} />
            {approvalOn && (
              <>
                <Field label="Responsible coach">
                  <select value={responsibleCoachUserId} onChange={(e) => setResponsibleCoachUserId(e.target.value)} className={input}>
                    <option value="">Any staff with events access</option>
                    {staffList.map((s) => <option key={s.id} value={s.id}>{s.firstName} {s.lastName}</option>)}
                  </select>
                </Field>
                <label className="flex items-start gap-2 text-sm text-text-primary min-h-[44px]"><input type="checkbox" className="mt-1" checked={approvalIntent === "APPROVAL_CHARGE"} onChange={(e) => setApprovalIntent(e.target.checked ? "APPROVAL_CHARGE" : "")} /><span>Charge their saved card the moment I approve<span className="block text-[11px] text-text-muted">Turns off “Card at signup”.</span></span></label>
                <label className="flex items-center gap-2 text-sm text-text-primary min-h-[44px]"><input type="checkbox" checked={allowProposals} onChange={(e) => setAllowProposals(e.target.checked)} /> Let coaches propose a change</label>
                <label className="flex items-center gap-2 text-sm text-text-primary min-h-[44px]"><input type="checkbox" checked={holdSpotDuringReview} onChange={(e) => setHoldSpotDuringReview(e.target.checked)} /> Hold a spot while reviewing</label>
                <div className="pt-1 border-t border-app-border space-y-2">
                  <Switch on={escalationEnabled} onChange={setEscalationEnabled} label="Payment reminders" sub="Nudges on a schedule around the deadline" />
                  {escalationEnabled && (
                    <div className="grid grid-cols-2 gap-2">
                      <select value={escalationAnchor} onChange={(e) => setEscalationAnchor(e.target.value)} className={input}>
                        <option value="registrationDeadline">From payment due date</option>
                        <option value="eventStart">From event start</option>
                        <option value="autoChargeDate">From auto-charge date</option>
                      </select>
                      <select value={escalationSchedule} onChange={(e) => setEscalationSchedule(e.target.value)} className={input}>
                        {(Object.keys(ESCALATION_SCHEDULE_DAYS) as EscalationSchedule[]).map((k) => <option key={k} value={k}>{k.replace("_", " ").toLowerCase()} ({ESCALATION_SCHEDULE_DAYS[k as Exclude<EscalationSchedule, "CUSTOM">].join(", ")})</option>)}
                        <option value="CUSTOM">custom</option>
                      </select>
                      {escalationSchedule === "CUSTOM" && <input value={escalationCustomDays} onChange={(e) => setEscalationCustomDays(e.target.value)} placeholder="-14, -7, -1, 0" className={`${input} col-span-2`} />}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-text-muted">Coach approval is available on tournaments and on custom types with a policy (Events → Manage types).</p>
        )}
      </Card>

      <Card
        title="Roster & entries"
        summary={`${!rosterLoaded ? "Loading…" : rosterCols.length && rosterRows.length ? `${rosterCols.length} roster${rosterCols.length === 1 ? "" : "s"} × ${rosterRows.length} position${rosterRows.length === 1 ? "" : "s"}` : "No roster"}${allowMultipleEntries ? ` · up to ${maxEntries || 5} entries each` : ""}`}
        open={!!open.roster} onToggle={() => toggle("roster")}
      >
        <p className="text-[11px] text-text-muted">
          Families pick one spot when they sign up. <strong>Rosters</strong> are the columns of your grid (e.g. divisions, skill levels);
          <strong> positions</strong> are the rows (e.g. weights, positions). Capacity is per spot — a position&apos;s capacity applies inside each roster.
          {approvalOn ? " A full spot can still be requested — it goes on the waitlist for you to decide." : " A full spot can't be picked."}
        </p>
        {rosterCols.length === 0 && rosterRows.length === 0 && categories.filter((c) => c.optionsText.trim()).length >= 2 && (
          <button type="button" onClick={rosterFromDropdowns} className="w-full text-left rounded-xl border border-brand/40 bg-brand/5 px-3 py-2.5 text-xs text-text-primary">
            <span className="font-medium text-brand">Build the roster from your dropdowns</span>
            <span className="block text-text-muted mt-0.5">
              Turns &quot;{categories.filter((c) => c.optionsText.trim())[0]?.label}&quot; and &quot;{categories.filter((c) => c.optionsText.trim())[1]?.label}&quot; into rosters and positions and removes them from the questions. Anyone already registered is placed on the grid from their answers when you save.
            </span>
          </button>
        )}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-text-primary">Rosters (columns)</span>
            <button type="button" onClick={() => editRoster(() => setRosterCols((c) => [...c, { id: null, label: "" }]))} className="text-xs text-brand font-medium min-h-[36px]">+ Roster</button>
          </div>
          {rosterCols.map((r, i) => (
            <div key={r.id ?? `new-${i}`} className="flex gap-2 mb-1.5">
              <input value={r.label} onChange={(e) => editRoster(() => setRosterCols((c) => c.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x))))} placeholder="Roster name — e.g. Advanced" className={input} />
              <button type="button" onClick={() => editRoster(() => setRosterCols((c) => c.filter((_, idx) => idx !== i)))} className="text-xs text-red-600 px-2">Remove</button>
            </div>
          ))}
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-text-primary">Positions (rows)</span>
            <button type="button" onClick={() => editRoster(() => setRosterRows((c) => [...c, { id: null, label: "", capacity: "", rosters: [] }]))} className="text-xs text-brand font-medium min-h-[36px]">+ Position</button>
          </div>
          {rosterRows.length > 0 && (
            <div className="grid grid-cols-[1fr_88px_auto] gap-1.5 items-center text-[10px] uppercase tracking-wide text-text-muted mb-1">
              <span>Position</span><span>Capacity</span><span />
            </div>
          )}
          {rosterRows.map((p, i) => {
            const liveCols = rosterCols.filter((r) => r.label.trim());
            const isOn = (l: string) => p.rosters.length === 0 || p.rosters.some((x) => x.toLowerCase() === l.trim().toLowerCase());
            const toggleCol = (l: string) => editRoster(() => setRosterRows((c) => c.map((x, idx) => {
              if (idx !== i) return x;
              const all = liveCols.map((r) => r.label.trim());
              const current = x.rosters.length === 0 ? all : x.rosters;
              const next = current.some((y) => y.toLowerCase() === l.toLowerCase()) ? current.filter((y) => y.toLowerCase() !== l.toLowerCase()) : [...current, l];
              if (next.length === 0) return x; // at least one roster
              return { ...x, rosters: next.length === all.length ? [] : next };
            })));
            return (
              <div key={p.id ?? `new-${i}`} className="mb-2">
                <div className="grid grid-cols-[1fr_88px_auto] gap-1.5 items-center">
                  <input value={p.label} onChange={(e) => editRoster(() => setRosterRows((c) => c.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x))))} placeholder="Position name" className={input} />
                  <input value={p.capacity} inputMode="numeric" onChange={(e) => editRoster(() => setRosterRows((c) => c.map((x, idx) => (idx === i ? { ...x, capacity: e.target.value.replace(/[^0-9]/g, "") } : x))))} placeholder="No limit" className={input} />
                  <button type="button" onClick={() => editRoster(() => setRosterRows((c) => c.filter((_, idx) => idx !== i)))} className="text-xs text-red-600 px-2">Remove</button>
                </div>
                {liveCols.length > 1 && (
                  <div className="flex flex-wrap items-center gap-1 mt-1">
                    <span className="text-[10px] text-text-muted mr-0.5">In:</span>
                    {liveCols.map((r) => {
                      const on = isOn(r.label);
                      return (
                        <button key={r.id ?? r.label} type="button" onClick={() => toggleCol(r.label.trim())} aria-pressed={on}
                          className={`text-[10px] px-2 py-0.5 rounded-full border ${on ? "border-brand bg-brand/10 text-brand font-medium" : "border-app-border text-text-muted line-through"}`}>
                          {r.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          {rosterRows.length > 0 && rosterCols.filter((r) => r.label.trim()).length > 1 && (
            <button type="button" onClick={() => {
              const labels = rosterCols.map((r) => r.label.trim()).filter(Boolean);
              editRoster(() => setRosterRows((c) => c.map((x) => ({ ...x, rosters: rostersNamedInLabel(x.label, labels) }))));
            }} className="text-[11px] text-brand mr-3">Match rosters to position names</button>
          )}
          <details className="mt-1">
            <summary className="text-[11px] text-brand cursor-pointer">Paste many positions at once</summary>
            <textarea value={pasteRows} onChange={(e) => setPasteRows(e.target.value)} rows={4} placeholder={"One per line"} className={`${input} mt-1.5`} />
            <button type="button" onClick={() => {
              const labels = pasteRows.split("\n").map((x) => x.trim()).filter(Boolean);
              if (!labels.length) return;
              editRoster(() => setRosterRows((c) => [...c, ...labels.filter((l) => !c.some((x) => x.label.toLowerCase() === l.toLowerCase())).map((label) => ({ id: null, label, capacity: "", rosters: rostersNamedInLabel(label, rosterCols.map((r) => r.label.trim()).filter(Boolean)) }))]));
              setPasteRows("");
            }} className="mt-1.5 text-xs px-3 py-1.5 rounded-lg border border-app-border text-text-primary">Add these</button>
          </details>
          {rosterRows.length > 1 && (
            <button type="button" onClick={() => {
              const v = window.prompt("Capacity for every position (blank = no limit)", "1");
              if (v === null) return;
              const n = v.replace(/[^0-9]/g, "");
              editRoster(() => setRosterRows((c) => c.map((x) => ({ ...x, capacity: n }))));
            }} className="mt-1.5 ml-2 text-[11px] text-brand">Set every capacity…</button>
          )}
        </div>
        <div className="rounded-xl border border-app-border p-3 space-y-2.5">
          <Switch
            on={allowMultipleEntries}
            onChange={setAllowMultipleEntries}
            label="Allow more than one entry per athlete"
            sub="The family sees “+ Add another entry” for the same athlete — e.g. two divisions. Still one registration, one payment, one approval."
          />
          {allowMultipleEntries && (
            <>
              <Field label="Most entries per athlete" hint="Blank = 5">
                <input value={maxEntries} inputMode="numeric" onChange={(e) => setMaxEntries(e.target.value.replace(/[^0-9]/g, ""))} placeholder="5" className={input} />
              </Field>
              <div>
                <span className="block text-xs font-medium text-text-primary mb-1">Extra entries cost</span>
                <div className="flex gap-1.5 flex-wrap">
                  <button type="button" onClick={() => setExtraEntryPriced(false)} className={`text-xs px-2.5 py-1.5 rounded-lg border ${!extraEntryPriced ? "border-brand bg-brand/10 text-brand font-medium" : "border-app-border text-text-primary"}`}>The same as the first</button>
                  <button type="button" onClick={() => setExtraEntryPriced(true)} className={`text-xs px-2.5 py-1.5 rounded-lg border ${extraEntryPriced ? "border-brand bg-brand/10 text-brand font-medium" : "border-app-border text-text-primary"}`}>A different price</button>
                </div>
                {extraEntryPriced && (
                  <input value={additionalEntryPrice} inputMode="decimal" onChange={(e) => setAdditionalEntryPrice(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="Price for each extra entry, e.g. 40" className={`${input} mt-1.5`} />
                )}
              </div>
              {rosterCols.length > 0 && (
                <Switch on={allowSameRosterTwice} onChange={setAllowSameRosterTwice} label="Allow two entries in the same roster" sub="Off: each entry must be in a different roster (e.g. one per division)." />
              )}
              {signupAccess === "PUBLIC_LINK" && (
                <Switch on={entriesOnPublicLink} onChange={setEntriesOnPublicLink} label="Allow extra entries on the public link too" sub="Off: the public link takes one entry; families add more from their account." />
              )}
              <p className="text-[11px] text-text-muted">Questions marked “Ask for each entry” (in Who signs up) are asked again for every entry.</p>
            </>
          )}
        </div>
        {isEdit && rosterCols.length > 0 && rosterRows.length > 0 && !rosterDirty && (
          <a href={`/dashboard/events/${ev!.id}/roster`} className="inline-block text-xs text-brand font-medium">Open the roster grid →</a>
        )}
      </Card>

      <Card title="Capacity, dates & policy" summary={capacityLine} open={!!open.capacity} onToggle={() => toggle("capacity")}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Capacity" hint="Blank = unlimited"><input type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} className={input} /></Field>
          <Field label="Payment due by"><input type="date" value={paymentDueBy} onChange={(e) => setPaymentDueBy(e.target.value)} className={input} /></Field>
        </div>
        <Field label="Cancellation policy" hint="Shown to families before they sign up."><textarea value={cancellationPolicyText} onChange={(e) => setCancellationPolicyText(e.target.value)} rows={2} className={input} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Publish at" hint="Hidden until then"><input type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} className={input} /></Field>
          <Field label="Unpublish at"><input type="datetime-local" value={unpublishAt} onChange={(e) => setUnpublishAt(e.target.value)} className={input} /></Field>
        </div>
      </Card>

      <Card title="Staff on this event" summary={staffLine} open={!!open.staff} onToggle={() => toggle("staff")}>
        {staffList.length === 0 ? <p className="text-[11px] text-text-muted">No staff yet.</p> : (
          <div className="flex flex-wrap gap-1.5">
            {staffList.map((s) => (
              <button key={s.id} type="button" onClick={() => toggleStaff(s.id)} className={`px-3 py-2 rounded-full text-xs border min-h-[36px] ${staffUserIds.includes(s.id) ? "border-brand bg-brand/10 text-brand font-medium" : "border-app-border text-text-primary"}`}>{s.firstName} {s.lastName}</button>
            ))}
          </div>
        )}
        <p className="text-[11px] text-text-muted">Payroll follows this roster (Event payroll on the event row).</p>
      </Card>
    </>
  );

  const preview = (
    <aside className="rounded-[14px] p-4 space-y-3" style={{ background: "#FAFAFB" }}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">What a family sees</p>
      <div className="bg-surface border border-app-border rounded-xl overflow-hidden">
        {imageUrl ? <img src={imageUrl} alt="" className="w-full h-24 object-cover" style={{ objectPosition: `${imagePositionX}% ${imagePositionY}%` }} /> : <div className="h-12 bg-app-bg" />}
        <div className="p-3 space-y-2">
          <p className="text-sm font-semibold text-text-primary">{name || "Event name"}</p>
          <p className="text-[11.5px] text-text-muted">{dateRange}{sessions.length > 1 ? ` · ${sessions.length} sessions` : ""}</p>
          {previewPrice.map((r) => (
            <div key={r.label} className="flex justify-between text-xs"><span className="text-text-muted">{r.label}</span><span className="font-semibold text-text-primary">{r.value}</span></div>
          ))}
          {coveredNames.length > 0 && <p className="text-[11px] text-text-muted">Included with {coveredNames.join(", ")}.</p>}
          <p className="text-[11px] text-text-muted">{approvalOn ? "A coach confirms your spot." : exclusions.paymentMethodsLocked ? (pricingModel === "SPLIT" ? "Your share is invoiced after the event." : "Nothing to pay.") : `Pay by ${payLine}.`}</p>
          <span className="block text-center text-xs font-semibold text-white rounded-lg py-2" style={{ background: "#6D5DF6" }}>{cta}</span>
        </div>
      </div>
      <div className="rounded-xl px-3 py-2.5 text-[11.5px]" style={conflict ? { background: "var(--color-warn-surface, #FFF7ED)", color: "var(--color-warn-text, #9A3412)" } : { background: "#F1F1F3", color: "#6B7280" }}>
        {conflict ?? "Nothing conflicts right now."}
      </div>
    </aside>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end lg:items-center justify-center p-0 lg:p-4" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="bg-app-bg w-full h-[100dvh] lg:h-auto lg:max-h-[92vh] lg:max-w-[900px] lg:rounded-2xl flex flex-col overflow-hidden"
      >
        <header className="shrink-0 bg-surface border-b border-app-border px-4 py-3 pt-[max(12px,env(safe-area-inset-top))]">
          <div className="flex items-center justify-between">
            <button type="button" onClick={onClose} className="text-sm text-brand min-h-[44px] md:min-h-0">Cancel</button>
            <span className="text-base font-semibold text-text-primary">{isEdit ? "Edit event" : "New event"}</span>
            <button type="submit" disabled={saving} className="text-sm font-semibold text-brand min-h-[44px] md:min-h-0 disabled:opacity-50">{saving ? "Saving…" : "Save"}</button>
          </div>
          <p className="text-center text-[11.5px] text-text-muted mt-0.5 truncate">{name || "Untitled"} · {dateRange}{isEdit ? ` · ${signedUp} signed up` : ""}</p>
        </header>
        {error && <div className="shrink-0 px-4 pt-3"><Problem>{error}</Problem></div>}
        <div className="flex-1 overflow-y-auto p-3.5 lg:p-5">
          <div className="lg:grid lg:grid-cols-[1fr_316px] lg:gap-5 lg:items-start">
            <div className="flex flex-col gap-2.5">{cards}</div>
            <div className="hidden lg:block sticky top-0">{preview}</div>
          </div>
        </div>
        <footer className="shrink-0 bg-surface border-t border-app-border px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))] flex items-center justify-between gap-3 lg:hidden">
          <span className="text-[11.5px] text-text-muted truncate">{conflict ?? moneyLine}</span>
          <button type="submit" disabled={saving} className="shrink-0 text-sm font-semibold px-4 py-2 bg-brand text-white rounded-lg disabled:opacity-50 min-h-[44px]">{saving ? "Saving…" : "Save event"}</button>
        </footer>
      </form>
    </div>
  );
}
