"use client";

// Client / Public Preview launcher. Owners and staff can:
//   - Enter "Preview Member Portal" — sets a cookie + lands them on /member
//     with a banner. Real member data isn't loaded; the layout/UI is what's
//     being previewed.
//   - Open the public links the club has live (/, /pricing, /e/<slug>,
//     each /m/<membership>, etc.) in a fresh tab to see what non-members see.
// Every tier of AthletixOS can use preview mode — no tier gating below.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type ClubInfo = { id: string; name: string; slug: string };
type PublicEvent = { id: string; name: string; publicSlug: string | null };

export default function PreviewPage() {
  const router = useRouter();
  const [club, setClub] = useState<ClubInfo | null>(null);
  const [events, setEvents] = useState<PublicEvent[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/club/info").then((r) => (r.ok ? r.json() : null)).then(setClub).catch(() => {});
    fetch("/api/events").then((r) => (r.ok ? r.json() : []))
      .then((d) => {
        const list: PublicEvent[] = Array.isArray(d) ? d : d?.events ?? [];
        setEvents(list.filter((e) => e.publicSlug));
      })
      .catch(() => {});
  }, []);

  async function startMemberPreview() {
    setBusy(true);
    await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "member" }),
    });
    router.push("/member");
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-text-primary mb-1">Client View / Preview</h1>
        <p className="text-sm text-text-muted">
          See what athletes, parents, and the public see — without signing out or impersonating
          anyone. Real member data isn&apos;t loaded; this is a layout-and-content preview.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {/* Member portal preview */}
        <div className="bg-surface border border-app-border rounded-xl p-5">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">Member portal</p>
          <h2 className="text-base font-semibold text-text-primary mb-1">Preview the member experience</h2>
          <p className="text-sm text-text-muted mb-4">
            Opens <code className="px-1 py-0.5 bg-app-bg rounded text-[11px]">/member</code> with your
            club branding. The portal banner makes it obvious you&apos;re in preview. Click
            &quot;Exit preview&quot; in the banner to return to the dashboard.
          </p>
          <button
            onClick={startMemberPreview}
            disabled={busy}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
          >
            {busy ? "Opening…" : "Preview Member Portal"}
          </button>
        </div>

        {/* Public-side links */}
        <div className="bg-surface border border-app-border rounded-xl p-5">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">Public view</p>
          <h2 className="text-base font-semibold text-text-primary mb-1">What non-members see</h2>
          <p className="text-sm text-text-muted mb-3">
            These pages don&apos;t require a login. Open in a new tab to see them as a stranger would.
          </p>
          <ul className="space-y-1.5 text-sm">
            <li>
              <Link href="/" target="_blank" rel="noopener noreferrer" className="underline text-text-primary hover:text-brand">
                Marketing landing page (/)
              </Link>
            </li>
            <li>
              <Link href="/pricing" target="_blank" rel="noopener noreferrer" className="underline text-text-primary hover:text-brand">
                Pricing page (/pricing)
              </Link>
            </li>
            {club?.slug && (
              <li>
                <Link href={`/login?club=${encodeURIComponent(club.slug)}`} target="_blank" rel="noopener noreferrer" className="underline text-text-primary hover:text-brand">
                  Sign-in page with your club prefilled
                </Link>
              </li>
            )}
            <li>
              <Link href="/member/signup" target="_blank" rel="noopener noreferrer" className="underline text-text-primary hover:text-brand">
                Public member signup
              </Link>
            </li>
          </ul>
        </div>
      </div>

      {/* Public event links */}
      <div className="bg-surface border border-app-border rounded-xl p-5 mt-4">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">Public event registration links</p>
        <h2 className="text-base font-semibold text-text-primary mb-1">/e/&lt;slug&gt; pages</h2>
        <p className="text-sm text-text-muted mb-3">
          Anyone with the link can register and pay. These are the events you&apos;ve made public.
        </p>
        {events.length === 0 ? (
          <p className="text-sm text-text-muted">
            No public events yet. Enable a public link on an event under{" "}
            <Link href="/dashboard/events" className="underline text-text-primary">/dashboard/events</Link>.
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {events.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/e/${e.publicSlug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-text-primary hover:text-brand"
                >
                  {e.name} — /e/{e.publicSlug}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-surface border border-app-border rounded-xl p-5 mt-4">
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">Safety</p>
        <ul className="text-sm text-text-muted space-y-1 list-disc pl-5">
          <li>Preview does not impersonate any member.</li>
          <li>No real bookings, subscriptions, or messages load during preview.</li>
          <li>Permissions and tier-gating still apply to every API call.</li>
          <li>Exit preview from the banner at the top of the member portal.</li>
        </ul>
      </div>
    </div>
  );
}
