"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Package, ArrowLeft } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { SkeletonList } from "@/components/LoadingSkeleton";

type EventLite = { id: string; name: string; startsAt: string; memberPrice: number | string | null; nonMemberPrice: number | string | null };
type BundleItem = { eventId: string; event: EventLite };
type Bundle = {
  id: string;
  name: string;
  description: string | null;
  price: number | string;
  published: boolean;
  items: BundleItem[];
};

export default function EventBundlesPage() {
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [events, setEvents] = useState<EventLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Bundle | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function load() {
    setLoading(true);
    const [b, e] = await Promise.all([
      fetch("/api/event-bundles").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/events?upcoming=true").then((r) => (r.ok ? r.json() : [])),
    ]);
    setBundles(Array.isArray(b) ? b : []);
    setEvents(Array.isArray(e) ? e.map((x: EventLite) => ({ id: x.id, name: x.name, startsAt: x.startsAt, memberPrice: x.memberPrice, nonMemberPrice: x.nonMemberPrice })) : []);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function remove(id: string) {
    if (!confirm("Delete this bundle? Members will no longer see it.")) return;
    await fetch(`/api/event-bundles/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl">
      <Link href="/dashboard/events" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary mb-3">
        <ArrowLeft size={15} /> Events
      </Link>
      <PageHeader
        title="Event bundles"
        description="Group several events into a package members buy for one discounted price."
        actions={
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover w-full sm:w-auto">
            + New bundle
          </button>
        }
      />

      {loading ? (
        <div className="bg-white rounded-xl border border-app-border"><SkeletonList rows={3} /></div>
      ) : bundles.length === 0 ? (
        <EmptyState
          icon={<Package size={26} strokeWidth={1.75} />}
          title="No bundles yet"
          description="Bundle a camp, a clinic series, or a set of events into one package deal."
          action={{ label: "Create your first bundle", onClick: () => setShowAdd(true) }}
          className="bg-white rounded-xl border border-app-border"
        />
      ) : (
        <div className="space-y-2">
          {bundles.map((b) => {
            const separate = b.items.reduce((sum, it) => sum + (Number(it.event.memberPrice) || Number(it.event.nonMemberPrice) || 0), 0);
            const price = Number(b.price);
            const savings = separate > price ? separate - price : 0;
            return (
              <div key={b.id} className="bg-white rounded-xl border border-app-border p-4">
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h3 className="text-sm font-semibold text-text-primary">{b.name}</h3>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${b.published ? "bg-green-50 text-green-700" : "bg-app-bg text-text-muted"}`}>
                        {b.published ? "Published" : "Draft"}
                      </span>
                    </div>
                    <p className="text-xs text-text-muted">
                      {b.items.length} event{b.items.length === 1 ? "" : "s"} · ${price.toFixed(2)}
                      {savings > 0 ? ` · saves $${savings.toFixed(2)} vs. separately` : ""}
                    </p>
                    <p className="text-[11px] text-text-muted mt-1 line-clamp-1">
                      {b.items.map((it) => it.event.name).join(", ") || "No events yet"}
                    </p>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button onClick={() => setEditing(b)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
                    <button onClick={() => remove(b.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Delete</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(showAdd || editing) && (
        <BundleModal
          bundle={editing}
          events={events}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function BundleModal({ bundle, events, onClose, onSaved }: {
  bundle: Bundle | null;
  events: EventLite[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!bundle;
  const [name, setName] = useState(bundle?.name || "");
  const [description, setDescription] = useState(bundle?.description || "");
  const [price, setPrice] = useState(bundle ? String(Number(bundle.price)) : "");
  const [published, setPublished] = useState(bundle?.published || false);
  const [eventIds, setEventIds] = useState<string[]>(bundle?.items.map((it) => it.eventId) || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function toggle(id: string) {
    setEventIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  async function save() {
    setError("");
    if (!name.trim()) { setError("Give the bundle a name."); return; }
    if (eventIds.length === 0) { setError("Add at least one event."); return; }
    const priceNum = Number(price);
    if (isNaN(priceNum) || priceNum < 0) { setError("Enter a valid price."); return; }
    setSaving(true);
    const url = isEdit ? `/api/event-bundles/${bundle!.id}` : "/api/event-bundles";
    try {
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null, price: priceNum, published, eventIds }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(typeof d.error === "string" ? d.error : "Save failed");
        return;
      }
      onSaved();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  }

  const separate = events.filter((e) => eventIds.includes(e.id)).reduce((s, e) => s + (Number(e.memberPrice) || Number(e.nonMemberPrice) || 0), 0);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white z-10">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit bundle" : "New bundle"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Summer Camp Package"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Description <span className="text-text-muted font-normal">(optional)</span></label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Package price ($)</label>
            <input type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            {separate > 0 && (
              <p className="text-[11px] text-text-muted mt-1">
                Sold separately these total ${separate.toFixed(2)}.
                {Number(price) > 0 && Number(price) < separate ? ` This bundle saves members $${(separate - Number(price)).toFixed(2)}.` : ""}
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Events in this bundle</label>
            {events.length === 0 ? (
              <p className="text-xs text-text-muted">No upcoming events to add yet.</p>
            ) : (
              <div className="space-y-1.5 max-h-56 overflow-y-auto border border-app-border rounded-lg p-2">
                {events.map((e) => (
                  <label key={e.id} className="flex items-center gap-2 text-sm text-text-primary px-1 py-1 rounded hover:bg-app-bg cursor-pointer">
                    <input type="checkbox" checked={eventIds.includes(e.id)} onChange={() => toggle(e.id)} />
                    <span className="flex-1 min-w-0 truncate">{e.name}</span>
                    <span className="text-[11px] text-text-muted">{new Date(e.startsAt).toLocaleDateString()}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} />
            Published — visible to members
          </label>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button onClick={save} disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save bundle" : "Create bundle"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
