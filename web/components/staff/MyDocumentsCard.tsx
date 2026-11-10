"use client";

// Phase 12.1 Part 4 — the documents I have to sign, on My account.
//
// Reuses the member flow's mechanics: the document body is the same sanitised
// rich text rendered through the same `.doc-prose` styles, and the signature is
// a typed name with the same optional drawn PNG from SignaturePad. What's
// different is only who the signature belongs to.
//
// The whole document is shown before anything can be signed. A signature on
// something nobody could read is not consent, so the Sign panel only opens
// underneath the text.
//
// Mobile: the list stacks, the document body scrolls inside its own panel.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, FileText, Loader2 } from "lucide-react";
import { SkeletonList } from "@/components/LoadingSkeleton";
import SignaturePad from "@/components/member/SignaturePad";

type Doc = {
  id: string;
  title: string;
  type: string;
  body: string | null;
  version: number;
  needsSignature: boolean;
  dueDate: string | null;
  signedAt: string | null;
  signedVersion: number | null;
  resignRequired: boolean;
};

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

export default function MyDocumentsCard() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [signerName, setSignerName] = useState("");
  const [outstanding, setOutstanding] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [drawn, setDrawn] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch("/api/me/documents", { cache: "no-store" });
      if (!r.ok) {
        setDocs([]);
        return;
      }
      const d = await r.json();
      setDocs(d.documents ?? []);
      setOutstanding(d.outstandingCount ?? 0);
      setSignerName(d.signerName ?? "");
    } catch {
      setDocs([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sign = async (documentId: string) => {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/me/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId,
          signerName: typed,
          signatureDataUrl: drawn,
          agreed: true,
        }),
      });
      const d = await r.json();
      if (!r.ok) setErr(d.error || d.message || "That couldn't be signed.");
      else {
        setDocs(d.documents ?? []);
        setOutstanding(d.outstandingCount ?? 0);
        setOpen(null);
        setTyped("");
        setDrawn(null);
        setAgreed(false);
      }
    } catch {
      setErr("That couldn't be signed.");
    } finally {
      setBusy(false);
    }
  };

  // Nothing assigned: say nothing. An empty card on everybody's account page
  // is noise.
  if (docs === null) return <SkeletonList rows={2} />;
  if (docs.length === 0) return null;

  return (
    <div className="rounded-xl border border-app-border bg-surface p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Documents</p>
        {outstanding > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-orange-accent/15 px-2 py-0.5 text-[12px] text-text-primary">
            <AlertTriangle className="h-3.5 w-3.5 text-orange-accent" strokeWidth={2} />
            {outstanding} waiting for your signature
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[12px] text-text-muted">
            <CheckCircle2 className="h-3.5 w-3.5 text-lime-accent" strokeWidth={2} /> All signed
          </span>
        )}
      </div>

      {err && <div className="mb-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}

      <ul className="space-y-2">
        {docs.map((d) => (
          <li key={d.id} className="rounded-lg border border-app-border">
            <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <FileText className="h-4 w-4 shrink-0 text-text-muted" strokeWidth={2} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text-primary">{d.title}</p>
                <p className="text-[12px] text-text-muted">
                  {d.needsSignature ? (
                    d.resignRequired ? (
                      <>
                        Updated since you signed it — version {d.version} needs your signature
                        {d.signedAt ? ` (you signed version ${d.signedVersion} on ${fmtStamp(d.signedAt)})` : ""}
                      </>
                    ) : (
                      <>Not signed yet{d.dueDate ? ` · due ${fmtDate(d.dueDate)}` : ""}</>
                    )
                  ) : (
                    <>Signed {d.signedAt ? fmtStamp(d.signedAt) : ""}</>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(open === d.id ? null : d.id);
                  setTyped(signerName);
                  setDrawn(null);
                  setAgreed(false);
                  setErr("");
                }}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs ${
                  d.needsSignature
                    ? "bg-charcoal text-white hover:bg-charcoal-hover"
                    : "border border-app-border text-text-primary hover:bg-app-bg"
                }`}
              >
                {open === d.id ? "Close" : d.needsSignature ? "Read and sign" : "Read it"}
              </button>
            </div>

            {open === d.id && (
              <div className="border-t border-app-border px-3 py-3">
                {/* The same sanitised rich text, through the same styles the
                    member documents use. */}
                <div
                  className="doc-prose max-h-80 overflow-y-auto rounded-lg border border-app-border bg-app-bg p-3 text-sm"
                  dangerouslySetInnerHTML={{ __html: d.body || "<p>This document has no content yet.</p>" }}
                />

                {d.needsSignature && (
                  <div className="mt-3 space-y-3">
                    <label className="block">
                      <span className="mb-1 block text-[12px] text-text-muted">Type your name to sign</span>
                      <input
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        className="w-full rounded-lg border border-app-border bg-surface px-3 py-2 font-serif italic text-sm"
                        placeholder={signerName || "Your full name"}
                      />
                    </label>
                    <div>
                      <span className="mb-1 block text-[12px] text-text-muted">
                        Or draw it (optional)
                      </span>
                      <SignaturePad onChange={setDrawn} />
                    </div>
                    <label className="flex items-start gap-2 text-[12px] text-text-primary">
                      <input
                        type="checkbox"
                        checked={agreed}
                        onChange={(e) => setAgreed(e.target.checked)}
                        className="mt-0.5"
                      />
                      <span>
                        I&apos;ve read this document and I agree to it. My name, the date, and my device details
                        are recorded with my signature.
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={() => sign(d.id)}
                      disabled={!agreed || typed.trim().length < 2 || busy}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-charcoal px-4 py-2 text-sm text-white hover:bg-charcoal-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {busy && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />}
                      Sign
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
