"use client";

import { useEffect, useState } from "react";

type Doc = {
  id: string;
  title: string;
  type: string;
  body: string | null;
  required: boolean;
  requiresGuardianSignature: boolean;
  deliveryTrigger: string;
  expiresAt: string | null;
};

const typeColors: Record<string, { bg: string; fg: string }> = {
  Waiver: { bg: "#FCE4E0", fg: "#7B2415" },
  Policy: { bg: "var(--color-primary)", fg: "#fff" },
  Agreement: { bg: "var(--color-primary)", fg: "#fff" },
  Handbook: { bg: "var(--color-success)", fg: "var(--color-text)" },
  Other: { bg: "var(--color-bg)", fg: "var(--color-muted)" },
};

export default function MemberDocumentsPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [isMinor, setIsMinor] = useState<boolean>(false);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<Doc | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/member/documents").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/member/portal").then((r) => (r.ok ? r.json() : null)),
    ]).then(([docs, portal]) => {
      setDocs(Array.isArray(docs) ? docs : []);
      setIsMinor(!!portal?.user?.memberProfile?.isMinor);
      setLoading(false);
    });
  }, []);

  const requiredDocs = docs.filter((d) => d.required);
  const otherDocs = docs.filter((d) => !d.required);

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900 mb-1">Documents</h1>
        <p className="text-sm text-stone-500">Club waivers, policies, and forms.</p>
      </div>

      {loading ? (
        <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>
      ) : docs.length === 0 ? (
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
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 font-medium">
                  Must sign
                </span>
              </div>
              <div className="space-y-2">
                {requiredDocs.map((d) => <DocCard key={d.id} doc={d} isMinor={isMinor} onView={() => setViewing(d)} />)}
              </div>
            </div>
          )}

          {otherDocs.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-stone-900 mb-2">Other Documents</h2>
              <div className="space-y-2">
                {otherDocs.map((d) => <DocCard key={d.id} doc={d} isMinor={isMinor} onView={() => setViewing(d)} />)}
              </div>
            </div>
          )}
        </>
      )}

      {viewing && (
        <DocViewer doc={viewing} isMinor={isMinor} onClose={() => setViewing(null)} />
      )}
    </>
  );
}

function DocCard({ doc, isMinor, onView }: { doc: Doc; isMinor: boolean; onView: () => void }) {
  const c = typeColors[doc.type] || typeColors.Other;
  // The "guardian signature required" rule only applies to minors. Adults sign for themselves.
  const guardianBadge = doc.requiresGuardianSignature && isMinor;
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
        </div>
        {doc.expiresAt && (
          <p className="text-xs text-stone-400">Expires {new Date(doc.expiresAt).toLocaleDateString()}</p>
        )}
      </div>
      <button
        onClick={onView}
        className="text-xs px-3 py-1.5 rounded-lg border border-stone-200 text-stone-700 hover:bg-stone-50 flex-shrink-0"
      >
        View
      </button>
    </div>
  );
}

function DocViewer({ doc, isMinor, onClose }: { doc: Doc; isMinor: boolean; onClose: () => void }) {
  const c = typeColors[doc.type] || typeColors.Other;
  const guardianGate = doc.requiresGuardianSignature && isMinor;

  function stripHtml(html: string) {
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-stone-200 flex items-center justify-between sticky top-0 bg-white">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-semibold text-stone-900">{doc.title}</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ background: c.bg, color: c.fg }}>
              {doc.type}
            </span>
            {doc.required && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-red-50 text-red-700">Required</span>
            )}
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none">×</button>
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

          {guardianGate && (
            <div className="mt-6 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
              This document requires a parent or guardian signature. Your guardian will receive a notification to sign.
            </div>
          )}

          {doc.required && (
            <div className="mt-6 border-t border-stone-100 pt-4">
              <p className="text-sm text-stone-500 mb-3">
                By clicking acknowledge below, you confirm you have read and agree to this document.
              </p>
              <button
                onClick={onClose}
                disabled={guardianGate}
                className="px-5 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title={guardianGate ? "Your guardian must sign this document" : undefined}
              >
                {guardianGate ? "Awaiting guardian signature" : "I have read and acknowledge"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
