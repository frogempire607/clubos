"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useSession } from "next-auth/react";
import {
  PRIVATE_DURATION_OPTIONS,
  privateDurationLabel,
  packageLessonTypeIds,
  normalizePricingMode,
  packageTotalForBasePrice,
  type PricingMode,
} from "@/lib/privateLessonRules";
import { hasPermission } from "@/lib/permissions";

// ─── Types ────────────────────────────────────────────────────────────────────

type PriceOption = {
  id: string;
  label: string;
  price: number;
  coachIds: string[];
  // Who may pick this option in the member portal: everyone (default),
  // active members only, or non-members only. Stored in the priceOptions JSON.
  audience?: "ALL" | "MEMBER" | "NON_MEMBER";
};

type LessonType = {
  id: string;
  title: string;
  description: string | null;
  durationMin: number;
  maxAthletes: number;
  basePrice: number;
  coachTierLabel: string | null;
  eligibleCoachIds: string[];
  priceOptions: PriceOption[];
  active: boolean;
  sortOrder: number;
};

type Package = {
  id: string;
  title: string;
  description: string | null;
  lessonTypeId: string | null;
  lessonTypeIds: string[];
  lessonType: { title: string } | null;
  credits: number;
  bonusCredits: number;
  pricingMode: PricingMode | string;
  discountValue: number | null;
  price: number;
  expiresAfterDays: number | null;
  active: boolean;
  publishedToMembers: boolean;
};

type Partner = {
  id: string;
  kind: "MEMBER" | "OUTSIDE" | "NEEDS_HELP" | string;
  status: "PENDING_COACH" | "INVITED" | "CONFIRMED" | "DECLINED" | string;
  memberId: string | null;
  outsideName: string | null;
  outsideEmail: string | null;
  outsidePhone: string | null;
  inviteToken: string | null;
  confirmedAt: string | null;
  notes: string | null;
  member: { id: string; firstName: string; lastName: string; email: string | null } | null;
};

type Booking = {
  id: string;
  status: string;
  requestedSlots: { date: string; startTime: string; endTime: string }[];
  confirmedStartAt: string | null;
  confirmedEndAt: string | null;
  paymentType: string | null;
  pricePaid: number | null;
  ownerApproved: boolean;
  cancelReason: string | null;
  notes: string | null;
  createdAt: string;
  member: { id: string; firstName: string; lastName: string; email: string };
  lessonType: { id: string; title: string; durationMin: number; basePrice: number; maxAthletes: number };
  coach: { id: string; firstName: string; lastName: string } | null;
  creditLedger: { creditsGranted: number; creditsUsed: number; expiresAt: string | null } | null;
  partners: Partner[];
};

type Member = { id: string; firstName: string; lastName: string; email: string };
type Staff  = { id: string; firstName: string; lastName: string };

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readListResponse<T>(res: Response, label: string): Promise<{ items: T[]; error: string | null }> {
  const text = await res.text();
  if (!text) {
    return { items: [], error: res.ok ? null : `${label} could not be loaded.` };
  }

  try {
    const data: unknown = JSON.parse(text);
    if (!res.ok) {
      const message =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `${label} could not be loaded.`;
      return { items: [], error: message };
    }
    return { items: Array.isArray(data) ? (data as T[]) : [], error: null };
  } catch {
    return { items: [], error: `${label} returned an invalid response.` };
  }
}

const STATUS_COLORS: Record<string, string> = {
  REQUESTED:     "bg-orange-accent text-white",
  PENDING_COACH: "bg-brand text-white",
  CONFIRMED:     "bg-lime-accent text-text-primary",
  DECLINED:      "bg-red-100 text-red-800",
  CANCELED:      "bg-app-bg text-text-muted",
  COMPLETED:     "bg-brand text-white",
};

const STATUS_LABEL: Record<string, string> = {
  REQUESTED:     "Requested",
  PENDING_COACH: "With Coach",
  CONFIRMED:     "Confirmed",
  DECLINED:      "Declined",
  CANCELED:      "Canceled",
  COMPLETED:     "Completed",
};

const PARTNER_KIND_LABEL: Record<string, string> = {
  MEMBER:     "Member",
  OUTSIDE:    "Outside",
  NEEDS_HELP: "Needs partner",
};

const PARTNER_STATUS_LABEL: Record<string, string> = {
  PENDING_COACH: "Pending coach",
  INVITED:       "Invited",
  CONFIRMED:     "Confirmed",
  DECLINED:      "Declined",
};

const PARTNER_STATUS_STYLE: Record<string, string> = {
  PENDING_COACH: "bg-amber-50 text-amber-700 border-amber-200",
  INVITED:       "bg-app-bg text-text-muted border-app-border",
  CONFIRMED:     "bg-lime-accent text-text-primary border-lime-accent",
  DECLINED:      "bg-red-50 text-red-700 border-red-200",
};

function partnerHeadline(p: Partner): string {
  if (p.kind === "NEEDS_HELP") return "Needs help finding partner";
  if (p.kind === "OUTSIDE") return p.outsideName ? `${p.outsideName} (outside)` : "Outside partner";
  if (p.member) return `${p.member.firstName} ${p.member.lastName}`;
  return "Partner";
}

function fmt(dateStr: string) {
  // hour12 is set explicitly so the value never falls back to military time
  // when the OS locale prefers 24h — the owner-facing UI is always AM/PM.
  return new Date(dateStr).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// Friendly label for a requested-slot row, e.g.
//   "Thu, Jun 15 · 2:30 PM – 3:30 PM"
// Inputs come from the booking form as ISO date ("YYYY-MM-DD") and 24h
// time strings ("HH:mm"). We re-parse them into a Date so toLocaleString
// can render them in the owner's locale with AM/PM.
function formatRequestedSlot(s: { date: string; startTime: string; endTime: string }) {
  const start = new Date(`${s.date}T${s.startTime}`);
  const end = new Date(`${s.date}T${s.endTime}`);
  if (Number.isNaN(start.getTime())) return `${s.date} · ${s.startTime}–${s.endTime}`;
  const datePart = start.toLocaleDateString([], {
    weekday: "short", month: "short", day: "numeric",
  });
  const timeOpts: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit", hour12: true };
  return `${datePart} · ${start.toLocaleTimeString([], timeOpts)} – ${end.toLocaleTimeString([], timeOpts)}`;
}

// Combine an ISO date + "HH:mm" time into the value an <input
// type="datetime-local"> wants: "YYYY-MM-DDTHH:mm". Pre-fills the
// confirm form so the owner can hit Confirm with one click.
function combineToLocalInput(date: string, time: string): string | null {
  if (!date || !time) return null;
  return `${date}T${time.length === 5 ? time : time.padStart(5, "0")}`;
}

// ─── LessonTypeModal ─────────────────────────────────────────────────────────

function LessonTypeModal({
  lt,
  staffList,
  onClose,
  onSave,
}: {
  lt: LessonType | null;
  staffList: Staff[];
  onClose: () => void;
  onSave: () => void;
}) {
  const [form, setForm] = useState({
    title:           lt?.title ?? "",
    description:     lt?.description ?? "",
    durationMin:     String(lt?.durationMin ?? 60),
    maxAthletes:     String(lt?.maxAthletes ?? 1),
    basePrice:       String(lt?.basePrice ?? ""),
    coachTierLabel:  lt?.coachTierLabel ?? "",
    eligibleCoachIds: lt?.eligibleCoachIds ?? [] as string[],
    active:          lt?.active ?? true,
    sortOrder:       String(lt?.sortOrder ?? 0),
  });
  const [priceOptions, setPriceOptions] = useState<PriceOption[]>(
    lt?.priceOptions?.length ? lt.priceOptions : [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");

  function toggleCoach(id: string) {
    setForm((f) => ({
      ...f,
      eligibleCoachIds: f.eligibleCoachIds.includes(id)
        ? f.eligibleCoachIds.filter((c) => c !== id)
        : [...f.eligibleCoachIds, id],
    }));
  }

  function addOption() {
    setPriceOptions((opts) => [
      ...opts,
      { id: `opt_${Date.now()}_${opts.length}`, label: "", price: 0, coachIds: [] },
    ]);
  }
  function updateOption(id: string, patch: Partial<PriceOption>) {
    setPriceOptions((opts) => opts.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  }
  function removeOption(id: string) {
    setPriceOptions((opts) => opts.filter((o) => o.id !== id));
  }
  function toggleOptionCoach(optId: string, coachId: string) {
    setPriceOptions((opts) =>
      opts.map((o) =>
        o.id === optId
          ? {
              ...o,
              coachIds: o.coachIds.includes(coachId)
                ? o.coachIds.filter((c) => c !== coachId)
                : [...o.coachIds, coachId],
            }
          : o,
      ),
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body = {
        title:           form.title,
        description:     form.description || null,
        durationMin:     parseInt(form.durationMin),
        maxAthletes:     parseInt(form.maxAthletes),
        basePrice:       parseFloat(form.basePrice),
        coachTierLabel:  form.coachTierLabel || null,
        eligibleCoachIds: form.eligibleCoachIds,
        priceOptions:    priceOptions
          .filter((o) => o.label.trim())
          .map((o) => ({
            id: o.id,
            label: o.label.trim(),
            price: Number(o.price) || 0,
            coachIds: o.coachIds,
            audience: o.audience ?? "ALL",
          })),
        active:          form.active,
        sortOrder:       parseInt(form.sortOrder),
      };
      const url    = lt ? `/api/private-lessons/types/${lt.id}` : "/api/private-lessons/types";
      const method = lt ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { const d = await res.json(); setError(d.error || "Error"); return; }
      onSave();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-border">
          <h2 className="font-semibold text-text-primary">{lt ? "Edit lesson type" : "New lesson type"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-muted text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">{error}</p>}

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Title *</label>
            <input className="w-full border border-app-border rounded-md px-3 py-2 text-sm" required
              value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Description</label>
            <textarea className="w-full border border-app-border rounded-md px-3 py-2 text-sm" rows={2}
              value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Duration</label>
              <select className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: e.target.value })}>
                {PRIVATE_DURATION_OPTIONS.map((min) => (
                  <option key={min} value={min}>{privateDurationLabel(min)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Max athletes</label>
              <input type="number" min={1} className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                value={form.maxAthletes} onChange={(e) => setForm({ ...form, maxAthletes: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Base price ($)</label>
              <input type="number" min={0} step="0.01" className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                value={form.basePrice} onChange={(e) => setForm({ ...form, basePrice: e.target.value })} />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Coach tier label</label>
              <input className="w-full border border-app-border rounded-md px-3 py-2 text-sm" placeholder="e.g. Black Belt"
                value={form.coachTierLabel} onChange={(e) => setForm({ ...form, coachTierLabel: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Sort order</label>
              <input type="number" className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: e.target.value })} />
            </div>
          </div>

          {staffList.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-text-muted mb-2">Eligible coaches</label>
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {staffList.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" checked={form.eligibleCoachIds.includes(s.id)} onChange={() => toggleCoach(s.id)} />
                    {s.firstName} {s.lastName}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-app-border pt-4">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-text-muted">
                Purchase options
              </label>
              <button type="button" onClick={addOption}
                className="text-xs px-2 py-1 rounded-md border border-app-border text-text-primary hover:bg-app-bg">
                + Add option
              </button>
            </div>
            <p className="text-xs text-text-muted mb-3">
              Offer this lesson type at different prices (e.g. tiers of coach). Each
              option can be limited to specific coaches. Leave empty to just use the
              base price &amp; eligible coaches above.
            </p>
            <div className="space-y-3">
              {priceOptions.map((o) => (
                <div key={o.id} className="border border-app-border rounded-lg p-3 space-y-2">
                  <div className="flex gap-2">
                    <input
                      className="flex-1 border border-app-border rounded-md px-3 py-2 text-sm"
                      placeholder="Option name (e.g. With a Head Coach)"
                      value={o.label}
                      onChange={(e) => updateOption(o.id, { label: e.target.value })}
                    />
                    <input
                      type="number" min={0} step="0.01"
                      className="w-28 border border-app-border rounded-md px-3 py-2 text-sm"
                      placeholder="Price"
                      value={o.price || ""}
                      onChange={(e) => updateOption(o.id, { price: parseFloat(e.target.value) || 0 })}
                    />
                    <button type="button" onClick={() => removeOption(o.id)}
                      className="px-2 text-text-muted hover:text-red-600" aria-label="Remove option">
                      ×
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-text-muted">Who can pick this rate:</label>
                    <select
                      value={o.audience ?? "ALL"}
                      onChange={(e) => updateOption(o.id, { audience: e.target.value as PriceOption["audience"] })}
                      className="border border-app-border rounded-md px-2 py-1 text-xs bg-surface"
                    >
                      <option value="ALL">Everyone</option>
                      <option value="MEMBER">Active members only</option>
                      <option value="NON_MEMBER">Non-members only</option>
                    </select>
                  </div>
                  {staffList.length > 0 && (
                    <div>
                      <p className="text-[11px] text-text-muted mb-1">
                        Coaches for this option {o.coachIds.length === 0 ? "(any eligible coach)" : ""}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {staffList.map((s) => {
                          const on = o.coachIds.includes(s.id);
                          return (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() => toggleOptionCoach(o.id, s.id)}
                              className={`text-xs px-2 py-1 rounded-full border transition ${
                                on
                                  ? "border-brand bg-brand text-white"
                                  : "border-app-border text-text-muted hover:bg-app-bg"
                              }`}
                            >
                              {s.firstName} {s.lastName}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {priceOptions.length === 0 && (
                <p className="text-xs text-text-muted italic">No extra options — base price applies.</p>
              )}
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Active (visible for booking)
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-app-border rounded-md text-text-primary hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-brand text-white rounded-md hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : lt ? "Save changes" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── PackageModal ─────────────────────────────────────────────────────────────

function PackageModal({
  pkg,
  lessonTypes,
  onClose,
  onSave,
}: {
  pkg: Package | null;
  lessonTypes: LessonType[];
  onClose: () => void;
  onSave: () => void;
}) {
  const [form, setForm] = useState({
    title:            pkg?.title ?? "",
    description:      pkg?.description ?? "",
    lessonTypeIds:    packageLessonTypeIds(pkg?.lessonTypeIds, pkg?.lessonTypeId),
    credits:          String(pkg?.credits ?? ""),
    bonusCredits:     String(pkg?.bonusCredits ?? 0),
    pricingMode:      normalizePricingMode(pkg?.pricingMode),
    discountValue:    String(pkg?.discountValue ?? ""),
    price:            String(pkg?.price ?? ""),
    expiresAfterDays: String(pkg?.expiresAfterDays ?? ""),
    active:           pkg?.active ?? true,
    // Owner opt-in for the member-facing package shop. Defaults to true
    // on NEW packages so members see them immediately (the common case);
    // existing packages keep whatever the owner already set.
    publishedToMembers: pkg?.publishedToMembers ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");

  // Tier-aware pricing preview: for each lesson type the package covers,
  // show what the buyer will pay for each priceOption tier.
  const previewTypes = useMemo(() => {
    const ids = form.lessonTypeIds.length ? form.lessonTypeIds : lessonTypes.map((lt) => lt.id);
    return lessonTypes.filter((lt) => ids.includes(lt.id));
  }, [form.lessonTypeIds, lessonTypes]);

  const previewCredits = parseInt(form.credits) || 0;
  const previewBonus = parseInt(form.bonusCredits) || 0;
  const previewDiscount = parseFloat(form.discountValue) || 0;
  const previewFlatPrice = parseFloat(form.price) || 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body = {
        title:            form.title,
        description:      form.description || null,
        lessonTypeId:     form.lessonTypeIds.length === 1 ? form.lessonTypeIds[0] : null,
        lessonTypeIds:    form.lessonTypeIds,
        credits:          parseInt(form.credits),
        bonusCredits:     parseInt(form.bonusCredits) || 0,
        pricingMode:      form.pricingMode,
        discountValue:    form.pricingMode === "FLAT" ? null : parseFloat(form.discountValue) || 0,
        price:            parseFloat(form.price) || 0,
        expiresAfterDays: form.expiresAfterDays ? parseInt(form.expiresAfterDays) : null,
        active:           form.active,
        publishedToMembers: form.publishedToMembers,
      };
      const url    = pkg ? `/api/private-lessons/packages/${pkg.id}` : "/api/private-lessons/packages";
      const method = pkg ? "PATCH" : "POST";
      const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) { const d = await res.json(); setError(d.error || "Error"); return; }
      onSave();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      {/* max-h + overflow on the OUTER card so the modal stays inside the
          viewport and the Save button at the bottom is always reachable
          on laptop screens. */}
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-border sticky top-0 bg-white z-10">
          <h2 className="font-semibold text-text-primary">{pkg ? "Edit package" : "New package"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-muted text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">{error}</p>}

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Title *</label>
            <input className="w-full border border-app-border rounded-md px-3 py-2 text-sm" required
              value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Lesson types</label>
            <div className="border border-app-border rounded-md p-2 max-h-40 overflow-y-auto space-y-1.5">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.lessonTypeIds.length === 0}
                  onChange={() => setForm({ ...form, lessonTypeIds: [] })}
                />
                Any lesson type
              </label>
              {lessonTypes.map((lt) => {
                const checked = form.lessonTypeIds.includes(lt.id);
                return (
                  <label key={lt.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setForm({
                        ...form,
                        lessonTypeIds: checked
                          ? form.lessonTypeIds.filter((id) => id !== lt.id)
                          : [...form.lessonTypeIds, lt.id],
                      })}
                    />
                    {lt.title}
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-text-muted mt-1">
              Select one or more lesson types this package can be used for.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Description</label>
            <textarea className="w-full border border-app-border rounded-md px-3 py-2 text-sm" rows={2}
              value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Lessons included *</label>
              <input type="number" min={1} required className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                value={form.credits} onChange={(e) => setForm({ ...form, credits: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Bonus lessons</label>
              <input type="number" min={0} className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                value={form.bonusCredits} onChange={(e) => setForm({ ...form, bonusCredits: e.target.value })} />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Pricing model</label>
            <div className="grid grid-cols-3 gap-2">
              {(["FLAT", "PERCENT", "FIXED"] as PricingMode[]).map((m) => (
                <button
                  type="button"
                  key={m}
                  onClick={() => setForm({ ...form, pricingMode: m })}
                  className={`text-xs px-2 py-2 rounded-lg border ${
                    form.pricingMode === m
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-app-border text-text-primary hover:bg-app-bg"
                  }`}
                >
                  {m === "FLAT" ? "Flat total" : m === "PERCENT" ? "% off per lesson" : "$ off per lesson"}
                </button>
              ))}
            </div>
            <p className="text-xs text-text-muted mt-1">
              {form.pricingMode === "FLAT"
                ? "Prepaid total covers all lessons."
                : form.pricingMode === "PERCENT"
                  ? "Discount applies to each lesson type / coach tier price the package covers."
                  : "Fixed dollar amount comes off each lesson's tier price."}
            </p>
          </div>

          {form.pricingMode === "FLAT" ? (
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Price ($) *</label>
              <input
                type="number" min={0} step="0.01" required
                className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })}
              />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">
                {form.pricingMode === "PERCENT" ? "Discount % per lesson *" : "Discount $ per lesson *"}
              </label>
              <input
                type="number"
                min={0}
                step={form.pricingMode === "PERCENT" ? "1" : "0.01"}
                max={form.pricingMode === "PERCENT" ? 100 : undefined}
                required
                className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                value={form.discountValue}
                onChange={(e) => setForm({ ...form, discountValue: e.target.value })}
              />
              <p className="text-xs text-text-muted mt-1">
                Charged total = (tier price {form.pricingMode === "PERCENT" ? `× ${previewDiscount}%` : `− $${previewDiscount.toFixed(2)}`}) × {previewCredits || "?"} lessons.
              </p>
            </div>
          )}

          {/* Tier-aware pricing preview */}
          {form.pricingMode !== "FLAT" && previewTypes.length > 0 && previewCredits > 0 && (previewDiscount > 0) && (
            <div className="border border-app-border rounded-md p-3 bg-app-bg/40">
              <p className="text-[11px] uppercase tracking-wider text-text-muted font-medium mb-2">Pricing preview</p>
              <div className="space-y-3 max-h-48 overflow-y-auto">
                {previewTypes.map((lt) => {
                  const opts = lt.priceOptions ?? [];
                  const tiers: { label: string; basePrice: number }[] = opts.length
                    ? opts.map((o) => ({ label: o.label, basePrice: Number(o.price) }))
                    : [{ label: "Base price", basePrice: Number(lt.basePrice) }];
                  return (
                    <div key={lt.id}>
                      <p className="text-xs font-medium text-text-primary mb-1">{lt.title}</p>
                      <ul className="text-xs text-text-muted space-y-0.5">
                        {tiers.map((t, i) => {
                          const total = packageTotalForBasePrice(
                            {
                              pricingMode: form.pricingMode,
                              discountValue: previewDiscount,
                              price: previewFlatPrice,
                              credits: previewCredits,
                              bonusCredits: previewBonus,
                            },
                            t.basePrice,
                          );
                          const perLesson = previewCredits > 0 ? total / previewCredits : 0;
                          return (
                            <li key={i} className="flex justify-between">
                              <span>{t.label} (${t.basePrice.toFixed(2)})</span>
                              <span className="text-text-primary">
                                ${total.toFixed(2)} <span className="text-text-muted">(${perLesson.toFixed(2)}/lesson)</span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Expires after (days, optional)</label>
            <input type="number" min={1} className="w-full border border-app-border rounded-md px-3 py-2 text-sm" placeholder="Leave blank = no expiry"
              value={form.expiresAfterDays} onChange={(e) => setForm({ ...form, expiresAfterDays: e.target.value })} />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Active (available for purchase)
          </label>

          {/* Member-shop publish toggle. Owner-only gate that controls
              whether this package appears in /member/shop/packages.
              Defaults off so packages never publish silently. */}
          <div className="border border-app-border rounded-md p-3 bg-app-bg/40">
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.publishedToMembers}
                onChange={(e) => setForm({ ...form, publishedToMembers: e.target.checked })}
              />
              <span>
                <span className="font-medium text-text-primary">Publish to member shop</span>
                <span className="block text-xs text-text-muted mt-0.5">
                  Members can buy this package directly through the portal.
                  Leave off to keep it owner-only (assigned by hand from
                  the member edit screen).
                </span>
              </span>
            </label>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-app-border rounded-md text-text-primary hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-brand text-white rounded-md hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : pkg ? "Save changes" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── BookingModal (owner actions: assign coach, accept, approve, cancel) ──────

function BookingModal({
  booking,
  staffList,
  onClose,
  onSave,
}: {
  booking: Booking;
  staffList: Staff[];
  onClose: () => void;
  onSave: () => void;
}) {
  const [action, setAction]               = useState<"assign" | "confirm" | "decline" | "cancel" | "complete" | null>(null);
  const [selectedCoachId, setSelectedCoachId] = useState(booking.coach?.id ?? "");
  const [confirmedStart, setConfirmedStart]   = useState("");
  const [confirmedEnd, setConfirmedEnd]       = useState("");
  const [cancelReason, setCancelReason]       = useState("");
  const [saving, setSaving]                   = useState(false);
  const [error, setError]                     = useState("");

  async function send(payload: Record<string, unknown>) {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/private-lessons/bookings/${booking.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error || "Error"); return; }
      onSave();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-border">
          <h2 className="font-semibold text-text-primary">Booking — {booking.member.firstName} {booking.member.lastName}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-muted text-xl leading-none">×</button>
        </div>

        <div className="p-6 space-y-4">
          {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">{error}</p>}

          {/* Summary */}
          <div className="bg-app-bg rounded-lg p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-text-muted">Lesson</span>
              <span className="font-medium">{booking.lessonType.title}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Status</span>
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[booking.status] ?? "bg-app-bg text-text-muted"}`}>
                {STATUS_LABEL[booking.status] ?? booking.status}
              </span>
            </div>
            {booking.coach && (
              <div className="flex justify-between">
                <span className="text-text-muted">Coach</span>
                <span>{booking.coach.firstName} {booking.coach.lastName}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-text-muted">Payment</span>
              <span>
                {booking.paymentType ?? "—"}{booking.pricePaid != null ? ` · $${Number(booking.pricePaid).toFixed(2)}` : ""}
                {(booking.paymentType === "CASH" || booking.paymentType === "CHECK") && !["CANCELED", "DECLINED"].includes(booking.status) && (
                  <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded-full ${booking.ownerApproved ? "bg-lime-accent/25 text-charcoal" : "bg-orange-accent/20 text-text-primary"}`}>
                    {booking.ownerApproved ? "payment confirmed" : "payment pending"}
                  </span>
                )}
              </span>
            </div>
            {booking.creditLedger && (
              <div className="flex justify-between">
                <span className="text-text-muted">Package balance</span>
                <span>{booking.creditLedger.creditsGranted - booking.creditLedger.creditsUsed} lessons remaining</span>
              </div>
            )}
            {booking.notes && (
              <div className="flex justify-between">
                <span className="text-text-muted">Notes</span>
                <span className="text-right max-w-[60%]">{booking.notes}</span>
              </div>
            )}
          </div>

          {/* Requested slots — friendly format, with one-click accept that
              pre-fills the confirm form. The owner can still click "Confirm
              time" and override if they want to propose a different slot. */}
          <div>
            <p className="text-xs font-medium text-text-muted mb-2">Requested times</p>
            <div className="space-y-1.5">
              {booking.requestedSlots.map((s, i) => {
                const pretty = formatRequestedSlot(s);
                return (
                  <div key={i} className="flex items-center justify-between gap-3 bg-orange-accent/10 px-3 py-2 rounded">
                    <span className="text-sm text-text-primary">{pretty}</span>
                    {["REQUESTED", "PENDING_COACH", "CONFIRMED"].includes(booking.status) && (
                      <button
                        type="button"
                        onClick={() => {
                          const startIso = combineToLocalInput(s.date, s.startTime);
                          const endIso = combineToLocalInput(s.date, s.endTime);
                          if (startIso) setConfirmedStart(startIso);
                          if (endIso) setConfirmedEnd(endIso);
                          setAction("confirm");
                        }}
                        className="text-xs px-2 py-1 bg-lime-accent text-charcoal font-medium rounded-md hover:opacity-90 flex-shrink-0"
                      >
                        Accept this time
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Confirmed time (if any) — not for terminal (canceled/declined) bookings */}
          {booking.confirmedStartAt && !["CANCELED", "DECLINED"].includes(booking.status) && (
            <div className="text-sm bg-lime-accent text-charcoal font-medium px-3 py-2 rounded">
              Confirmed: {fmt(booking.confirmedStartAt)} – {booking.confirmedEndAt ? fmt(booking.confirmedEndAt) : ""}
            </div>
          )}
          {["CANCELED", "DECLINED"].includes(booking.status) && (
            <div className="text-sm bg-app-bg text-text-muted px-3 py-2 rounded border border-app-border">
              {booking.status === "DECLINED" ? "Declined" : "Canceled"}
              {booking.cancelReason ? ` — ${booking.cancelReason}` : ""}
            </div>
          )}

          {/* Partners — multi-athlete lessons */}
          {(booking.lessonType.maxAthletes > 1 || booking.partners.length > 0) && (
            <PartnersPanel booking={booking} onChanged={onSave} />
          )}

          {/* Actions */}
          {!action && (
            <div className="flex flex-wrap gap-2 pt-2">
              {["REQUESTED", "PENDING_COACH", "CONFIRMED"].includes(booking.status) && (
                <button onClick={() => setAction("assign")} className="px-3 py-1.5 text-sm border border-app-border rounded-md text-text-primary hover:bg-app-bg">
                  Assign / reassign coach
                </button>
              )}
              {["REQUESTED", "PENDING_COACH", "CONFIRMED"].includes(booking.status) && (
                <button
                  onClick={() => {
                    // Pre-fill with the first requested slot so "Confirm" is
                    // a one-click action by default. Owner can still tweak.
                    const first = booking.requestedSlots[0];
                    if (first && !confirmedStart) {
                      const startIso = combineToLocalInput(first.date, first.startTime);
                      const endIso = combineToLocalInput(first.date, first.endTime);
                      if (startIso) setConfirmedStart(startIso);
                      if (endIso) setConfirmedEnd(endIso);
                    }
                    setAction("confirm");
                  }}
                  className="px-3 py-1.5 text-sm bg-lime-accent text-charcoal font-medium rounded-md hover:opacity-90"
                >
                  Confirm or change time
                </button>
              )}
              {(booking.paymentType === "CASH" || booking.paymentType === "CHECK") &&
                !booking.ownerApproved &&
                !["CANCELED", "DECLINED"].includes(booking.status) && (
                  <button onClick={() => send({ action: "CONFIRM_PAYMENT" })} disabled={saving} className="px-3 py-1.5 text-sm bg-lime-accent text-charcoal font-medium rounded-md hover:opacity-90 disabled:opacity-50">
                    {saving ? "…" : `Confirm ${booking.paymentType === "CHECK" ? "check" : "cash"} payment`}
                  </button>
                )}
              {booking.status === "CONFIRMED" && !booking.ownerApproved && (
                <button onClick={() => send({ action: "APPROVE" })} disabled={saving} title="Approve this booking. This does NOT mark the lesson finished." className="px-3 py-1.5 text-sm bg-brand text-white rounded-md hover:bg-brand-hover disabled:opacity-50">
                  {saving ? "…" : "Approve booking"}
                </button>
              )}
              {booking.status === "CONFIRMED" && (
                <button onClick={() => send({ action: "COMPLETE" })} disabled={saving} title="Mark the lesson as finished. You can reopen it if this was a mistake." className="px-3 py-1.5 text-sm bg-brand text-white rounded-md hover:bg-brand-hover disabled:opacity-50">
                  {saving ? "…" : "Mark lesson completed"}
                </button>
              )}
              {booking.status === "COMPLETED" && (
                <button onClick={() => send({ action: "REOPEN" })} disabled={saving} title="Undo — return this lesson to Confirmed." className="px-3 py-1.5 text-sm bg-app-bg text-text-primary border border-app-border rounded-md hover:bg-app-border/40 disabled:opacity-50">
                  {saving ? "…" : "Reopen"}
                </button>
              )}
              {!["CANCELED", "DECLINED", "COMPLETED"].includes(booking.status) && (
                <button onClick={() => setAction("cancel")} className="px-3 py-1.5 text-sm bg-red-50 text-red-700 border border-red-200 rounded-md hover:bg-red-100">
                  Cancel
                </button>
              )}
            </div>
          )}

          {action === "assign" && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-text-primary">Assign coach</p>
              <select className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                value={selectedCoachId} onChange={(e) => setSelectedCoachId(e.target.value)}>
                <option value="">Unassigned</option>
                {staffList.map((s) => <option key={s.id} value={s.id}>{s.firstName} {s.lastName}</option>)}
              </select>
              <div className="flex gap-2">
                <button onClick={() => setAction(null)} className="px-3 py-1.5 text-sm border border-app-border rounded-md text-text-primary hover:bg-app-bg">Back</button>
                <button onClick={() => send({ action: "ASSIGN_COACH", coachId: selectedCoachId || null })} disabled={saving}
                  className="px-3 py-1.5 text-sm bg-brand text-white rounded-md hover:bg-brand-hover disabled:opacity-50">
                  {saving ? "Saving…" : "Save assignment"}
                </button>
              </div>
            </div>
          )}

          {action === "confirm" && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-text-primary">Confirm time</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1">Start</label>
                  <input type="datetime-local" className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                    value={confirmedStart} onChange={(e) => setConfirmedStart(e.target.value)} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1">End</label>
                  <input type="datetime-local" className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                    value={confirmedEnd} onChange={(e) => setConfirmedEnd(e.target.value)} />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => setAction(null)} className="px-3 py-1.5 text-sm border border-app-border rounded-md text-text-primary hover:bg-app-bg">Back</button>
                <button onClick={() => send({ action: "ACCEPT", confirmedStartAt: confirmedStart, confirmedEndAt: confirmedEnd })}
                  disabled={saving || !confirmedStart || !confirmedEnd}
                  className="px-3 py-1.5 text-sm bg-lime-accent text-charcoal font-medium rounded-md hover:bg-lime-accent disabled:opacity-50">
                  {saving ? "Confirming…" : "Confirm"}
                </button>
              </div>
            </div>
          )}

          {action === "cancel" && (
            <div className="space-y-3">
              <p className="text-sm font-medium text-text-primary">Cancel booking</p>
              <textarea className="w-full border border-app-border rounded-md px-3 py-2 text-sm" rows={2}
                placeholder="Reason (optional)" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
              <div className="flex gap-2">
                <button onClick={() => setAction(null)} className="px-3 py-1.5 text-sm border border-app-border rounded-md text-text-primary hover:bg-app-bg">Back</button>
                <button onClick={() => send({ action: "CANCEL", cancelReason: cancelReason || null })} disabled={saving}
                  className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50">
                  {saving ? "Canceling…" : "Confirm cancel"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── PartnersPanel (inside BookingModal) ─────────────────────────────────────

function PartnersPanel({ booking, onChanged }: { booking: Booking; onChanged: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const maxPartners = (booking.lessonType.maxAthletes || 1) - 1;
  const canAdd = booking.partners.length < maxPartners;

  async function call(path: string, init?: RequestInit) {
    setError("");
    const res = await fetch(path, init);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Could not update partner");
      return false;
    }
    return true;
  }

  async function copy(token: string) {
    const url = `${window.location.origin}/privates/partner/${token}`;
    try { await navigator.clipboard.writeText(url); } catch {}
  }

  async function regenerate(id: string) {
    setBusyId(id);
    const ok = await call(`/api/private-lessons/bookings/${booking.id}/partners/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "OUTSIDE", regenerateToken: true }),
    });
    setBusyId(null);
    if (ok) onChanged();
  }

  async function remove(id: string) {
    if (!confirm("Remove this partner from the booking?")) return;
    setBusyId(id);
    const ok = await call(`/api/private-lessons/bookings/${booking.id}/partners/${id}`, {
      method: "DELETE",
    });
    setBusyId(null);
    if (ok) onChanged();
  }

  async function add(kind: "OUTSIDE" | "NEEDS_HELP") {
    const ok = await call(`/api/private-lessons/bookings/${booking.id}/partners`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    });
    if (ok) onChanged();
  }

  return (
    <div>
      <p className="text-xs font-medium text-text-muted mb-2">
        Partners {booking.partners.length > 0 && `(${booking.partners.length}/${maxPartners})`}
      </p>
      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}
      <div className="space-y-2">
        {booking.partners.length === 0 && (
          <p className="text-xs text-text-muted">No partners on this booking yet.</p>
        )}
        {booking.partners.map((p) => (
          <div key={p.id} className="border border-app-border rounded-lg p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm">
                <p className="font-medium text-text-primary">{partnerHeadline(p)}</p>
                <p className="text-xs text-text-muted">
                  {PARTNER_KIND_LABEL[p.kind] || p.kind}
                  {p.kind === "OUTSIDE" && p.outsideEmail ? ` · ${p.outsideEmail}` : ""}
                  {p.kind === "OUTSIDE" && p.outsidePhone ? ` · ${p.outsidePhone}` : ""}
                </p>
              </div>
              <span className={`text-[11px] px-2 py-0.5 rounded border ${PARTNER_STATUS_STYLE[p.status] || "bg-app-bg text-text-muted border-app-border"}`}>
                {PARTNER_STATUS_LABEL[p.status] || p.status}
              </span>
            </div>

            {p.kind === "OUTSIDE" && p.inviteToken && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  readOnly
                  value={`${typeof window !== "undefined" ? window.location.origin : ""}/privates/partner/${p.inviteToken}`}
                  onFocus={(e) => e.currentTarget.select()}
                  className="flex-1 text-[11px] px-2 py-1 border border-app-border rounded bg-app-bg text-text-muted"
                />
                <button
                  onClick={() => copy(p.inviteToken!)}
                  className="text-[11px] px-2 py-1 border border-app-border rounded hover:bg-app-bg"
                >
                  Copy
                </button>
              </div>
            )}

            <div className="mt-2 flex flex-wrap gap-2">
              {p.kind === "OUTSIDE" && ["INVITED", "PENDING_COACH"].includes(p.status) && (
                <button
                  disabled={busyId === p.id}
                  onClick={() => regenerate(p.id)}
                  className="text-[11px] px-2 py-1 border border-app-border rounded text-text-primary hover:bg-app-bg disabled:opacity-50"
                >
                  {p.inviteToken ? "Regenerate link" : "Generate link"}
                </button>
              )}
              <button
                disabled={busyId === p.id}
                onClick={() => remove(p.id)}
                className="text-[11px] px-2 py-1 border border-red-200 rounded text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>

      {canAdd && (
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => add("OUTSIDE")}
            className="text-xs px-2.5 py-1 border border-app-border rounded-md text-text-primary hover:bg-app-bg"
          >
            + Add outside partner
          </button>
          <button
            onClick={() => add("NEEDS_HELP")}
            className="text-xs px-2.5 py-1 border border-app-border rounded-md text-text-primary hover:bg-app-bg"
          >
            + Needs partner
          </button>
        </div>
      )}
    </div>
  );
}

// ─── BookingRow ───────────────────────────────────────────────────────────────

function BookingRow({ booking, onClick }: { booking: Booking; onClick: () => void }) {
  const slot = booking.requestedSlots[0];
  // Surface partner status at-a-glance so coaches can spot pending work.
  const parts = booking.partners || [];
  const confirmed = parts.filter((p) => p.status === "CONFIRMED").length;
  const needsHelp = parts.some((p) => p.kind === "NEEDS_HELP");
  return (
    <tr className="hover:bg-app-bg cursor-pointer" onClick={onClick}>
      <td className="px-4 py-3 text-sm font-medium text-text-primary">
        {booking.member.firstName} {booking.member.lastName}
        {parts.length > 0 && (
          <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded bg-app-bg text-text-muted">
            +{parts.length} partner{parts.length === 1 ? "" : "s"}
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-text-muted">{booking.lessonType.title}</td>
      <td className="px-4 py-3 text-sm text-text-muted">
        {booking.coach ? `${booking.coach.firstName} ${booking.coach.lastName}` : <span className="text-orange-accent">Unassigned</span>}
      </td>
      <td className="px-4 py-3 text-sm text-text-muted">
        {slot ? `${slot.date} ${slot.startTime}` : "—"}
        {booking.requestedSlots.length > 1 && <span className="ml-1 text-xs text-text-muted">+{booking.requestedSlots.length - 1}</span>}
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1">
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium w-fit ${STATUS_COLORS[booking.status] ?? "bg-app-bg text-text-muted"}`}>
            {STATUS_LABEL[booking.status] ?? booking.status}
          </span>
          {parts.length > 0 && (
            <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded border w-fit ${
              needsHelp
                ? "bg-amber-50 text-amber-700 border-amber-200"
                : confirmed === parts.length
                  ? "bg-lime-accent text-text-primary border-lime-accent"
                  : "bg-app-bg text-text-muted border-app-border"
            }`}>
              {needsHelp ? "Needs partner" : `${confirmed}/${parts.length} confirmed`}
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-text-muted">{new Date(booking.createdAt).toLocaleDateString()}</td>
    </tr>
  );
}

// ─── NewBookingModal (quick-create by owner) ──────────────────────────────────

function NewBookingModal({
  lessonTypes,
  staffList,
  members,
  onClose,
  onSave,
}: {
  lessonTypes: LessonType[];
  staffList: Staff[];
  members: Member[];
  onClose: () => void;
  onSave: () => void;
}) {
  const [form, setForm] = useState({
    memberId:    "",
    lessonTypeId:"",
    priceOptionId: "",
    coachId:     "",
    date:        "",
    startTime:   "",
    endTime:     "",
    paymentType: "MANUAL" as "CREDIT" | "STRIPE" | "MANUAL" | "UNPAID",
    notes:       "",
    allowUnpaid: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");

  const selectedType = lessonTypes.find((lt) => lt.id === form.lessonTypeId);
  const typeOptions: PriceOption[] = selectedType?.priceOptions ?? [];
  const selectedOption = typeOptions.find((o) => o.id === form.priceOptionId) || null;
  // If an option is chosen and it restricts coaches, only show those.
  const coachChoices =
    selectedOption && selectedOption.coachIds.length > 0
      ? staffList.filter((s) => selectedOption.coachIds.includes(s.id))
      : selectedType && selectedType.eligibleCoachIds.length > 0
        ? staffList.filter((s) => selectedType.eligibleCoachIds.includes(s.id))
        : staffList;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const body = {
        memberId:       form.memberId,
        lessonTypeId:   form.lessonTypeId,
        priceOptionId:  form.priceOptionId || null,
        coachId:        form.coachId || null,
        requestedSlots: [{ date: form.date, startTime: form.startTime, endTime: form.endTime }],
        paymentType:    form.paymentType,
        notes:          form.notes || null,
        allowUnpaid:    form.allowUnpaid,
      };
      const res = await fetch("/api/private-lessons/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const d = await res.json(); setError(d.error || "Error"); return; }
      onSave();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-border">
          <h2 className="font-semibold text-text-primary">New booking</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-muted text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">{error}</p>}

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Member *</label>
            <select className="w-full border border-app-border rounded-md px-3 py-2 text-sm" required
              value={form.memberId} onChange={(e) => setForm({ ...form, memberId: e.target.value })}>
              <option value="">Select member…</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Lesson type *</label>
            <select className="w-full border border-app-border rounded-md px-3 py-2 text-sm" required
              value={form.lessonTypeId}
              onChange={(e) =>
                setForm({ ...form, lessonTypeId: e.target.value, priceOptionId: "", coachId: "" })
              }>
              <option value="">Select…</option>
              {lessonTypes.map((lt) => <option key={lt.id} value={lt.id}>{lt.title} — {lt.durationMin}min</option>)}
            </select>
          </div>

          {typeOptions.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Purchase option *</label>
              <select className="w-full border border-app-border rounded-md px-3 py-2 text-sm" required
                value={form.priceOptionId}
                onChange={(e) => setForm({ ...form, priceOptionId: e.target.value, coachId: "" })}>
                <option value="">Select option…</option>
                {typeOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label} — ${Number(o.price).toFixed(2)}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Coach (optional)</label>
            <select className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
              value={form.coachId} onChange={(e) => setForm({ ...form, coachId: e.target.value })}>
              <option value="">Unassigned</option>
              {coachChoices.map((s) => <option key={s.id} value={s.id}>{s.firstName} {s.lastName}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Requested date *</label>
            <input type="date" required className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
              value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">Start time *</label>
              <input type="time" required className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">End time *</label>
              <input type="time" required className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
                value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Payment type</label>
            <select className="w-full border border-app-border rounded-md px-3 py-2 text-sm"
              value={form.paymentType} onChange={(e) => setForm({ ...form, paymentType: e.target.value as typeof form.paymentType })}>
              <option value="MANUAL">Manual / cash</option>
              <option value="CREDIT">Use lesson package balance</option>
              <option value="UNPAID">Unpaid</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Notes</label>
            <textarea className="w-full border border-app-border rounded-md px-3 py-2 text-sm" rows={2}
              value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={form.allowUnpaid} onChange={(e) => setForm({ ...form, allowUnpaid: e.target.checked })} />
            Allow unpaid booking
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-app-border rounded-md text-text-primary hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-brand text-white rounded-md hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Creating…" : "Create booking"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AssignPackageModal({
  packages,
  lessonTypes,
  members,
  onClose,
  onSave,
}: {
  packages: Package[];
  lessonTypes: LessonType[];
  members: Member[];
  onClose: () => void;
  onSave: () => void;
}) {
  const [memberId, setMemberId] = useState("");
  const [packageId, setPackageId] = useState("");
  const [lessonTypeId, setLessonTypeId] = useState("");
  const [priceOptionId, setPriceOptionId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedPackage = packages.find((p) => p.id === packageId);
  const pkgMode = selectedPackage ? normalizePricingMode(selectedPackage.pricingMode) : "FLAT";
  const isDiscount = pkgMode !== "FLAT";

  // Lesson types covered by the selected package.
  const allowedLessonTypeIds = selectedPackage
    ? packageLessonTypeIds(selectedPackage.lessonTypeIds, selectedPackage.lessonTypeId)
    : [];
  const coveredTypes = allowedLessonTypeIds.length
    ? lessonTypes.filter((lt) => allowedLessonTypeIds.includes(lt.id))
    : lessonTypes;
  const selectedLessonType = coveredTypes.find((lt) => lt.id === lessonTypeId) || null;
  const tierOptions = selectedLessonType?.priceOptions ?? [];

  // Compute the total the buyer will be charged based on chosen tier.
  const baseTierPrice = (() => {
    if (!selectedLessonType) return 0;
    if (priceOptionId) {
      const p = tierOptions.find((o) => o.id === priceOptionId);
      if (p) return Number(p.price);
    }
    return Number(selectedLessonType.basePrice);
  })();
  const computedTotal = selectedPackage
    ? packageTotalForBasePrice(
        {
          pricingMode: selectedPackage.pricingMode,
          discountValue: selectedPackage.discountValue,
          price: selectedPackage.price,
          credits: selectedPackage.credits,
          bonusCredits: selectedPackage.bonusCredits,
        },
        baseTierPrice,
      )
    : 0;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!memberId || !packageId) return;
    if (isDiscount && !lessonTypeId) {
      setError("Pick a lesson type for this discount package.");
      return;
    }
    setSaving(true);
    setError("");
    const res = await fetch(`/api/members/${memberId}/credits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        packageId,
        notes: notes || undefined,
        lessonTypeId: lessonTypeId || undefined,
        priceOptionId: priceOptionId || undefined,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error?.toString() || "Could not assign package.");
      return;
    }
    onSave();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-border sticky top-0 bg-white z-10">
          <h2 className="font-semibold text-text-primary">Assign lesson package</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-muted text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Member</label>
            <select required value={memberId} onChange={(e) => setMemberId(e.target.value)} className="w-full border border-app-border rounded-md px-3 py-2 text-sm">
              <option value="">Select member…</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.firstName} {m.lastName}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Package</label>
            <select required value={packageId} onChange={(e) => {
              setPackageId(e.target.value);
              setLessonTypeId("");
              setPriceOptionId("");
            }} className="w-full border border-app-border rounded-md px-3 py-2 text-sm">
              <option value="">Select package…</option>
              {packages.filter((p) => p.active).map((p) => {
                const mode = normalizePricingMode(p.pricingMode);
                const label =
                  mode === "PERCENT"
                    ? `${Number(p.discountValue ?? 0)}% off`
                    : mode === "FIXED"
                      ? `$${Number(p.discountValue ?? 0).toFixed(2)} off / lesson`
                      : `$${Number(p.price).toFixed(2)}`;
                return (
                  <option key={p.id} value={p.id}>
                    {p.title} — {p.credits + p.bonusCredits} lessons · {label}
                  </option>
                );
              })}
            </select>
            {selectedPackage && (
              <p className="text-xs text-text-muted mt-1">
                Creates a balance of {selectedPackage.credits + selectedPackage.bonusCredits} remaining lessons.
              </p>
            )}
          </div>

          {isDiscount && (
            <>
              <div>
                <label className="block text-xs font-medium text-text-muted mb-1">Lesson type *</label>
                <select required value={lessonTypeId} onChange={(e) => {
                  setLessonTypeId(e.target.value);
                  setPriceOptionId("");
                }} className="w-full border border-app-border rounded-md px-3 py-2 text-sm">
                  <option value="">Select lesson type…</option>
                  {coveredTypes.map((lt) => (
                    <option key={lt.id} value={lt.id}>{lt.title}</option>
                  ))}
                </select>
              </div>
              {selectedLessonType && tierOptions.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1">Coach tier</label>
                  <select value={priceOptionId} onChange={(e) => setPriceOptionId(e.target.value)} className="w-full border border-app-border rounded-md px-3 py-2 text-sm">
                    <option value="">Default (${Number(selectedLessonType.basePrice).toFixed(2)})</option>
                    {tierOptions.map((o) => (
                      <option key={o.id} value={o.id}>{o.label} — ${Number(o.price).toFixed(2)}</option>
                    ))}
                  </select>
                </div>
              )}
              {selectedPackage && selectedLessonType && (
                <div className="rounded-md border border-app-border bg-app-bg/40 px-3 py-2 text-xs text-text-muted">
                  Charged total: <span className="text-text-primary font-medium">${computedTotal.toFixed(2)}</span>
                  {selectedPackage.credits > 0 && (
                    <> · ${(computedTotal / selectedPackage.credits).toFixed(2)}/lesson</>
                  )}
                </div>
              )}
            </>
          )}

          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full border border-app-border rounded-md px-3 py-2 text-sm" />
          </div>
          {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-app-border rounded-md text-text-primary hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-brand text-white rounded-md hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Assigning…" : "Assign package"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = "bookings" | "types" | "packages";

export default function PrivatesPage() {
  const { data: session } = useSession();
  const isOwner = session?.user.role === "OWNER";
  // Staff with events edit/full manage privates too — the API routes already
  // allow them (privates live under the "events" permission key); the UI was
  // still hiding every action behind owner-only.
  const perms = (session?.user as { permissions?: Record<string, unknown> | null } | undefined)?.permissions ?? null;
  const canManage = isOwner || hasPermission(perms, "events", "edit");

  const [tab, setTab]               = useState<Tab>("bookings");
  const [bookings, setBookings]     = useState<Booking[]>([]);
  const [lessonTypes, setLessonTypes] = useState<LessonType[]>([]);
  const [packages, setPackages]     = useState<Package[]>([]);
  const [members, setMembers]       = useState<Member[]>([]);
  const [staffList, setStaffList]   = useState<Staff[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading]       = useState(true);
  const [loadError, setLoadError]   = useState("");

  const [editLT, setEditLT]         = useState<LessonType | null | undefined>(undefined);
  const [editPkg, setEditPkg]       = useState<Package | null | undefined>(undefined);
  const [assignPkg, setAssignPkg]   = useState(false);
  const [viewBooking, setViewBooking] = useState<Booking | null>(null);
  const [newBooking, setNewBooking] = useState(false);
  const [clubSlug, setClubSlug]     = useState("");
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    fetch("/api/club/info")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => { if (c?.slug) setClubSlug(c.slug); });
  }, []);

  // Public "book a private lesson" link for websites/socials — mirrors the
  // membership "Copy link" on /dashboard/memberships. Opens /join/[slug]
  // ?goal=privates, which funnels into signup/login and lands on
  // /member/privates.
  function copyPublicPrivatesLink() {
    if (!clubSlug) {
      alert("Set your club URL (slug) in Settings → Club first so the public link works.");
      return;
    }
    const url = `${window.location.origin}/join/${clubSlug}?goal=privates`;
    const done = () => {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 1800);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done, () =>
        window.prompt("Copy this public booking link:", url),
      );
    } else {
      window.prompt("Copy this public booking link:", url);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = statusFilter ? `?status=${statusFilter}` : "";
      const [bRes, ltRes, pkgRes, mRes, sRes] = await Promise.all([
        fetch(`/api/private-lessons/bookings${params}`),
        fetch("/api/private-lessons/types"),
        fetch("/api/private-lessons/packages"),
        fetch("/api/members"),
        fetch("/api/staff?includeOwners=true"),
      ]);
      const [b, lt, pkg, m, s] = await Promise.all([
        readListResponse<Booking>(bRes, "Bookings"),
        readListResponse<LessonType>(ltRes, "Lesson types"),
        readListResponse<Package>(pkgRes, "Packages"),
        readListResponse<Member>(mRes, "Members"),
        readListResponse<Staff>(sRes, "Staff"),
      ]);
      setBookings(b.items);
      setLessonTypes(lt.items);
      setPackages(pkg.items);
      setMembers(m.items);
      setStaffList(s.items);
      setLoadError([b.error, lt.error, pkg.error, m.error, s.error].filter(Boolean).join(" "));
    } catch {
      setLoadError("Private lessons could not be loaded. Please refresh and try again.");
      setBookings([]);
      setLessonTypes([]);
      setPackages([]);
      setMembers([]);
      setStaffList([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  async function deletePackage(id: string) {
    if (!confirm("Delete this package?")) return;
    await fetch(`/api/private-lessons/packages/${id}`, { method: "DELETE" });
    load();
  }

  async function deleteLessonType(id: string) {
    if (!confirm("Delete this lesson type?")) return;
    await fetch(`/api/private-lessons/types/${id}`, { method: "DELETE" });
    load();
  }

  async function duplicateLessonType(id: string) {
    const res = await fetch(`/api/private-lessons/types/${id}/duplicate`, { method: "POST" });
    if (res.ok) load();
    else alert("Could not duplicate this lesson type.");
  }

  function packageTypeLabel(pkg: Package): string {
    const ids = packageLessonTypeIds(pkg.lessonTypeIds, pkg.lessonTypeId);
    if (ids.length === 0) return "Any";
    const names = ids
      .map((id) => lessonTypes.find((lt) => lt.id === id)?.title)
      .filter(Boolean) as string[];
    if (names.length === 0 && pkg.lessonType?.title) return pkg.lessonType.title;
    if (names.length <= 2) return names.join(", ");
    return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
  }

  function pricingDisplay(pkg: Package): string {
    const mode = normalizePricingMode(pkg.pricingMode);
    if (mode === "PERCENT") return `${Number(pkg.discountValue ?? 0)}% off per lesson`;
    if (mode === "FIXED") return `$${Number(pkg.discountValue ?? 0).toFixed(2)} off per lesson`;
    return `$${Number(pkg.price).toFixed(2)} total`;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Private Lessons</h1>
          <p className="text-sm text-text-muted mt-0.5">Manage booking requests, lesson types, and lesson quantity packages</p>
        </div>
        {canManage && tab === "bookings" && (
          <div className="flex gap-2">
            <button onClick={copyPublicPrivatesLink} className="px-4 py-2 text-sm border border-app-border rounded-md text-text-primary hover:bg-app-bg">
              {copiedLink ? "Copied!" : "Copy public link"}
            </button>
            <button onClick={() => setNewBooking(true)} className="px-4 py-2 text-sm bg-brand text-white rounded-md hover:bg-brand-hover">
              + New booking
            </button>
          </div>
        )}
        {canManage && tab === "types" && (
          <button onClick={() => setEditLT(null)} className="px-4 py-2 text-sm bg-brand text-white rounded-md hover:bg-brand-hover">
            + New lesson type
          </button>
        )}
        {canManage && tab === "packages" && (
          <div className="flex gap-2">
            <button onClick={() => setAssignPkg(true)} className="px-4 py-2 text-sm border border-app-border rounded-md text-text-primary hover:bg-app-bg">
              Assign package
            </button>
            <button onClick={() => setEditPkg(null)} className="px-4 py-2 text-sm bg-brand text-white rounded-md hover:bg-brand-hover">
              + New package
            </button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-app-border mb-6">
        {(["bookings", "types", "packages"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition ${
              tab === t ? "border-brand text-text-primary" : "border-transparent text-text-muted hover:text-text-primary"
            }`}>
            {t === "packages" ? "Lesson packages" : t}
          </button>
        ))}
      </div>

      {loadError && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-text-muted py-12 text-center">Loading…</div>
      ) : (
        <>
          {/* ── Bookings tab ─────────────────────────────────────── */}
          {tab === "bookings" && (
            <div>
              <div className="flex items-center gap-3 mb-4">
                <select className="border border-app-border rounded-md px-3 py-1.5 text-sm"
                  value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">All statuses</option>
                  {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <span className="text-sm text-text-muted">{bookings.length} bookings</span>
              </div>

              {bookings.length === 0 ? (
                <div className="text-center py-16 text-text-muted">No bookings found</div>
              ) : (
                <div className="bg-white rounded-xl border border-app-border overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-app-bg border-b border-app-border">
                      <tr>
                        {["Member", "Lesson type", "Coach", "Requested", "Status", "Date"].map((h) => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wide">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-app-border">
                      {bookings.map((b) => (
                        <BookingRow key={b.id} booking={b} onClick={() => setViewBooking(b)} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── Lesson types tab ─────────────────────────────────── */}
          {tab === "types" && (
            <div>
              {lessonTypes.length === 0 ? (
                <div className="text-center py-16 text-text-muted">No lesson types yet</div>
              ) : (
                <div className="bg-white rounded-xl border border-app-border overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-app-bg border-b border-app-border">
                      <tr>
                        {["Title", "Duration", "Max", "Price", "Status", ""].map((h) => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wide">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-app-border">
                      {lessonTypes.map((lt) => (
                        <tr key={lt.id} className="hover:bg-app-bg">
                          <td className="px-4 py-3 text-sm font-medium text-text-primary">{lt.title}</td>
                          <td className="px-4 py-3 text-sm text-text-muted">{privateDurationLabel(lt.durationMin)}</td>
                          <td className="px-4 py-3 text-sm text-text-muted">{lt.maxAthletes}</td>
                          <td className="px-4 py-3 text-sm text-text-muted">${Number(lt.basePrice).toFixed(2)}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${lt.active ? "bg-lime-accent text-text-primary" : "bg-app-bg text-text-muted"}`}>
                              {lt.active ? "Active" : "Inactive"}
                            </span>
                          </td>
                          {canManage && (
                            <td className="px-4 py-3 text-right">
                              <button onClick={() => setEditLT(lt)} className="text-xs text-text-muted hover:text-text-primary mr-3">Edit</button>
                              <button onClick={() => duplicateLessonType(lt.id)} className="text-xs text-text-muted hover:text-text-primary mr-3">Duplicate</button>
                              <button onClick={() => deleteLessonType(lt.id)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── Packages tab ─────────────────────────────────────── */}
          {tab === "packages" && (
            <div>
              {packages.length === 0 ? (
                <div className="text-center py-16 text-text-muted">No packages yet</div>
              ) : (
                <div className="bg-white rounded-xl border border-app-border overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-app-bg border-b border-app-border">
                      <tr>
                        {["Title", "Lesson type", "Lessons", "Pricing", "Expires", "Status", ""].map((h) => (
                          <th key={h} className="px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wide">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-app-border">
                      {packages.map((pkg) => (
                        <tr key={pkg.id} className="hover:bg-app-bg">
                          <td className="px-4 py-3 text-sm font-medium text-text-primary">{pkg.title}</td>
                          <td className="px-4 py-3 text-sm text-text-muted">{packageTypeLabel(pkg)}</td>
                          <td className="px-4 py-3 text-sm text-text-muted">
                            {pkg.credits}{pkg.bonusCredits > 0 ? ` +${pkg.bonusCredits} bonus` : ""}
                          </td>
                          <td className="px-4 py-3 text-sm text-text-muted">{pricingDisplay(pkg)}</td>
                          <td className="px-4 py-3 text-sm text-text-muted">{pkg.expiresAfterDays ? `${pkg.expiresAfterDays}d` : "Never"}</td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${pkg.active ? "bg-lime-accent text-text-primary" : "bg-app-bg text-text-muted"}`}>
                              {pkg.active ? "Active" : "Inactive"}
                            </span>
                          </td>
                          {canManage && (
                            <td className="px-4 py-3 text-right">
                              <button onClick={() => setEditPkg(pkg)} className="text-xs text-text-muted hover:text-text-primary mr-3">Edit</button>
                              <button onClick={() => deletePackage(pkg.id)} className="text-xs text-red-500 hover:text-red-700">Delete</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Modals */}
      {editLT !== undefined && (
        <LessonTypeModal lt={editLT} staffList={staffList} onClose={() => setEditLT(undefined)} onSave={() => { setEditLT(undefined); load(); }} />
      )}
      {editPkg !== undefined && (
        <PackageModal pkg={editPkg} lessonTypes={lessonTypes} onClose={() => setEditPkg(undefined)} onSave={() => { setEditPkg(undefined); load(); }} />
      )}
      {assignPkg && (
        <AssignPackageModal
          packages={packages}
          lessonTypes={lessonTypes}
          members={members}
          onClose={() => setAssignPkg(false)}
          onSave={() => { setAssignPkg(false); load(); }}
        />
      )}
      {viewBooking && (
        <BookingModal booking={viewBooking} staffList={staffList} onClose={() => setViewBooking(null)} onSave={() => { setViewBooking(null); load(); }} />
      )}
      {newBooking && (
        <NewBookingModal lessonTypes={lessonTypes} staffList={staffList} members={members} onClose={() => setNewBooking(false)} onSave={() => { setNewBooking(false); load(); }} />
      )}
    </div>
  );
}
