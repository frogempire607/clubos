"use client";

// Phase 12.1 Part 4 — the owner's side of staff documents.
//
// Lives on the existing Documents page as a second audience, because these ARE
// Documents: same model, same body, same editor idea. Only who signs them
// differs.
//
// What this screen is for: see who hasn't signed, and nudge them. So the
// outstanding count is the first thing on every row, and the people list opens
// with outstanding first.
//
// Mobile: rows stack, the people table scrolls.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Bell, CheckCircle2, ChevronRight, FileText, Loader2, Plus, Trash2 } from "lucide-react";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { ASSIGNMENT_SCOPES, type AssignmentScope } from "@/lib/staffDocuments";

type Person = {
  userId: string;
  name: string;
  email: string | null;
  title: string | null;
  status: "SIGNED" | "OUTSTANDING" | "SUPERSEDED";
  signedAt: string | null;
  signedVersion: number | null;
  dueDate: string | null;
};
type Assignment = { id: string; scope: AssignmentScope; staffUserId: string | null; role: string | null; dueDate: string | null };
type Doc = {
  id: string;
  title: string;
  type: string;
  body: string | null;
  version: number;
  assignments: Assignment[];
  people: Person[];
  signed: number;
  outstanding: number;
  signatures: {
    staffUserId: string;
    signerName: string;
    documentVersion: number;
    signedAt: string;
    hasDrawnSignature: boolean;
    ipAddress: string | null;
  }[];
};
type Staff = { userId: string; name: string; email: string | null; title: string | null };

const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

const inputCls = "w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-sm";

export default function StaffDocumentsPanel({ canEdit }: { canEdit: boolean }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Doc | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch("/api/staff-documents", { cache: "no-store" });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setErr(d?.error || "Couldn't load staff documents.");
        setDocs([]);
        return;
      }
      const d = await r.json();
      setDocs(d.documents ?? []);
      setStaff(d.staff ?? []);
      setRoles(d.roles ?? []);
    } catch {
      setErr("Couldn't load staff documents.");
      setDocs([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remind = async (d: Doc) => {
    setBusy(`remind:${d.id}`);
    setErr("");
    setMsg("");
    try {
      const r = await fetch(`/api/staff-documents/${d.id}/remind`, { method: "POST" });
      const body = await r.json();
      if (!r.ok) setErr(body.error || "Couldn't send that reminder.");
      else
        setMsg(
          body.reminded === 0
            ? body.note || "Nobody needed a reminder."
            : `Reminder sent to ${body.reminded} ${body.reminded === 1 ? "person" : "people"}.`,
        );
    } catch {
      setErr("Couldn't send that reminder.");
    } finally {
      setBusy("");
    }
  };

  const remove = async (d: Doc) => {
    setBusy(`del:${d.id}`);
    setErr("");
    try {
      const r = await fetch(`/api/staff-documents/${d.id}`, { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        setErr(body?.error || "Couldn't remove that document.");
      } else await load();
    } catch {
      setErr("Couldn't remove that document.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-[12px] text-text-muted">
          Handbooks, policies and agreements your team signs in the app. Assign one to everyone, to a role, or
          to named people. Changing a document&apos;s title or wording publishes a new version and asks
          everyone again — earlier signatures are kept.
        </p>
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              setAdding(true);
              setEditing(null);
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover"
          >
            <Plus className="h-4 w-4" strokeWidth={2} /> New staff document
          </button>
        )}
      </div>

      {err && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}
      {msg && <div className="rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-text-muted">{msg}</div>}

      {(adding || editing) && (
        <DocForm
          doc={editing}
          staff={staff}
          roles={roles}
          onCancel={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setAdding(false);
            setEditing(null);
            await load();
          }}
        />
      )}

      {docs === null ? (
        <SkeletonList rows={3} />
      ) : docs.length === 0 ? (
        <div className="rounded-xl border border-app-border bg-surface px-4 py-10 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <FileText className="h-7 w-7" strokeWidth={2} />
          </div>
          <p className="text-sm text-text-primary">No staff documents yet</p>
          <p className="mt-1 text-[12px] text-text-muted">
            A handbook, a non-compete, a code of conduct — anything you need your team to read and sign.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {docs.map((d) => (
            <li key={d.id} className="overflow-hidden rounded-xl border border-app-border bg-surface">
              <div className="flex flex-wrap items-center gap-2 px-3 py-3">
                <button
                  type="button"
                  onClick={() => setOpen(open === d.id ? null : d.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <ChevronRight
                    className={`h-4 w-4 shrink-0 text-text-muted transition-transform ${open === d.id ? "rotate-90" : ""}`}
                    strokeWidth={2}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-text-primary">{d.title}</span>
                    <span className="block text-[12px] text-text-muted">
                      {d.type} · version {d.version} · {describeAssignments(d.assignments, staff)}
                    </span>
                  </span>
                </button>
                <span className="shrink-0 text-[12px]">
                  {d.outstanding === 0 ? (
                    <span className="inline-flex items-center gap-1 text-text-muted">
                      <CheckCircle2 className="h-3.5 w-3.5 text-lime-accent" strokeWidth={2} /> All {d.signed} signed
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-text-primary">
                      <AlertTriangle className="h-3.5 w-3.5 text-orange-accent" strokeWidth={2} />
                      {d.outstanding} of {d.outstanding + d.signed} outstanding
                    </span>
                  )}
                </span>
                {canEdit && (
                  <span className="flex shrink-0 items-center gap-1">
                    {d.outstanding > 0 && (
                      <button
                        type="button"
                        onClick={() => remind(d)}
                        disabled={busy !== ""}
                        className="inline-flex items-center gap-1 rounded-lg border border-app-border px-2.5 py-1.5 text-xs text-text-primary hover:bg-app-bg disabled:opacity-50"
                      >
                        {busy === `remind:${d.id}` ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                        ) : (
                          <Bell className="h-3.5 w-3.5" strokeWidth={2} />
                        )}
                        Remind
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(d);
                        setAdding(false);
                      }}
                      className="rounded-lg border border-app-border px-2.5 py-1.5 text-xs text-text-primary hover:bg-app-bg"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(d)}
                      disabled={busy !== ""}
                      aria-label={`Remove ${d.title}`}
                      className="rounded-lg p-1.5 text-text-muted hover:bg-app-bg disabled:opacity-50"
                      title="Removes the document. Signatures already given are kept."
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={2} />
                    </button>
                  </span>
                )}
              </div>

              {open === d.id && (
                <div className="overflow-x-auto border-t border-app-border">
                  <table className="w-full min-w-[34rem] text-[12px]">
                    <thead className="bg-app-bg uppercase tracking-wide text-text-muted">
                      <tr>
                        <th className="px-3 py-2 text-left">Who</th>
                        <th className="px-3 py-2 text-left">Role</th>
                        <th className="px-3 py-2 text-left">Status</th>
                        <th className="px-3 py-2 text-left">Signed</th>
                        <th className="px-3 py-2 text-left">Due</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.people.map((p) => (
                        <tr key={p.userId} className="border-t border-app-border">
                          <td className="px-3 py-2 text-text-primary">{p.name}</td>
                          <td className="px-3 py-2 text-text-muted">{p.title ?? "—"}</td>
                          <td className="px-3 py-2">
                            {p.status === "SIGNED" ? (
                              <span className="text-text-muted">Signed</span>
                            ) : p.status === "SUPERSEDED" ? (
                              <span className="text-orange-accent">
                                Signed version {p.signedVersion} — needs to re-sign
                              </span>
                            ) : (
                              <span className="text-orange-accent">Not signed</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-text-muted">
                            {p.signedAt ? fmtStamp(p.signedAt) : "—"}
                          </td>
                          <td className="px-3 py-2 text-text-muted">{p.dueDate ? fmtDate(p.dueDate) : "—"}</td>
                        </tr>
                      ))}
                      {d.people.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-3 py-4 text-center text-text-muted">
                            Nobody is assigned this document yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {d.signatures.length > 0 && (
                    <p className="px-3 py-2 text-[12px] text-text-muted">
                      {d.signatures.length} {d.signatures.length === 1 ? "signature" : "signatures"} on record,
                      including earlier versions. Each one keeps the name typed, the time, and the IP address it
                      came from.
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function describeAssignments(assignments: Assignment[], staff: Staff[]): string {
  if (assignments.length === 0) return "not assigned";
  const parts: string[] = [];
  if (assignments.some((a) => a.scope === "ALL")) parts.push("everyone");
  const roles = assignments.filter((a) => a.scope === "ROLE" && a.role).map((a) => a.role as string);
  if (roles.length) parts.push(roles.join(", "));
  const named = assignments
    .filter((a) => a.scope === "STAFF" && a.staffUserId)
    .map((a) => staff.find((s) => s.userId === a.staffUserId)?.name)
    .filter((n): n is string => !!n);
  if (named.length) parts.push(named.join(", "));
  return parts.join(" · ") || "not assigned";
}

// ── Create / edit ───────────────────────────────────────────────────────────

function DocForm({
  doc,
  staff,
  roles,
  onCancel,
  onSaved,
}: {
  doc: Doc | null;
  staff: Staff[];
  roles: string[];
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [title, setTitle] = useState(doc?.title ?? "");
  const [type, setType] = useState(doc?.type ?? "POLICY");
  const [body, setBody] = useState(doc?.body ?? "");
  const [scope, setScope] = useState<AssignmentScope>(
    doc?.assignments[0]?.scope ?? "ALL",
  );
  const [role, setRole] = useState(doc?.assignments.find((a) => a.scope === "ROLE")?.role ?? roles[0] ?? "");
  const [picked, setPicked] = useState<string[]>(
    doc?.assignments.filter((a) => a.scope === "STAFF").map((a) => a.staffUserId as string) ?? [],
  );
  const [dueDate, setDueDate] = useState(doc?.assignments.find((a) => a.dueDate)?.dueDate ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Changing the wording asks everyone again, so say so BEFORE they save
  // rather than after.
  const willBumpVersion =
    !!doc && (title.trim() !== doc.title.trim() || (body ?? "").trim() !== (doc.body ?? "").trim());

  const save = async () => {
    setBusy(true);
    setErr("");
    const assignments =
      scope === "ALL"
        ? [{ scope: "ALL" as const, dueDate: dueDate || null }]
        : scope === "ROLE"
          ? [{ scope: "ROLE" as const, role, dueDate: dueDate || null }]
          : picked.map((id) => ({ scope: "STAFF" as const, staffUserId: id, dueDate: dueDate || null }));
    try {
      const r = await fetch(doc ? `/api/staff-documents/${doc.id}` : "/api/staff-documents", {
        method: doc ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, type, body: body || null, assignments }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error || d.message || "That couldn't be saved.");
      else await onSaved();
    } catch {
      setErr("That couldn't be saved.");
    } finally {
      setBusy(false);
    }
  };

  const ready =
    title.trim().length > 0 && (scope !== "ROLE" || !!role) && (scope !== "STAFF" || picked.length > 0);

  return (
    <div className="space-y-3 rounded-xl border border-app-border bg-surface p-4">
      <p className="text-sm font-medium text-text-primary">
        {doc ? `Edit "${doc.title}"` : "New staff document"}
      </p>

      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-muted">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="Staff handbook" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-muted">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
            {["POLICY", "HANDBOOK", "AGREEMENT", "CONTRACT", "OTHER"].map((t) => (
              <option key={t} value={t}>
                {t.charAt(0) + t.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-[12px] text-text-muted">
          The document itself — what your team reads before signing
        </span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          className={`${inputCls} font-mono text-[12px]`}
          placeholder="<p>Paste or write the document here. Basic HTML is allowed and is cleaned before it's saved.</p>"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-muted">Who has to sign it</span>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as AssignmentScope)}
            className={inputCls}
          >
            {ASSIGNMENT_SCOPES.map((sc) => (
              <option key={sc} value={sc}>
                {sc === "ALL" ? "Everyone on staff" : sc === "ROLE" ? "Everyone in a role" : "Named people"}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-muted">Due date (optional)</span>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} />
        </label>
      </div>

      {scope === "ROLE" && (
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-muted">Which role</span>
          {roles.length === 0 ? (
            <p className="text-[12px] text-text-muted">
              No staff titles are set yet, so there are no roles to pick. Set a title on a staff profile first,
              or assign to named people.
            </p>
          ) : (
            <select value={role} onChange={(e) => setRole(e.target.value)} className={inputCls}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
        </label>
      )}

      {scope === "STAFF" && (
        <div>
          <span className="mb-1 block text-[12px] text-text-muted">Who</span>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-app-border p-2">
            {staff.map((s) => (
              <label key={s.userId} className="flex items-center gap-2 text-[12px] text-text-primary">
                <input
                  type="checkbox"
                  checked={picked.includes(s.userId)}
                  onChange={(e) =>
                    setPicked((prev) =>
                      e.target.checked ? [...prev, s.userId] : prev.filter((x) => x !== s.userId),
                    )
                  }
                />
                {s.name}
                {s.title && <span className="text-text-muted">· {s.title}</span>}
              </label>
            ))}
          </div>
        </div>
      )}

      {willBumpVersion && (
        <p className="rounded-lg border border-orange-accent/40 bg-orange-accent/5 px-3 py-2 text-[12px] text-text-primary">
          You&apos;ve changed the title or the wording, so saving publishes version {doc!.version + 1} and
          everyone will be asked to sign again. Their existing signatures are kept.
        </p>
      )}
      {err && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!ready || busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-charcoal px-4 py-2 text-sm text-white hover:bg-charcoal-hover disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />}
          {doc ? "Save" : "Create and assign"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-app-border px-4 py-2 text-sm text-text-primary hover:bg-app-bg"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
