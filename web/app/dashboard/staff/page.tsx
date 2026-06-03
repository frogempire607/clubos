"use client";

import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import ImageUpload from "@/components/ImageUpload";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { SkeletonList } from "@/components/LoadingSkeleton";
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
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl">
      <PageHeader
        title="Staff"
        description="Manage coaches and staff, set their roles and permissions."
        actions={
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover w-full sm:w-auto"
          >
            + Add staff
          </button>
        }
      />

      {loading ? (
        <div className="bg-white rounded-xl border border-app-border"><SkeletonList rows={4} /></div>
      ) : staff.length === 0 ? (
        <EmptyState
          icon={<Shield size={26} strokeWidth={1.75} />}
          title="No staff yet"
          description="Add coaches and staff to give them access to the dashboard."
          action={{ label: "Add your first staff member", onClick: () => setShowAdd(true) }}
          className="bg-white rounded-xl border border-app-border"
        />
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
                      onClick={async () => {
                        const res = await fetch(`/api/staff/${s.id}/setup-link`, { method: "POST" });
                        const d = await res.json().catch(() => ({}));
                        if (!res.ok) {
                          window.alert(d.error || "Could not regenerate setup link.");
                          return;
                        }
                        const msg = d.emailed
                          ? "Setup link emailed. Copy it below in case the email doesn't arrive:\n\n" + d.setupUrl
                          : "Email failed to send. Copy this link and send it to them manually:\n\n" + d.setupUrl;
                        window.prompt(msg, d.setupUrl);
                      }}
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-app-bg"
                      title="Generate a fresh 14-day setup link"
                    >
                      Setup link
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
  // Mode picker: "invite" emails a one-time setup link (recommended);
  // "temp" lets the owner hand over a temporary password they pick.
  const [mode, setMode] = useState<"invite" | "temp">("invite");
  const [title, setTitle] = useState("");
  const [permissions, setPermissions] = useState<Record<string, PermissionLevel>>(defaultPermissions());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function setLevel(key: string, val: PermissionLevel) {
    setPermissions((p) => ({ ...p, [key]: val }));
  }

  const [createdSetupUrl, setCreatedSetupUrl] = useState<string | null>(null);
  const [createdEmailed, setCreatedEmailed] = useState<boolean>(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const body =
      mode === "invite"
        ? { firstName, lastName, email, sendSetupLink: true, title, permissions }
        : { firstName, lastName, email, password, title, permissions };
    const res = await fetch("/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error?.toString() || "Failed to add staff");
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (mode === "invite" && data?.setupUrl) {
      // Show the link inside the modal so the owner can copy it manually
      // when email isn't reliable. Hitting Done closes the modal.
      setCreatedSetupUrl(data.setupUrl);
      setCreatedEmailed(!!data.emailed);
      return;
    }
    onSaved();
  }

  // After a setup-link invite succeeds we swap the form for a confirmation
  // panel that surfaces the URL — critical when SMTP isn't configured so
  // the owner still has a way to deliver the link.
  if (createdSetupUrl) {
    return (
      <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
        <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-lg p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-text-primary mb-1">Staff member added</h2>
            <p className="text-sm text-text-muted">
              {createdEmailed
                ? "We emailed a one-time setup link. It expires in 14 days."
                : "Email couldn't be sent (your SMTP may not be configured). Copy this link and send it to them directly:"}
            </p>
          </div>
          <div className="rounded-lg border border-app-border bg-app-bg p-3 text-xs font-mono break-all text-text-primary">
            {createdSetupUrl}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(createdSetupUrl).catch(() => {});
              }}
              className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg"
            >
              Copy link
            </button>
            <button
              type="button"
              onClick={onSaved}
              className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-text-primary">Add staff member</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            <p className="text-sm font-medium text-text-primary mb-2">How should they sign in?</p>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button
                type="button"
                onClick={() => setMode("invite")}
                className={`rounded-lg border px-3 py-2 text-left transition ${
                  mode === "invite"
                    ? "border-brand bg-brand/5 text-text-primary"
                    : "border-app-border text-text-muted hover:border-text-muted"
                }`}
              >
                <div className="text-sm font-semibold">Email setup link</div>
                <div className="text-[11px] mt-0.5 opacity-80">They choose their own password (recommended)</div>
              </button>
              <button
                type="button"
                onClick={() => setMode("temp")}
                className={`rounded-lg border px-3 py-2 text-left transition ${
                  mode === "temp"
                    ? "border-brand bg-brand/5 text-text-primary"
                    : "border-app-border text-text-muted hover:border-text-muted"
                }`}
              >
                <div className="text-sm font-semibold">Set a temporary password</div>
                <div className="text-[11px] mt-0.5 opacity-80">You hand it over and they change it later</div>
              </button>
            </div>
            {mode === "temp" ? (
              <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8}
                placeholder="At least 8 characters"
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            ) : (
              <p className="text-xs text-text-muted">
                We&apos;ll email <strong>{email || "the staff member"}</strong> a one-time setup link
                that expires in 14 days. They&apos;ll create their own password and land back at the sign-in page.
              </p>
            )}
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
  // Account fields — owners can edit anything except the password.
  const [firstName, setFirstName] = useState(staff.firstName || "");
  const [lastName, setLastName] = useState(staff.lastName || "");
  const [email, setEmail] = useState(staff.email || "");
  const [title, setTitle] = useState(staff.staffProfile?.title || "");
  // Preserved (no longer edited here — pricing now lives on lesson types).
  const appointmentPrice = staff.staffProfile?.appointmentPrice || "";
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
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim().toLowerCase(),
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
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-text-primary">
            Edit — {staff.firstName} {staff.lastName}
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Account — owner-editable. Password is intentionally NOT here; it
              is reset by the staff member via Forgot password. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            <label className="block text-sm font-medium text-text-primary mb-1">Login email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
            <p className="text-[11px] text-text-muted mt-1">
              The email this staff member uses to sign in. Password changes are
              handled by the staff member via Forgot password — not editable here.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Title</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="Head Coach, Assistant Coach, Front Desk…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div className="pt-2 border-t border-app-border">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">
              Private lesson types
            </p>
            <p className="text-xs text-text-muted mb-3">
              Pick which lesson types this coach offers. Prices live on the lesson
              type (and its purchase options) under Purchase Options → Privates.
            </p>
            <CoachLessonTypes coachId={staff.id} />
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

        {/* Staff documents (tax docs, contracts, agreements, etc.). Lives
            outside the main form so uploads/visibility toggles save
            independently of the rest of the staff profile. */}
        <div className="px-6 pb-6">
          <StaffDocsPanel staffUserId={staff.id} />
        </div>
      </div>
    </div>
  );
}

/* ── Modular compensation builder ─────────────────────────────────────────── */

type ScopeType = "CLASS" | "EVENT" | "MEMBERSHIP" | "PRIVATE_LESSON_TYPE";
type Scope = { scopeType: ScopeType; scopeId: string };
type BonusDraft = {
  bonusType: "ATTENDANCE" | "SIGNUP" | "REVENUE_SHARE";
  amount: string;
  scopes: Scope[];
  minThreshold: string;
  maxThreshold: string;
};
type Opt = { id: string; name: string };
type CompOptions = { classes: Opt[]; events: Opt[]; memberships: Opt[]; lessonTypes: Opt[] };

const BONUS_LABEL: Record<BonusDraft["bonusType"], string> = {
  ATTENDANCE: "Class growth incentive ($ per kid / per class)",
  SIGNUP: "Signup bonus (pay on next paycheck)",
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
            (d.plan.bonuses ?? []).map((b: { bonusType: BonusDraft["bonusType"]; amount: number; scopes: Scope[]; minThreshold?: number | null; maxThreshold?: number | null }) => ({
              bonusType: b.bonusType,
              amount: String(b.amount),
              scopes: b.scopes ?? [],
              minThreshold: b.minThreshold != null ? String(b.minThreshold) : "",
              maxThreshold: b.maxThreshold != null ? String(b.maxThreshold) : "",
            }))
          );
        }
        setLoading(false);
      });
  }, [staffId]);

  function addBonus() {
    setBonuses((b) => [...b, { bonusType: "ATTENDANCE", amount: "", scopes: [], minThreshold: "", maxThreshold: "" }]);
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
          .map((b) => ({
            bonusType: b.bonusType,
            amount: parseFloat(b.amount) || 0,
            scopes: b.scopes,
            minThreshold: b.minThreshold.trim() === "" ? null : Math.max(0, parseInt(b.minThreshold) || 0),
            maxThreshold: b.maxThreshold.trim() === "" ? null : Math.max(0, parseInt(b.maxThreshold) || 0),
          })),
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
        {bonuses.length === 0 && (
          <p className="text-xs text-text-muted">
            No bonuses. Add a signup bonus for the next paycheck, or convert growth into a per-kid/per-class incentive.
          </p>
        )}
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

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">Starts after</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={b.minThreshold}
                    onChange={(e) => updateBonus(i, { minThreshold: e.target.value })}
                    placeholder="e.g. 10"
                    className="w-full px-2 py-1.5 border border-app-border rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-text-muted mb-1">Caps at</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={b.maxThreshold}
                    onChange={(e) => updateBonus(i, { maxThreshold: e.target.value })}
                    placeholder="e.g. 25"
                    className="w-full px-2 py-1.5 border border-app-border rounded-lg text-sm"
                  />
                </div>
              </div>
              <p className="text-[11px] text-text-muted">
                Bonus only pays for items above the “starts after” count, up to the “caps at” count. Leave blank for no bound.
              </p>

              <ScopePicker
                allowed={BONUS_SCOPES[b.bonusType]}
                opts={opts}
                scopes={b.scopes}
                onChange={(s) => updateBonus(i, { scopes: s })}
              />
              {b.bonusType === "ATTENDANCE" && (
                <p className="text-[11px] text-text-muted">
                  Pays this amount for each attending athlete in the selected classes/events, so growth and retention increase pay automatically.
                </p>
              )}
              {b.bonusType === "SIGNUP" && (
                <p className="text-[11px] text-text-muted">
                  Pays once in the selected payroll period for each qualifying signup or purchase.
                </p>
              )}
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

// ─── CoachLessonTypes ─────────────────────────────────────────────────────────
// Self-contained: lists the club's private lesson types and toggles whether
// this coach is eligible (writes to PrivateLessonType.eligibleCoachIds).
type CoachLT = {
  id: string;
  title: string;
  durationMin: number;
  basePrice: number;
  eligibleCoachIds: string[];
  priceOptions?: { id: string; label: string; price: number; coachIds: string[] }[];
};

function CoachLessonTypes({ coachId }: { coachId: string }) {
  const [types, setTypes] = useState<CoachLT[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/private-lessons/types")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => {
        setTypes(Array.isArray(d) ? d : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function isEligible(lt: CoachLT) {
    if (lt.eligibleCoachIds?.includes(coachId)) return true;
    return (lt.priceOptions || []).some((o) => o.coachIds?.includes(coachId));
  }

  async function toggle(lt: CoachLT) {
    setBusyId(lt.id);
    setError("");
    const has = lt.eligibleCoachIds?.includes(coachId);
    const next = has
      ? lt.eligibleCoachIds.filter((c) => c !== coachId)
      : [...(lt.eligibleCoachIds || []), coachId];
    const res = await fetch(`/api/private-lessons/types/${lt.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eligibleCoachIds: next }),
    });
    setBusyId(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Could not update");
      return;
    }
    setTypes((prev) =>
      prev.map((t) => (t.id === lt.id ? { ...t, eligibleCoachIds: next } : t)),
    );
  }

  if (loading) return <p className="text-xs text-text-muted">Loading lesson types…</p>;
  if (types.length === 0)
    return (
      <p className="text-xs text-text-muted">
        No lesson types yet. Create them under Purchase Options → Privates.
      </p>
    );

  return (
    <div className="space-y-1.5">
      {error && <p className="text-xs text-red-600">{error}</p>}
      {types.map((lt) => {
        const on = isEligible(lt);
        return (
          <label
            key={lt.id}
            className="flex items-center justify-between gap-3 px-3 py-2 border border-app-border rounded-lg cursor-pointer hover:bg-app-bg"
          >
            <span className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={on}
                disabled={busyId === lt.id}
                onChange={() => toggle(lt)}
                className="rounded"
              />
              {lt.title}
            </span>
            <span className="text-xs text-text-muted">
              {lt.durationMin}min · ${Number(lt.basePrice).toFixed(2)}
              {lt.priceOptions && lt.priceOptions.length > 0
                ? ` · ${lt.priceOptions.length} option${lt.priceOptions.length === 1 ? "" : "s"}`
                : ""}
            </span>
          </label>
        );
      })}
    </div>
  );
}

// ── Staff Documents Panel (owner-side) ──────────────────────────────────────
// Lists docs the owner has uploaded to this staff member, with kind + share
// toggle + delete. Upload uses the existing /api/upload private-file flow.

type StaffDoc = {
  id: string;
  title: string;
  kind: string;
  fileUrl: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  notes: string | null;
  sharedWithStaff: boolean;
  createdAt: string;
};

const STAFF_DOC_KINDS = [
  { v: "W9",            label: "W-9" },
  { v: "1099",          label: "1099" },
  { v: "CONTRACT",      label: "Contract" },
  { v: "AGREEMENT",     label: "Agreement" },
  { v: "CERTIFICATION", label: "Certification" },
  { v: "OTHER",         label: "Other" },
];

function StaffDocsPanel({ staffUserId }: { staffUserId: string }) {
  const [docs, setDocs] = useState<StaffDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("OTHER");
  const [shared, setShared] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  function load() {
    setLoading(true);
    fetch(`/api/staff/${staffUserId}/documents`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { setDocs(Array.isArray(d) ? d : []); setLoading(false); });
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [staffUserId]);

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    if (!title.trim()) { setError("Give the document a title first."); return; }
    setUploading(true); setError("");
    try {
      // Multi-file: each picked file becomes its own StaffDocument row. When
      // more than one is selected at once, the title is suffixed "(n/total)"
      // so they stay distinguishable in the list.
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fd = new FormData();
        fd.append("file", file);
        fd.append("kind", "document");
        const upRes = await fetch("/api/upload", { method: "POST", body: fd });
        if (!upRes.ok) {
          const j = await upRes.json().catch(() => ({}));
          throw new Error(`${file.name}: ${typeof j.error === "string" ? j.error : "upload failed"}`);
        }
        const up = await upRes.json();
        const t = files.length === 1 ? title.trim() : `${title.trim()} (${i + 1}/${files.length})`;
        const r = await fetch(`/api/staff/${staffUserId}/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: t,
            kind,
            fileUrl: up.url,
            fileId: up.id ?? null,
            fileName: file.name,
            mimeType: file.type || null,
            sizeBytes: file.size,
            sharedWithStaff: shared,
          }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(`${file.name}: ${typeof j.error === "string" ? j.error : "save failed"}`);
        }
      }
      setTitle(""); setKind("OTHER"); setShared(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      // Reset the file input so the same files can be re-selected.
      e.target.value = "";
    }
  }

  async function toggleShared(d: StaffDoc) {
    setDocs((prev) => prev.map((x) => x.id === d.id ? { ...x, sharedWithStaff: !x.sharedWithStaff } : x));
    await fetch(`/api/staff/${staffUserId}/documents/${d.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sharedWithStaff: !d.sharedWithStaff }),
    });
  }

  async function remove(d: StaffDoc) {
    if (!confirm(`Delete "${d.title}"?`)) return;
    await fetch(`/api/staff/${staffUserId}/documents/${d.id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="border-t border-app-border pt-5">
      <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">
        Documents (tax docs, contracts, agreements)
      </p>

      {/* Upload */}
      <div className="bg-app-bg rounded-lg p-3 mb-3 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Document title (e.g. 2026 W-9)"
            className="px-3 py-2 border border-app-border rounded-lg text-sm"
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="px-3 py-2 border border-app-border rounded-lg text-sm bg-white"
          >
            {STAFF_DOC_KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={shared}
            onChange={(e) => setShared(e.target.checked)}
            className="rounded"
          />
          Let this staff member see &amp; download it
        </label>
        <label className="block">
          <span className="sr-only">Choose file</span>
          <input
            type="file"
            multiple
            onChange={upload}
            disabled={uploading}
            className="block w-full text-xs file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-brand file:text-white file:font-medium hover:file:bg-brand-hover disabled:opacity-50"
          />
        </label>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>

      {/* List */}
      {loading ? (
        <div className="py-2"><SkeletonList rows={2} /></div>
      ) : docs.length === 0 ? (
        <p className="text-xs text-text-muted">No documents yet.</p>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => (
            <div key={d.id} className="flex items-start gap-3 p-3 border border-app-border rounded-lg">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap mb-0.5">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-app-bg text-text-muted font-medium">
                    {STAFF_DOC_KINDS.find((k) => k.v === d.kind)?.label ?? d.kind}
                  </span>
                  <a
                    href={d.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-text-primary hover:underline truncate"
                  >
                    {d.title}
                  </a>
                </div>
                <p className="text-[11px] text-text-muted">
                  {d.fileName ? `${d.fileName} · ` : ""}
                  {new Date(d.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                <label className="flex items-center gap-1.5 text-[11px] text-text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={d.sharedWithStaff}
                    onChange={() => toggleShared(d)}
                    className="rounded"
                  />
                  Visible to staff
                </label>
                <button
                  onClick={() => remove(d)}
                  className="text-[11px] text-red-600 hover:bg-red-50 px-2 py-0.5 rounded"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
