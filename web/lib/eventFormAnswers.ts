// What each registrant answered on an event's signup form, and who an
// "Email registrants" send reaches. PURE: no prisma, no Date.now().
//
// Two stores hold answers, both keyed by the field id in
// Event.registrationForm:
//   EventRegistration.formResponses        one answer per registration
//   EventRegistrationEntry.answers         questions asked again per entry
// The form is the label source. A question the owner later deleted keeps its
// answers in the row, so those are shown too, under the id they were stored
// with, rather than silently dropped. Keys starting "__" are written by the
// server (private-link stamp, acknowledged documents) and are never answers.
//
// The rows come from the ONE Attendees ledger (lib/eventAttendees), so the
// answers view, its CSV and the email audience agree with the list on screen
// about who is registered and who was removed.

import { eventFormFields } from "@/lib/eventForm";
import { keyFromFieldId } from "@/lib/eventCategories";
import { matchesFilter, type AttendeeRow } from "@/lib/eventAttendees";
import type { ExportTable } from "@/lib/eventAttendeeExtras";

export type AnswerSource = {
  formResponses: Record<string, unknown> | null;
  entries: Array<{ label: string | null; answers: Record<string, unknown> | null }>;
};

export type AnswerColumn = { id: string; label: string; removedQuestion: boolean };

const isAnswerKey = (k: string) => !k.startsWith("__");

function text(v: unknown): string {
  if (v === true) return "Yes";
  if (v === false) return "No";
  if (v == null) return "";
  return String(v).trim();
}

/** The questions to show: the form's own, in the owner's order, then any
 *  answered key the form no longer has. */
export function answerColumns(registrationForm: unknown, sources: AnswerSource[]): AnswerColumn[] {
  const fields = eventFormFields(registrationForm);
  const cols: AnswerColumn[] = fields.map((f) => ({ id: f.id, label: f.label, removedQuestion: false }));
  const known = new Set<string>();
  for (const f of fields) {
    known.add(f.id);
    known.add(keyFromFieldId(f.id));
  }
  const extra = new Set<string>();
  for (const s of sources) {
    for (const bag of [s.formResponses, ...s.entries.map((e) => e.answers)]) {
      if (!bag) continue;
      for (const k of Object.keys(bag)) {
        if (isAnswerKey(k) && !known.has(k) && text(bag[k]) !== "") extra.add(k);
      }
    }
  }
  for (const k of [...extra].sort()) cols.push({ id: k, label: k, removedQuestion: true });
  return cols;
}

function pick(bag: Record<string, unknown> | null | undefined, id: string): string {
  if (!bag) return "";
  const direct = text(bag[id]);
  if (direct !== "") return direct;
  // Category questions are also stored under their short key.
  const alt = keyFromFieldId(id);
  return alt && alt !== id ? text(bag[alt]) : "";
}

/** One registrant's answer to one question. Per-entry answers are joined,
 *  each named by its entry when there is more than one. */
export function answerFor(source: AnswerSource | null | undefined, id: string): string {
  if (!source) return "";
  const own = pick(source.formResponses, id);
  const perEntry = source.entries
    .map((e) => ({ label: e.label, value: pick(e.answers, id) }))
    .filter((e) => e.value !== "");
  const parts: string[] = [];
  if (own !== "") parts.push(own);
  if (perEntry.length === 1 && own === "") parts.push(perEntry[0].value);
  else for (const e of perEntry) parts.push(e.label ? `${e.label}: ${e.value}` : e.value);
  return parts.join(" · ");
}

/** A checkbox the registrant left unticked is stored as nothing at all. For a
 *  checkbox question, show that as "No" so a column can be read top to bottom. */
export function answerCell(source: AnswerSource | null | undefined, col: AnswerColumn, registrationForm: unknown): string {
  const v = answerFor(source, col.id);
  if (v !== "" || !source) return v;
  const f = eventFormFields(registrationForm).find((x) => x.id === col.id);
  return f?.type === "checkbox" && !f.perEntry ? "No" : "";
}

/** Everyone's answers as a table: one row per registrant, one column per question. */
export function answersTable(
  rows: AttendeeRow[],
  sourceOf: (registrationId: string) => AnswerSource | null,
  registrationForm: unknown,
  opts: { statusText: (r: AttendeeRow) => string },
): ExportTable & { columns: AnswerColumn[] } {
  const live = rows.filter((r) => !r.removed && r.registrationId);
  const sources = live.map((r) => sourceOf(r.registrationId as string)).filter((s): s is AnswerSource => !!s);
  const columns = answerColumns(registrationForm, sources);
  return {
    columns,
    headers: ["Name", "Email", "Phone", "Status", ...columns.map((c) => (c.removedQuestion ? `${c.label} (removed question)` : c.label))],
    rows: live.map((r) => {
      const s = sourceOf(r.registrationId as string);
      return [r.name, r.email ?? "", r.phone ?? "", opts.statusText(r), ...columns.map((c) => answerCell(s, c, registrationForm))];
    }),
  };
}

// ── Email registrants ───────────────────────────────────────────────────────

export type RegistrantAudience = "paid" | "all";

export type RegistrantRecipient = {
  /** Lower-cased; one row per address however many athletes share it. */
  email: string;
  /** The athletes this address is registered for. */
  names: string[];
  memberId: string | null;
};

export type RegistrantRecipients = {
  send: RegistrantRecipient[];
  /** Registered, in the audience, but with no address to send to. */
  noEmail: string[];
  /** How many people the audience covers (before addresses are merged). */
  people: number;
};

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

/**
 * Who an event email goes to.
 *   all   everyone on the Attendees list who was not removed (a cancelled or
 *         declined registration and a cancelled booking are "removed")
 *   paid  of those, only the settled ones: paid, or covered by a membership
 *         or a free event
 * The address is the one the ledger resolved for the row: the family's
 * address for a member, the registration's own address for a guest with no
 * member profile. Each address appears once.
 */
export function registrantRecipients(rows: AttendeeRow[], audience: RegistrantAudience): RegistrantRecipients {
  const inAudience = rows.filter((r) => !r.removed && (audience === "all" || matchesFilter(r, "settled")));
  const byEmail = new Map<string, RegistrantRecipient>();
  const noEmail: string[] = [];
  for (const r of inAudience) {
    const email = (r.email ?? "").trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email)) {
      noEmail.push(r.name);
      continue;
    }
    const hit = byEmail.get(email);
    if (hit) {
      if (!hit.names.includes(r.name)) hit.names.push(r.name);
      if (!hit.memberId) hit.memberId = r.memberId;
    } else {
      byEmail.set(email, { email, names: [r.name], memberId: r.memberId });
    }
  }
  return { send: [...byEmail.values()], noEmail, people: inAudience.length };
}

/** A typed message as email blocks: each line the sender typed is its own paragraph. */
export function messageToBlocks(message: string): Array<{ type: "paragraph"; runs: Array<{ kind: "text"; text: string }> }> {
  return message
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ type: "paragraph" as const, runs: [{ kind: "text" as const, text: p }] }));
}
