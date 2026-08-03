"use client";

// Family & access — the staff-facing view of who can actually act for an
// athlete, and the control to change it.
//
// This card exists because the dashboard previously showed only
// MemberRelationship (a descriptive label that grants nothing) and never showed
// MemberGuardianUser (the thing that grants everything). Staff had no way to
// see that a child was linked to the wrong account, and no way to fix it.
//
// The vocabulary here is deliberate and never blurred:
//   "Can sign in and manage"  → a guardian link. Real access.
//   "Family label"            → a MemberRelationship. Says nothing about access.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  UserPlus, ShieldCheck, Clock, Search, X, Check, Star, AlertTriangle,
} from "lucide-react";

export type FamilyGuardian = {
  linkId: string;
  userId: string;
  name: string;
  email: string | null;
  relationship: string | null;
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
  isMinor: boolean;
  status: string;
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

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function PermPills({ row }: { row: Record<string, unknown> }) {
  return (
    <div className="flex flex-wrap gap-1">
      {PERMS.map((p) => {
        const on = !!row[p.key];
        return (
          <span
            key={p.key}
            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
              on
                ? "bg-lime-accent/25 text-charcoal"
                : "bg-app-bg text-text-muted line-through"
            }`}
          >
            {p.label}
          </span>
        );
      })}
    </div>
  );
}

export default function FamilyAccessCard({
  memberId,
  memberName,
  family,
  canManage,
  onChanged,
}: {
  memberId: string;
  memberName: string;
  family: FamilyPayload | undefined;
  /** members:full — granting access is an authorization change, not triage. */
  canManage: boolean;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [relationship, setRelationship] = useState("Parent");

  const loadCandidates = useCallback(
    async (query: string) => {
      const res = await fetch(
        `/api/members/${memberId}/guardians${query ? `?q=${encodeURIComponent(query)}` : ""}`,
      );
      if (!res.ok) return;
      const d = await res.json();
      setCandidates(d.candidates ?? []);
      setSearched(!!d.searched);
    },
    [memberId],
  );

  useEffect(() => {
    if (!adding) return;
    const t = setTimeout(() => void loadCandidates(q), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [adding, q, loadCandidates]);

  async function grant(userId: string) {
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/members/${memberId}/guardians`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, relationship: relationship || null }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr((await res.json().catch(() => ({}))).error ?? "Could not grant access.");
      return;
    }
    setAdding(false);
    setQ("");
    onChanged();
  }

  async function patch(linkId: string, body: Record<string, unknown>) {
    setBusy(true);
    await fetch(`/api/members/${memberId}/guardians`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linkId, ...body }),
    });
    setBusy(false);
    onChanged();
  }

  async function revoke(linkId: string, name: string) {
    if (
      !confirm(
        `Remove ${name}'s access to ${memberName}?\n\nThey will no longer be able to book, pay, sign, or see this athlete. ` +
          `The record of the link is kept so the change stays auditable.`,
      )
    )
      return;
    setBusy(true);
    await fetch(`/api/members/${memberId}/guardians?linkId=${linkId}`, { method: "DELETE" });
    setBusy(false);
    onChanged();
  }

  const guardians = family?.guardians ?? [];
  const managed = family?.managedAthletes ?? [];
  const pending = family?.pendingGuardianRequests ?? [];

  return (
    <div className="bg-surface border border-app-border rounded-xl p-5 lg:col-span-2">
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Family &amp; access</h2>
          <p className="text-xs text-text-muted mt-0.5">
            Who can sign in and act for this athlete. This is real access — not the family labels below.
          </p>
        </div>
        {canManage && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:underline"
          >
            <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
            Give someone access
          </button>
        )}
      </div>

      {/* ── Add flow ─────────────────────────────────────────────────────── */}
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
              {searched
                ? "No accounts match that search."
                : "No obvious match. Search for the parent's account by name or email."}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {candidates.map((c) => (
                <li
                  key={c.userId}
                  className="flex items-start justify-between gap-3 rounded-md bg-surface border border-app-border px-2.5 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-text-primary font-medium truncate">
                      {c.name}
                      {c.ownMemberName && (
                        <span className="text-text-muted font-normal"> · member: {c.ownMemberName}</span>
                      )}
                    </p>
                    <p className="text-xs text-text-muted truncate">{c.email}</p>
                    {c.reasons.map((r) => (
                      <p key={r} className="text-[11px] text-orange-accent mt-0.5">{r}</p>
                    ))}
                    {c.neverSignedIn && (
                      <p className="text-[11px] text-text-muted mt-0.5">This account has never signed in.</p>
                    )}
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => grant(c.userId)}
                    className="shrink-0 text-xs px-2 py-1 rounded-md bg-charcoal text-white hover:bg-charcoal-hover disabled:opacity-50"
                  >
                    Give access
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Pending requests ─────────────────────────────────────────────── */}
      {pending.length > 0 && (
        <div className="mb-4 rounded-lg border border-orange-accent/40 bg-orange-accent/5 p-3">
          <p className="text-xs font-medium text-text-primary flex items-center gap-1.5 mb-1.5">
            <Clock className="h-3.5 w-3.5 text-orange-accent" strokeWidth={2} />
            Waiting for your approval
          </p>
          <ul className="space-y-1">
            {pending.map((p) => (
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
              parent should see this athlete in their portal, use &ldquo;Give someone access&rdquo;.
            </span>
          </p>
        </div>
      ) : (
        <ul className="space-y-2 mb-4">
          {guardians.map((g) => (
            <li key={g.linkId} className="rounded-lg border border-app-border px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text-primary flex items-center gap-1.5 flex-wrap">
                    {g.memberId ? (
                      <Link href={`/dashboard/members/${g.memberId}`} className="hover:underline">
                        {g.name}
                      </Link>
                    ) : (
                      g.name
                    )}
                    {g.isPrimary && (
                      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-charcoal text-white font-medium">
                        <Star className="h-2.5 w-2.5" strokeWidth={2.5} /> Primary
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-text-muted truncate">
                    {g.email}
                    {g.relationship ? ` · ${g.relationship}` : ""} · linked {fmtDate(g.linkedAt)}
                  </p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 items-center gap-2">
                    {!g.isPrimary && (
                      <button
                        disabled={busy}
                        onClick={() => patch(g.linkId, { makePrimary: true })}
                        className="text-xs text-text-muted hover:text-text-primary disabled:opacity-50"
                        title="The primary guardian sets parental controls"
                      >
                        Make primary
                      </button>
                    )}
                    <button
                      disabled={busy}
                      onClick={() => revoke(g.linkId, g.name)}
                      className="text-xs text-red-600 hover:bg-red-50 px-2 py-0.5 rounded disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-3">
                <PermPills row={g as unknown as Record<string, unknown>} />
                {canManage && (
                  <div className="flex gap-1.5">
                    {PERMS.map((p) => (
                      <button
                        key={p.key}
                        disabled={busy}
                        onClick={() => patch(g.linkId, { [p.key]: !g[p.key] })}
                        className="text-[10px] text-text-muted hover:text-brand disabled:opacity-50"
                        title={`${g[p.key] ? "Remove" : "Allow"} ${p.label.toLowerCase()}`}
                      >
                        {g[p.key] ? "−" : "+"}{p.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* ── Reciprocal direction ─────────────────────────────────────────── */}
      {family?.hasOwnLogin && (
        <>
          <p className="text-[11px] uppercase tracking-wide text-text-muted font-semibold mb-1.5">
            {memberName} can manage
          </p>
          {managed.length === 0 ? (
            <p className="text-sm text-text-muted mb-1">
              This account doesn&apos;t manage anyone else.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {managed.map((m) => (
                <li
                  key={m.linkId}
                  className="flex items-center justify-between gap-3 rounded-lg border border-app-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary flex items-center gap-1.5">
                      <ShieldCheck className="h-3.5 w-3.5 text-lime-accent shrink-0" strokeWidth={2} />
                      <Link href={`/dashboard/members/${m.memberId}`} className="hover:underline truncate">
                        {m.name}
                      </Link>
                    </p>
                    <p className="text-xs text-text-muted">
                      {m.relationship ?? "Guardian"} · {m.isMinor ? "Minor" : "Adult"} · linked {fmtDate(m.linkedAt)}
                    </p>
                  </div>
                  <PermPills row={m as unknown as Record<string, unknown>} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {busy && (
        <p className="text-xs text-text-muted mt-2 flex items-center gap-1">
          <Check className="h-3 w-3" strokeWidth={2} /> Saving…
        </p>
      )}
    </div>
  );
}
