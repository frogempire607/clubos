// What an entrant picks when they sign up — and what a coach can propose
// changing (plan.md §5.4.6).
//
// AthletixOS is sold to any youth sports organisation. A wrestling club calls
// this a weight class, a judo club a belt and a weight, a soccer club a
// position, a swim club an age group and an event. There is no set of three
// slots that fits all of them, so nothing here is named after a sport: the
// club supplies the words, the code supplies the plumbing.
//
// ── Where the definitions live (no new columns) ─────────────────────────────
//
//   PER EVENT   `Event.registrationForm` — already the list of questions this
//               event asks, already rendered on the signup page, validated
//               server-side, stored into `formResponses` and shown on the
//               roster. Category fields are ordinary entries in it, marked by
//               a reserved id. Multiple categories are multiple entries, so
//               "how many" is a data question, not a schema one.
//
//   PER TYPE    `ClubEventType.defaultPolicy.categoryFields` — the club's
//               defaults for that type, seeded into a new event's form. Same
//               JSON blob the tournament-workflow defaults already use.
//
// The reserved id is `participant_category` for the first field (which is what
// the single-category events created before this shipped already carry) and
// `participant_category:<key>` for the rest. That is what makes this backward
// compatible without touching a row.
//
// PURE — no prisma, no IO.

export const PARTICIPANT_FIELD_ID = "participant_category";
const CATEGORY_ID_PREFIX = `${PARTICIPANT_FIELD_ID}:`;

/** One thing an entrant chooses. `options` empty = free text. */
export type CategoryField = {
  /** Stable key used in formResponses and in a proposal's `changes`. */
  key: string;
  /** The club's own word for it. Never assumed, never defaulted to a sport. */
  label: string;
  options: string[];
  required?: boolean;
};

/**
 * Starting points offered in the editor, so a club that thinks in one of the
 * common vocabularies doesn't have to type it — and any club that doesn't can
 * ignore the list entirely and write their own.
 *
 * This is the ONE file where sport-specific words are legitimate: they are
 * choices being offered to an owner, not copy being shown to a parent. The
 * vocabulary guard (scripts/sport-terms-guard.ts) scans rendered UI and
 * deliberately does not scan lib/ for that reason.
 */
export const CATEGORY_PRESETS: { key: string; label: string; hint: string }[] = [
  { key: "weightClass", label: "Weight Class", hint: "wrestling, judo, boxing, MMA" },
  { key: "division", label: "Division", hint: "most sports" },
  { key: "ageGroup", label: "Age Group", hint: "swimming, track, gymnastics" },
  { key: "position", label: "Position", hint: "soccer, football, hockey" },
  { key: "beltLevel", label: "Belt Level", hint: "judo, BJJ, karate" },
  { key: "bracket", label: "Bracket", hint: "tennis, chess, any seeded draw" },
];

/** The neutral default for the optional "one more entry" toggle on a proposal. */
export const DEFAULT_EXTRA_ENTRY_LABEL = "Add another entry";

/** Keys a proposal may carry that are not category fields. */
export const STRUCTURAL_CHANGE_KEYS = ["session", "extraEntry"] as const;

/**
 * Keys older proposals used, before categories were configurable. Nothing in
 * production carries them (checked 2026-08-12: zero live proposals), but a row
 * written by an in-flight branch would otherwise render as a bare key.
 */
export const LEGACY_CHANGE_LABELS: Record<string, string> = {
  weightClass: "Weight class",
  division: "Division",
  addAnotherDual: "Additional entry",
  freeText: "Note",
};

type FormFieldLike = {
  id?: unknown;
  label?: unknown;
  type?: unknown;
  required?: unknown;
  options?: unknown;
};

function isCategoryId(id: unknown): id is string {
  return typeof id === "string" && (id === PARTICIPANT_FIELD_ID || id.startsWith(CATEGORY_ID_PREFIX));
}

/** `participant_category:beltLevel` → `beltLevel`; the bare id → `category`. */
export function keyFromFieldId(id: string): string {
  return id === PARTICIPANT_FIELD_ID ? "category" : id.slice(CATEGORY_ID_PREFIX.length);
}

/** `beltLevel` → `participant_category:beltLevel`; `category` → the bare id. */
export function fieldIdForKey(key: string): string {
  return key === "category" ? PARTICIPANT_FIELD_ID : `${CATEGORY_ID_PREFIX}${key}`;
}

function cleanOptions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((o) => String(o).trim()).filter(Boolean);
}

/** The category fields an event actually asks, in the order the owner set. */
export function categoryFieldsFromForm(registrationForm: unknown): CategoryField[] {
  if (!Array.isArray(registrationForm)) return [];
  const out: CategoryField[] = [];
  for (const raw of registrationForm as FormFieldLike[]) {
    if (!isCategoryId(raw?.id)) continue;
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (!label) continue;
    out.push({
      key: keyFromFieldId(raw.id as string),
      label,
      options: cleanOptions(raw.options),
      required: raw.required === true,
    });
  }
  return out;
}

/** The per-type defaults, validated the same way the rest of defaultPolicy is. */
export function categoryFieldsFromPolicy(raw: unknown): CategoryField[] {
  if (!Array.isArray(raw)) return [];
  const out: CategoryField[] = [];
  for (const f of raw as FormFieldLike[]) {
    const label = typeof f?.label === "string" ? f.label.trim() : "";
    const key = typeof f?.id === "string" ? f.id : typeof (f as { key?: unknown })?.key === "string" ? String((f as { key: string }).key) : "";
    if (!label || !key) continue;
    out.push({ key, label, options: cleanOptions(f.options), required: f.required === true });
  }
  return out;
}

/**
 * What this event's coach may propose changing.
 *
 * The event's own form wins: it is what the registrant actually answered, and
 * proposing a change to a question nobody was asked is meaningless. The type
 * default is the fallback for an event whose form has no category fields yet.
 */
export function resolveCategoryFields(
  event: { registrationForm?: unknown },
  policy?: { categoryFields?: unknown } | null,
): CategoryField[] {
  const fromForm = categoryFieldsFromForm(event?.registrationForm);
  if (fromForm.length > 0) return fromForm;
  return categoryFieldsFromPolicy(policy?.categoryFields);
}

/** The club's word for "one more of these", or the neutral default. */
export function resolveExtraEntryLabel(policy?: { extraEntryLabel?: unknown } | null): string {
  const raw = policy?.extraEntryLabel;
  return typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_EXTRA_ENTRY_LABEL;
}

/**
 * Every key a proposal on this event may carry. Replaces the fixed
 * `weightClass | division | session | addAnotherDual | freeText` allowlist:
 * an unknown key is still a 400, it is just no longer decided in advance by
 * whichever sport the code was written for.
 */
export function proposableKeys(fields: CategoryField[]): string[] {
  return [...fields.map((f) => f.key), ...STRUCTURAL_CHANGE_KEYS];
}

/**
 * The example text under "Note to the parent", written in the club's own
 * vocabulary rather than in wrestling.
 *
 * Derived rather than configured on purpose: a per-type placeholder string is a
 * setting nobody would ever curate, and deriving it means a club that renames
 * "Weight Class" to "Bracket" gets consistent copy without touching anything.
 */
export function proposalNotePlaceholder(fields: CategoryField[]): string {
  const first = fields[0];
  if (!first) return "e.g. why you're suggesting this — the parent sees it word for word.";
  const [a, b] = first.options;
  if (a && b) {
    return `e.g. ${a} is full — ${b} is a better fit and they'd get more time on the field.`;
  }
  return `e.g. why this ${first.label.toLowerCase()} suits them better — the parent sees it word for word.`;
}

/** Label for a key inside a stored proposal, for surfaces without the event. */
export function labelForChangeKey(
  key: string,
  labels?: Record<string, string> | null,
  extraEntryLabel?: string,
): string {
  if (labels && typeof labels[key] === "string" && labels[key].trim()) return labels[key];
  if (key === "session") return "Session";
  if (key === "extraEntry") return extraEntryLabel || DEFAULT_EXTRA_ENTRY_LABEL;
  return LEGACY_CHANGE_LABELS[key] ?? key;
}
