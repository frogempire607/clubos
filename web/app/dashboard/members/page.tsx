"use client";

import { useEffect, useRef, useState } from "react";
import StripeRequiredBanner from "@/components/StripeRequiredBanner";
import ImageUpload from "@/components/ImageUpload";
import ExportMenu from "@/components/ExportMenu";

type GuardianProfile = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

type Member = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: "ACTIVE" | "PROSPECT" | "INACTIVE" | "PAUSED";
  tags: string;
  dateOfBirth: string | null;
  notes: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  gender: string | null;
  customFieldValues: string;
  joinedAt: string;
  isMinor: boolean;
  guardianId: string | null;
  guardianName: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
  guardianRelationship: string | null;
  guardian?: GuardianProfile | null;
  membership?: { name: string } | null;
  subscriptions?: { id: string; status: string; membership: { name: string }; optionLabel: string }[];
};

type CustomField = { id: string; label: string; fieldType: string; required: boolean; options: string };
type Membership = { id: string; name: string; options: string; active: boolean; autoRenewDefault: boolean };
type Option = { label: string; price: number; billingPeriod: string };

const statusColors: Record<string, { bg: string; fg: string }> = {
  ACTIVE: { bg: "var(--color-success)", fg: "var(--color-text)" },
  PROSPECT: { bg: "var(--color-primary)", fg: "#fff" },
  INACTIVE: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
  PAUSED: { bg: "var(--color-warning)", fg: "#fff" },
};

// ── Simple CSV parser ──────────────────────────────────────────────────────
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
    } else if ((c === "\n" || c === "\r") && !inQuotes) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field.trim());
      if (row.some((f) => f)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field || row.length) { row.push(field.trim()); if (row.some((f) => f)) rows.push(row); }
  return rows;
}

const MEMBER_FIELDS = [
  { key: "firstName",     label: "First name",     required: true  },
  { key: "lastName",      label: "Last name",       required: true  },
  { key: "email",         label: "Email",           required: false },
  { key: "phone",         label: "Phone",           required: false },
  { key: "dateOfBirth",   label: "Date of birth",   required: false },
  { key: "gender",        label: "Gender",          required: false },
  { key: "streetAddress", label: "Street address",  required: false },
  { key: "city",          label: "City",            required: false },
  { key: "state",         label: "State",           required: false },
  { key: "zipCode",       label: "Zip code",        required: false },
  { key: "status",        label: "Status",          required: false },
  { key: "tags",          label: "Tags",            required: false },
  { key: "notes",         label: "Notes",           required: false },
  { key: "guardianName",  label: "Guardian name",   required: false },
  { key: "guardianEmail", label: "Guardian email",  required: false },
  { key: "guardianPhone", label: "Guardian phone",  required: false },
  { key: "skip",          label: "— Skip column —", required: false },
];

export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const [subscribing, setSubscribing] = useState<Member | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [filter, setFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [membershipFilter, setMembershipFilter] = useState("");
  const [genderFilter, setGenderFilter] = useState("");
  const [ageFilter, setAgeFilter] = useState("");
  const [customFieldFilter, setCustomFieldFilter] = useState("");
  const [customFieldValue, setCustomFieldValue] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  async function load() {
    setLoading(true);
    const [mRes, fRes] = await Promise.all([fetch("/api/members"), fetch("/api/custom-fields")]);
    if (mRes.ok) setMembers(await mRes.json());
    if (fRes.ok) setCustomFields(await fRes.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  const filtered = members.filter((m) => {
    if (filter !== "ALL" && m.status !== filter) return false;
    if (tagFilter && !m.tags.split(",").map((t) => t.trim()).includes(tagFilter)) return false;
    const activeSub = m.subscriptions?.find((s) => s.status === "active");
    if (membershipFilter && activeSub?.membership.name !== membershipFilter && m.membership?.name !== membershipFilter) return false;
    if (genderFilter && m.gender !== genderFilter) return false;
    if (ageFilter === "minor" && !m.isMinor) return false;
    if (ageFilter === "adult" && m.isMinor) return false;
    if (customFieldFilter && customFieldValue) {
      let values: Record<string, string> = {};
      try { values = JSON.parse(m.customFieldValues || "{}"); } catch {}
      if ((values[customFieldFilter] || "").toLowerCase() !== customFieldValue.toLowerCase()) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      return [
        m.firstName,
        m.lastName,
        m.email || "",
        m.phone || "",
        m.guardianName || "",
        m.guardianEmail || "",
        m.guardianPhone || "",
        m.tags,
      ].some((v) => v.toLowerCase().includes(q));
    }
    return true;
  });

  const allTags = Array.from(new Set(members.flatMap((m) => m.tags.split(",").map((t) => t.trim()).filter(Boolean)))).sort();
  const allMemberships = Array.from(new Set(members.flatMap((m) => [
    m.membership?.name,
    ...(m.subscriptions || []).filter((s) => s.status === "active").map((s) => s.membership.name),
  ]).filter(Boolean) as string[])).sort();
  const allGenders = Array.from(new Set(members.map((m) => m.gender).filter(Boolean) as string[])).sort();

  const counts = {
    ALL: members.length,
    ACTIVE: members.filter((m) => m.status === "ACTIVE").length,
    PROSPECT: members.filter((m) => m.status === "PROSPECT").length,
    INACTIVE: members.filter((m) => m.status === "INACTIVE").length,
    PAUSED: members.filter((m) => m.status === "PAUSED").length,
  };

  async function handleDelete(id: string) {
    if (!confirm("Remove this member?")) return;
    const res = await fetch(`/api/members/${id}`, { method: "DELETE" });
    if (res.ok) load();
  }

  return (
    <div className="p-8 max-w-7xl">
      <StripeRequiredBanner feature="charge members for memberships" />

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Members</h1>
          <p className="text-sm text-text-muted">{members.length} total</p>
        </div>
        <div className="flex gap-2">
          <a href="/dashboard/custom-fields" className="text-sm px-3 py-2 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">
            Custom fields
          </a>
          <ExportMenu baseUrl="/api/export/members" label="Export" />
          <button onClick={() => setShowImport(true)} className="text-sm px-3 py-2 rounded-lg border border-app-border text-text-primary hover:bg-app-bg">
            Import CSV
          </button>
          <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover transition-colors">
            + Add member
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="flex gap-1 bg-app-bg rounded-lg p-1">
          {(["ALL", "ACTIVE", "PROSPECT", "INACTIVE", "PAUSED"] as const).map((s) => (
            <button key={s} onClick={() => setFilter(s)} className={`text-xs px-3 py-1.5 rounded-md transition ${filter === s ? "bg-surface shadow-sm text-text-primary font-medium" : "text-text-muted"}`}>
              {s.charAt(0) + s.slice(1).toLowerCase()} ({counts[s]})
            </button>
          ))}
        </div>
        <input type="text" placeholder="Search name, email, phone, guardian…" value={search} onChange={(e) => setSearch(e.target.value)} className="flex-1 max-w-xs px-3 py-1.5 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-4">
        <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="">All tags</option>
          {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={membershipFilter} onChange={(e) => setMembershipFilter(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="">All memberships</option>
          {allMemberships.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select value={genderFilter} onChange={(e) => setGenderFilter(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="">All genders</option>
          {allGenders.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select value={ageFilter} onChange={(e) => setAgeFilter(e.target.value)} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="">All ages</option>
          <option value="minor">Minors</option>
          <option value="adult">Adults</option>
        </select>
        <select value={customFieldFilter} onChange={(e) => { setCustomFieldFilter(e.target.value); setCustomFieldValue(""); }} className="px-3 py-2 border border-app-border rounded-lg text-sm bg-surface">
          <option value="">Custom field</option>
          {customFields.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        {customFieldFilter && (
          <input value={customFieldValue} onChange={(e) => setCustomFieldValue(e.target.value)} placeholder="Custom field value" className="px-3 py-2 border border-app-border rounded-lg text-sm" />
        )}
      </div>

      {selectedIds.size > 0 && (
        <div className="mb-4 flex items-center gap-3 bg-app-bg border border-app-border rounded-lg px-3 py-2">
          <span className="text-sm text-text-primary">{selectedIds.size} selected</span>
          <a
            href={`/api/export/members?ids=${encodeURIComponent(Array.from(selectedIds).join(","))}`}
            className="text-sm px-3 py-1.5 rounded-md bg-surface border border-app-border text-text-primary hover:bg-app-bg"
          >
            Export selected
          </a>
          <button onClick={() => setSelectedIds(new Set())} className="text-sm text-text-muted hover:text-text-primary">Clear</button>
        </div>
      )}

      <div className="bg-surface rounded-xl border border-app-border overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <div className="text-4xl mb-2">◉</div>
            <h3 className="text-lg font-medium text-text-primary mb-1">No members yet</h3>
            <p className="text-sm text-text-muted mb-4">Add your first member or import from a CSV file.</p>
            <div className="flex gap-2 justify-center">
              <button onClick={() => setShowImport(true)} className="px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Import CSV</button>
              <button onClick={() => setShowAdd(true)} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">+ Add member</button>
            </div>
          </div>
        ) : (
          <table className="w-full">
            <thead className="bg-app-bg border-b border-app-border">
              <tr>
                <Th>
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && filtered.every((m) => selectedIds.has(m.id))}
                    onChange={(e) => setSelectedIds(e.target.checked ? new Set(filtered.map((m) => m.id)) : new Set())}
                  />
                </Th>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th>Tags</Th>
                <Th>Membership</Th>
                <Th>Joined</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const c = statusColors[m.status];
                const activeSub = m.subscriptions?.find((s) => s.status === "active");
                return (
                  <tr key={m.id} className="border-b border-app-border last:border-0 hover:bg-app-bg">
                    <Td>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(m.id)}
                        onChange={() => setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(m.id)) next.delete(m.id);
                          else next.add(m.id);
                          return next;
                        })}
                      />
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-app-border flex items-center justify-center text-xs font-medium text-text-primary flex-shrink-0 overflow-hidden">
                          {(m as any).profileImageUrl
                            ? <img src={(m as any).profileImageUrl} alt="" className="w-full h-full object-cover" />
                            : <>{m.firstName[0]}{m.lastName[0]}</>
                          }
                        </div>
                        <div>
                          <div className="text-sm font-medium text-text-primary">{m.firstName} {m.lastName}</div>
                          {m.email && <div className="text-xs text-text-muted">{m.email}</div>}
                          {m.isMinor && (
                            <div className="text-xs text-text-muted flex items-center gap-1">
                              <span>Minor</span>
                              {m.guardianName && <span>· Guardian: {m.guardianName}</span>}
                            </div>
                          )}
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: c.bg, color: c.fg }}>
                        {m.status.charAt(0) + m.status.slice(1).toLowerCase()}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex gap-1 flex-wrap">
                        {m.tags.split(",").map((t) => t.trim()).filter(Boolean).map((t) => (
                          <span key={t} className="text-xs px-2 py-0.5 rounded-full bg-app-bg text-text-primary">{t}</span>
                        ))}
                      </div>
                    </Td>
                    <Td>
                      {activeSub ? (
                        <div>
                          <div className="text-sm text-text-primary">{activeSub.membership.name}</div>
                          <div className="text-[10px] text-text-muted">{activeSub.optionLabel}</div>
                        </div>
                      ) : (
                        <button onClick={() => setSubscribing(m)} className="text-xs px-2 py-1 rounded text-text-muted hover:bg-app-bg">
                          + Purchase membership
                        </button>
                      )}
                    </Td>
                    <Td>
                      <span className="text-sm text-text-muted">{new Date(m.joinedAt).toLocaleDateString()}</span>
                    </Td>
                    <Td>
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => setEditing(m)} className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg">Edit</button>
                        <button onClick={() => handleDelete(m.id)} className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded">Remove</button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {(showAdd || editing) && (
        <MemberModal member={editing} customFields={customFields} onClose={() => { setShowAdd(false); setEditing(null); }} onSaved={() => { setShowAdd(false); setEditing(null); load(); }} />
      )}

  {subscribing && <PurchaseMembershipModal member={subscribing} onClose={() => setSubscribing(null)} />}

      {showImport && <ImportCSVModal customFields={customFields} onClose={() => setShowImport(false)} onImported={() => { setShowImport(false); load(); }} />}
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="text-left text-xs font-medium text-text-muted uppercase tracking-wider px-5 py-3">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-5 py-3">{children}</td>;
}

// ── Member Modal ─────────────────────────────────────────────────────────────
function MemberModal({ member, customFields, onClose, onSaved }: { member: Member | null; customFields: CustomField[]; onClose: () => void; onSaved: () => void }) {
  const isEdit = !!member;
  const initialCustomValues = (() => { try { return JSON.parse(member?.customFieldValues || "{}"); } catch { return {}; } })();

  const athleteName = member ? `${member.firstName} ${member.lastName}`.trim() : "";
  const [fullName, setFullName] = useState(athleteName);
  const [email, setEmail] = useState(member?.email || "");
  const [phone, setPhone] = useState(member?.phone || "");
  const [gender, setGender] = useState(member?.gender || "");
  const [streetAddress, setStreetAddress] = useState(member?.streetAddress || "");
  const [city, setCity]                   = useState(member?.city || "");
  const [state, setState]                 = useState(member?.state || "");
  const [zipCode, setZipCode]             = useState(member?.zipCode || "");
  const [status, setStatus] = useState(member?.status || "PROSPECT");
  const [tags, setTags] = useState(member?.tags || "");
  const [dateOfBirth, setDateOfBirth] = useState(member?.dateOfBirth ? new Date(member.dateOfBirth).toISOString().slice(0, 10) : "");
  const [notes, setNotes] = useState(member?.notes || "");
  const [isMinor, setIsMinor] = useState(member?.isMinor || false);
  const [guardianName, setGuardianName] = useState(member?.guardianName || "");
  const [guardianEmail, setGuardianEmail] = useState(member?.guardianEmail || "");
  const [guardianPhone, setGuardianPhone] = useState(member?.guardianPhone || "");
  const [guardianRelationship, setGuardianRelationship] = useState(member?.guardianRelationship || "");
  const [profileImageUrl, setProfileImageUrl] = useState((member as any)?.profileImageUrl || "");
  const [customValues, setCustomValues] = useState<Record<string, string>>(initialCustomValues);
  const [siblings, setSiblings] = useState<{ id: string; firstName: string; lastName: string }[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Look up siblings when guardian email changes — server matches both
  // legacy inline guardianEmail and the normalized Guardian profile email.
  useEffect(() => {
    if (!isMinor || !guardianEmail) { setSiblings([]); return; }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/members?guardianEmail=${encodeURIComponent(guardianEmail)}`);
      if (res.ok) {
        const all: Member[] = await res.json();
        setSiblings(all.filter((m) => m.id !== member?.id));
      }
    }, 400);
    return () => clearTimeout(t);
  }, [guardianEmail, isMinor, member?.id]);

  function splitName(name: string) {
    const parts = name.trim().split(/\s+/);
    const firstName = parts[0] || "";
    const lastName = parts.slice(1).join(" ") || parts[0] || "";
    return { firstName, lastName };
  }

  function setCV(id: string, value: string) { setCustomValues({ ...customValues, [id]: value }); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    const url = isEdit ? `/api/members/${member!.id}` : "/api/members";
    const method = isEdit ? "PATCH" : "POST";
    const { firstName, lastName } = splitName(fullName);
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName, lastName, email: email || null,
        phone: phone || null,
        gender: gender || null,
        streetAddress: streetAddress || null,
        city: city || null,
        state: state || null,
        zipCode: zipCode || null,
        status, tags,
        dateOfBirth: dateOfBirth || undefined,
        notes,
        customFieldValues: customValues,
        profileImageUrl: profileImageUrl || null,
        isMinor,
        guardianName: isMinor ? guardianName : undefined,
        guardianEmail: isMinor ? guardianEmail : undefined,
        guardianPhone: isMinor ? guardianPhone : undefined,
        guardianRelationship: isMinor ? guardianRelationship : undefined,
      }),
    });
    setSaving(false);
    if (!res.ok) { const data = await res.json(); setError(data.error?.toString() || "Save failed"); return; }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <h2 className="text-lg font-semibold text-text-primary">{isEdit ? "Edit member" : "Add member"}</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <ImageUpload
            label="Profile photo"
            value={profileImageUrl || null}
            onChange={setProfileImageUrl}
            shape="circle"
          />

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              Athlete name <span className="text-red-500">*</span>
            </label>
            <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} required placeholder="First Last" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              Email {!isMinor && <span className="text-red-500">*</span>}
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required={!isMinor}
              placeholder={isMinor ? "Optional for minors" : "athlete@example.com"}
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
            <p className="text-xs text-text-muted mt-1">
              {isMinor ? "Guardian email is used as primary contact for minors" : "Used to link their member portal account"}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Phone</label>
              <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 000-0000" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Gender</label>
              <select value={gender} onChange={(e) => setGender(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-brand">
                <option value="">Prefer not to say</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Non-binary">Non-binary</option>
                <option value="Other">Other</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Street address</label>
            <input type="text" value={streetAddress} onChange={(e) => setStreetAddress(e.target.value)} placeholder="123 Main St" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-1">
              <label className="block text-sm font-medium text-text-primary mb-1">City</label>
              <input type="text" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Springfield" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">State</label>
              <input type="text" value={state} onChange={(e) => setState(e.target.value)} placeholder="IL" maxLength={2} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Zip code</label>
              <input type="text" value={zipCode} onChange={(e) => setZipCode(e.target.value)} placeholder="62701" maxLength={10} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as any)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-brand">
              <option value="PROSPECT">Prospect</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="PAUSED">Paused</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Date of birth</label>
            <input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          {/* Minor toggle */}
          <div className="flex items-center gap-3 py-2 border border-app-border rounded-lg px-3">
            <input type="checkbox" id="isMinor" checked={isMinor} onChange={(e) => setIsMinor(e.target.checked)} className="rounded" />
            <label htmlFor="isMinor" className="text-sm font-medium text-text-primary cursor-pointer select-none">This member is a minor (under 18)</label>
          </div>

          {isMinor && (
            <div className="space-y-3 p-4 bg-orange-accent/10 border border-orange-accent/30 rounded-lg">
              <p className="text-xs font-medium text-text-primary uppercase tracking-wider">Guardian / Parent Information</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-text-primary mb-1">Guardian name</label>
                  <input type="text" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" placeholder="Full name" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-primary mb-1">Relationship</label>
                  <select value={guardianRelationship} onChange={(e) => setGuardianRelationship(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none">
                    <option value="">Select…</option>
                    <option value="Parent">Parent</option>
                    <option value="Mother">Mother</option>
                    <option value="Father">Father</option>
                    <option value="Legal guardian">Legal guardian</option>
                    <option value="Grandparent">Grandparent</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Guardian email</label>
                <input type="email" value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" placeholder="guardian@email.com" />
              </div>
              <div>
                <label className="block text-xs font-medium text-text-primary mb-1">Guardian phone <span className="text-red-500">*</span></label>
                <input type="tel" value={guardianPhone} onChange={(e) => setGuardianPhone(e.target.value)} required={isMinor} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" placeholder="(555) 000-0000" />
              </div>

              {siblings.length > 0 && (
                <div className="p-3 bg-surface border border-orange-accent/40 rounded-lg">
                  <p className="text-xs font-medium text-text-primary mb-2">Existing athletes under this guardian:</p>
                  <div className="space-y-1">
                    {siblings.map((s) => (
                      <div key={s.id} className="text-xs text-text-primary flex items-center gap-1">
                        <span className="text-orange-accent">◉</span>
                        {s.firstName} {s.lastName}
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-text-muted mt-2">This athlete will be linked to the same guardian.</p>
                </div>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Tags</label>
            <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Beginner, 14U, Travel team" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            <p className="text-xs text-text-muted mt-1">Comma-separated</p>
          </div>

          {customFields.length > 0 && (
            <div className="pt-2 border-t border-app-border">
              <p className="text-xs uppercase tracking-wider text-text-muted mb-3 font-medium">Custom fields</p>
              <div className="space-y-3">
                {customFields.map((f) => {
                  const opts = (() => { try { return JSON.parse(f.options); } catch { return []; } })();
                  return (
                    <div key={f.id}>
                      <label className="block text-sm font-medium text-text-primary mb-1">{f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}</label>
                      {f.fieldType === "textarea" ? (
                        <textarea value={customValues[f.id] || ""} onChange={(e) => setCV(f.id, e.target.value)} required={f.required} rows={3} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand resize-none" />
                      ) : f.fieldType === "select" ? (
                        <select value={customValues[f.id] || ""} onChange={(e) => setCV(f.id, e.target.value)} required={f.required} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-brand">
                          <option value="">Select…</option>
                          {opts.map((o: string) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input type={f.fieldType === "number" ? "number" : f.fieldType === "date" ? "date" : f.fieldType === "email" ? "email" : f.fieldType === "phone" ? "tel" : "text"} value={customValues[f.id] || ""} onChange={(e) => setCV(f.id, e.target.value)} required={f.required} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand resize-none" />
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : isEdit ? "Save changes" : "Add member"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Purchase Membership Modal ────────────────────────────────────────────────
function PurchaseMembershipModal({ member, onClose }: { member: Member; onClose: () => void }) {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [selectedMembership, setSelectedMembership] = useState("");
  const [selectedOption, setSelectedOption] = useState("");
  // Assignment controls
  const [billingType, setBillingType] = useState<"RECURRING" | "ONE_TIME" | "MANUAL">("RECURRING");
  const [autoRenew, setAutoRenew] = useState(true);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [billingDay, setBillingDay] = useState("");
  const [notes, setNotes] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/memberships").then((r) => r.json()).then((d) => {
      setMemberships(Array.isArray(d) ? d : []);
      setLoading(false);
    });
  }, []);

  const currentMembership = memberships.find((m) => m.id === selectedMembership);
  const options: Option[] = (() => { try { return JSON.parse(currentMembership?.options || "[]"); } catch { return []; } })();
  const selectedOptionObj = options.find((o) => o.label === selectedOption);
  const isOneTime = selectedOptionObj?.billingPeriod === "ONE_TIME";

  const periodLabels: Record<string, string> = {
    WEEKLY: "per week", MONTHLY: "per month", QUADRIMESTRAL: "per 4 months",
    QUARTERLY: "per 3 months", SEMI_ANNUAL: "per 6 months", ANNUAL: "per year", ONE_TIME: "one-time",
  };

  // When membership changes, reset billing type to match plan default
  function selectMembership(id: string) {
    setSelectedMembership(id);
    setSelectedOption("");
    const m = memberships.find((x) => x.id === id);
    if (m) setAutoRenew(m.autoRenewDefault);
  }

  async function handleSubmit() {
    setError("");
    setSubmitting(true);

    const resolvedBillingType = isOneTime ? "ONE_TIME" : billingType;

    const res = await fetch("/api/members/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memberId: member.id,
        membershipId: selectedMembership,
        optionLabel: selectedOption,
        billingType: resolvedBillingType,
        autoRenew: resolvedBillingType === "MANUAL" ? false : autoRenew,
        startDate: startDate || null,
        endDate: endDate || null,
        billingDay: billingDay ? parseInt(billingDay, 10) : null,
        notes: notes || null,
      }),
    });

    const data = await res.json();
    setSubmitting(false);

    if (!res.ok) { setError(data.error?.toString() || "Failed"); return; }

    // Manual assignment completes immediately
    if (data.type === "manual") { setDone(true); return; }

    // Stripe checkout
    if (data.url) { window.location.href = data.url; return; }

    setError("Unexpected response from server");
  }

  if (done) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
        <div className="bg-surface rounded-xl w-full max-w-sm p-8 text-center">
          <div className="text-3xl mb-2">✓</div>
          <h3 className="text-lg font-semibold text-text-primary mb-1">Membership assigned</h3>
          <p className="text-sm text-text-muted mb-6">{member.firstName} {member.lastName} is now enrolled in {currentMembership?.name}.</p>
          <button onClick={onClose} className="px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <h2 className="text-lg font-semibold text-text-primary">Assign membership</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-6 space-y-4">
          {/* Member header */}
          <div className="flex items-center gap-2 pb-2 border-b border-app-border">
            <div className="w-9 h-9 rounded-full bg-app-border flex items-center justify-center text-xs font-medium text-text-primary flex-shrink-0">
              {member.firstName[0]}{member.lastName[0]}
            </div>
            <div>
              <div className="text-sm font-medium text-text-primary">{member.firstName} {member.lastName}</div>
              {member.email && <div className="text-xs text-text-muted">{member.email}</div>}
            </div>
          </div>

          {loading ? (
            <div className="text-sm text-text-muted text-center py-4">Loading plans…</div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-text-primary mb-1">Membership plan</label>
                <select value={selectedMembership} onChange={(e) => selectMembership(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-brand">
                  <option value="">Select a plan…</option>
                  {memberships.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>

              {selectedMembership && (
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Purchase option</label>
                  <select value={selectedOption} onChange={(e) => setSelectedOption(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface focus:outline-none focus:ring-2 focus:ring-brand">
                    <option value="">Select an option…</option>
                    {options.map((o) => (
                      <option key={o.label} value={o.label}>
                        {o.label} — ${o.price.toFixed(2)} {periodLabels[o.billingPeriod] ? `(${periodLabels[o.billingPeriod]})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {selectedOption && !isOneTime && (
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Payment method</label>
                  <div className="flex gap-2">
                    {(["RECURRING", "MANUAL"] as const).map((t) => (
                      <button key={t} type="button" onClick={() => setBillingType(t)} className={`flex-1 py-2 rounded-lg text-sm border transition ${billingType === t ? "bg-brand text-white border-brand" : "border-app-border text-text-primary hover:bg-app-bg"}`}>
                        {t === "RECURRING" ? "Stripe Checkout" : "Manual / Cash"}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    {billingType === "RECURRING" ? "Sends a Stripe payment link. Auto-bills on the billing cycle." : "Records enrollment immediately. You handle payment outside ClubOS."}
                  </p>
                </div>
              )}

              {selectedOption && (
                <>
                  {/* Auto-renew — only relevant for recurring */}
                  {billingType === "RECURRING" && !isOneTime && (
                    <div className="flex items-center justify-between py-2 border border-app-border rounded-lg px-3">
                      <div>
                        <p className="text-sm font-medium text-text-primary">Auto-renew</p>
                        <p className="text-xs text-text-muted">Cancel at period end if off</p>
                      </div>
                      <button type="button" onClick={() => setAutoRenew(!autoRenew)} className={`relative inline-flex h-5 w-9 rounded-full transition ${autoRenew ? "bg-brand" : "bg-app-border"}`}>
                        <span className={`inline-block h-4 w-4 rounded-full bg-surface shadow transition-transform mt-0.5 ${autoRenew ? "translate-x-4" : "translate-x-0.5"}`} />
                      </button>
                    </div>
                  )}

                  {/* Advanced: dates + billing day */}
                  <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="text-xs text-text-muted hover:text-text-primary underline">
                    {showAdvanced ? "Hide" : "Show"} advanced options (start/end dates, billing day)
                  </button>

                  {showAdvanced && (
                    <div className="space-y-3 p-4 bg-app-bg border border-app-border rounded-lg">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-text-primary mb-1">Start date</label>
                          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                          <p className="text-xs text-text-muted mt-0.5">Blank = today</p>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-text-primary mb-1">End date</label>
                          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                          <p className="text-xs text-text-muted mt-0.5">Override expiry</p>
                        </div>
                      </div>
                      {billingType === "RECURRING" && !isOneTime && (
                        <div>
                          <label className="block text-xs font-medium text-text-primary mb-1">Bill on day of month <span className="text-text-muted font-normal">(1–28)</span></label>
                          <input type="number" min="1" max="28" value={billingDay} onChange={(e) => setBillingDay(e.target.value)} placeholder="Signup date" className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                        </div>
                      )}
                      <div>
                        <label className="block text-xs font-medium text-text-primary mb-1">Internal notes</label>
                        <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Migration note, pre-paid months, etc." className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                      </div>
                    </div>
                  )}
                </>
              )}

              {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

              <div className="flex gap-2 pt-2">
                <button onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
                <button onClick={handleSubmit} disabled={!selectedMembership || !selectedOption || submitting} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
                  {submitting ? "Processing…" : billingType === "MANUAL" || isOneTime ? "Assign membership" : "Send Stripe Checkout"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Import CSV Modal ─────────────────────────────────────────────────────────
function ImportCSVModal({ customFields, onClose, onImported }: { customFields: CustomField[]; onClose: () => void; onImported: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "map" | "preview" | "done">("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ created: number; skipped: number; failed: number; errors: string[] } | null>(null);
  const [error, setError] = useState("");
  const mappingFields = [
    ...MEMBER_FIELDS.slice(0, -1),
    { key: "guardianRelationship", label: "Guardian relationship", required: false },
    { key: "membershipName", label: "Membership / purchase option", required: false },
    { key: "isMinor", label: "Minor/adult", required: false },
    ...customFields.map((f) => ({ key: `custom:${f.id}`, label: `Custom: ${f.label}`, required: f.required })),
    MEMBER_FIELDS[MEMBER_FIELDS.length - 1],
  ];

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const parsed = parseCSV(text);
      if (parsed.length < 2) { setError("CSV must have a header row and at least one data row."); return; }
      const hdrs = parsed[0];
      const dataRows = parsed.slice(1);
      setHeaders(hdrs);
      setRows(dataRows);

      // Auto-map based on common header names
      const autoMap: Record<number, string> = {};
      hdrs.forEach((h, i) => {
        const lh = h.toLowerCase().replace(/\s+/g, "").replace(/_/g, "");
        if (lh.includes("first")) autoMap[i] = "firstName";
        else if (lh.includes("last")) autoMap[i] = "lastName";
        else if (lh.includes("email") && !lh.includes("guardian")) autoMap[i] = "email";
        else if (lh.includes("dob") || lh.includes("birth") || lh.includes("birthdate")) autoMap[i] = "dateOfBirth";
        else if (lh.includes("status")) autoMap[i] = "status";
        else if (lh.includes("tag")) autoMap[i] = "tags";
        else if (lh.includes("note")) autoMap[i] = "notes";
        else if (lh.includes("guardian") && lh.includes("name")) autoMap[i] = "guardianName";
        else if (lh.includes("guardian") && lh.includes("email")) autoMap[i] = "guardianEmail";
        else if (lh.includes("guardian") && lh.includes("phone")) autoMap[i] = "guardianPhone";
        else if (lh.includes("guardian") && (lh.includes("relation") || lh.includes("relationship"))) autoMap[i] = "guardianRelationship";
        else if (lh.includes("member") && lh.includes("ship")) autoMap[i] = "membershipName";
        else if (lh.includes("minor") || lh.includes("adult")) autoMap[i] = "isMinor";
        else {
          const custom = customFields.find((f) => f.label.toLowerCase().replace(/\s+/g, "").replace(/_/g, "") === lh);
          autoMap[i] = custom ? `custom:${custom.id}` : "skip";
          return;
        }
      });
      setMapping(autoMap);
      setStep("map");
    };
    reader.readAsText(file);
  }

  function buildMembers() {
    return rows.map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((_, i) => {
        const field = mapping[i];
        if (field && field !== "skip") obj[field] = row[i] || "";
      });
      return obj;
    }).filter((m) => m.firstName || m.lastName);
  }

  async function handleImport() {
    setImporting(true);
    setError("");
    const members = buildMembers().map((m) => ({
      firstName: m.firstName || "(no name)",
      lastName: m.lastName || "",
      email: m.email || undefined,
      dateOfBirth: m.dateOfBirth || undefined,
      status: (["ACTIVE","PROSPECT","INACTIVE","PAUSED"].includes((m.status || "").toUpperCase()) ? m.status.toUpperCase() : "ACTIVE") as any,
      tags: m.tags || undefined,
      notes: m.notes || undefined,
      guardianName: m.guardianName || undefined,
      guardianEmail: m.guardianEmail || undefined,
      guardianPhone: m.guardianPhone || undefined,
      guardianRelationship: m.guardianRelationship || undefined,
      membershipName: m.membershipName || undefined,
      customFieldValues: Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith("custom:")).map(([k, v]) => [k.replace("custom:", ""), v])),
      isMinor: m.isMinor ? ["yes", "true", "minor", "under18", "under 18", "1"].includes(m.isMinor.toLowerCase()) : !!(m.guardianName || m.guardianEmail),
    }));

    const res = await fetch("/api/members/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members }),
    });
    const data = await res.json();
    setImporting(false);
    if (!res.ok) { setError(data.error?.toString() || "Import failed"); return; }
    setResult(data);
    setStep("done");
  }

  const preview = buildMembers().slice(0, 5);

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-surface">
          <h2 className="text-lg font-semibold text-text-primary">Import members from CSV</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <div className="p-6">
          {/* Step indicator */}
          <div className="flex gap-2 mb-6">
            {["Upload", "Map columns", "Preview", "Done"].map((s, i) => {
              const stepKeys = ["upload", "map", "preview", "done"];
              const active = stepKeys.indexOf(step) >= i;
              return (
                <div key={s} className="flex items-center gap-2 flex-1">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold ${active ? "bg-brand text-white" : "bg-app-bg text-text-muted"}`}>{i + 1}</div>
                  <span className={`text-xs ${active ? "text-text-primary font-medium" : "text-text-muted"}`}>{s}</span>
                  {i < 3 && <div className="flex-1 h-px bg-app-border" />}
                </div>
              );
            })}
          </div>

          {step === "upload" && (
            <div className="text-center">
              <div className="border-2 border-dashed border-app-border rounded-xl p-10 hover:border-app-border transition cursor-pointer" onClick={() => fileRef.current?.click()}>
                <div className="text-4xl mb-3">📄</div>
                <p className="text-sm font-medium text-text-primary mb-1">Drop a CSV file here or click to browse</p>
                <p className="text-xs text-text-muted">Supports up to 500 members per import</p>
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFile} />
              </div>
              <div className="mt-4 text-xs text-text-muted text-left bg-app-bg rounded-lg p-3">
                <p className="font-medium mb-1">CSV format tips:</p>
                <ul className="space-y-0.5 list-disc list-inside">
                  <li>First row should be column headers</li>
                  <li>Required columns: First Name, Last Name</li>
                  <li>Optional: Email, Date of Birth, Status, Tags, Notes</li>
                  <li>Guardian columns: Guardian Name, Guardian Email, Guardian Phone</li>
                </ul>
              </div>
              {error && <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
            </div>
          )}

          {step === "map" && (
            <div>
              <p className="text-sm text-text-muted mb-4">
                Match your CSV columns to member fields. We auto-detected some mappings — adjust as needed.
              </p>
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {headers.map((h, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="w-48 text-sm text-text-primary font-medium truncate flex-shrink-0">{h}</div>
                    <div className="text-text-muted text-xs flex-shrink-0">→</div>
                    <select value={mapping[i] || "skip"} onChange={(e) => setMapping({ ...mapping, [i]: e.target.value })} className="flex-1 px-3 py-1.5 border border-app-border rounded-lg text-sm bg-surface">
                      {mappingFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                    <div className="text-xs text-text-muted w-20 truncate flex-shrink-0">{rows[0]?.[i] || ""}</div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 pt-4">
                <button onClick={() => setStep("upload")} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Back</button>
                <button onClick={() => setStep("preview")} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">Preview import</button>
              </div>
            </div>
          )}

          {step === "preview" && (
            <div>
              <p className="text-sm text-text-muted mb-3">
                Importing <strong>{rows.length}</strong> members. Preview of first {Math.min(5, preview.length)}:
              </p>
              <div className="border border-app-border rounded-lg overflow-hidden mb-4">
                <table className="w-full text-sm">
                  <thead className="bg-app-bg">
                    <tr>
                      <th className="text-left text-xs font-medium text-text-muted px-3 py-2">Name</th>
                      <th className="text-left text-xs font-medium text-text-muted px-3 py-2">Email</th>
                      <th className="text-left text-xs font-medium text-text-muted px-3 py-2">Status</th>
                      <th className="text-left text-xs font-medium text-text-muted px-3 py-2">Guardian</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((m, i) => (
                      <tr key={i} className="border-t border-app-border">
                        <td className="px-3 py-2 font-medium">{m.firstName} {m.lastName}</td>
                        <td className="px-3 py-2 text-text-muted">{m.email || "—"}</td>
                        <td className="px-3 py-2 text-text-muted">{m.status || "ACTIVE"}</td>
                        <td className="px-3 py-2 text-text-muted">{m.guardianName || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 5 && <p className="text-xs text-text-muted mb-4">…and {rows.length - 5} more rows</p>}
              {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">{error}</div>}
              <div className="flex gap-2">
                <button onClick={() => setStep("map")} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Back</button>
                <button onClick={handleImport} disabled={importing} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
                  {importing ? "Importing…" : `Import ${rows.length} members`}
                </button>
              </div>
            </div>
          )}

          {step === "done" && result && (
            <div className="text-center">
              <div className="text-5xl mb-4">{result.failed === 0 ? "✓" : "⚠"}</div>
              <h3 className="text-lg font-semibold text-text-primary mb-2">Import complete</h3>
              <div className="flex justify-center gap-4 mb-4">
                <div className="text-center">
                  <p className="text-2xl font-bold text-text-primary">{result.created}</p>
                  <p className="text-xs text-text-muted">imported</p>
                </div>
                {result.skipped > 0 && (
                  <div className="text-center">
                    <p className="text-2xl font-bold text-orange-accent">{result.skipped}</p>
                    <p className="text-xs text-text-muted">skipped</p>
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="text-center">
                    <p className="text-2xl font-bold text-red-600">{result.failed}</p>
                    <p className="text-xs text-text-muted">failed</p>
                  </div>
                )}
              </div>
              {result.errors.length > 0 && (
                <div className="text-left bg-app-bg border border-app-border rounded-lg p-3 mb-4 max-h-40 overflow-y-auto">
                  <p className="text-xs font-medium text-text-muted mb-1.5">Notes:</p>
                  {result.errors.map((e, i) => (
                    <p key={i} className="text-xs text-text-muted py-0.5 border-b border-app-border last:border-0">{e}</p>
                  ))}
                </div>
              )}
              <button onClick={onImported} className="px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
                Done
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
