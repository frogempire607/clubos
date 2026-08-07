// The profile's Documents tab — session 4.
//
// Julian: "Documents matters most — I need to see signed waivers and ones still
// waiting."
//
// So the list leads with what is outstanding and states each document's status
// in words rather than by colour alone. Three states, deliberately not two:
//
//   Signed    — a valid signature is on file, with who signed and when
//   Expired   — they DID sign, but it lapsed past signatureValidForDays.
//               Different from never-signed: the conversation is "please
//               re-sign", not "please sign", and the member may reasonably
//               believe they already did.
//   Not signed
//
// Staff never sign on a member's behalf. A DocumentSignature carries a signer
// identity, IP and user agent; one created from this screen would be a forged
// audit record. The action here is Request, which is why the card links to the
// member rather than offering a signature control.

"use client";

import { useEffect, useState } from "react";
import { Check, Clock, FileText, ShieldAlert } from "lucide-react";
import type { DocumentStatus } from "@/lib/documents";

type DocRow = {
  id: string;
  title: string;
  type: string;
  requiredForOnboarding: boolean;
  requiresGuardianSignature: boolean;
  signatureValidForDays: number | null;
  status: DocumentStatus;
  expiresAt: string | null;
  signature: { signerName: string; relationship: string; signedAt: string } | null;
};

type Payload = {
  documents: DocRow[];
  summary: { total: number; signed: number; expired: number; missing: number; outstanding: number };
};

const fmt = (v: string) =>
  new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const STATUS: Record<DocumentStatus, { label: string; surface: string; text: string }> = {
  SIGNED: { label: "Signed", surface: "var(--color-success-surface)", text: "var(--color-success-text)" },
  EXPIRED: { label: "Expired", surface: "var(--color-warn-surface)", text: "var(--color-warn-text)" },
  MISSING: { label: "Not signed", surface: "var(--color-danger-surface)", text: "var(--color-danger-text)" },
};

export function MemberDocumentsCard({ memberId, className }: { memberId: string; className?: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/members/${memberId}/documents`)
      .then(async (r) => {
        if (r.status === 403) throw new Error("You don't have permission to view documents.");
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not load documents");
        return r.json();
      })
      .then((d: Payload) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Could not load documents"));
    return () => { cancelled = true; };
  }, [memberId]);

  const shell = `rounded-xl border border-app-border bg-surface p-5 ${className ?? ""}`;

  if (error) return <div className={shell}><p className="text-[13px] text-text-muted">{error}</p></div>;
  if (!data) return <div className={`${shell} h-40 animate-pulse`} />;

  const { documents, summary } = data;

  return (
    <div className={shell}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-text-primary">Documents</h3>
        {summary.outstanding > 0 ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium"
            style={{ background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            {summary.outstanding} required {summary.outstanding === 1 ? "document" : "documents"} outstanding
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium"
            style={{ background: "var(--color-success-surface)", color: "var(--color-success-text)" }}
          >
            <Check className="h-3.5 w-3.5" />
            Nothing outstanding
          </span>
        )}
      </div>

      {documents.length === 0 ? (
        <p className="text-[13px] text-text-muted">
          This club hasn&rsquo;t published any documents yet, so there is nothing for members to sign.
        </p>
      ) : (
        <>
          <p className="mb-3 text-[12px] text-text-muted">
            {summary.signed} signed · {summary.expired} expired · {summary.missing} not signed
          </p>
          <ul className="flex flex-col divide-y" style={{ borderColor: "var(--color-hairline)" }}>
            {documents.map((d) => {
              const s = STATUS[d.status];
              return (
                <li key={d.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                      <span className="text-[13.5px] font-medium text-text-primary">{d.title}</span>
                      {d.requiredForOnboarding && (
                        <span className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.05em]"
                          style={{ background: "var(--color-chip-surface)", color: "var(--color-chip-text)" }}>
                          Required
                        </span>
                      )}
                      {d.requiresGuardianSignature && (
                        <span className="text-[11px] text-text-muted">guardian must sign</span>
                      )}
                    </div>
                    <div className="mt-0.5 pl-5 text-[11.5px] text-text-muted">
                      {d.signature ? (
                        <>
                          Signed by {d.signature.signerName}
                          {d.signature.relationship === "GUARDIAN" && " (guardian)"} on {fmt(d.signature.signedAt)}
                          {d.expiresAt && (
                            <>
                              {" · "}
                              {d.status === "EXPIRED" ? "expired" : "valid until"} {fmt(d.expiresAt)}
                            </>
                          )}
                        </>
                      ) : d.requiredForOnboarding ? (
                        "Waiting on the member — never signed."
                      ) : (
                        "Not required for this member."
                      )}
                    </div>
                  </div>
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium"
                    style={{ background: s.surface, color: s.text }}
                  >
                    {d.status === "SIGNED" ? <Check className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                    {s.label}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-[11.5px] leading-relaxed text-text-muted">
            Staff can&rsquo;t sign on a member&rsquo;s behalf — a signature records who signed, from where, and when.
            Ask them to sign in the member portal under Documents.
          </p>
        </>
      )}
    </div>
  );
}
