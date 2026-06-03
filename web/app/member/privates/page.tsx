"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { UserCheck } from "lucide-react";
import { packageAllowsLessonType, privateDurationLabel } from "@/lib/privateLessonRules";

type Opt = { id: string; label: string; price: number; coachIds: string[] };
type LessonType = {
  id: string;
  title: string;
  description: string | null;
  durationMin: number;
  maxAthletes: number;
  basePrice: number;
  priceOptions: Opt[];
  eligibleCoachIds: string[];
};
type Coach = { id: string; firstName: string; lastName: string };
type Slot = { date: string; startTime: string };
// One recurring weekly availability window per row. Matches the
// StaffAvailability shape returned by /api/member/privates.
type CoachAvailability = {
  userId: string;
  dayOfWeek: number; // 0=Sun … 6=Sat
  startTime: string; // "HH:mm" 24h
  endTime: string;   // "HH:mm" 24h
};
type Credit = {
  id: string;
  packageTitle: string | null;
  lessonTypeId: string | null;
  packageLessonTypeIds: string[];
  remaining: number;
  expiresAt: string | null;
};

type PartnerKind = "MEMBER" | "OUTSIDE" | "NEEDS_HELP";
type PartnerDraft = {
  kind: PartnerKind | null;
  memberId?: string;
  memberName?: string;
  // OUTSIDE-only — collected up front (optional) so the system can email
  // the partner their invite link directly once the coach accepts.
  outsideName?: string;
  outsideEmail?: string;
};

type BookingPartner = {
  id: string;
  kind: string;
  status: string;
  inviteToken: string | null;
  outsideName: string | null;
  member: { firstName: string; lastName: string } | null;
};
type Booking = {
  id: string;
  status: string;
  createdAt: string;
  confirmedStartAt: string | null;
  lessonType: { title: string } | null;
  coach: { firstName: string; lastName: string } | null;
  partners: BookingPartner[];
};

type MemberHit = { id: string; firstName: string; lastName: string; email: string | null };

type Invite = {
  id: string;
  member: { firstName: string; lastName: string } | null;
  booking: {
    id: string;
    status: string;
    confirmedStartAt: string | null;
    confirmedEndAt: string | null;
    member: { firstName: string; lastName: string };
    lessonType: { title: string };
  };
};

const STATUS_LABEL: Record<string, string> = {
  REQUESTED: "Requested",
  PENDING_COACH: "Waiting on coach",
  CONFIRMED: "Confirmed",
  COMPLETED: "Completed",
  CANCELED: "Canceled",
  DECLINED: "Declined",
};
const STATUS_STYLE: Record<string, string> = {
  REQUESTED: "bg-amber-50 text-amber-700",
  PENDING_COACH: "bg-amber-50 text-amber-700",
  CONFIRMED: "bg-green-50 text-green-700",
  COMPLETED: "bg-stone-100 text-stone-600",
  CANCELED: "bg-stone-100 text-stone-500",
  DECLINED: "bg-red-50 text-red-700",
};

const PARTNER_STATUS_LABEL: Record<string, string> = {
  PENDING_COACH: "Waiting on coach",
  INVITED: "Invited",
  CONFIRMED: "Confirmed",
  DECLINED: "Declined",
};

function partnerLabel(p: BookingPartner): string {
  if (p.kind === "NEEDS_HELP") return "Coach finding partner";
  if (p.kind === "OUTSIDE") return p.outsideName ? `${p.outsideName} (outside)` : "Outside partner";
  if (p.member) return `${p.member.firstName} ${p.member.lastName}`;
  return "Partner";
}

// ── Time helpers for the slot picker ─────────────────────────────────────────

// Parse "YYYY-MM-DD" into a local Date at midnight. Avoids the UTC parsing
// trap of `new Date("YYYY-MM-DD")` which lands a day off for negative
// timezones.
function parseLocalDate(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d));
}

// "HH:mm" → minutes since midnight.
function timeToMinutes(time: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function minutesToTime(min: number): string {
  const hh = Math.floor(min / 60).toString().padStart(2, "0");
  const mm = (min % 60).toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

// "14:30" → "2:30 PM". Doesn't rely on locale formatting so it matches the
// rest of the form's display style consistently.
function format12h(time: string): string {
  const total = timeToMinutes(time);
  if (total == null) return time;
  let h = Math.floor(total / 60);
  const m = total % 60;
  const period = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m.toString().padStart(2, "0")} ${period}`;
}

// Build suggested start-time chips for a given coach + date pair. We sample
// the coach's recurring weekly availability window for that weekday and
// emit chips at 30-minute intervals, leaving room at the end of the window
// for the lesson's full duration (so a 60-minute lesson never gets a
// 4:30 PM chip when the window closes at 5:00 PM).
function suggestedTimesFor(
  availability: CoachAvailability[],
  coachId: string,
  dateStr: string,
  durationMin: number,
): string[] {
  if (!coachId || !dateStr) return [];
  const d = parseLocalDate(dateStr);
  if (!d) return [];
  const dow = d.getDay();
  const windows = availability.filter(
    (a) => a.userId === coachId && a.dayOfWeek === dow,
  );
  if (windows.length === 0) return [];
  const STEP = 30; // minutes
  const out = new Set<string>();
  for (const w of windows) {
    const start = timeToMinutes(w.startTime);
    const end = timeToMinutes(w.endTime);
    if (start == null || end == null || end <= start) continue;
    // Latest valid start = end - durationMin, snapped down to the previous
    // STEP boundary.
    const latest = end - durationMin;
    for (let t = start; t <= latest; t += STEP) {
      out.add(minutesToTime(t));
    }
  }
  return Array.from(out).sort();
}

// "Thu, Jun 15" — readable label for the date the user picked.
function formatSlotDate(dateStr: string): string {
  const d = parseLocalDate(dateStr);
  if (!d) return "";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// "2:30 PM – 3:30 PM" — preview range for the slot.
function formatSlotRange(dateStr: string, startTime: string, durationMin: number): string {
  const startMin = timeToMinutes(startTime);
  if (!dateStr || startMin == null) return "";
  const endMin = startMin + durationMin;
  return `${format12h(startTime)} – ${format12h(minutesToTime(endMin))}`;
}

export default function MemberPrivatesPage() {
  const [types, setTypes] = useState<LessonType[]>([]);
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [credits, setCredits] = useState<Credit[]>([]);
  const [availability, setAvailability] = useState<CoachAvailability[]>([]);
  const [hasProfile, setHasProfile] = useState(true);
  const [loading, setLoading] = useState(true);

  const [typeId, setTypeId] = useState("");
  const [optionId, setOptionId] = useState("");
  const [coachId, setCoachId] = useState("");
  const [partners, setPartners] = useState<PartnerDraft[]>([]);
  const [slots, setSlots] = useState<Slot[]>([{ date: "", startTime: "" }]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  // Captures what was just silently cleared by the coach/tier cascade
  // useEffect so we can render a visible warning. Without this, picking a
  // pricing option that's incompatible with the current coach (or vice
  // versa) silently wipes the other selection and the user is left
  // staring at a disabled submit button with no explanation.
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);

  function load() {
    setLoading(true);
    Promise.all([
      fetch("/api/member/privates").then((r) => (r.ok ? r.json() : null)),
      fetch("/api/member/privates/partner-response").then((r) => (r.ok ? r.json() : [])),
    ]).then(([d, inv]) => {
      if (d) {
        setTypes(d.types || []);
        setCoaches(d.coaches || []);
        setBookings(d.bookings || []);
        setCredits(d.credits || []);
        setAvailability(Array.isArray(d.availability) ? d.availability : []);
        setHasProfile(d.hasMemberProfile);
      }
      setInvites(Array.isArray(inv) ? inv : []);
      setLoading(false);
    });
  }
  useEffect(() => { load(); }, []);

  const type = types.find((t) => t.id === typeId) || null;
  const options = type?.priceOptions ?? [];
  const option = options.find((o) => o.id === optionId) || null;

  function optionCoachIds(o: Opt, lesson: LessonType): string[] {
    if (o.coachIds.length > 0) return o.coachIds;
    if (lesson.eligibleCoachIds.length > 0) return lesson.eligibleCoachIds;
    return coaches.map((c) => c.id);
  }

  function coachIdsForLesson(lesson: LessonType): string[] {
    const ids = new Set<string>();
    if (lesson.priceOptions.length > 0) {
      for (const o of lesson.priceOptions) optionCoachIds(o, lesson).forEach((id) => ids.add(id));
    } else if (lesson.eligibleCoachIds.length > 0) {
      lesson.eligibleCoachIds.forEach((id) => ids.add(id));
    } else {
      coaches.forEach((c) => ids.add(c.id));
    }
    return Array.from(ids);
  }

  // Reset partners whenever the lesson type changes so the slot count matches
  // the new lesson's maxAthletes.
  useEffect(() => {
    if (!type) { setPartners([]); return; }
    const partnerSlots = Math.max(0, (type.maxAthletes ?? 1) - 1);
    setPartners(Array.from({ length: partnerSlots }, () => ({ kind: null })));
  }, [typeId, type?.maxAthletes]);

  const availableOptions =
    type && coachId
      ? options.filter((o) => optionCoachIds(o, type).includes(coachId))
      : options;
  const availableCoachIds: string[] = type
    ? option
      ? optionCoachIds(option, type)
      : coachIdsForLesson(type)
    : [];
  const availableCoaches = coaches.filter((c) => availableCoachIds.includes(c.id));

  const price = option ? option.price : type ? type.basePrice : 0;
  const usableCredit = type
    ? credits.find((c) => {
        if (c.remaining <= 0) return false;
        if (c.packageLessonTypeIds.length) {
          return packageAllowsLessonType(c.packageLessonTypeIds, c.lessonTypeId, type.id);
        }
        return !c.lessonTypeId || c.lessonTypeId === type.id;
      }) ?? null
    : null;
  const maxSlotCount = usableCredit ? Math.min(usableCredit.remaining, 16) : 3;

  useEffect(() => {
    if (!type) return;
    // Auto-clear incompatible selections so the rendered grids never
    // show a "selected" state for an item that's no longer in
    // availableCoaches / availableOptions. We also record what was
    // cleared so the warning banner can explain why.
    if (coachId && !coachIdsForLesson(type).includes(coachId)) {
      const c = coaches.find((x) => x.id === coachId);
      const who = c ? `${c.firstName} ${c.lastName}` : "Your previous coach";
      setConflictNotice(`${who} doesn't teach ${type.title}. Pick another coach.`);
      setCoachId("");
      return;
    }
    if (option && coachId && !optionCoachIds(option, type).includes(coachId)) {
      const c = coaches.find((x) => x.id === coachId);
      const who = c ? `${c.firstName} ${c.lastName}` : "Your previous coach";
      setConflictNotice(`${who} isn't available for the "${option.label}" pricing option. Choose a different option, or change coaches.`);
      setOptionId("");
      return;
    }
    if (option && !availableOptions.some((o) => o.id === option.id)) {
      setConflictNotice(`The "${option.label}" pricing option isn't available for the current selection. Pick another option.`);
      setOptionId("");
      return;
    }
  }, [typeId, coachId, optionId, types, coaches]);

  function setSlot(i: number, patch: Partial<Slot>) {
    setSlots((s) => s.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function addSlot() {
    if (slots.length < maxSlotCount) setSlots((s) => [...s, { date: "", startTime: "" }]);
  }
  function removeSlot(i: number) {
    setSlots((s) => s.filter((_, idx) => idx !== i));
  }

  function setPartner(i: number, patch: Partial<PartnerDraft>) {
    setPartners((p) => p.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }

  const validSlots = slots.filter((s) => s.date && s.startTime);
  const partnersComplete = partners.every(
    (p) => p.kind !== null && (p.kind !== "MEMBER" || !!p.memberId),
  );
  const canSubmit =
    !!type &&
    validSlots.length > 0 &&
    (options.length === 0 || !!option) &&
    (!coachId || availableCoachIds.includes(coachId)) &&
    partnersComplete;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError("");
    const res = await fetch("/api/member/privates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lessonTypeId: typeId,
        priceOptionId: optionId || null,
        coachId: coachId || null,
        requestedSlots: validSlots,
        notes: notes || null,
        partners: partners
          .filter((p) => p.kind !== null)
          .map((p) => ({
            kind: p.kind,
            memberId: p.kind === "MEMBER" ? p.memberId : null,
            // Only forward the optional outside-partner contact for
            // OUTSIDE rows; the server schema treats these as nullable
            // so empty strings collapse to null.
            outsideName:
              p.kind === "OUTSIDE" && p.outsideName?.trim()
                ? p.outsideName.trim()
                : null,
            outsideEmail:
              p.kind === "OUTSIDE" && p.outsideEmail?.trim()
                ? p.outsideEmail.trim()
                : null,
          })),
      }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setError(d.error || "Could not submit request"); return; }
    setDone(true);
    setTypeId(""); setOptionId(""); setCoachId("");
    setSlots([{ date: "", startTime: "" }]); setNotes("");
    setPartners([]);
    load();
  }

  async function respondToInvite(partnerId: string, action: "confirm" | "decline") {
    const res = await fetch(`/api/member/privates/partner-response/${partnerId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (res.ok) load();
  }

  function inviteUrl(token: string) {
    if (typeof window === "undefined") return `/privates/partner/${token}`;
    return `${window.location.origin}/privates/partner/${token}`;
  }

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 mb-1">Private lessons</h1>
          <p className="text-sm text-stone-500">
            Pick a lesson, choose a coach, and request a few times. Your coach
            confirms or suggests another time.
          </p>
        </div>
        <Link href="/member/shop" className="text-xs text-stone-500 hover:text-stone-900">
          All purchase options →
        </Link>
      </div>

      {!hasProfile && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 text-sm text-amber-800">
          Your account isn&apos;t linked to a member profile yet. Contact your club.
        </div>
      )}
      {done && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-sm text-green-800 mb-4">
          Request sent! Your coach will review your times and confirm.
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 mb-4">
          {error}
        </div>
      )}
      {conflictNotice && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-800 mb-4 flex items-start gap-2 justify-between">
          <p className="flex-1">{conflictNotice}</p>
          <button
            onClick={() => setConflictNotice(null)}
            className="text-amber-700 hover:text-amber-900 text-lg leading-none flex-shrink-0"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Incoming partner invitations */}
      {invites.length > 0 && (
        <div className="mb-6 space-y-2">
          <h2 className="text-sm font-semibold text-stone-900">Partner invitations</h2>
          {invites.map((inv) => (
            <div key={inv.id} className="bg-white rounded-xl border border-stone-200 p-4 flex items-center justify-between gap-3">
              <div className="min-w-0 text-sm">
                <p className="font-medium text-stone-900">
                  {inv.booking.member.firstName} {inv.booking.member.lastName} invited{" "}
                  {inv.member ? `${inv.member.firstName} ${inv.member.lastName}` : "you"}{" "}
                  to a partner lesson
                </p>
                <p className="text-xs text-stone-500">
                  {inv.booking.lessonType.title}
                  {inv.booking.confirmedStartAt
                    ? ` · ${new Date(inv.booking.confirmedStartAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
                    : ""}
                </p>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button onClick={() => respondToInvite(inv.id, "decline")}
                  className="px-3 py-1.5 text-xs border border-stone-200 rounded-md text-stone-600 hover:bg-stone-50">
                  Decline
                </button>
                <button onClick={() => respondToInvite(inv.id, "confirm")}
                  className="px-3 py-1.5 text-xs bg-stone-900 text-white rounded-md hover:bg-stone-700">
                  Confirm
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>
      ) : types.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <UserCheck className="h-7 w-7" strokeWidth={2} />
          </div>
          <p className="text-base font-medium text-stone-900 mb-1">No private lessons offered</p>
          <p className="text-sm text-stone-500">Your club hasn&apos;t set up private lessons yet.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-5">
          {/* 1. Lesson type */}
          <div>
            <p className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">
              1 · Lesson type
            </p>
            <div className="grid sm:grid-cols-2 gap-2">
              {types.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setTypeId(t.id);
                    setOptionId("");
                    setCoachId("");
                    setConflictNotice(null);
                  }}
                  className={`text-left p-3 rounded-lg border transition ${
                    typeId === t.id
                      ? "border-stone-900 bg-stone-50"
                      : "border-stone-200 hover:border-stone-300"
                  }`}
                >
                  <p className="text-sm font-semibold text-stone-900">
                    {t.title}
                    {t.maxAthletes > 1 && (
                      <span className="ml-1 text-[11px] font-medium text-stone-500 align-middle">
                        · up to {t.maxAthletes} athletes
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-stone-500">
                    {privateDurationLabel(t.durationMin)}
                    {t.priceOptions.length === 0 && ` · $${t.basePrice.toFixed(2)}`}
                    {t.priceOptions.length > 0 && ` · ${t.priceOptions.length} options`}
                  </p>
                  {t.description && (
                    <p className="text-xs text-stone-500 mt-1 line-clamp-2">{t.description}</p>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* 2. Coach */}
          {type && (
            <div>
              <p className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">
                2 · Coach
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => { setCoachId(""); setConflictNotice(null); }}
                  className={`px-3 py-1.5 rounded-full text-sm border transition ${
                    coachId === ""
                      ? "border-stone-900 bg-stone-900 text-white"
                      : "border-stone-200 text-stone-600 hover:bg-stone-50"
                  }`}
                >
                  No preference
                </button>
                {availableCoaches.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setCoachId(c.id);
                      setConflictNotice(null);
                      if (option && type && !optionCoachIds(option, type).includes(c.id)) setOptionId("");
                    }}
                    className={`px-3 py-1.5 rounded-full text-sm border transition ${
                      coachId === c.id
                        ? "border-stone-900 bg-stone-50"
                        : "border-stone-200 text-stone-600 hover:bg-stone-50"
                    }`}
                  >
                    {c.firstName} {c.lastName}
                  </button>
                ))}
              </div>
              {options.length > 0 && (
                <p className="text-xs text-stone-500 mt-2">Choosing a coach filters the pricing options below.</p>
              )}
            </div>
          )}

          {/* 3. Pricing option */}
          {type && options.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">
                3 · Pricing option
              </p>
              <div className="grid sm:grid-cols-2 gap-2">
                {availableOptions.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => {
                      setOptionId(o.id);
                      setConflictNotice(null);
                      if (type && coachId && !optionCoachIds(o, type).includes(coachId)) setCoachId("");
                    }}
                    className={`text-left p-3 rounded-lg border transition ${
                      optionId === o.id
                        ? "border-stone-900 bg-stone-900 text-white"
                        : "border-stone-200 hover:border-stone-300"
                    }`}
                  >
                    <p className={optionId === o.id ? "text-sm font-semibold text-white" : "text-sm font-semibold text-stone-900"}>{o.label}</p>
                    <p className={optionId === o.id ? "text-xs text-white/75" : "text-xs text-stone-500"}>${Number(o.price).toFixed(2)}</p>
                  </button>
                ))}
              </div>
              {availableOptions.length === 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-800">
                  <p className="font-medium">No pricing options match that coach.</p>
                  <p className="text-xs mt-0.5">
                    Pick a different coach above, or clear the coach selection to see all options.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* 4. Partners — only when the lesson type supports more than one athlete */}
          {type && (options.length === 0 || option) && type.maxAthletes > 1 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">
                {options.length > 0 ? "4" : "3"} · Partners
              </p>
              <p className="text-xs text-stone-500 mb-3">
                This lesson takes up to {type.maxAthletes} athletes. Tell us about each partner.
                Your coach approves the booking before partners are notified.
              </p>
              <div className="space-y-3">
                {partners.map((p, i) => (
                  <PartnerPicker
                    key={i}
                    index={i}
                    value={p}
                    onChange={(patch) => setPartner(i, patch)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* 5. Times */}
          {type && (options.length === 0 || option) && (
            <div>
              <p className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">
                {(() => {
                  let step = 2;
                  if (options.length > 0) step++;
                  if (type.maxAthletes > 1) step++;
                  return step;
                })()} · {usableCredit ? "Request package lesson dates" : "Request up to 3 times"}
              </p>
              <div className="space-y-2">
                {usableCredit && (
                  <p className="text-xs text-stone-500 mb-2">
                    Package balance: {usableCredit.remaining} lesson{usableCredit.remaining === 1 ? "" : "s"}
                    {usableCredit.packageTitle ? ` from ${usableCredit.packageTitle}` : ""}. Add one date/time per lesson you want to request.
                  </p>
                )}
                {slots.map((s, i) => {
                  const suggestions = type
                    ? suggestedTimesFor(availability, coachId, s.date, type.durationMin)
                    : [];
                  const previewRange =
                    type && s.date && s.startTime
                      ? formatSlotRange(s.date, s.startTime, type.durationMin)
                      : "";
                  const previewDate = s.date ? formatSlotDate(s.date) : "";
                  return (
                    <div
                      key={i}
                      className="border border-stone-200 rounded-lg p-3 bg-stone-50/50"
                    >
                      {/* Inputs — stack on mobile, row on sm+. The native
                          date + time inputs handle keyboard / picker UI
                          properly; we just give them more breathing room
                          than the old flex-wrap. */}
                      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-2 items-end">
                        <div>
                          <label className="block text-[11px] text-stone-500 mb-0.5">Date</label>
                          <input
                            type="date"
                            value={s.date}
                            onChange={(e) => setSlot(i, { date: e.target.value })}
                            className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-stone-500 mb-0.5">Start time</label>
                          <input
                            type="time"
                            value={s.startTime}
                            onChange={(e) => setSlot(i, { startTime: e.target.value })}
                            className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] text-stone-500 mb-0.5">Duration</label>
                          <div className="px-3 py-2 border border-stone-200 rounded-lg text-sm text-stone-500 bg-white whitespace-nowrap">
                            {privateDurationLabel(type.durationMin)}
                          </div>
                        </div>
                        {slots.length > 1 && (
                          <button
                            onClick={() => removeSlot(i)}
                            className="px-2 py-2 text-stone-500 hover:text-red-600 text-sm justify-self-start sm:justify-self-end"
                          >
                            Remove
                          </button>
                        )}
                      </div>

                      {/* Suggested time chips — only when a coach is picked
                          and their recurring availability covers this
                          weekday. Each chip fills both inputs and the
                          preview row at once. */}
                      {coachId && s.date && suggestions.length > 0 && (
                        <div className="mt-3">
                          <p className="text-[11px] text-stone-500 mb-1">
                            Coach typically available:
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {suggestions.map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => setSlot(i, { startTime: t })}
                                className={`px-2 py-1 rounded-md text-[11px] border transition ${
                                  s.startTime === t
                                    ? "border-stone-900 bg-stone-900 text-white"
                                    : "border-stone-200 bg-white text-stone-700 hover:bg-stone-100"
                                }`}
                              >
                                {format12h(t)}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {/* No-availability hint — only fires when a coach IS
                          picked but their recurring availability doesn't
                          cover this date. Avoids creating false
                          impressions of "any time works" when in fact
                          we have no signal. */}
                      {coachId && s.date && suggestions.length === 0 && (
                        <p className="mt-3 text-[11px] text-stone-500">
                          No recurring availability on file for that day — the coach
                          will confirm or propose another time.
                        </p>
                      )}

                      {/* Friendly preview row — confirms what the inputs
                          will be submitted as, in a human-readable form. */}
                      {previewRange && (
                        <p className="mt-3 text-xs text-stone-700">
                          <span className="font-medium">{previewDate}</span>{" "}
                          <span className="text-stone-500">·</span>{" "}
                          <span className="tabular-nums">{previewRange}</span>
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              {slots.length < maxSlotCount && (
                <button
                  onClick={addSlot}
                  className="mt-2 text-xs px-2.5 py-1 rounded-md border border-stone-300 text-stone-700 hover:bg-stone-50"
                >
                  + Add another {usableCredit ? "lesson time" : "time"}
                </button>
              )}

              <div className="mt-4">
                <label className="block text-[11px] text-stone-500 mb-0.5">
                  Note for your coach (optional)
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  maxLength={500}
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm"
                  placeholder="What do you want to work on?"
                />
              </div>
            </div>
          )}

          {/* Explain WHY submit is disabled — without this, a user who's
              filled most of the form but missed one field stares at a
              greyed-out button with no hint about what's missing. */}
          {type && !canSubmit && !saving && (
            <p className="text-xs text-stone-500 -mt-2">
              {options.length > 0 && !option
                ? "Pick a pricing option to continue."
                : coachId && !availableCoachIds.includes(coachId)
                  ? "The selected coach isn't available for this pricing option. Pick a different coach or option."
                  : validSlots.length === 0
                    ? "Add at least one date and time you'd like."
                    : !partnersComplete
                      ? "Tell us about each partner before submitting."
                      : "Some required info is missing."}
            </p>
          )}

          <div className="flex items-center justify-between border-t border-stone-100 pt-4">
            <p className="text-sm text-stone-600">
              {type ? (
                <>
                  {usableCredit ? (
                    <>
                      Using package credits: <span className="font-semibold text-stone-900">{validSlots.length || 1}</span>
                      <span className="text-xs text-stone-400"> · no custom duration</span>
                    </>
                  ) : (
                    <>
                      Estimated: <span className="font-semibold text-stone-900">${price.toFixed(2)}</span>{" "}
                      <span className="text-xs text-stone-400">· billed by your club after confirmation</span>
                    </>
                  )}
                </>
              ) : (
                "Select a lesson to begin"
              )}
            </p>
            <button
              onClick={submit}
              disabled={!canSubmit || saving || !hasProfile}
              className="px-5 py-2.5 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
            >
              {saving ? "Sending…" : "Request lesson"}
            </button>
          </div>
        </div>
      )}

      {/* Existing requests */}
      {bookings.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-stone-900 mb-3">Your requests</h2>
          <div className="space-y-2">
            {bookings.map((b) => (
              <div
                key={b.id}
                className="bg-white rounded-xl border border-stone-200 p-4 space-y-2"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-900">
                      {b.lessonType?.title ?? "Private lesson"}
                    </p>
                    <p className="text-xs text-stone-500">
                      {b.coach ? `with ${b.coach.firstName} ${b.coach.lastName}` : "Coach to be assigned"}
                      {b.confirmedStartAt
                        ? ` · ${new Date(b.confirmedStartAt).toLocaleString("en-US", {
                            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                          })}`
                        : ""}
                    </p>
                  </div>
                  <span
                    className={`text-[11px] px-2 py-1 rounded-full font-medium flex-shrink-0 ${
                      STATUS_STYLE[b.status] || "bg-stone-100 text-stone-600"
                    }`}
                  >
                    {STATUS_LABEL[b.status] || b.status}
                  </span>
                </div>

                {/* Partner status + shareable outside-partner links */}
                {b.partners && b.partners.length > 0 && (
                  <div className="border-t border-stone-100 pt-2 space-y-1.5">
                    {b.partners.map((p) => (
                      <div key={p.id} className="text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-stone-700">{partnerLabel(p)}</span>
                          <span className="text-stone-500">
                            {PARTNER_STATUS_LABEL[p.status] || p.status}
                          </span>
                        </div>
                        {p.kind === "OUTSIDE" && p.inviteToken && p.status === "INVITED" && (
                          <div className="mt-1 flex items-center gap-2">
                            <input
                              readOnly
                              value={inviteUrl(p.inviteToken)}
                              className="flex-1 px-2 py-1 text-[11px] border border-stone-200 rounded bg-stone-50 text-stone-600"
                              onFocus={(e) => e.currentTarget.select()}
                            />
                            <button
                              onClick={() => navigator.clipboard?.writeText(inviteUrl(p.inviteToken!))}
                              className="px-2 py-1 text-[11px] border border-stone-200 rounded hover:bg-stone-50"
                            >
                              Copy
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ─── PartnerPicker ───────────────────────────────────────────────────────────

function PartnerPicker({
  index,
  value,
  onChange,
}: {
  index: number;
  value: PartnerDraft;
  onChange: (patch: Partial<PartnerDraft>) => void;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<MemberHit[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (value.kind !== "MEMBER") { setResults([]); return; }
    if (search.trim().length < 2) { setResults([]); return; }
    const handle = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await fetch(`/api/member/privates/search-partners?q=${encodeURIComponent(search.trim())}`);
        if (r.ok) setResults(await r.json());
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [search, value.kind]);

  return (
    <div className="border border-stone-200 rounded-lg p-3">
      <p className="text-xs font-medium text-stone-700 mb-2">Partner {index + 1}</p>
      <div className="flex flex-wrap gap-2 mb-2">
        <KindBtn label="It's another member" active={value.kind === "MEMBER"}
          onClick={() => onChange({ kind: "MEMBER", memberId: undefined, memberName: undefined })} />
        <KindBtn label="Non-member partner" active={value.kind === "OUTSIDE"}
          onClick={() => onChange({ kind: "OUTSIDE", memberId: undefined, memberName: undefined })} />
        <KindBtn label="I don't have one — help me find one" active={value.kind === "NEEDS_HELP"}
          onClick={() => onChange({ kind: "NEEDS_HELP", memberId: undefined, memberName: undefined })} />
      </div>

      {value.kind === "MEMBER" && (
        <div className="mt-1">
          {value.memberId ? (
            <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-stone-50 border border-stone-200 rounded">
              <span className="text-sm text-stone-900">{value.memberName || "Selected member"}</span>
              <button
                type="button"
                onClick={() => onChange({ memberId: undefined, memberName: undefined })}
                className="text-xs text-stone-500 hover:text-stone-900"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or email"
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm"
              />
              {searching && <p className="text-[11px] text-stone-400 mt-1">Searching…</p>}
              {results.length > 0 && (
                <ul className="mt-1 border border-stone-200 rounded-lg divide-y divide-stone-100 max-h-44 overflow-y-auto">
                  {results.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange({ memberId: r.id, memberName: `${r.firstName} ${r.lastName}` });
                          setSearch("");
                          setResults([]);
                        }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-stone-50"
                      >
                        {r.firstName} {r.lastName}
                        {r.email && <span className="ml-2 text-xs text-stone-400">{r.email}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {value.kind === "OUTSIDE" && (
        <div className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-stone-500 mb-0.5">
                Partner name <span className="text-stone-400">(optional)</span>
              </label>
              <input
                type="text"
                value={value.outsideName || ""}
                onChange={(e) => onChange({ outsideName: e.target.value })}
                placeholder="First Last"
                maxLength={100}
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm"
              />
            </div>
            <div>
              <label className="block text-[11px] text-stone-500 mb-0.5">
                Partner email <span className="text-stone-400">(optional)</span>
              </label>
              <input
                type="email"
                value={value.outsideEmail || ""}
                onChange={(e) => onChange({ outsideEmail: e.target.value })}
                placeholder="partner@example.com"
                maxLength={200}
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm"
              />
            </div>
          </div>
          <p className="text-xs text-stone-500">
            If you add their email, we&apos;ll send the invite link directly to your partner
            once your coach approves. Otherwise you&apos;ll get a shareable link to send them
            yourself.
          </p>
        </div>
      )}

      {value.kind === "NEEDS_HELP" && (
        <p className="text-xs text-stone-500">
          Your coach will help match you with a partner.
        </p>
      )}
    </div>
  );
}

function KindBtn({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs border transition ${
        active
          ? "border-stone-900 bg-stone-900 text-white"
          : "border-stone-200 text-stone-600 hover:bg-stone-50"
      }`}
    >
      {label}
    </button>
  );
}
