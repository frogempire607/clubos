"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Opt = { id: string; label: string; price: number; coachIds: string[] };
type LessonType = {
  id: string;
  title: string;
  description: string | null;
  durationMin: number;
  basePrice: number;
  priceOptions: Opt[];
  eligibleCoachIds: string[];
};
type Coach = { id: string; firstName: string; lastName: string };
type Slot = { date: string; startTime: string; endTime: string };
type Booking = {
  id: string;
  status: string;
  createdAt: string;
  confirmedStartAt: string | null;
  lessonType: { title: string } | null;
  coach: { firstName: string; lastName: string } | null;
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

export default function MemberPrivatesPage() {
  const [types, setTypes] = useState<LessonType[]>([]);
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [hasProfile, setHasProfile] = useState(true);
  const [loading, setLoading] = useState(true);

  const [typeId, setTypeId] = useState("");
  const [optionId, setOptionId] = useState("");
  const [coachId, setCoachId] = useState("");
  const [slots, setSlots] = useState<Slot[]>([{ date: "", startTime: "", endTime: "" }]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  function load() {
    setLoading(true);
    fetch("/api/member/privates")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setTypes(d.types || []);
          setCoaches(d.coaches || []);
          setBookings(d.bookings || []);
          setHasProfile(d.hasMemberProfile);
        }
        setLoading(false);
      });
  }
  useEffect(() => { load(); }, []);

  const type = types.find((t) => t.id === typeId) || null;
  const options = type?.priceOptions ?? [];
  const option = options.find((o) => o.id === optionId) || null;

  // Coaches available for the current selection.
  const availableCoachIds: string[] =
    option && option.coachIds.length > 0
      ? option.coachIds
      : type && type.eligibleCoachIds.length > 0
        ? type.eligibleCoachIds
        : coaches.map((c) => c.id);
  const availableCoaches = coaches.filter((c) => availableCoachIds.includes(c.id));

  const price = option ? option.price : type ? type.basePrice : 0;

  function setSlot(i: number, patch: Partial<Slot>) {
    setSlots((s) => s.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function addSlot() {
    if (slots.length < 3) setSlots((s) => [...s, { date: "", startTime: "", endTime: "" }]);
  }
  function removeSlot(i: number) {
    setSlots((s) => s.filter((_, idx) => idx !== i));
  }

  const validSlots = slots.filter((s) => s.date && s.startTime && s.endTime);
  const canSubmit = !!type && validSlots.length > 0 && (options.length === 0 || !!option);

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
      }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setError(d.error || "Could not submit request"); return; }
    setDone(true);
    setTypeId(""); setOptionId(""); setCoachId("");
    setSlots([{ date: "", startTime: "", endTime: "" }]); setNotes("");
    load();
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

      {loading ? (
        <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>
      ) : types.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <p className="text-3xl mb-2 text-stone-200">◎</p>
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
                  <p className="text-sm font-semibold text-stone-900">{t.title}</p>
                  <p className="text-xs text-stone-500">
                    {t.durationMin} min
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

          {/* 2. Pricing option */}
          {type && options.length > 0 && (
            <div>
              <p className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">
                2 · Option
              </p>
              <div className="grid sm:grid-cols-2 gap-2">
                {options.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => { setOptionId(o.id); setCoachId(""); }}
                    className={`text-left p-3 rounded-lg border transition ${
                      optionId === o.id
                        ? "border-stone-900 bg-stone-50"
                        : "border-stone-200 hover:border-stone-300"
                    }`}
                  >
                    <p className="text-sm font-semibold text-stone-900">{o.label}</p>
                    <p className="text-xs text-stone-500">${Number(o.price).toFixed(2)}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 3. Coach */}
          {type && (options.length === 0 || option) && (
            <div>
              <p className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">
                {options.length > 0 ? "3" : "2"} · Coach
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
                    onClick={() => setCoachId(c.id)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition ${
                      coachId === c.id
                        ? "border-stone-900 bg-stone-900 text-white"
                        : "border-stone-200 text-stone-600 hover:bg-stone-50"
                    }`}
                  >
                    {c.firstName} {c.lastName}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 4. Times */}
          {type && (options.length === 0 || option) && (
            <div>
              <p className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">
                {options.length > 0 ? "4" : "3"} · Request up to 3 times
              </p>
              <div className="space-y-2">
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
                      <label className="block text-[11px] text-stone-500 mb-0.5">To</label>
                      <input
                        type="time"
                        value={s.endTime}
                        onChange={(e) => setSlot(i, { endTime: e.target.value })}
                        className="px-3 py-2 border border-stone-300 rounded-lg text-sm"
                      />
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
              {slots.length < 3 && (
                <button
                  onClick={addSlot}
                  className="mt-2 text-xs px-2.5 py-1 rounded-md border border-stone-300 text-stone-700 hover:bg-stone-50"
                >
                  + Add another time
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
                  Estimated: <span className="font-semibold text-stone-900">${price.toFixed(2)}</span>{" "}
                  <span className="text-xs text-stone-400">· billed by your club after confirmation</span>
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
                className="bg-white rounded-xl border border-stone-200 p-4 flex items-center justify-between gap-3"
              >
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
            ))}
          </div>
        </div>
      )}
    </>
  );
}
