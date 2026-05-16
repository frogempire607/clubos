"use client";

import { useEffect, useState } from "react";
import ImageUpload from "@/components/ImageUpload";
import {
  PERMISSION_CATALOG,
  DEFAULT_PERMISSIONS,
  resolvePermissions,
  type PermissionLevel,
} from "@/lib/permissions";

type StaffProfile = {
  title: string | null;
  hourlyRate: string | null;
  salary: string | null;
  appointmentPrice: string | null;
  permissions: Record<string, PermissionLevel>;
};

type StaffUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  createdAt: string;
  staffProfile: StaffProfile | null;
};

const PERMISSION_DEFS = PERMISSION_CATALOG.map((p) => ({
  key: p.key,
  label: p.label,
  desc: p.description,
  levels: p.levels,
}));

const levelColors: Record<PermissionLevel, string> = {
  none: "bg-app-bg text-text-muted",
  view: "bg-brand/10 text-brand",
  send: "bg-brand/10 text-brand",
  edit: "bg-orange-accent/10 text-orange-accent",
  full: "bg-lime-accent text-text-primary",
};

function defaultPermissions(): Record<string, PermissionLevel> {
  return { ...DEFAULT_PERMISSIONS };
}

export default function StaffPage() {
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<StaffUser | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/staff");
    if (res.ok) setStaff(await res.json());
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleRemove(id: string) {
    if (!confirm("Remove this staff member? They will lose dashboard access.")) return;
    await fetch(`/api/staff/${id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-semibold text-text-primary mb-1">Staff</h1>
          <p className="text-sm text-text-muted">
            Manage coaches and staff, set their roles and permissions.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover"
        >
          + Add staff
        </button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
      ) : staff.length === 0 ? (
        <div className="bg-white rounded-xl border border-app-border p-12 text-center">
          <div className="text-4xl mb-2 text-text-muted">◎</div>
          <h3 className="text-lg font-medium text-text-primary mb-1">No staff yet</h3>
          <p className="text-sm text-text-muted mb-4">
            Add coaches and staff to give them access to the dashboard.
          </p>
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover"
          >
            Add your first staff member
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {staff.map((s) => {
            const perms = s.staffProfile?.permissions || {};
            const activePerms = PERMISSION_DEFS.filter((p) => perms[p.key] && perms[p.key] !== "none");
            return (
              <div key={s.id} className="bg-white rounded-xl border border-app-border p-5">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-full bg-app-border flex items-center justify-center text-sm font-medium text-text-primary flex-shrink-0">
                    {s.firstName[0]}{s.lastName[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <h3 className="text-sm font-semibold text-text-primary">
                        {s.firstName} {s.lastName}
                      </h3>
                      {s.staffProfile?.title && (
                        <span className="text-xs text-text-muted">· {s.staffProfile.title}</span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted mb-2">{s.email}</p>
                    <div className="flex flex-wrap gap-1">
                      {activePerms.length === 0 ? (
                        <span className="text-xs text-text-muted">No permissions set</span>
                      ) : (
                        activePerms.map((p) => {
                          const lvl = (perms[p.key] || "none") as PermissionLevel;
                          return (
                            <span
                              key={p.key}
                              className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${levelColors[lvl]}`}
                            >
                              {p.label}: {lvl}
                            </span>
                          );
                        })
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => setEditing(s)}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleRemove(s.id)}
                      className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <AddStaffModal
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}

      {editing && (
        <EditStaffModal
          staff={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function PermissionRow({
  def,
  value,
  onChange,
}: {
  def: typeof PERMISSION_DEFS[0];
  value: PermissionLevel;
  onChange: (val: PermissionLevel) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">{def.label}</div>
        <div className="text-xs text-text-muted">{def.desc}</div>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as PermissionLevel)}
        className="text-xs px-2 py-1.5 border border-app-border rounded-md bg-white text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
      >
        {def.levels.map((lvl) => (
          <option key={lvl} value={lvl}>
            {lvl.charAt(0).toUpperCase() + lvl.slice(1)}
          </option>
        ))}
      </select>
    </div>
  );
}

function AddStaffModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [title, setTitle] = useState("");
  const [permissions, setPermissions] = useState<Record<string, PermissionLevel>>(defaultPermissions());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function setLevel(key: string, val: PermissionLevel) {
    setPermissions((p) => ({ ...p, [key]: val }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const res = await fetch("/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, lastName, email, password, title, permissions }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error?.toString() || "Failed to add staff");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-text-primary">Add staff member</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">First name</label>
              <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} required
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-primary mb-1">Last name</label>
              <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} required
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Temporary password</label>
            <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8}
              placeholder="They can change this after signing in"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Title (optional)</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="Head Coach, Assistant Coach, Front Desk…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div className="pt-2 border-t border-app-border">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Permissions</p>
            <div className="space-y-3">
              {PERMISSION_DEFS.map((def) => (
                <PermissionRow
                  key={def.key}
                  def={def}
                  value={permissions[def.key] as PermissionLevel}
                  onChange={(v) => setLevel(def.key, v)}
                />
              ))}
            </div>
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Adding…" : "Add staff member"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditStaffModal({
  staff,
  onClose,
  onSaved,
}: {
  staff: StaffUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const existing = resolvePermissions(staff.staffProfile?.permissions ?? null);
  const [title, setTitle] = useState(staff.staffProfile?.title || "");
  const [appointmentPrice, setAppointmentPrice] = useState(staff.staffProfile?.appointmentPrice || "");
  const [bio, setBio] = useState((staff.staffProfile as any)?.bio || "");
  const [publicEmail, setPublicEmail] = useState((staff.staffProfile as any)?.publicEmail || "");
  const [publicPhone, setPublicPhone] = useState((staff.staffProfile as any)?.publicPhone || "");
  const [photoUrl, setPhotoUrl] = useState<string>((staff.staffProfile as any)?.photoUrl || "");
  const [showOnPortal, setShowOnPortal] = useState<boolean>(!!(staff.staffProfile as any)?.showOnPortal);
  const [permissions, setPermissions] = useState<Record<string, PermissionLevel>>({ ...existing });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function setLevel(key: string, val: PermissionLevel) {
    setPermissions((p) => ({ ...p, [key]: val }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const res = await fetch(`/api/staff/${staff.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title || null,
        appointmentPrice: appointmentPrice ? parseFloat(appointmentPrice) : null,
        bio: bio || null,
        publicEmail: publicEmail || null,
        publicPhone: publicPhone || null,
        photoUrl: photoUrl || null,
        showOnPortal,
        permissions,
      }),
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
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-text-primary">
            Edit — {staff.firstName} {staff.lastName}
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="Head Coach, Assistant Coach, Front Desk…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div className="w-1/2">
            <label className="block text-sm font-medium text-text-primary mb-1">Private lesson display price ($)</label>
            <input type="number" min="0" step="0.01" value={appointmentPrice}
              onChange={(e) => setAppointmentPrice(e.target.value)} placeholder="0.00"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            <p className="text-xs text-text-muted mt-1">Shown to members when booking a 1-on-1 with this coach. Pay is set in the compensation plan below.</p>
          </div>

          <div className="pt-2 border-t border-app-border">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Compensation plan</p>
            <CompensationBuilder staffId={staff.id} />
          </div>

          <div className="pt-2 border-t border-app-border">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Member portal profile</p>
            <p className="text-xs text-text-muted mb-3">When enabled, this staff member appears on your member portal's Staff page with their bio and visible contact info.</p>

            <label className="flex items-center gap-3 py-2 mb-3 cursor-pointer">
              <input type="checkbox" checked={showOnPortal} onChange={(e) => setShowOnPortal(e.target.checked)} className="rounded" />
              <span className="text-sm text-text-primary">Show on member portal</span>
            </label>

            {showOnPortal && (
              <div className="space-y-3">
                <ImageUpload
                  label="Profile photo"
                  value={photoUrl || null}
                  onChange={setPhotoUrl}
                  shape="circle"
                />
                <div>
                  <label className="block text-sm font-medium text-text-primary mb-1">Bio</label>
                  <textarea
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    rows={4}
                    maxLength={2000}
                    placeholder="Coaching background, certifications, philosophy…"
                    className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand resize-y"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1">Public email</label>
                    <input type="email" value={publicEmail} onChange={(e) => setPublicEmail(e.target.value)}
                      placeholder="coach@club.com"
                      className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text-primary mb-1">Public phone</label>
                    <input type="tel" value={publicPhone} onChange={(e) => setPublicPhone(e.target.value)}
                      placeholder="(555) 000-0000"
                      className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
                  </div>
                </div>
                <p className="text-xs text-text-muted">Leave blank to hide. Members will only see what you fill in here, not the staff member's login email.</p>
              </div>
            )}
          </div>

          <div className="pt-2 border-t border-app-border">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">Permissions</p>
            <div className="space-y-3">
              {PERMISSION_DEFS.map((def) => (
                <PermissionRow
                  key={def.key}
                  def={def}
                  value={permissions[def.key] as PermissionLevel}
                  onChange={(v) => setLevel(def.key, v)}
                />
              ))}
            </div>
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ── Modular compensation builder ─────────────────────────────────────────── */

type ScopeType = "CLASS" | "EVENT" | "MEMBERSHIP" | "PRIVATE_LESSON_TYPE";
type Scope = { scopeType: ScopeType; scopeId: string };
type BonusDraft = { bonusType: "ATTENDANCE" | "SIGNUP" | "REVENUE_SHARE"; amount: string; scopes: Scope[] };
type Opt = { id: string; name: string };
type CompOptions = { classes: Opt[]; events: Opt[]; memberships: Opt[]; lessonTypes: Opt[] };

const BONUS_LABEL: Record<BonusDraft["bonusType"], string> = {
  ATTENDANCE: "Attendance bonus ($ per athlete attendance)",
  SIGNUP: "Signup bonus ($ per athlete who joins/buys)",
  REVENUE_SHARE: "Revenue share (% of revenue)",
};
const BONUS_SCOPES: Record<BonusDraft["bonusType"], ScopeType[]> = {
  ATTENDANCE: ["CLASS", "EVENT"],
  SIGNUP: ["CLASS", "MEMBERSHIP"],
  REVENUE_SHARE: ["CLASS", "EVENT", "MEMBERSHIP", "PRIVATE_LESSON_TYPE"],
};

function scopeOptions(opts: CompOptions, t: ScopeType): Opt[] {
  if (t === "CLASS") return opts.classes;
  if (t === "EVENT") return opts.events;
  if (t === "MEMBERSHIP") return opts.memberships;
  return opts.lessonTypes;
}

function ScopePicker({
  allowed,
  opts,
  scopes,
  onChange,
}: {
  allowed: ScopeType[];
  opts: CompOptions;
  scopes: Scope[];
  onChange: (s: Scope[]) => void;
}) {
  function toggle(scopeType: ScopeType, scopeId: string) {
    const has = scopes.some((s) => s.scopeType === scopeType && s.scopeId === scopeId);
    onChange(
      has
        ? scopes.filter((s) => !(s.scopeType === scopeType && s.scopeId === scopeId))
        : [...scopes, { scopeType, scopeId }]
    );
  }
  return (
    <div className="space-y-2">
      {allowed.map((t) => {
        const list = scopeOptions(opts, t);
        if (list.length === 0) return null;
        return (
          <div key={t}>
            <p className="text-[11px] uppercase tracking-wider text-text-muted mb-1">
              {t === "PRIVATE_LESSON_TYPE" ? "Private lessons" : t.charAt(0) + t.slice(1).toLowerCase() + "s"}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {list.map((o) => {
                const active = scopes.some((s) => s.scopeType === t && s.scopeId === o.id);
                return (
                  <button
                    type="button"
                    key={o.id}
                    onClick={() => toggle(t, o.id)}
                    className={`text-xs px-2 py-1 rounded-md border ${
                      active ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-muted hover:bg-app-bg"
                    }`}
                  >
                    {o.name}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <p className="text-[11px] text-text-muted">Leave all unselected to apply club-wide / to everything this staff is tied to.</p>
    </div>
  );
}

function CompensationBuilder({ staffId }: { staffId: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [opts, setOpts] = useState<CompOptions>({ classes: [], events: [], memberships: [], lessonTypes: [] });
  const [baseType, setBaseType] = useState<"SALARY" | "PER_CLASS" | "HOURLY">("HOURLY");
  const [baseAmount, setBaseAmount] = useState("");
  const [baseScopes, setBaseScopes] = useState<Scope[]>([]);
  const [bonuses, setBonuses] = useState<BonusDraft[]>([]);

  useEffect(() => {
    fetch(`/api/staff/${staffId}/compensation`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.options) setOpts(d.options);
        if (d?.plan) {
          setBaseType(d.plan.baseType);
          setBaseAmount(String(d.plan.baseAmount ?? ""));
          setBaseScopes(d.plan.baseScopes ?? []);
          setBonuses(
            (d.plan.bonuses ?? []).map((b: { bonusType: BonusDraft["bonusType"]; amount: number; scopes: Scope[] }) => ({
              bonusType: b.bonusType,
              amount: String(b.amount),
              scopes: b.scopes ?? [],
            }))
          );
        }
        setLoading(false);
      });
  }, [staffId]);

  function addBonus() {
    setBonuses((b) => [...b, { bonusType: "ATTENDANCE", amount: "", scopes: [] }]);
  }
  function updateBonus(i: number, patch: Partial<BonusDraft>) {
    setBonuses((b) => b.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  }
  function removeBonus(i: number) {
    setBonuses((b) => b.filter((_, idx) => idx !== i));
  }

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    const res = await fetch(`/api/staff/${staffId}/compensation`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseType,
        baseAmount: parseFloat(baseAmount) || 0,
        baseScopes: baseType === "PER_CLASS" || baseType === "HOURLY" ? baseScopes : [],
        bonuses: bonuses
          .filter((b) => b.amount.trim() !== "")
          .map((b) => ({ bonusType: b.bonusType, amount: parseFloat(b.amount) || 0, scopes: b.scopes })),
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Save failed");
      return;
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  if (loading) return <p className="text-sm text-text-muted">Loading plan…</p>;

  return (
    <div className="space-y-4">
      {/* Base */}
      <div>
        <p className="text-sm font-medium text-text-primary mb-1">Base compensation</p>
        <div className="grid grid-cols-3 gap-2 mb-2">
          {(["SALARY", "PER_CLASS", "HOURLY"] as const).map((t) => (
            <button
              type="button"
              key={t}
              onClick={() => setBaseType(t)}
              className={`text-xs px-3 py-2 rounded-lg border ${
                baseType === t ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-primary hover:bg-app-bg"
              }`}
            >
              {t === "SALARY" ? "Salary (monthly)" : t === "PER_CLASS" ? "Per class" : "Hourly"}
            </button>
          ))}
        </div>
        <label className="block text-xs font-medium text-text-primary mb-1">
          {baseType === "SALARY" ? "Monthly amount ($)" : baseType === "PER_CLASS" ? "Amount per class ($)" : "Hourly rate ($)"}
        </label>
        <input
          type="number" min="0" step="0.01" value={baseAmount}
          onChange={(e) => setBaseAmount(e.target.value)} placeholder="0.00"
          className="w-40 px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
        />
        {(baseType === "PER_CLASS" || baseType === "HOURLY") && (
          <div className="mt-2">
            <p className="text-xs font-medium text-text-primary mb-1">Assigned classes (optional)</p>
            <ScopePicker allowed={["CLASS"]} opts={opts} scopes={baseScopes} onChange={setBaseScopes} />
          </div>
        )}
      </div>

      {/* Bonuses */}
      <div className="border-t border-app-border pt-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-text-primary">Bonuses (stackable)</p>
          <button type="button" onClick={addBonus} className="text-xs text-brand hover:underline">+ Add bonus</button>
        </div>
        {bonuses.length === 0 && <p className="text-xs text-text-muted">No bonuses. Add attendance, signup, or revenue-share bonuses.</p>}
        <div className="space-y-3">
          {bonuses.map((b, i) => (
            <div key={i} className="border border-app-border rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2">
                <select
                  value={b.bonusType}
                  onChange={(e) =>
                    updateBonus(i, { bonusType: e.target.value as BonusDraft["bonusType"], scopes: [] })
                  }
                  className="flex-1 px-2 py-1.5 border border-app-border rounded-lg text-sm bg-white"
                >
                  {(Object.keys(BONUS_LABEL) as BonusDraft["bonusType"][]).map((t) => (
                    <option key={t} value={t}>{BONUS_LABEL[t]}</option>
                  ))}
                </select>
                <button type="button" onClick={() => removeBonus(i)} className="text-text-muted hover:text-red-600 text-lg leading-none w-6">×</button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-muted">{b.bonusType === "REVENUE_SHARE" ? "%" : "$"}</span>
                <input
                  type="number" min="0" step="0.01" value={b.amount}
                  onChange={(e) => updateBonus(i, { amount: e.target.value })}
                  placeholder={b.bonusType === "REVENUE_SHARE" ? "e.g. 10" : "e.g. 5.00"}
                  className="w-32 px-2 py-1.5 border border-app-border rounded-lg text-sm"
                />
              </div>
              <ScopePicker
                allowed={BONUS_SCOPES[b.bonusType]}
                opts={opts}
                scopes={b.scopes}
                onChange={(s) => updateBonus(i, { scopes: s })}
              />
            </div>
          ))}
        </div>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save compensation plan"}
        </button>
        {saved && <span className="text-sm text-green-600">Saved</span>}
      </div>
    </div>
  );
}
