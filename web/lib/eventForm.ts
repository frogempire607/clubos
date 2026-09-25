// The questions an event asks at signup (Event.registrationForm) — one reader
// and one validator for every path that registers someone: the public link,
// the member portal, and anything added later.
//
// Before this, only the public route validated the form, and the portal route
// did not read it at all: a parent registering from the portal was never asked
// the weight class / division the coach needs (Titus Hall, Finger Lakes Duals,
// 2026-09-24). Both routes now call validateFormResponses.
//
// PURE — no prisma, no IO.

export type EventFormField = {
  id: string;
  label: string;
  type: string; // text | textarea | select | checkbox | email | phone
  required: boolean;
  options: string[];
};

/** The event's form as a clean list. Anything malformed is dropped, never thrown. */
export function eventFormFields(raw: unknown): EventFormField[] {
  if (!Array.isArray(raw)) return [];
  const out: EventFormField[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const r = f as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) continue;
    out.push({
      id: r.id,
      label: typeof r.label === "string" && r.label.trim() ? r.label : r.id,
      type: typeof r.type === "string" ? r.type : "text",
      required: r.required === true,
      options: Array.isArray(r.options) ? r.options.filter((o): o is string => typeof o === "string") : [],
    });
  }
  return out;
}

export type FormAnswers = Record<string, string | boolean>;

export type FormCheck =
  | { ok: true; answers: FormAnswers }
  | { ok: false; fieldId: string; message: string };

/**
 * Required fields answered, select answers taken from the field's own options,
 * and only the event's own questions kept (a client cannot write arbitrary
 * keys into formResponses — `__documentsAcknowledged` and friends are
 * server-written). Strings are trimmed.
 */
export function validateFormResponses(fields: EventFormField[], raw: unknown): FormCheck {
  const given: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const answers: FormAnswers = {};
  for (const f of fields) {
    let v = given[f.id];
    if (typeof v === "string") v = v.trim();
    if (f.type === "checkbox") {
      const on = v === true || v === "true";
      if (f.required && !on) return { ok: false, fieldId: f.id, message: `"${f.label}" is required` };
      if (on) answers[f.id] = true;
      continue;
    }
    if (v === undefined || v === null || v === "" || typeof v !== "string") {
      if (f.required) return { ok: false, fieldId: f.id, message: `"${f.label}" is required` };
      continue;
    }
    if (f.type === "select" && f.options.length > 0 && !f.options.includes(v)) {
      return { ok: false, fieldId: f.id, message: `Choose one of the listed options for "${f.label}"` };
    }
    answers[f.id] = v.slice(0, 2000);
  }
  return { ok: true, answers };
}
