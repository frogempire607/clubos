"use client";

import { useEffect, useState, useCallback } from "react";

type Signature = {
  signerName: string;
  relationship: string;
  signedAt: string;
  expiresAt: string | null;
  expired: boolean;
};

type Doc = {
  id: string;
  title: string;
  type: string;
  body: string | null;
  required: boolean;
  requiresGuardianSignature: boolean;
  deliveryTrigger: string;
  expiresAt: string | null;
  signatureValidForDays: number | null;
  signature: Signature | null;
};

type AccessibleMember = {
  id: string;
  firstName: string;
  lastName: string;
  isMinor: boolean;
  kind: "self" | "child";
};

type DocsResponse = {
  documents: Doc[];
  contextMemberId: string | null;
  contextMember: { firstName: string; lastName: string; isMinor: boolean } | null;
  accessibleMembers: AccessibleMember[];
};

const typeColors: Record<string, { bg: string; fg: string }> = {
  Waiver: { bg: "#FCE4E0", fg: "#7B2415" },
  Policy: { bg: "var(--color-primary)", fg: "#fff" },
  Agreement: { bg: "var(--color-primary)", fg: "#fff" },
  Handbook: { bg: "var(--color-success)", fg: "var(--color-text)" },
  Other: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function MemberDocumentsPage() {
  const [data, setData] = useState<DocsResponse | null>(null);
  const [activeMemberId, setActiveMemberId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<Doc | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  const load = useCallback((memberId?: string | null) => {
    const qs = memberId ? `?memberId=${encodeURIComponent(memberId)}` : "";
    fetch(`/api/member/documents${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: DocsResponse | null) => {
        if (d) {
          setData(d);
          if (!activeMemberId) setActiveMemberId(d.contextMemberId);
        }
        setLoading(false);
      });
  }, [activeMemberId]);

  useEffect(() => { load(activeMemberId); }, [activeMemberId, load]);

  async function signDocument(doc: Doc) {
    if (!activeMemberId) return;
    setSigning(true);
    setSignError(null);
    const res = await fetch(`/api/member/documents/${doc.id}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId: activeMemberId }),
    });
    const result = await res.json().catch(() => ({}));
    setSigning(false);
    if (!res.ok) {
      setSignError(result.error || "Could not record signature. Please try again.");
      return;
    }
    setViewing(null);
    setSignError(null);
    load(activeMemberId);
  }

  if (loading) return <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>;
  if (!data) return <div className="text-center py-8 text-stone-400 text-sm">Could not load documents.</div>;

  const docs = data.documents;
  const requiredDocs = docs.filter((d) => d.required);
  const otherDocs = docs.filter((d) => !d.required);
  const contextMember = data.contextMember;
  const showMemberPicker = data.accessibleMembers.length > 1;
  // A required doc is considered "outstanding" if there's no signature OR the
  // existing signature has expired against the configured frequency.
  const unsignedRequired = requiredDocs.filter((d) => !d.signature || d.signature.expired).length;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900 mb-1">Documents</h1>
        <p className="text-sm text-stone-500">Club waivers, policies, and forms.</p>
      </div>

      {showMemberPicker && (
        <div className="mb-4">
          <p className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-1.5">Viewing documents for</p>
          <div className="flex flex-wrap gap-2">
            {data.accessibleMembers.map((m) => (
              <button
                key={m.id}
                onClick={() => setActiveMemberId(m.id)}
                className={`px-3 py-1.5 rounded-full text-sm border transition ${
                  activeMemberId === m.id
                    ? "border-stone-900 bg-stone-900 text-white"
                    : "border-stone-200 text-stone-600 bg-white hover:bg-stone-50"
                }`}
              >
                {m.kind === "self" ? "Me" : `${m.firstName} ${m.lastName}`}
                {m.isMinor && <span className="ml-1 text-[10px] opacity-70">(minor)</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {unsignedRequired > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4 text-sm text-amber-800">
          {unsignedRequired} required document{unsignedRequired === 1 ? "" : "s"} needing signature
          {contextMember ? ` for ${contextMember.firstName}` : ""}.
        </div>
      )}

      {docs.length === 0 ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <p className="text-3xl mb-2 text-stone-200">▤</p>
          <p className="text-base font-medium text-stone-900 mb-1">No documents yet</p>
          <p className="text-sm text-stone-500">Your club hasn't posted any documents.</p>
        </div>
      ) : (
        <>
          {requiredDocs.length > 0 && (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-sm font-semibold text-stone-900">Required</h2>
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 font-medium">Must sign</span>
              </div>
              <div className="space-y-2">
                {requiredDocs.map((d) => (
                  <DocCard
                    key={d.id}
                    doc={d}
                    contextIsMinor={!!contextMember?.isMinor}
                    onView={() => setViewing(d)}
                  />
                ))}
              </div>
            </div>
          )}

          {otherDocs.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-stone-900 mb-2">Other Documents</h2>
              <div className="space-y-2">
                {otherDocs.map((d) => (
                  <DocCard
                    key={d.id}
                    doc={d}
                    contextIsMinor={!!contextMember?.isMinor}
                    onView={() => setViewing(d)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {viewing && (
        <DocViewer
          doc={viewing}
          contextIsMinor={!!contextMember?.isMinor}
          contextName={contextMember ? `${contextMember.firstName} ${contextMember.lastName}` : ""}
          onClose={() => { setViewing(null); setSignError(null); }}
          onSign={() => signDocument(viewing)}
          signing={signing}
          signError={signError}
        />
      )}
    </>
  );
}

function DocCard({
  doc,
  contextIsMinor,
  onView,
}: {
  doc: Doc;
  contextIsMinor: boolean;
  onView: () => void;
}) {
  const c = typeColors[doc.type] || typeColors.Other;
  const guardianBadge = doc.requiresGuardianSignature && contextIsMinor;
  const signed = !!doc.signature && !doc.signature.expired;
  const expired = !!doc.signature?.expired;
  return (
    <div className="bg-white rounded-xl border border-stone-200 p-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <h3 className="text-sm font-semibold text-stone-900">{doc.title}</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: c.bg, color: c.fg }}>
            {doc.type}
          </span>
          {guardianBadge && (
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700">
              Guardian signature required
            </span>
          )}
          {signed && (
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-green-50 text-green-700">
              ✓ Signed
            </span>
          )}
          {expired && (
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700">
              Signature expired
            </span>
          )}
        </div>
        {signed && doc.signature && (
          <p className="text-xs text-stone-500">
            Signed by {doc.signature.signerName} on {formatDate(doc.signature.signedAt)}
            {doc.signature.expiresAt && ` · valid until ${formatDate(doc.signature.expiresAt)}`}
          </p>
        )}
        {expired && doc.signature && (
          <p className="text-xs text-amber-700">
            Last signed {formatDate(doc.signature.signedAt)} — re-signature required
            {doc.signature.expiresAt && ` (expired ${formatDate(doc.signature.expiresAt)})`}
          </p>
        )}
        {!doc.signature && doc.expiresAt && (
          <p className="text-xs text-stone-400">Expires {formatDate(doc.expiresAt)}</p>
        )}
        {!doc.signature && doc.signatureValidForDays && (
          <p className="text-[11px] text-stone-400">
            Re-signature required every {doc.signatureValidForDays === 365 ? "year" : `${doc.signatureValidForDays} days`}
          </p>
        )}
      </div>
      <button
        onClick={onView}
        className="text-xs px-3 py-1.5 rounded-lg border border-stone-200 text-stone-700 hover:bg-stone-50 flex-shrink-0"
      >
        {expired ? "Re-sign" : signed ? "View" : doc.required ? "Sign" : "View"}
      </button>
    </div>
  );
}

function DocViewer({
  doc,
  contextIsMinor,
  contextName,
  onClose,
  onSign,
  signing,
  signError,
}: {
  doc: Doc;
  contextIsMinor: boolean;
  contextName: string;
  onClose: () => void;
  onSign: () => void;
  signing: boolean;
  signError: string | null;
}) {
  const c = typeColors[doc.type] || typeColors.Other;
  const signedAndValid = !!doc.signature && !doc.signature.expired;
  const expired = !!doc.signature?.expired;
  const needsSignature = !doc.signature || expired;
  const guardianRequired = doc.requiresGuardianSignature && contextIsMinor;
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-semibold text-stone-900">{doc.title}</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: c.bg, color: c.fg }}>
              {doc.type}
            </span>
            {doc.required && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-red-50 text-red-700">Required</span>
            )}
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-2xl leading-none w-8 h-8 flex items-center justify-center rounded-lg hover:bg-stone-100">×</button>
        </div>
        <div className="p-6">
          {doc.body ? (
            <div
              className="text-sm text-stone-700 leading-relaxed prose max-w-none"
              dangerouslySetInnerHTML={{ __html: doc.body }}
            />
          ) : (
            <p className="text-sm text-stone-400 italic">No content added yet.</p>
          )}

          {signedAndValid && doc.signature && (
            <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800">
              <p className="font-medium">✓ Signed by {doc.signature.signerName}{doc.signature.relationship === "GUARDIAN" ? " (guardian)" : ""}</p>
              <p className="text-xs text-green-700/80 mt-0.5">
                {formatDate(doc.signature.signedAt)}
                {doc.signature.expiresAt && ` · Valid until ${formatDate(doc.signature.expiresAt)}`}
              </p>
            </div>
          )}

          {expired && doc.signature && (
            <div className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
              <p className="font-medium">Signature expired</p>
              <p className="text-xs mt-0.5">
                Last signed {formatDate(doc.signature.signedAt)}
                {doc.signature.expiresAt ? ` · expired ${formatDate(doc.signature.expiresAt)}` : ""}.
                Please re-sign to keep this on file.
              </p>
            </div>
          )}

          {needsSignature && guardianRequired && (
            <div className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
              This document requires a parent or guardian signature on behalf of the minor. By signing
              below, you confirm you are the legal guardian of {contextName || "this athlete"}.
            </div>
          )}

          {signError && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              {signError}
            </div>
          )}

          {needsSignature && (
            <div className="mt-6 border-t border-stone-100 pt-5">
              {!confirming ? (
                <>
                  <p className="text-sm text-stone-500 mb-4">
                    By clicking sign below, you confirm you have read and agree to this document
                    {contextName ? ` on behalf of ${contextName}` : ""}.
                  </p>
                  <button
                    onClick={() => setConfirming(true)}
                    className="w-full sm:w-auto px-6 py-2.5 bg-stone-900 text-white rounded-xl text-sm font-semibold hover:bg-stone-700 transition"
                  >
                    {expired ? "Re-sign document" : guardianRequired ? "Sign as guardian" : "I have read and acknowledge"}
                  </button>
                </>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-stone-700">
                    This action will be recorded with your name, the current date and time, and your IP address as legal proof of agreement. Continue?
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfirming(false)}
                      disabled={signing}
                      className="flex-1 sm:flex-none px-5 py-2.5 border border-stone-300 text-stone-700 rounded-xl text-sm font-medium hover:bg-stone-50 transition disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={onSign}
                      disabled={signing}
                      className="flex-1 sm:flex-none px-6 py-2.5 bg-stone-900 text-white rounded-xl text-sm font-semibold hover:bg-stone-700 transition disabled:opacity-60"
                    >
                      {signing ? "Recording…" : "Yes, record my signature"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
