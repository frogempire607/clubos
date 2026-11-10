// Phase 12.1 — a PDF copy of a completed Form W-9.
//
// The IRS allows an electronic substitute for Form W-9 provided the system can
// produce a hard copy on request and the certification is presented as the
// paper form presents it. This renders that copy.
//
// It is a SUBSTITUTE, clearly labelled as one — not a facsimile of the IRS
// form, which would be misleading. It carries every field the form collects,
// the full certification text as it was shown and agreed to, and the
// electronic-signature details (who, when, from where).
//
// jspdf is already a dependency and already used server-side by
// lib/exporters.ts buildPdf, so this adds nothing to the bundle.
//
// ⚠️  THE RENDERED PDF CONTAINS A TAX ID IN THE CLEAR, because a W-9 does.
//     Callers reach it only through lib/contractorTin.ts, which audits the
//     decryption first, and the bytes are stored behind the club-scoped
//     /api/files/[id] gate. Nothing here logs.

import { jsPDF } from "jspdf";
import { taxClassificationLabel } from "@/lib/tin";

export type W9PdfInput = {
  legalName: string;
  businessName: string | null;
  taxClassification: string;
  classificationNote: string | null;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  taxIdKind: "SSN" | "EIN";
  /// Already formatted — "123-45-6789" or "12-3456789".
  taxIdFormatted: string;
  certificationText: string;
  signedName: string;
  signedAt: Date;
  ipAddress: string | null;
};

const MARGIN = 54; // 0.75in at 72dpi
const WIDTH = 612; // US Letter portrait
const BODY_WIDTH = WIDTH - MARGIN * 2;

export function renderW9Pdf(input: W9PdfInput): Buffer {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
  let y = MARGIN;

  const line = (text: string, size = 10, bold = false, gap = 14) => {
    doc.setFontSize(size);
    doc.setFont("helvetica", bold ? "bold" : "normal");
    for (const l of doc.splitTextToSize(text, BODY_WIDTH) as string[]) {
      if (y > 720) {
        doc.addPage();
        y = MARGIN;
      }
      doc.text(l, MARGIN, y);
      y += gap;
    }
  };
  const field = (label: string, value: string) => {
    doc.setFontSize(8);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(110);
    doc.text(label.toUpperCase(), MARGIN, y);
    doc.setTextColor(0);
    doc.setFontSize(11);
    doc.text(value || "—", MARGIN, y + 13);
    y += 30;
  };
  const rule = () => {
    doc.setDrawColor(210);
    doc.line(MARGIN, y, WIDTH - MARGIN, y);
    y += 16;
  };

  line("Substitute Form W-9", 17, true, 22);
  line("Request for Taxpayer Identification Number and Certification", 10.5, false, 16);
  doc.setTextColor(110);
  line(
    "Completed and signed electronically in AthletixOS. This is a substitute for IRS Form W-9, not a copy of the IRS form.",
    8.5,
    false,
    11,
  );
  doc.setTextColor(0);
  y += 6;
  rule();

  field("1 · Name (as shown on your income tax return)", input.legalName);
  field("2 · Business name / disregarded entity name", input.businessName || "—");
  field(
    "3 · Federal tax classification",
    input.classificationNote
      ? `${taxClassificationLabel(input.taxClassification)} — ${input.classificationNote}`
      : taxClassificationLabel(input.taxClassification),
  );
  field("5 · Address", input.streetAddress);
  field("6 · City, state and ZIP code", `${input.city}, ${input.state} ${input.zipCode}`);
  rule();

  line("Part I · Taxpayer Identification Number", 12, true, 18);
  field(
    input.taxIdKind === "EIN" ? "Employer identification number" : "Social security number",
    input.taxIdFormatted,
  );
  rule();

  line("Part II · Certification", 12, true, 18);
  // The SNAPSHOTTED text — what this person actually agreed to, which is not
  // necessarily what the app shows today.
  line(input.certificationText, 9, false, 12);
  y += 8;
  rule();

  line("Electronic signature", 12, true, 18);
  doc.setFontSize(8);
  doc.setTextColor(110);
  doc.text("SIGNATURE OF U.S. PERSON", MARGIN, y);
  doc.setTextColor(0);
  // The typed signature, set apart so it reads as a signature rather than as
  // another data field.
  doc.setFont("times", "italic");
  doc.setFontSize(18);
  doc.text(input.signedName, MARGIN, y + 22);
  doc.setFont("helvetica", "normal");
  y += 36;
  doc.setDrawColor(60);
  doc.line(MARGIN, y, MARGIN + 260, y);
  y += 20;

  const stamp = input.signedAt.toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  });
  field("Date signed", `${stamp} UTC`);
  if (input.ipAddress) field("Signed from IP address", input.ipAddress);

  doc.setFontSize(8);
  doc.setTextColor(110);
  const footer = doc.splitTextToSize(
    "Typing a name and submitting this form constitutes an electronic signature with the same legal effect as a handwritten one. A copy is retained and available on request.",
    BODY_WIDTH,
  ) as string[];
  for (const l of footer) {
    doc.text(l, MARGIN, y);
    y += 11;
  }

  return Buffer.from(doc.output("arraybuffer"));
}
