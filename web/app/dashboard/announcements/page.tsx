"use client";

import { useEffect, useState } from "react";
import { Megaphone, Smartphone, Mail, Bell, type LucideIcon } from "lucide-react";

type Announcement = {
  id: string;
  title: string;
  body: string;
  channels: string;
  publishAt: string | null;
  unpublishAt: string | null;
  createdAt: string;
  engagement?: {
    seen: number;
    opened: number;
    clicked: number;
    linkClicks?: number;
  };
};

type AnnouncementEngagement = {
  announcement: { id: string; title: string };
  totals: { seen: number; opened: number; clicked: number; linkClicks?: number };
  members: Array<{
    userId: string;
    name: string;
    email: string;
    role: string;
    memberStatus: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    openedAt: string | null;
    openCount: number;
    clickedAt: string | null;
    clickCount: number;
  }>;
};

type Status = "LIVE" | "SCHEDULED" | "EXPIRED";

function getStatus(a: Announcement): Status {
  const now = new Date();
  if (a.publishAt && new Date(a.publishAt) > now) return "SCHEDULED";
  if (a.unpublishAt && new Date(a.unpublishAt) < now) return "EXPIRED";
  return "LIVE";
}

const statusStyle: Record<Status, { bg: string; fg: string; label: string }> = {
  LIVE:      { bg: "var(--color-success)", fg: "#1F1F23", label: "Live" },
  SCHEDULED: { bg: "var(--color-warning)", fg: "#fff", label: "Scheduled" },
  EXPIRED:   { bg: "var(--color-bg)", fg: "var(--color-muted)", label: "Expired" },
};

const CHANNELS: { id: string; label: string; Icon: LucideIcon }[] = [
  { id: "app",   label: "In-App",  Icon: Smartphone },
  { id: "email", label: "Email",   Icon: Mail },
  { id: "push",  label: "Push",    Icon: Bell },
];

const FILTER_OPTIONS: Array<{ value: "ALL" | Status; label: string }> = [
  { value: "ALL",       label: "All" },
  { value: "LIVE",      label: "Live" },
  { value: "SCHEDULED", label: "Scheduled" },
  { value: "EXPIRED",   label: "Expired" },
];

export default function AnnouncementsPage() {
  const [items, setItems]       = useState<Announcement[]>([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState<"ALL" | Status>("ALL");
  const [showModal, setShowModal]   = useState(false);
  const [editing, setEditing]       = useState<Announcement | null>(null);
  const [engagement, setEngagement] = useState<AnnouncementEngagement | null>(null);
  const [engagementLoading, setEngagementLoading] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/announcements");
    if (res.ok) setItems(await res.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const filtered = items.filter((a) => filter === "ALL" || getStatus(a) === filter);

  async function handleDelete(id: string) {
    if (!confirm("Archive this announcement?")) return;
    await fetch(`/api/announcements/${id}`, { method: "DELETE" });
    load();
  }

  async function openEngagement(id: string) {
    setEngagementLoading(true);
    const res = await fetch(`/api/announcements/${id}/engagement`);
    if (res.ok) setEngagement(await res.json());
    setEngagementLoading(false);
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Announcements</h1>
          <p className="text-sm text-text-muted">Broadcast messages to all members</p>
        </div>
        <button
          onClick={() => { setEditing(null); setShowModal(true); }}
          className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors"
        >
          + New announcement
        </button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 bg-app-bg rounded-lg p-1 mb-6 w-fit">
        {FILTER_OPTIONS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
              filter === f.value
                ? "bg-white shadow-sm text-text-primary font-medium"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-16 text-text-muted text-sm">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-xl border border-app-border">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <Megaphone className="h-7 w-7" strokeWidth={2} />
          </div>
          <h3 className="text-lg font-medium text-text-primary mb-1">
            {filter === "ALL" ? "No announcements yet" : `No ${filter.toLowerCase()} announcements`}
          </h3>
          <p className="text-sm text-text-muted mb-4">
            Create your first announcement to reach all members at once.
          </p>
          <button
            onClick={() => { setEditing(null); setShowModal(true); }}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors"
          >
            + New announcement
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((a) => {
            const st = getStatus(a);
            const s = statusStyle[st];
            const channelList = a.channels.split(",").map((c) => c.trim()).filter(Boolean);
            return (
              <div key={a.id} className="bg-white rounded-xl border border-app-border p-5 hover:border-app-border transition-colors">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="text-xs px-2 py-0.5 rounded-full font-medium"
                        style={{ background: s.bg, color: s.fg }}
                      >
                        {s.label}
                      </span>
                      <div className="flex gap-1">
                        {CHANNELS.filter((c) => channelList.includes(c.id)).map((c) => (
                          <span key={c.id} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-app-bg text-text-muted">
                            <c.Icon className="h-3 w-3" strokeWidth={2} /> {c.label}
                          </span>
                        ))}
                      </div>
                    </div>
                    <h3 className="text-base font-semibold text-text-primary mb-1">{a.title}</h3>
                    <p className="text-sm text-text-muted line-clamp-2">{a.body}</p>
                    <div className="mt-2 text-xs text-text-muted flex gap-3">
                      {a.publishAt && (
                        <span>Publishes {new Date(a.publishAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                      )}
                      {!a.publishAt && (
                        <span>Created {new Date(a.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                      )}
                      {a.engagement && (
                        <span>
                          Seen {a.engagement.seen} · Opened {a.engagement.opened}
                          {(a.engagement.linkClicks ?? a.engagement.clicked) > 0
                            ? ` · Link clicks ${a.engagement.linkClicks ?? a.engagement.clicked}`
                            : ""}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => openEngagement(a.id)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-app-border text-text-muted hover:bg-app-bg transition-colors"
                    >
                      Engagement
                    </button>
                    <button
                      onClick={() => { setEditing(a); setShowModal(true); }}
                      className="text-xs px-3 py-1.5 rounded-lg border border-app-border text-text-muted hover:bg-app-bg transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(a.id)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                    >
                      Archive
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <AnnouncementModal
          announcement={editing}
          onClose={() => { setShowModal(false); setEditing(null); }}
          onSaved={() => { setShowModal(false); setEditing(null); load(); }}
        />
      )}
      {(engagement || engagementLoading) && (
        <EngagementModal
          loading={engagementLoading}
          data={engagement}
          onClose={() => { setEngagement(null); setEngagementLoading(false); }}
        />
      )}
    </div>
  );
}

function EngagementModal({
  loading,
  data,
  onClose,
}: {
  loading: boolean;
  data: AnnouncementEngagement | null;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Announcement engagement</h2>
            {data && <p className="text-xs text-text-muted mt-0.5">{data.announcement.title}</p>}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        {loading || !data ? (
          <div className="p-8 text-center text-sm text-text-muted">Loading engagement...</div>
        ) : (
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                ["Seen", data.totals.seen],
                ["Opened", data.totals.opened],
                ["Link clicks", data.totals.linkClicks ?? data.totals.clicked],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-app-border bg-app-bg p-3">
                  <p className="text-xs text-text-muted uppercase tracking-wide">{label}</p>
                  <p className="text-2xl font-semibold text-text-primary">{value}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-text-muted">
              Seen means the announcement was listed in the member portal. Opened means the member opened the announcement detail. Link clicks only count URL links inside the announcement body.
            </p>

            {data.members.length === 0 ? (
              <div className="text-center py-10 text-sm text-text-muted border border-dashed border-app-border rounded-lg">
                No member views recorded yet.
              </div>
            ) : (
              <div className="overflow-x-auto border border-app-border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-app-bg border-b border-app-border">
                    <tr>
                      {["Member", "Status", "Seen", "Opened", "Link clicks"].map((h) => (
                        <th key={h} className="text-left text-xs text-text-muted uppercase tracking-wide px-3 py-2">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.members.map((member) => (
                      <tr key={member.userId} className="border-b border-app-border last:border-0">
                        <td className="px-3 py-2">
                          <p className="font-medium text-text-primary">{member.name}</p>
                          <p className="text-xs text-text-muted">{member.email}</p>
                        </td>
                        <td className="px-3 py-2 text-text-muted">{member.memberStatus || member.role}</td>
                        <td className="px-3 py-2 text-text-muted">{formatDateTime(member.lastSeenAt)}</td>
                        <td className="px-3 py-2 text-text-muted">
                          {member.openedAt ? `${formatDateTime(member.openedAt)} (${member.openCount})` : "Not yet"}
                        </td>
                        <td className="px-3 py-2 text-text-muted">
                          {member.clickedAt ? `${formatDateTime(member.clickedAt)} (${member.clickCount})` : "Not yet"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function AnnouncementModal({
  announcement,
  onClose,
  onSaved,
}: {
  announcement: Announcement | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!announcement;
  const [title, setTitle]           = useState(announcement?.title ?? "");
  const [body, setBody]             = useState(announcement?.body ?? "");
  const [channels, setChannels]     = useState<string[]>(
    announcement ? announcement.channels.split(",").map((c) => c.trim()).filter(Boolean) : ["app"]
  );
  const [publishAt, setPublishAt]   = useState(
    announcement?.publishAt ? announcement.publishAt.slice(0, 16) : ""
  );
  const [unpublishAt, setUnpublishAt] = useState(
    announcement?.unpublishAt ? announcement.unpublishAt.slice(0, 16) : ""
  );
  const [sendNow, setSendNow]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState("");

  function toggleChannel(id: string) {
    setChannels((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !body.trim()) { setError("Title and body are required"); return; }
    if (channels.length === 0) { setError("Select at least one channel"); return; }

    setError("");
    setSaving(true);

    const payload = {
      title,
      body,
      channels: channels.join(","),
      publishAt: publishAt || null,
      unpublishAt: unpublishAt || null,
      sendNow,
    };

    const res = isEdit
      ? await fetch(`/api/announcements/${announcement!.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      : await fetch("/api/announcements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

    setSaving(false);
    if (!res.ok) {
      // Surface the server's reason (tier gate, SMTP missing, validation…) —
      // the blanket message hid why a publish failed.
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" && d.error ? d.error : "Failed to save announcement");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-text-primary">
            {isEdit ? "Edit announcement" : "New announcement"}
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{error}</div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              Title <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder="Summer camp registration open!"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              Body <span className="text-red-500">*</span>
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
              rows={5}
              placeholder="Write your announcement here…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand resize-none"
            />
          </div>

          {/* Channels */}
          <div>
            <label className="block text-sm font-medium text-text-primary mb-2">Delivery channels</label>
            <div className="flex gap-2 flex-wrap">
              {CHANNELS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleChannel(c.id)}
                  className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border transition-colors ${
                    channels.includes(c.id)
                      ? "bg-brand border-brand text-white"
                      : "border-app-border text-text-muted hover:bg-app-bg"
                  }`}
                >
                  <c.Icon className="h-4 w-4" strokeWidth={2} /> {c.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-text-muted mt-1">Email requires SMTP to be configured in your .env</p>
          </div>

          {/* Schedule */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Publish at (optional)</label>
              <input
                type="datetime-local"
                value={publishAt}
                onChange={(e) => setPublishAt(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <p className="text-xs text-text-muted mt-1">Leave blank to publish now</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Unpublish at (optional)</label>
              <input
                type="datetime-local"
                value={unpublishAt}
                onChange={(e) => setUnpublishAt(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
            </div>
          </div>

          {/* Email blast option */}
          {!isEdit && channels.includes("email") && (
            <div className="flex items-center gap-3 py-2 px-3 border border-brand/20 bg-brand/5 rounded-lg">
              <input
                type="checkbox"
                id="sendNow"
                checked={sendNow}
                onChange={(e) => setSendNow(e.target.checked)}
                className="rounded"
              />
              <label htmlFor="sendNow" className="text-sm text-text-primary cursor-pointer">
                Send email immediately to all active members
              </label>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition-colors"
            >
              {saving ? "Saving…" : isEdit ? "Save changes" : "Publish"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
