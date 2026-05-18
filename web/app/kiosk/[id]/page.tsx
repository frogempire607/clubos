"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

type Data = {
  kind: "class" | "event";
  title: string;
  dateLabel: string;
  timeLabel: string;
  club: { name: string; slug: string; logoUrl: string | null; primaryColor: string | null };
};

// Full-screen, branded check-in / signup kiosk. Staff opens this on a tablet
// (or prints it) and posts it at the door. The QR sends walk-ins to the
// club's member signup / sign-in. Public — no login needed to display it.
export default function KioskPage({ params }: { params: { id: string } }) {
  const [d, setD] = useState<Data | null>(null);
  const [qr, setQr] = useState("");
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`/api/checkin/${params.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j || j.error) { setNotFound(true); return; }
        setD(j);
      })
      .catch(() => setNotFound(true));
  }, [params.id]);

  useEffect(() => {
    if (!d) return;
    const url = `${window.location.origin}/c/${params.id}`;
    QRCode.toDataURL(url, { width: 720, margin: 1, errorCorrectionLevel: "M" })
      .then(setQr)
      .catch(() => setQr(""));
  }, [d, params.id]);

  if (notFound) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50 text-stone-500 text-sm">
        This check-in screen is no longer available.
      </div>
    );
  }
  if (!d) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50 text-stone-400 text-sm">
        Loading…
      </div>
    );
  }

  const accent = d.club.primaryColor || "#1C1917";

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center px-6 py-10 print:bg-white">
      <div className="w-full max-w-xl bg-white rounded-3xl border border-stone-200 shadow-sm overflow-hidden text-center print:shadow-none">
        {/* Brand header */}
        <div className="px-10 pt-10 pb-6 flex flex-col items-center">
          {d.club.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={d.club.logoUrl}
              alt={d.club.name}
              className="w-28 h-28 rounded-2xl object-cover mb-4"
            />
          ) : (
            <div
              className="w-28 h-28 rounded-2xl mb-4 flex items-center justify-center text-white text-4xl font-bold"
              style={{ background: accent }}
            >
              {d.club.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <h1 className="text-3xl font-bold text-stone-900">{d.club.name}</h1>
          <p className="text-base text-stone-500 mt-1">
            {d.dateLabel} · {d.timeLabel}
          </p>
          <p
            className="mt-3 text-xl font-semibold px-4 py-1.5 rounded-full"
            style={{ background: `${accent}14`, color: accent }}
          >
            {d.title}
          </p>
        </div>

        {/* Big QR */}
        <div className="px-10 pb-4 flex flex-col items-center">
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={qr}
              alt="Scan to sign up"
              className="w-72 h-72 sm:w-80 sm:h-80 rounded-2xl border border-stone-200"
            />
          ) : (
            <div className="w-72 h-72 rounded-2xl border border-stone-200 flex items-center justify-center text-stone-400 text-sm">
              Generating…
            </div>
          )}
        </div>

        {/* Call to action */}
        <div className="px-10 pb-10">
          <p className="text-xl font-semibold text-stone-900">Scan to sign up or sign in</p>
          <p className="text-sm text-stone-500 mt-1">
            Point your phone camera here to join {d.club.name} or check in.
          </p>
        </div>

        <div
          className="py-3 text-xs text-white/90 print:hidden"
          style={{ background: accent }}
        >
          Powered by AthletixOS
        </div>
      </div>

      <button
        onClick={() => window.print()}
        className="mt-6 text-xs text-stone-400 hover:text-stone-700 print:hidden"
      >
        Print this screen
      </button>
    </div>
  );
}
