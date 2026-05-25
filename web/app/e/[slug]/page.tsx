"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

type FormField = {
  id: string;
  label: string;
  type: "text" | "email" | "phone" | "textarea" | "select" | "checkbox";
  required: boolean;
  options?: string[];
};

type PublicEvent = {
  id: string;
  name: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  imageUrl: string | null;
  imagePositionX: number;
  imagePositionY: number;
  location: { name: string; address: string | null; latitude: number | null; longitude: number | null } | null;
  club: { name: string; logoUrl: string | null; primaryColor: string | null };
  isTournament: boolean;
  tournamentMode: string | null;
  publicFormIntro: string | null;
  registrationForm: FormField[];
  price: number | null;
  priceLabel: string;
  capacityReached: boolean;
  registrationOpen: boolean;
};

export default function PublicEventPage() {
  const { slug } = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [responses, setResponses] = useState<Record<string, string | boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<null | { message: string }>(null);

  const justRegistered = searchParams.get("registered") === "true";
  const justPaid = searchParams.get("paid") === "true";
  const wasCanceled = searchParams.get("canceled") === "true";

  useEffect(() => {
    fetch(`/api/public/events/${slug}`)
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          setError(d.error || "Event not found");
          setLoading(false);
          return null;
        }
        return r.json();
      })
      .then((d: PublicEvent | null) => {
        if (d) setEvent(d);
        setLoading(false);
      });
  }, [slug]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    const res = await fetch(`/api/public/events/${slug}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, phone: phone || null, formResponses: responses }),
    });
    const d = await res.json().catch(() => ({}));
    setSubmitting(false);
    if (!res.ok) {
      setError(typeof d.error === "string" ? d.error : "Registration failed");
      return;
    }
    if (d.url) {
      window.location.href = d.url;
      return;
    }
    setDone({
      message:
        d.message ||
        (d.free ? "You're registered! See you there." : "You're registered."),
    });
  }

  const accent = event?.club.primaryColor || "#534AB7";

  if (loading) {
    return <div className="min-h-screen bg-stone-50 flex items-center justify-center text-stone-400 text-sm">Loading…</div>;
  }

  if (error && !event) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-xl border border-stone-200 p-8 max-w-md text-center">
          <p className="text-2xl mb-2">🚫</p>
          <h1 className="text-lg font-semibold text-stone-900 mb-1">Can't open this event</h1>
          <p className="text-sm text-stone-500">{error}</p>
        </div>
      </div>
    );
  }

  if (!event) return null;

  return (
    <div className="min-h-screen bg-stone-50">
      {/* Header */}
      <header className="bg-white border-b border-stone-200">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-2">
          {event.club.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={event.club.logoUrl} alt="" className="w-7 h-7 rounded-md object-cover" />
          ) : (
            <div className="w-7 h-7 rounded-md flex items-center justify-center text-white text-xs font-bold" style={{ background: accent }}>
              {event.club.name[0]}
            </div>
          )}
          <span className="text-sm font-semibold text-stone-900">{event.club.name}</span>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6">
        {event.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={event.imageUrl}
            alt={event.name}
            className="w-full aspect-[16/9] object-cover rounded-xl border border-stone-200 mb-4"
            style={{ objectPosition: `${event.imagePositionX ?? 50}% ${event.imagePositionY ?? 50}%` }}
          />
        )}

        <div className="bg-white rounded-xl border border-stone-200 p-6 mb-4">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            {event.isTournament && (
              <span className="text-[11px] px-2 py-0.5 rounded-full font-medium text-white" style={{ background: accent }}>
                {event.tournamentMode === "HOST" ? "Tournament" : "Tournament Trip"}
              </span>
            )}
          </div>
          <h1 className="text-2xl font-semibold text-stone-900">{event.name}</h1>
          <p className="text-sm text-stone-500 mt-1">
            {new Date(event.startsAt).toLocaleString("en-US", {
              weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
            })}
            {" – "}
            {new Date(event.endsAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
          </p>
          {event.location && (
            <p className="text-sm text-stone-500 mt-0.5">
              📍 {event.location.name}{event.location.address ? ` · ${event.location.address}` : ""}
              {event.location.latitude != null && event.location.longitude != null && (
                <>
                  {" · "}
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${event.location.latitude},${event.location.longitude}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                    style={{ color: event.club.primaryColor ?? undefined }}
                  >
                    Directions
                  </a>
                </>
              )}
            </p>
          )}
          {event.description && (
            <p className="text-sm text-stone-700 mt-3 whitespace-pre-wrap leading-relaxed">{event.description}</p>
          )}
          <div className="mt-4 pt-4 border-t border-stone-100 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-stone-400 font-medium">Cost</span>
            <span className="text-sm font-semibold text-stone-900">{event.priceLabel}</span>
          </div>
        </div>

        {/* Status banners */}
        {(justRegistered || justPaid) && (
          <div className="bg-green-50 border border-green-200 rounded-xl p-4 mb-4 text-sm text-green-800">
            ✓ Payment received — you're registered. A confirmation has been emailed to you.
          </div>
        )}
        {wasCanceled && (
          <div className="bg-stone-100 border border-stone-200 rounded-xl p-4 mb-4 text-sm text-stone-600">
            Checkout canceled — you can try again below.
          </div>
        )}

        {done ? (
          <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
            <p className="text-3xl mb-2">🎉</p>
            <h2 className="text-lg font-semibold text-stone-900 mb-1">{done.message}</h2>
            <p className="text-sm text-stone-500">A confirmation has been sent to {email}.</p>
          </div>
        ) : !event.registrationOpen ? (
          <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
            <h2 className="text-base font-semibold text-stone-900 mb-1">
              {event.capacityReached ? "This event is full" : "Registration is closed"}
            </h2>
            <p className="text-sm text-stone-500">Contact {event.club.name} for more information.</p>
          </div>
        ) : (
          <form onSubmit={submit} className="bg-white rounded-xl border border-stone-200 p-6 space-y-4">
            <div>
              <h2 className="text-base font-semibold text-stone-900">Register</h2>
              {event.publicFormIntro && (
                <p className="text-sm text-stone-500 mt-1 whitespace-pre-wrap">{event.publicFormIntro}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Full name *</label>
              <input
                type="text" required value={name} onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2"
                style={{ outlineColor: accent }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Email *</label>
                <input
                  type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Phone</label>
                <input
                  type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2"
                />
              </div>
            </div>

            {/* Owner-defined custom fields */}
            {event.registrationForm.map((f) => (
              <div key={f.id}>
                <label className="block text-sm font-medium text-stone-700 mb-1">
                  {f.label}{f.required ? " *" : ""}
                </label>
                {f.type === "textarea" ? (
                  <textarea
                    required={f.required}
                    value={(responses[f.id] as string) || ""}
                    onChange={(e) => setResponses((r) => ({ ...r, [f.id]: e.target.value }))}
                    rows={3}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2"
                  />
                ) : f.type === "select" ? (
                  <select
                    required={f.required}
                    value={(responses[f.id] as string) || ""}
                    onChange={(e) => setResponses((r) => ({ ...r, [f.id]: e.target.value }))}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2"
                  >
                    <option value="">Select…</option>
                    {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : f.type === "checkbox" ? (
                  <label className="flex items-center gap-2 text-sm text-stone-700">
                    <input
                      type="checkbox"
                      checked={!!responses[f.id]}
                      onChange={(e) => setResponses((r) => ({ ...r, [f.id]: e.target.checked }))}
                    />
                    Yes
                  </label>
                ) : (
                  <input
                    type={f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text"}
                    required={f.required}
                    value={(responses[f.id] as string) || ""}
                    onChange={(e) => setResponses((r) => ({ ...r, [f.id]: e.target.value }))}
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2"
                  />
                )}
              </div>
            ))}

            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-lg text-white text-sm font-semibold disabled:opacity-50"
              style={{ background: accent }}
            >
              {submitting
                ? "Submitting…"
                : event.price && event.price > 0
                  ? `Register & pay $${event.price.toFixed(2)}`
                  : "Register"}
            </button>
            <p className="text-[11px] text-stone-400 text-center">
              Powered by AthletixOS
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
