"use client";

// Phase 12.1 Part 3 — the W-9, in two modes.
//
//   mode="self"  on My account: the person fills in and SIGNS their own form.
//   mode="owner" on the staff record: status, the masked tax ID, the PDF, and
//                "ask for a new one".
//
// ── WHY AN OWNER CANNOT FILL THIS IN ────────────────────────────────────────
// Part II of a W-9 is a certification made under penalties of perjury. An owner
// completing it on somebody's behalf would be forging that certification, so
// the form only renders in self mode and the API refuses anyone else. An owner
// holding a signed paper W-9 attaches it to the staff member's documents
// instead, which is what that path is for.
//
// ── THE TAX ID ──────────────────────────────────────────────────────────────
// This component never receives one. It shows the mask, which comes from the
// stored plaintext last four — so looking at this screen is not a decryption.
// "Show the full number" is an explicit, audited, owner-only POST, and what it
// returns is held in local state and never persisted or logged.
//
// Mobile: fields stack, the history table scrolls.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Eye, FileText, Loader2, RefreshCw } from "lucide-react";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { normalizeTin, suggestsEin, taxClassificationLabel, validateW9 } from "@/lib/tin";

type Classification = { key: string; label: string };
type HistoryRow = {
  id: string;
  legalName: string;
  businessName: string | null;
  taxClassification: string;
  taxIdKind: string;
  maskedTin: string;
  signedName: string;
  signedAt: string;
  supersededAt: string | null;
  fileUrl: string | null;
};
type Payload = {
  workerType?: string | null;
  workerTypeLabel?: string;
  workerTypeDescription?: string;
  classificationNote?: string;
  contractor:
    | {
        id: string;
        name: string;
        w9Status: string;
        hasW9: boolean;
        maskedTin: string;
        w9Url: string | null;
        w9RequestedAt: string | null;
        streetAddress: string | null;
        city: string | null;
        state: string | null;
        zipCode: string | null;
      }
    | null;
  history: HistoryRow[];
  form: {
    classifications: readonly Classification[];
    certificationText: string;
    esignNotice: string;
    canCollectTaxId: boolean;
  };
  signerName?: string | null;
};

const fmtStamp = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

const inputCls = "w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-sm";

export default function W9Card({
  mode,
  contractorId,
  staffName,
}: {
  mode: "self" | "owner";
  /// Owner mode only: whose W-9 this is.
  contractorId?: string;
  staffName?: string;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);

  const endpoint = mode === "self" ? "/api/me/worker" : `/api/contractors/${contractorId}/w9`;

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch(endpoint, { cache: "no-store" });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setErr(d?.error || "Couldn't load the W-9.");
        setData(null);
      } else {
        const d = await r.json();
        // The owner endpoint nests the contractor differently; normalise.
        setData(mode === "self" ? d : { ...d, contractor: d.contractor, history: d.history, form: d.form });
      }
    } catch {
      setErr("Couldn't load the W-9.");
    } finally {
      setLoading(false);
    }
  }, [endpoint, mode]);

  useEffect(() => {
    void load();
  }, [load]);

  const current = data?.history.find((h) => !h.supersededAt) ?? null;

  if (loading) return <SkeletonList rows={4} />;
  if (err) return <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>;
  if (!data) return null;

  // Nothing to show when this person isn't a contractor.
  if (!data.contractor) {
    if (mode === "owner") return null;
    return (
      <div className="rounded-xl border border-app-border bg-surface p-5">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-text-muted">Tax forms</p>
        <p className="text-sm text-text-primary">
          {data.workerType === "EMPLOYEE"
            ? "You're set up as an employee, so there's no W-9 to complete — your pay goes through payroll."
            : "Nothing to complete. If you work as a contractor, ask the club to set that on your staff record and a W-9 will appear here."}
        </p>
        {data.workerTypeDescription && (
          <p className="mt-1 text-[12px] text-text-muted">{data.workerTypeDescription}</p>
        )}
      </div>
    );
  }

  const c = data.contractor;
  const needsW9 = c.w9Status !== "SUBMITTED";

  return (
    <div className="rounded-xl border border-app-border bg-surface p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            {mode === "self" ? "Your W-9" : `W-9 — ${staffName ?? c.name}`}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-text-primary">
            {c.w9Status === "SUBMITTED" ? (
              <>
                <CheckCircle2 className="h-4 w-4 text-lime-accent" strokeWidth={2} /> Submitted
                {current && <span className="text-text-muted">· signed {fmtStamp(current.signedAt)}</span>}
              </>
            ) : (
              <>
                <AlertTriangle className="h-4 w-4 text-orange-accent" strokeWidth={2} /> Not started
                {c.w9RequestedAt && (
                  <span className="text-text-muted">· requested {fmtStamp(c.w9RequestedAt)}</span>
                )}
              </>
            )}
          </p>
          {c.hasW9 && (
            <p className="mt-1 text-[12px] text-text-muted">
              Tax ID {c.maskedTin}
              {revealed && <span className="ml-2 font-medium text-text-primary">{revealed}</span>}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {c.w9Url && (
            <a
              href={c.w9Url}
              className="inline-flex items-center gap-1 rounded-lg border border-app-border px-3 py-1.5 text-xs text-text-primary hover:bg-app-bg"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={2} /> PDF
            </a>
          )}
          {mode === "owner" && c.hasW9 && !revealed && (
            <button
              type="button"
              onClick={async () => {
                setBusy("reveal");
                setErr("");
                try {
                  const r = await fetch(`/api/contractors/${c.id}/w9/reveal`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({}),
                  });
                  const d = await r.json();
                  if (!r.ok) setErr(d.error || "Couldn't show the tax ID.");
                  else setRevealed(d.tin);
                } catch {
                  setErr("Couldn't show the tax ID.");
                } finally {
                  setBusy("");
                }
              }}
              disabled={busy !== ""}
              className="inline-flex items-center gap-1 rounded-lg border border-app-border px-3 py-1.5 text-xs text-text-primary hover:bg-app-bg disabled:opacity-50"
              title="Shows the full number once. Every time anybody does this it is recorded in the audit trail."
            >
              {busy === "reveal" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              ) : (
                <Eye className="h-3.5 w-3.5" strokeWidth={2} />
              )}
              Show full number
            </button>
          )}
          {mode === "owner" && c.w9Status === "SUBMITTED" && (
            <button
              type="button"
              onClick={async () => {
                setBusy("request");
                setErr("");
                try {
                  const r = await fetch(`/api/contractors/${c.id}/w9`, { method: "PATCH" });
                  if (!r.ok) {
                    const d = await r.json().catch(() => null);
                    setErr(d?.error || "Couldn't request a new W-9.");
                  } else await load();
                } catch {
                  setErr("Couldn't request a new W-9.");
                } finally {
                  setBusy("");
                }
              }}
              disabled={busy !== ""}
              className="inline-flex items-center gap-1 rounded-lg border border-app-border px-3 py-1.5 text-xs text-text-primary hover:bg-app-bg disabled:opacity-50"
            >
              {busy === "request" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} />
              )}
              Ask for a new one
            </button>
          )}
          {mode === "self" && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="rounded-lg bg-charcoal px-3 py-1.5 text-xs text-white hover:bg-charcoal-hover"
            >
              {open ? "Close" : needsW9 ? "Complete your W-9" : "Submit a new W-9"}
            </button>
          )}
        </div>
      </div>

      {revealed && (
        <p className="mb-3 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-[12px] text-text-muted">
          Shown once, and recorded in the audit trail with your name and the time. Close this page when
          you&apos;re done — it isn&apos;t stored anywhere in your browser.
        </p>
      )}

      {mode === "owner" && !c.hasW9 && (
        <p className="mb-3 text-[12px] text-text-muted">
          Only {staffName ?? c.name} can fill this in — a W-9 is certified under penalties of perjury, so it
          has to be signed by the person it&apos;s for. They&apos;ll find it on their My account page.
          {" "}If you already hold a signed paper copy, attach it to their staff documents instead.
        </p>
      )}

      {mode === "self" && open && (
        <W9Form
          data={data}
          contractorId={c.id}
          onDone={async () => {
            setOpen(false);
            await load();
          }}
        />
      )}

      {data.history.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-lg border border-app-border">
          <table className="w-full min-w-[32rem] text-[12px]">
            <thead className="bg-app-bg uppercase tracking-wide text-text-muted">
              <tr>
                <th className="px-3 py-2 text-left">Signed</th>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Classification</th>
                <th className="px-3 py-2 text-left">Tax ID</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.history.map((h) => (
                <tr key={h.id} className="border-t border-app-border">
                  <td className="whitespace-nowrap px-3 py-2 text-text-muted">{fmtStamp(h.signedAt)}</td>
                  <td className="px-3 py-2 text-text-primary">
                    {h.legalName}
                    {h.businessName && <span className="block text-text-muted">{h.businessName}</span>}
                  </td>
                  <td className="px-3 py-2 text-text-muted">{taxClassificationLabel(h.taxClassification)}</td>
                  <td className="px-3 py-2 tabular-nums text-text-muted">{h.maskedTin}</td>
                  <td className="px-3 py-2 text-text-muted">
                    {h.supersededAt ? `Replaced ${fmtStamp(h.supersededAt)}` : "Current"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {h.fileUrl && (
                      <a href={h.fileUrl} className="inline-flex items-center gap-1 text-brand hover:underline">
                        <FileText className="h-3 w-3" strokeWidth={2} /> PDF
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── The form ────────────────────────────────────────────────────────────────

function W9Form({
  data,
  contractorId,
  onDone,
}: {
  data: Payload;
  contractorId: string;
  onDone: () => void | Promise<void>;
}) {
  const c = data.contractor!;
  const [legalName, setLegalName] = useState(data.signerName ?? "");
  const [businessName, setBusinessName] = useState("");
  const [taxClassification, setTaxClassification] = useState("INDIVIDUAL");
  const [classificationNote, setClassificationNote] = useState("");
  const [streetAddress, setStreetAddress] = useState(c.streetAddress ?? "");
  const [city, setCity] = useState(c.city ?? "");
  const [state, setState] = useState(c.state ?? "");
  const [zipCode, setZipCode] = useState(c.zipCode ?? "");
  const [taxIdKind, setTaxIdKind] = useState<"SSN" | "EIN">("SSN");
  const [taxId, setTaxId] = useState("");
  const [signedName, setSignedName] = useState("");
  const [certified, setCertified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // The classification suggests which number is usual — a hint, never a
  // restriction: a sole proprietor may legitimately use either, and the IRS
  // instructions say so.
  useEffect(() => {
    setTaxIdKind(suggestsEin(taxClassification) ? "EIN" : "SSN");
  }, [taxClassification]);

  const problems = useMemo(
    () =>
      validateW9({
        legalName,
        businessName,
        taxClassification,
        classificationNote,
        streetAddress,
        city,
        state,
        zipCode,
        taxIdKind,
        taxId,
        signedName,
      }),
    [legalName, businessName, taxClassification, classificationNote, streetAddress, city, state, zipCode, taxIdKind, taxId, signedName],
  );
  const ready = problems.length === 0 && certified && data.form.canCollectTaxId;

  if (!data.form.canCollectTaxId) {
    return (
      <div className="rounded-lg border border-orange-accent/40 bg-orange-accent/5 px-3 py-2 text-[12px] text-text-primary">
        <strong>This club can&apos;t accept tax IDs yet.</strong> AthletixOS encrypts them before storing them,
        and this installation has no encryption key set up — so rather than hold your Social Security number
        unprotected, the form is closed. Ask the club owner to set it up, then come back.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-app-border bg-app-bg p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[12px] text-text-muted">
            1 · Name, as shown on your income tax return
          </span>
          <input value={legalName} onChange={(e) => setLegalName(e.target.value)} className={inputCls} />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[12px] text-text-muted">
            2 · Business name, if different (optional)
          </span>
          <input value={businessName} onChange={(e) => setBusinessName(e.target.value)} className={inputCls} />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[12px] text-text-muted">3 · Federal tax classification</span>
          <select
            value={taxClassification}
            onChange={(e) => setTaxClassification(e.target.value)}
            className={inputCls}
          >
            {data.form.classifications.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        {taxClassification === "OTHER" && (
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-[12px] text-text-muted">Describe your classification</span>
            <input
              value={classificationNote}
              onChange={(e) => setClassificationNote(e.target.value)}
              className={inputCls}
            />
          </label>
        )}
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-[12px] text-text-muted">5 · Address</span>
          <input value={streetAddress} onChange={(e) => setStreetAddress(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-muted">6 · City</span>
          <input value={city} onChange={(e) => setCity(e.target.value)} className={inputCls} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-muted">State and ZIP</span>
          <div className="flex gap-2">
            <input
              value={state}
              onChange={(e) => setState(e.target.value)}
              className={inputCls}
              placeholder="OH"
              maxLength={40}
            />
            <input
              value={zipCode}
              onChange={(e) => setZipCode(e.target.value)}
              className={inputCls}
              placeholder="45402"
              inputMode="numeric"
            />
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-[12px] text-text-muted">Part I · Which number is this?</span>
          <select
            value={taxIdKind}
            onChange={(e) => setTaxIdKind(e.target.value as "SSN" | "EIN")}
            className={inputCls}
          >
            <option value="SSN">Social Security number</option>
            <option value="EIN">Employer Identification Number</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-text-muted">
            {taxIdKind === "SSN" ? "Social Security number" : "Employer Identification Number"}
          </span>
          <input
            value={taxId}
            onChange={(e) => setTaxId(e.target.value)}
            className={`${inputCls} tabular-nums`}
            placeholder={taxIdKind === "SSN" ? "123-45-6789" : "12-3456789"}
            inputMode="numeric"
            // Never offered back by the browser, and never stored by it.
            autoComplete="off"
            spellCheck={false}
          />
          <span className="mt-1 block text-[12px] text-text-muted">
            Encrypted before it&apos;s stored. Only the last four digits are ever shown afterwards, including
            to the club.
          </span>
        </label>
      </div>

      <div className="rounded-lg border border-app-border bg-surface p-3">
        <p className="mb-1 text-[12px] font-semibold uppercase tracking-wider text-text-muted">
          Part II · Certification
        </p>
        <p className="whitespace-pre-line text-[12px] text-text-primary">{data.form.certificationText}</p>
        <label className="mt-3 flex items-start gap-2 text-[12px] text-text-primary">
          <input
            type="checkbox"
            checked={certified}
            onChange={(e) => setCertified(e.target.checked)}
            className="mt-0.5"
          />
          <span>I certify that the above is true and correct.</span>
        </label>
        <label className="mt-3 block">
          <span className="mb-1 block text-[12px] text-text-muted">Type your name to sign</span>
          <input
            value={signedName}
            onChange={(e) => setSignedName(e.target.value)}
            className={`${inputCls} font-serif italic`}
            placeholder={legalName || "Your full name"}
          />
        </label>
        <p className="mt-1 text-[12px] text-text-muted">{data.form.esignNotice}</p>
      </div>

      {/* Problems are shown, but only once something has been typed — a form
          that scolds you before you start is worse than one that waits. */}
      {problems.length > 0 && (legalName || taxId || signedName) && (
        <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-text-muted">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {err && <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>}

      <button
        type="button"
        disabled={!ready || busy}
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            const r = await fetch(`/api/contractors/${contractorId}/w9`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                legalName,
                businessName: businessName || null,
                taxClassification,
                classificationNote: classificationNote || null,
                streetAddress,
                city,
                state,
                // Digits only on the wire; the server normalises again.
                zipCode,
                taxIdKind,
                taxId: normalizeTin(taxId),
                signedName,
                certified: true,
              }),
            });
            const d = await r.json();
            if (!r.ok) setErr(d.error || d.message || "That couldn't be submitted.");
            else {
              // Clear the number from component state the moment it is saved.
              setTaxId("");
              await onDone();
            }
          } catch {
            setErr("That couldn't be submitted.");
          } finally {
            setBusy(false);
          }
        }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-charcoal px-4 py-2 text-sm text-white hover:bg-charcoal-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />}
        Sign and submit
      </button>
    </div>
  );
}
