// One place that turns a ZodError into a sentence a club owner can act on.
//
// Every API route used to do this:
//
//   if (err instanceof z.ZodError)
//     return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
//
// which surfaces Zod's raw validator text with the field PATH thrown away. A
// bulk email send that failed on an empty recipient list told the owner
// "Array must contain at least 1 element(s)" — and since that payload carries
// two arrays (memberIds and email.blocks), the message could not even say
// which one was wrong. 116 routes shared that line.
//
// Zod's default strings are written for developers reading a stack trace:
// "String must contain at least 1 character(s)", "Expected string, received
// number", "Required". This module keeps the diagnosis and rewrites the
// prose, always naming the field.
//
// PURE — no Next, no prisma. Tests: scripts/zod-errors-tests.ts.
import { z } from "zod";

const ACRONYMS: Record<string, string> = { id: "ID", ids: "IDs", url: "URL", urls: "URLs", sms: "SMS", api: "API" };

/**
 * "previewText" → "Preview text", "email.blocks" → "Email blocks",
 * ["members", 3, "email"] → "Members item 4 email".
 *
 * Numeric segments are array indices; they are rendered 1-based because the
 * reader is looking at a list in a UI, not at a zero-indexed array.
 */
export function humanizeFieldPath(path: (string | number)[]): string {
  if (!path.length) return "This request";

  const words: string[] = [];
  for (const seg of path) {
    if (typeof seg === "number") {
      words.push("item", String(seg + 1));
      continue;
    }
    // camelCase / PascalCase → separate words, preserving known acronyms.
    for (const raw of seg.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/)) {
      if (!raw) continue;
      words.push(ACRONYMS[raw.toLowerCase()] ?? raw.toLowerCase());
    }
  }

  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

const list = (values: readonly (string | number)[]) => values.map(String).join(", ");

/** One issue → one sentence, always naming the field. */
function describeIssue(issue: z.ZodIssue): string {
  const field = humanizeFieldPath(issue.path);

  switch (issue.code) {
    case "invalid_type":
      // A missing key and a wrong type are different problems to the reader.
      if (issue.received === "undefined" || issue.received === "null") return `${field} is required.`;
      return `${field} must be a ${issue.expected}, but a ${issue.received} was sent.`;

    case "too_small": {
      const min = Number(issue.minimum);
      if (issue.type === "array") {
        return min === 1
          ? `${field} needs at least one item.`
          : `${field} needs at least ${min} items.`;
      }
      // A min(1) string is an empty box, not a length problem.
      if (issue.type === "string") {
        return min === 1 ? `${field} is required.` : `${field} must be at least ${min} characters.`;
      }
      return `${field} must be at least ${min}.`;
    }

    case "too_big": {
      const max = Number(issue.maximum);
      if (issue.type === "array") return `${field} allows at most ${max} items.`;
      if (issue.type === "string") return `${field} must be ${max} characters or fewer.`;
      return `${field} must be ${max} or less.`;
    }

    case "invalid_string":
      if (issue.validation === "email") return `${field} must be a valid email address.`;
      if (issue.validation === "url") return `${field} must be a valid URL.`;
      return `${field} is not in the expected format.`;

    case "invalid_enum_value":
      return `${field} must be one of: ${list(issue.options)}.`;

    case "unrecognized_keys":
      return `${field} contains unexpected field${issue.keys.length === 1 ? "" : "s"}: ${list(issue.keys)}.`;

    case "invalid_union":
      return `${field} is not in any of the accepted formats.`;

    default: {
      // Anything Zod adds later still names its field and ends as a sentence.
      const raw = issue.message?.trim();
      if (!raw) return `${field} is invalid.`;
      return /[.!?]$/.test(raw) ? `${field}: ${raw}` : `${field}: ${raw}.`;
    }
  }
}

/**
 * The message to hand back to the client. Reports the FIRST issue: a form
 * fixes one field at a time, and a wall of validator output is not more
 * actionable than the first thing to correct.
 */
export function formatZodError(err: z.ZodError): string {
  const issue = err.errors[0];
  if (!issue) return "The request could not be validated.";
  return describeIssue(issue);
}

/** Every issue, for logs or a route that genuinely wants the full list. */
export function formatZodIssues(err: z.ZodError): string[] {
  return err.errors.map(describeIssue);
}
