"use client";

// Family & access — the staff view of who can actually act for an athlete,
// and every action plan.md §4C asks for.
//
// This card exists because the dashboard previously showed only
// MemberRelationship (a descriptive label that grants nothing) and never showed
// MemberGuardianUser (the thing that grants everything). Staff couldn't see that
// a child was linked to the wrong account, and couldn't fix it.
//
// The vocabulary is deliberate and never blurred:
//   "Can sign in and manage" → a guardian link. Real access.
//   "Family label"           → a MemberRelationship. Says nothing about access.
//   "Suggested by staff"     → a PENDING link. Grants NOTHING until confirmed.
//
// Neither pending state is ever labelled just "pending" (owner call, 2026-08-03):
// a family request and a staff suggestion resolve in different places, so each
// chip says who asked AND where it gets resolved.
//
// Every action is gated by server-resolved `capabilities`, never by a
// client-side guess, so the UI can't offer something the API would refuse.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  UserPlus, ShieldCheck, Clock, Search, X, Check, Star, AlertTriangle,
  ExternalLink, CalendarPlus, CreditCard, Pencil, UserMinus,
} from "lucide-react";

export type FamilyGuardian = {
  linkId: string;
  userId: string;
  name: string;
  email: string | null;
  profileImageUrl: string | null;
  relationship: string | null;
  status: string;
  isPrimary: boolean;
  canBook: boolean;
  canPay: boolean;
  canSignWaivers: boolean;
  canReceiveEmails: boolean;
  source: string | null;
  linkedAt: string;
  memberId: string | null;
};

export type FamilyManagedAthlete = {
  linkId: string;
  memberId: string;
  name: string;
  profileImageUrl: string | null;
  isMinor: boolean;
  status: string;
  linkStatus: string;
  transferableSubscriptionId: string | null;
  relationship: string | null;
  isPrimary: boolean;
  canBook: boolean;
  canPay: boolean;
  canSignWaivers: boolean;
  canReceiveEmails: boolean;
  linkedAt: string;
};

export type FamilyPendingLink = {
  approvalId: string;
  requestingUserId: string | null;
  requestingUserEmail: string | null;
  relationship: string | null;
  requestedAt: string;
};

export type FamilyCapabilities = {
  canViewFamily: boolean;
  canProposeLink: boolean;
  canGrantLink: boolean;
  canTransferMembership: boolean;
  canBookForAthlete: boolean;
  canViewBilling: boolean;
};

export type FamilyPayload = {
  guardians: FamilyGuardian[];
  managedAthletes: FamilyManagedAthlete[];
  pendingGuardianRequests: FamilyPendingLink[];
  hasOwnLogin: boolean;
};

type Candidate = {
  userId: string;
  name: string;
  email: string | null;
  neverSignedIn: boolean;
  ownMemberId: string | null;
  ownMemberName: string | null;
  reasons: string[];
};

const PERMS = [
  { key: "canBook", label: "Book" },
  { key: "canPay", label: "Pay" },
  { key: "canSignWaivers", label: "Waivers" },
  { key: "canReceiveEmails", label: "Emails" },
] as const;

/**
 * Where a link came from, in words.
 *
 * 4.5.6 asks for "Added by Coach Ben at the desk · Jul 27" on staff-created
 * links. We don't carry the creating staff member's NAME on the payload (only
 * createdByUserId), so this states the ORIGIN honestly rather than inventing an
 * attribution — how a link came to exist is what decides whether to trust it,
 * and a wrong name is worse than an unnamed one. Adding the name is a payload
 * change for a later pass.
 */
function sourceLine(source: string | null, linkedAt: string): string {
  const when = fmtDate(linkedAt);
  switch (source) {
    case "STAFF_LINKED":
      return `added by staff at the desk · ${when}`;
    case "OWNER_VOUCHED":
      return `matched the guardian email on file · ${when}`;
    case "SIGNUP_SWEEP":
      return `linked when they signed up · ${when}`;
    case "MIGRATION_ACTIVATION":
      return `linked during activation · ${when}`;
    case "APPROVAL":
      return `approved from the queue · ${when}`;
    case "CONSENT_TOKEN":
      return `confirmed by the guardian · ${when}`;
    default:
      return `linked ${when}`;
  }
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  return (
    <div className="h-8 w-8 shrink-0 rounded-full bg-app-border overflow-hidden flex items-center justify-center text-[11px] font-semibold text-text-primary">
      {src ? <img src={src} alt="" className="h-full w-full object-cover" /> : initials || "?"}
    </div>
  );
}

/**
 * The four permissions — 4.5.6 requires these EDITABLE IN PLACE.
 *
 * They were read-only pills, which meant the only way to change what a parent
 * could do was to remove their access and re-grant it. That is destructive for
 * a correction as small as "Sam shouldn't be paying" and it loses the original
 * link's history.
 *
 * Column names are the shipped ones — canBook / canPay / canSignWaivers /
 * canReceiveEmails. plan.md said canWaivers / canMessages, which do not exist;
 * J-9 settled it in favour of the code and the doc was corrected.
 *
 * A PENDING link's permissions are shown but NOT editable: the row grants
 * nothing until it is confirmed, so editing it would imply an authority it
 * doesn't have. Confirm first, then adjust.
 */
function PermCells({
  row,
  linkId,
  memberId,
  editable,
  onChanged,
}: {
  row: Record<string, unknown>;
  linkId: string;
  memberId: string;
  editable: boolean;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [local, setLocal] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(PERMS.map((p) => [p.key, !!row[p.key]])),
  );
  const [failed, setFailed] = useState<string | null>(null);

  // Keep in step when the parent reloads the family after some other change.
  useEffect(() => {
    setLocal(Object.fromEntries(PERMS.map((p) => [p.key, !!row[p.key]])));
  }, [row]);

  async function toggle(key: string) {
    if (!editable || saving) return;
    const next = !local[key];
    setLocal((l) => ({ ...l, [key]: next })); // optimistic
    setSaving(key);
    setFailed(null);
    try {
      // linkId travels in the BODY — the PATCH handler reads it from the parsed
      // schema, not the query string. Sending it as ?linkId= parsed fine and
      // then 400'd on the missing field, which surfaced as a toggle that
      // flipped and silently flipped back.
      const res = await fetch(`/api/members/${memberId}/guardians`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ linkId, [key]: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not save");
      onChanged();
    } catch (e) {
      // Roll the optimistic flip back — a permission that looks granted but
      // isn't is worse than a visible failure.
      setLocal((l) => ({ ...l, [key]: !next }));
      setFailed(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {PERMS.map((p) => {
          const on = local[p.key];
          const busy = saving === p.key;
          const label = `${on ? "Can" : "Cannot"} ${p.label.toLowerCase()}`;
          if (!editable) {
            return (
              <span
                key={p.key}
                title={`${label} — confirm this link before changing what it allows`}
                className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                  on ? "bg-lime-accent/25 text-charcoal" : "bg-app-bg text-text-muted line-through"
                }`}
              >
                {p.label}
              </span>
            );
          }
          return (
            <button
              key={p.key}
              onClick={() => toggle(p.key)}
              disabled={busy}
              role="switch"
              aria-checked={on}
              aria-label={`${p.label} — ${label}`}
              title={`${label}. Click to change.`}
              className={`min-h-[44px] min-w-[44px] rounded px-1.5 text-[10px] font-medium transition-colors disabled:opacity-60 md:min-h-[26px] md:min-w-0 ${
                on
                  ? "bg-lime-accent/25 text-charcoal hover:bg-lime-accent/40"
                  : "bg-app-bg text-text-muted line-through hover:bg-app-border"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      {failed && <p className="mt-1 text-[10px] text-orange-accent">{failed}</p>}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  if (status === "PENDING") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-orange-accent/15 text-orange-accent font-medium"
        title="A staff member suggested this link. It grants nothing until someone with full member permissions confirms it here."
      >
        <Clock className="h-2.5 w-2.5" strokeWidth={2.5} /> Suggested by staff — confirm here
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-lime-accent/25 text-charcoal font-medium">
      <ShieldCheck className="h-2.5 w-2.5" strokeWidth={2.5} /> Active
    </span>
  );
}

export default function FamilyAccessCard({
  memberId,
  memberName,
  family,
  onChanged,
  onAssignMembership,
}: {
  memberId: string;
  memberName: string;
  family: FamilyPayload | undefined;
  onChanged: () => void;
  /** Opens the 4A transfer modal. Undefined hides "Assign Membership". */
  onAssignMembership?: (subscriptionId: string) => void;
}) {
  const [caps, setCaps] = useState<FamilyCapabilities | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [relationship, setRelationship] = useState("Parent");
  const [editing, setEditing] = useState<string | null>(null);

  const loadSide = useCallback(
    async (query: string) => {
      const res = await fetch(
        `/api/members/${memberId}/guardians${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      );
      if (!res.ok) return;
      const d = await res.json();
      setCandidates(d.candidates ?? []);
      setSearched(!!d.searched);
      setCaps(d.capabilities ?? null);
    },
    [memberId],
  );

  // Capabilities come from the server on mount so the action set is correct
  // even before the add panel is opened.
  useEffect(() => { void loadSide(""); }, [loadSide]);
  useEffect(() => {
    if (!adding) return;
    const t = setTimeout(() => void loadSide(q), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [adding, q, loadSide]);

  async function call(method: string, body?: Record<string, unknown>, qs = "") {
    setBusy(true);
    setErr(null);
    setNotice(null);
    const res = await fetch(`/api/members/${memberId}/guardians${qs}`, {
      method,
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(d.error ?? "That didn't work."); return false; }
    if (d.message) setNotice(d.message);
    onChanged();
    void loadSide(q);
    return true;
  }

  async function revoke(linkId: string, name: string, pending: boolean) {
    const msg = pending
      ? `Withdraw the suggestion to give ${name} access to ${memberName}?`
      : `Remove ${name}'s access to ${memberName}?\n\nThey will no longer be able to book, pay, sign, or see this athlete. The record of the link is kept so the change stays auditable.`;
    if (!confirm(msg)) return;
    await call("DELETE", undefined, `?linkId=${linkId}`);
  }

  const guardians = family?.guardians ?? [];
  const managed = family?.managedAthletes ?? [];
  const requests = family?.pendingGuardianRequests ?? [];
  const canManage = !!caps?.canGrantLink;

  const confirmedGuardians = guardians.filter((g) => g.status === "CONFIRMED");
  const pendingGuardians = guardians.filter((g) => g.status === "PENDING");
  const countLine = [
    `${confirmedGuardians.length} account ${confirmedGuardians.length === 1 ? "holder" : "holders"}`,
    `${managed.length} ${managed.length === 1 ? "athlete" : "athletes"}`,
    pendingGuardians.length + requests.length > 0
      ? `${pendingGuardians.length + requests.length} pending guardian`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const canAdd = !!(caps?.canGrantLink || caps?.canProposeLink);

  return (
    <div className="bg-surface border border-app-border rounded-xl p-5 lg:col-span-2">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Family &amp; access</h2>
          {/* 4.5.6 header line. Counts are of ACCESS, not of relationships —
              a pending guardian is counted separately precisely because it
              grants nothing yet. */}
          <p className="text-xs text-text-muted mt-0.5 tabular-nums">
            {countLine}
          </p>
          <p className="text-xs text-text-muted mt-0.5">
            Who can sign in and act for this athlete. This is real access — not the family labels below.
          </p>
        </div>
        {canAdd && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 text-xs font-medium text-brand hover:underline md:min-h-0"
          >
            <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
            {caps?.canGrantLink ? "Give someone access" : "Suggest access"}
          </button>
        )}
      </div>

      {notice && (
        <p className="mt-2 text-xs text-text-primary bg-lime-accent/15 rounded-lg px-3 py-2">{notice}</p>
      )}

      {/* ── Add / propose ────────────────────────────────────────────────── */}
      {adding && (
        <div className="mt-3 mb-4 rounded-lg border border-app-border bg-app-bg p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-text-primary">
              Link an existing portal account to {memberName}
            </p>
            <button onClick={() => { setAdding(false); setErr(null); }} className="text-text-muted hover:text-text-primary">
              <X className="h-4 w-4" strokeWidth={2} />
            </button>
          </div>

          {!caps?.canGrantLink && (
            <p className="text-[11px] text-orange-accent mb-2">
              Your access lets you suggest a link. It grants nothing until someone with full member
              permissions confirms it here.
            </p>
          )}

          <div className="flex flex-col sm:flex-row gap-2 mb-2">
            <div className="relative flex-1">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" strokeWidth={2} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search by name or email…"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="w-full pl-8 pr-2 py-1.5 text-sm rounded-md border border-app-border bg-surface text-text-primary focus:ring-2 focus:ring-brand outline-none"
              />
            </div>
            <input
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              placeholder="Relationship"
              className="sm:w-40 px-2 py-1.5 text-sm rounded-md border border-app-border bg-surface text-text-primary focus:ring-2 focus:ring-brand outline-none"
            />
          </div>

          {err && <p className="text-xs text-red-600 mb-2">{err}</p>}

          {candidates.length === 0 ? (
            <p className="text-xs text-text-muted">
              {searched ? "No accounts match that search." : "No obvious match. Search for the parent's account by name or email."}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {candidates.map((c) => (
                <li key={c.userId} className="flex items-start justify-between gap-3 rounded-md bg-surface border border-app-border px-2.5 py-2">
                  <div className="min-w-0">
                    <p className="text-sm text-text-primary font-medium truncate">
                      {c.name}
                      {c.ownMemberName && <span className="text-text-muted font-normal"> · member: {c.ownMemberName}</span>}
                    </p>
                    <p className="text-xs text-text-muted truncate">{c.email}</p>
                    {c.reasons.map((r) => (
                      <p key={r} className="text-[11px] text-orange-accent mt-0.5">{r}</p>
                    ))}
                    {c.neverSignedIn && <p className="text-[11px] text-text-muted mt-0.5">This account has never signed in.</p>}
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => call("POST", { userId: c.userId, relationship: relationship || null }).then((ok) => ok && setAdding(false))}
                    className="inline-flex min-h-[44px] shrink-0 items-center rounded-md bg-charcoal px-2 py-1 text-xs text-white hover:bg-charcoal-hover disabled:opacity-50 md:min-h-0"
                  >
                    {caps?.canGrantLink ? "Give access" : "Suggest"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Family-initiated requests (PendingApproval) ──────────────────── */}
      {requests.length > 0 && (
        <div className="mb-4 rounded-lg border border-orange-accent/40 bg-orange-accent/5 p-3">
          <p className="text-xs font-medium text-text-primary flex items-center gap-1.5 mb-1.5">
            <Clock className="h-3.5 w-3.5 text-orange-accent" strokeWidth={2} />
            Requested by family — approve in Approvals
          </p>
          <ul className="space-y-1">
            {requests.map((p) => (
              <li key={p.approvalId} className="text-xs text-text-muted">
                {p.requestingUserEmail ?? "Someone"} asked to manage this athlete
                {p.relationship ? ` as ${p.relationship}` : ""} · {fmtDate(p.requestedAt)} —{" "}
                <Link href="/dashboard/members/approvals" className="text-brand hover:underline">
                  review in Approvals
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Guardians ────────────────────────────────────────────────────── */}
      <p className="text-[11px] uppercase tracking-wide text-text-muted font-semibold mb-1.5">
        Can sign in and manage {memberName}
      </p>
      {guardians.length === 0 ? (
        <div className="rounded-lg bg-app-bg px-3 py-2.5 mb-4">
          <p className="text-sm text-text-muted flex items-start gap-1.5">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-orange-accent" strokeWidth={2} />
            <span>
              Nobody can manage this athlete yet. A family label below is <strong>not</strong> access — if a
              parent should see this athlete in their portal, use &ldquo;{caps?.canGrantLink ? "Give someone access" : "Suggest access"}&rdquo;.
            </span>
          </p>
        </div>
      ) : (
        <ul className="space-y-2 mb-4">
          {guardians.map((g) => {
            const pending = g.status === "PENDING";
            return (
              <li key={g.linkId} className={`rounded-lg border px-3 py-2.5 ${pending ? "border-orange-accent/40 bg-orange-accent/5" : "border-app-border"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <Avatar src={g.profileImageUrl} name={g.name} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-text-primary flex items-center gap-1.5 flex-wrap">
                        {g.name}
                        {g.isPrimary && (
                          <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-charcoal text-white font-medium" title="The primary guardian holds parental controls">
                            <Star className="h-2.5 w-2.5" strokeWidth={2.5} /> Manages controls
                          </span>
                        )}
                        <StatusChip status={g.status} />
                      </p>
                      <p className="text-xs text-text-muted truncate">
                        {g.email}
                        {g.relationship ? ` · ${g.relationship}` : ""} · {sourceLine(g.source, g.linkedAt)}
                      </p>
                    </div>
                  </div>
                  <div className="shrink-0 flex flex-wrap justify-end gap-x-2.5 gap-y-1">
                    {g.memberId && (
                      <Link href={`/dashboard/members/${g.memberId}`} className="inline-flex min-h-[44px] items-center gap-1 text-xs text-text-muted hover:text-text-primary md:min-h-0">
                        <ExternalLink className="h-3 w-3" strokeWidth={2} /> View profile
                      </Link>
                    )}
                    {canManage && pending && (
                      <button disabled={busy} onClick={() => call("PATCH", { linkId: g.linkId, confirm: true })} className="inline-flex min-h-[44px] items-center text-xs text-brand hover:underline disabled:opacity-50 md:min-h-0">
                        Confirm
                      </button>
                    )}
                    {canManage && !pending && (
                      <button disabled={busy} onClick={() => setEditing(editing === g.linkId ? null : g.linkId)} className="inline-flex min-h-[44px] items-center gap-1 text-xs text-text-muted hover:text-text-primary md:min-h-0">
                        <Pencil className="h-3 w-3" strokeWidth={2} /> Edit
                      </button>
                    )}
                    {canManage && !pending && !g.isPrimary && (
                      <button disabled={busy} onClick={() => call("PATCH", { linkId: g.linkId, makePrimary: true })} className="inline-flex min-h-[44px] items-center text-xs text-text-muted hover:text-text-primary disabled:opacity-50 md:min-h-0" title="Parental controls move to this guardian">
                        Make primary guardian
                      </button>
                    )}
                    {canManage && (
                      <button disabled={busy} onClick={() => revoke(g.linkId, g.name, pending)} className="inline-flex min-h-[44px] items-center gap-1 rounded px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 md:min-h-0">
                        <UserMinus className="h-3 w-3" strokeWidth={2} /> {pending ? "Withdraw" : "Remove"}
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-1.5">
                  <PermCells
                    row={g as unknown as Record<string, unknown>}
                    linkId={g.linkId}
                    memberId={memberId}
                    editable={canManage && g.status === "CONFIRMED"}
                    onChanged={onChanged}
                  />
                </div>

                {editing === g.linkId && canManage && (
                  <div className="mt-2 pt-2 border-t border-app-border flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-text-muted">Allow:</span>
                    {PERMS.map((p) => (
                      <label key={p.key} className="inline-flex items-center gap-1 text-[11px] text-text-primary cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!g[p.key]}
                          disabled={busy}
                          onChange={(e) => call("PATCH", { linkId: g.linkId, [p.key]: e.target.checked })}
                          className="accent-[color:var(--color-brand)]"
                        />
                        {p.label}
                      </label>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* ── Reciprocal direction ─────────────────────────────────────────── */}
      {family?.hasOwnLogin && (
        <>
          <p className="text-[11px] uppercase tracking-wide text-text-muted font-semibold mb-1.5">
            {memberName} can manage
          </p>
          {managed.length === 0 ? (
            <p className="text-sm text-text-muted mb-1">This account doesn&apos;t manage anyone else.</p>
          ) : (
            <ul className="space-y-1.5">
              {managed.map((m) => (
                <li key={m.linkId} className="rounded-lg border border-app-border px-3 py-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <Avatar src={m.profileImageUrl} name={m.name} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary flex items-center gap-1.5 flex-wrap">
                          <Link href={`/dashboard/members/${m.memberId}`} className="hover:underline truncate">{m.name}</Link>
                          <StatusChip status={m.linkStatus} />
                        </p>
                        <p className="text-xs text-text-muted">
                          {m.relationship ?? "Guardian"} · {m.isMinor ? "Minor" : "Adult"} · {m.status.toLowerCase()} · linked {fmtDate(m.linkedAt)}
                        </p>
                      </div>
                    </div>
                    <div className="shrink-0 flex flex-wrap justify-end gap-x-2.5 gap-y-1">
                      {caps?.canBookForAthlete && (
                        <Link href={`/dashboard/attendance?memberId=${m.memberId}`} className="inline-flex min-h-[44px] items-center gap-1 text-xs text-text-muted hover:text-text-primary md:min-h-0">
                          <CalendarPlus className="h-3 w-3" strokeWidth={2} /> Book a class
                        </Link>
                      )}
                      {caps?.canTransferMembership && m.transferableSubscriptionId && onAssignMembership && (
                        <button
                          onClick={() => onAssignMembership(m.transferableSubscriptionId!)}
                          className="text-xs text-brand hover:underline inline-flex items-center gap-1"
                          title="Move this athlete's membership to another family member"
                        >
                          <CreditCard className="h-3 w-3" strokeWidth={2} /> Assign membership
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-1.5">
                    <PermCells
                      row={m as unknown as Record<string, unknown>}
                      linkId={m.linkId}
                      memberId={m.memberId}
                      editable={canManage && m.linkStatus === "CONFIRMED"}
                      onChanged={onChanged}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {err && !adding && <p className="text-xs text-red-600 mt-2">{err}</p>}
      {busy && (
        <p className="text-xs text-text-muted mt-2 flex items-center gap-1">
          <Check className="h-3 w-3" strokeWidth={2} /> Saving…
        </p>
      )}
    </div>
  );
}
