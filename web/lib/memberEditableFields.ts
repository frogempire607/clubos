// The single list of what a staffer may edit on a member — session 4, D-4.
//
// Julian: "I need to edit everything about a member except birthday and
// password." The edit drawer shipped with seven fields (name ×2, email, phone,
// guardian ×3) while `MemberModal` rendered the full set, so which surface you
// happened to open decided what you were allowed to fix. `PATCH
// /api/members/[id]` already accepted every field — it was purely a UI gap.
//
// The fix is not "add ten more inputs to the drawer". Two hand-maintained lists
// drift the moment someone adds a column, and the person adding it has no
// reason to know a second surface exists. So the LIST lives here, the drawer
// renders from it, and `scripts/member-fields-tests.ts` asserts that every key
// here is accepted by the API's Zod schema and sent by `MemberModal` — adding a
// field in one place and not the others fails the build instead of quietly
// producing a surface that can't edit it.
//
// PURE. No Prisma, no React, no imports beyond the form-config types, so both
// the client components and the node test runner can read it.
import type { MemberFormFieldKey } from "./memberForm";

/**
 * Deliberately NOT editable here, by anyone at the club:
 *
 *  · `dateOfBirth` — guardian-owned. Sets age brackets, waiver rules and minor
 *    status, so it is changed by the member/guardian in the portal and locked
 *    once confirmed (`birthdayLockedAt`). `PATCH /api/members/[id]` returns 403
 *    BIRTHDAY_LOCKED if staff try.
 *  · `password` — never visible or settable by staff. The reset flow is the
 *    only path, and it emails a single-use 60-minute link.
 *
 * Both still RENDER in the drawer, in the locked block, naming who can change
 * them and where. A hidden field reads as a missing feature; a visibly locked
 * one with an explanation does not generate a support ticket.
 */
export const LOCKED_MEMBER_FIELDS = ["dateOfBirth", "password"] as const;

export type MemberFieldGroup = "identity" | "contact" | "address" | "relationship" | "internal";

export type MemberEditableField = {
  key: string;
  label: string;
  group: MemberFieldGroup;
  input: "text" | "email" | "tel" | "select" | "textarea" | "checkbox";
  options?: { value: string; label: string }[];
  helper?: string;
  /** Club-configurable visibility. Omitted = always shown to staff. */
  formKey?: MemberFormFieldKey;
  /** Only meaningful for a minor; hidden and not submitted otherwise. */
  minorOnly?: boolean;
};

export const MEMBER_FIELD_GROUPS: { id: MemberFieldGroup; title: string }[] = [
  { id: "identity", title: "Identity" },
  { id: "contact", title: "Contact" },
  { id: "address", title: "Address" },
  { id: "relationship", title: "Relationship" },
  { id: "internal", title: "Internal" },
];

export const MEMBER_EDITABLE_FIELDS: MemberEditableField[] = [
  { key: "firstName", label: "First name", group: "identity", input: "text" },
  { key: "lastName", label: "Last name", group: "identity", input: "text" },
  {
    key: "gender",
    label: "Gender",
    group: "identity",
    input: "select",
    formKey: "gender",
    options: [
      { value: "", label: "Not specified" },
      { value: "MALE", label: "Male" },
      { value: "FEMALE", label: "Female" },
      { value: "OTHER", label: "Other" },
    ],
  },

  {
    key: "email",
    label: "Email",
    group: "contact",
    input: "email",
    formKey: "email",
    // D-0. The drawer replaces this helper with a stronger, specific warning
    // when the member owns their own login, because that edit moves sign-in.
    helper: "Changing this re-points any pending invitation. It does not re-send it.",
  },
  { key: "phone", label: "Phone", group: "contact", input: "tel", formKey: "phone" },

  { key: "streetAddress", label: "Street address", group: "address", input: "text", formKey: "streetAddress" },
  { key: "city", label: "City", group: "address", input: "text", formKey: "city" },
  { key: "state", label: "State", group: "address", input: "text", formKey: "state" },
  { key: "zipCode", label: "Zip code", group: "address", input: "text", formKey: "zipCode" },

  { key: "guardianName", label: "Guardian name", group: "relationship", input: "text", minorOnly: true },
  { key: "guardianEmail", label: "Guardian email", group: "relationship", input: "email", minorOnly: true },
  { key: "guardianPhone", label: "Guardian phone", group: "relationship", input: "tel", minorOnly: true },
  {
    key: "guardianRelationship",
    label: "Guardian relationship",
    group: "relationship",
    input: "text",
    formKey: "guardianRelationship",
    minorOnly: true,
  },

  {
    key: "status",
    label: "Status",
    group: "internal",
    input: "select",
    formKey: "status",
    helper: "Active requires a live subscription — the server coerces it to Prospect otherwise.",
    options: [
      { value: "PROSPECT", label: "Prospect" },
      { value: "ACTIVE", label: "Active" },
      { value: "PAUSED", label: "Paused" },
      { value: "INACTIVE", label: "Inactive" },
    ],
  },
  { key: "tags", label: "Tags", group: "internal", input: "text", formKey: "tags", helper: "Comma separated." },
  { key: "notes", label: "Notes", group: "internal", input: "textarea", formKey: "notes" },
];

/** Every key the drawer and the modal are both expected to be able to write. */
export const MEMBER_EDITABLE_KEYS: string[] = MEMBER_EDITABLE_FIELDS.map((f) => f.key);

/**
 * Fields that are editable but not rendered as plain inputs by the shared
 * renderer — they need bespoke UI. Listed so the drift test can tell "handled
 * elsewhere" apart from "forgotten".
 *
 *  · `profileImageUrl` — upload widget
 *  · `customFieldValues` — the club's own fields, rendered from `CustomField[]`.
 *    This is where "emergency contact" lives: there is no emergency-contact
 *    column on `Member`, so clubs model it as a custom field. Rendering custom
 *    fields is what makes it editable, not a new column.
 *  · `isMinor` — a checkbox that gates the whole relationship group, and the
 *    server overrides it from date of birth anyway (COPPA: DOB is
 *    authoritative, so an owner cannot clear the flag on a real child).
 */
export const MEMBER_BESPOKE_FIELDS = ["profileImageUrl", "customFieldValues", "isMinor"] as const;

export function fieldsForGroup(group: MemberFieldGroup): MemberEditableField[] {
  return MEMBER_EDITABLE_FIELDS.filter((f) => f.group === group);
}
