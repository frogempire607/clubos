"use client";

import { useEffect, useState } from "react";
import { ListChecks, ArrowLeft } from "lucide-react";

type CustomField = {
  id: string;
  label: string;
  fieldType: string;
  required: boolean;
  options: string;
  sortOrder: number;
  active: boolean;
};

const fieldTypeLabels: Record<string, string> = {
  text: "Text",
  email: "Email",
  phone: "Phone",
  address: "Address",
  date: "Date",
  textarea: "Long text",
  number: "Number",
  select: "Dropdown",
};

export default function CustomFieldsPage() {
  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<CustomField | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/custom-fields");
    if (res.ok) setFields(await res.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(id: string) {
    if (!confirm("Delete this custom field? Existing values will remain on members.")) return;
    await fetch(`/api/custom-fields/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <a href="/dashboard/members" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Back to members
        </a>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Custom fields</h1>
          <p className="text-sm text-text-muted">Add any fields you want to collect from members — phone, address, emergency contact, anything.</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
          + Add field
        </button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
      ) : fields.length === 0 ? (
        <div className="bg-white rounded-xl border border-app-border p-12 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <ListChecks className="h-7 w-7" strokeWidth={2} />
          </div>
          <h3 className="text-lg font-medium text-text-primary mb-1">No custom fields yet</h3>
          <p className="text-sm text-text-muted mb-4">Add fields like phone, address, t-shirt size, emergency contact — whatever you need.</p>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
            + Add your first field
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map((f) => (
            <div key={f.id} className="bg-white rounded-xl border border-app-border p-4 flex items-center gap-3">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{f.label}</span>
                  {f.required && <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-red-50 text-red-700">Required</span>}
                </div>
                <div className="text-xs text-text-muted">{fieldTypeLabels[f.fieldType]}</div>
              </div>
              <button onClick={() => setEditing(f)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
              <button onClick={() => handleDelete(f.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Delete</button>
            </div>
          ))}
        </div>
      )}

      {(showAdd || editing) && (
        <FieldModal
          field={editing}
          onClose={() => { setShowAdd(false); setEditing(null); }}
          onSaved={() => { setShowAdd(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function FieldModal({ field, onClose, onSaved }: { field: CustomField | null; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!field;
  const initialOptions = (() => {
    if (!field) return [];
    try { return JSON.parse(field.options); } catch { return []; }
  })();

  const [label, setLabel] = useState(field?.label || "");
  const [fieldType, setFieldType] = useState(field?.fieldType || "text");
  const [required, setRequired] = useState(field?.required || false);
  const [options, setOptions] = useState<string[]>(initialOptions);
  const [newOption, setNewOption] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    const url = isEdit ? `/api/custom-fields/${field!.id}` : "/api/custom-fields";
    const method = isEdit ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, fieldType, required, options: fieldType === "select" ? options : [] }),
    });

    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error?.toString() || "Save failed");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit field" : "Add custom field"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Field label</label>
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Phone number" required className="w-full px-3 py-2 border border-app-border rounded-lg text-sm" />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Field type</label>
            <select value={fieldType} onChange={(e) => setFieldType(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white">
              <option value="text">Text</option>
              <option value="email">Email</option>
              <option value="phone">Phone</option>
              <option value="address">Address</option>
              <option value="date">Date</option>
              <option value="textarea">Long text</option>
              <option value="number">Number</option>
              <option value="select">Dropdown</option>
            </select>
          </div>

          {fieldType === "select" && (
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Dropdown options</label>
              <div className="space-y-1 mb-2">
                {options.map((o, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-app-bg rounded-md text-sm">
                    <span className="flex-1">{o}</span>
                    <button type="button" onClick={() => setOptions(options.filter((_, j) => j !== i))} className="text-text-muted hover:text-red-600 text-xs">×</button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input type="text" value={newOption} onChange={(e) => setNewOption(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (newOption.trim()) { setOptions([...options, newOption.trim()]); setNewOption(""); } } }} placeholder="Add an option" className="flex-1 px-3 py-1.5 border border-app-border rounded-md text-sm" />
                <button type="button" onClick={() => { if (newOption.trim()) { setOptions([...options, newOption.trim()]); setNewOption(""); } }} className="px-3 py-1.5 border border-app-border rounded-md text-sm hover:bg-app-bg">Add</button>
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="w-4 h-4 accent-stone-900" />
            <span className="text-sm text-text-primary">Required field</span>
          </label>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save" : "Add field"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
