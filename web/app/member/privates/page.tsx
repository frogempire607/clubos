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

export default function MemberPrivatesPage() {
  const [types, setTypes] = useState<LessonType[]>([]);
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [credits, setCredits] = useState<Credit[]>([]);
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
    if (coachId && !coachIdsForLesson(type).includes(coachId)) setCoachId("");
    if (option && coachId && !optionCoachIds(option, type).includes(coachId)) setOptionId("");
    if (option && !availableOptions.some((o) => o.id === option.id)) setOptionId("");
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
                  onClick={() => { setTypeId(t.id); setOptionId(""); setCoachId(""); }}
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
                  onClick={() => setCoachId("")}
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
                <p className="text-sm text-stone-500">No pricing options are assigned to that coach.</p>
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
                {slots.map((s, i) => (
                  <div key={i} className="flex flex-wrap items-end gap-2">
                    <div>
                      <label className="block text-[11px] text-stone-500 mb-0.5">Date</label>
                      <input
                        type="date"
                        value={s.date}
                        onChange={(e) => setSlot(i, { date: e.target.value })}
                        className="px-3 py-2 border border-stone-300 rounded-lg text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-stone-500 mb-0.5">From</label>
                      <input
                        type="time"
                        value={s.startTime}
                        onChange={(e) => setSlot(i, { startTime: e.target.value })}
                        className="px-3 py-2 border border-stone-300 rounded-lg text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-stone-500 mb-0.5">Duration</label>
                      <div className="px-3 py-2 border border-stone-200 rounded-lg text-sm text-stone-500 bg-stone-50">
                        {type ? privateDurationLabel(type.durationMin) : "Select a lesson"}
                      </div>
                    </div>
                    {slots.length > 1 && (
                      <button
                        onClick={() => removeSlot(i)}
                        className="px-2 py-2 text-stone-400 hover:text-red-600 text-sm"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
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
        <p className="text-xs text-stone-500">
          Once your coach approves, we&apos;ll generate a shareable link you can send to your partner.
          They&apos;ll fill in their info there.
        </p>
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
