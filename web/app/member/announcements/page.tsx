"use client";

import { useEffect, useState } from "react";

type Announcement = {
  id: string;
  title: string;
  body: string;
  channels: string;
  publishAt: string | null;
  createdAt: string;
};

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtRelative(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return fmtDate(iso);
}

export default function MemberAnnouncementsPage() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Announcement | null>(null);

  useEffect(() => {
    fetch("/api/member/announcements")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => {
        setItems(Array.isArray(d) ? d : []);
        setLoading(false);
      });
  }, []);

  async function openAnnouncement(announcement: Announcement) {
    setOpen(announcement);
    await fetch(`/api/member/announcements/${announcement.id}/engagement`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "open" }),
    }).catch(() => {});
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900 mb-1">Announcements</h1>
        <p className="text-sm text-stone-500">News and updates from your club.</p>
      </div>

      {loading ? (
        <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <p className="text-3xl mb-2 text-stone-200">◇</p>
          <p className="text-base font-medium text-stone-900 mb-1">No announcements yet</p>
          <p className="text-sm text-stone-500">When your club posts updates, they'll appear here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((a) => {
            const dateIso = a.publishAt || a.createdAt;
            return (
              <button
                key={a.id}
                onClick={() => openAnnouncement(a)}
                className="w-full text-left bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm transition"
              >
                <div className="flex items-start justify-between gap-3 mb-1">
                  <h3 className="text-sm font-semibold text-stone-900 truncate">{a.title}</h3>
                  <span className="text-[11px] text-stone-400 flex-shrink-0">{fmtRelative(dateIso)}</span>
                </div>
                <p className="text-sm text-stone-600 line-clamp-2 whitespace-pre-wrap">{a.body}</p>
              </button>
            );
          })}
        </div>
      )}

      {open && <AnnouncementViewer announcement={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function AnnouncementViewer({ announcement, onClose }: { announcement: Announcement; onClose: () => void }) {
  const dateIso = announcement.publishAt || announcement.createdAt;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-stone-200 flex items-start justify-between sticky top-0 bg-white">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-stone-900">{announcement.title}</h2>
            <p className="text-xs text-stone-400 mt-0.5">{fmtDate(dateIso)}</p>
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none ml-4 flex-shrink-0">×</button>
        </div>
        <div className="p-6">
          <div className="text-sm text-stone-700 leading-relaxed whitespace-pre-wrap">{announcement.body}</div>
        </div>
      </div>
    </div>
  );
}
