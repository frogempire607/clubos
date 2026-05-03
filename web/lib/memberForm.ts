/**
 * Member intake form configuration.
 *
 * Stored on Club.memberFormConfig as JSON. Drives the Add Member modal,
 * the CSV import requirement set, and the first-time-setup gate.
 *
 * `firstName`, `lastName` are always enabled & required (schema-enforced) and
 * are presented in the UI as a single "Athlete Name" input. `email` is always
 * enabled; required state is controlled by the config (default: required).
 */

export type MemberFormFieldKey =
  | "athleteName"   // synthetic — always enabled, always required
  | "email"
  | "phone"
  | "dateOfBirth"
  | "gender"
  | "streetAddress"
  | "city"
  | "state"
  | "zipCode"
  | "status"
  | "tags"
  | "notes"
  | "isMinor"
  | "profileImageUrl"
  | "guardianRelationship";

export type MemberFormConfig = {
  enabledFields: MemberFormFieldKey[];
  requiredFields: MemberFormFieldKey[];
};

export const DEFAULT_MEMBER_FORM_CONFIG: MemberFormConfig = {
  enabledFields: ["athleteName", "email"],
  requiredFields: ["athleteName", "email"],
};

export const ALWAYS_ON_FIELDS: MemberFormFieldKey[] = ["athleteName", "email"];

export const FIELD_LABELS: Record<MemberFormFieldKey, string> = {
  athleteName:           "Athlete name",
  email:                 "Email",
  phone:                 "Phone",
  dateOfBirth:           "Date of birth",
  gender:                "Gender",
  streetAddress:         "Street address",
  city:                  "City",
  state:                 "State",
  zipCode:               "Zip code",
  status:                "Status",
  tags:                  "Tags",
  notes:                 "Notes",
  isMinor:               "Minor / guardian info",
  profileImageUrl:       "Profile photo",
  guardianRelationship:  "Guardian relationship",
};

export const FIELD_ORDER: MemberFormFieldKey[] = [
  "athleteName",
  "email",
  "phone",
  "dateOfBirth",
  "gender",
  "profileImageUrl",
  "streetAddress",
  "city",
  "state",
  "zipCode",
  "status",
  "tags",
  "notes",
  "isMinor",
  "guardianRelationship",
];

export function parseMemberFormConfig(raw: unknown): MemberFormConfig {
  if (!raw || typeof raw !== "object") return DEFAULT_MEMBER_FORM_CONFIG;
  const r = raw as Partial<MemberFormConfig>;
  const enabled = Array.isArray(r.enabledFields) ? (r.enabledFields as MemberFormFieldKey[]) : DEFAULT_MEMBER_FORM_CONFIG.enabledFields;
  const required = Array.isArray(r.requiredFields) ? (r.requiredFields as MemberFormFieldKey[]) : DEFAULT_MEMBER_FORM_CONFIG.requiredFields;
  // Always-on fields are forced enabled
  const enabledSet = new Set<MemberFormFieldKey>([...enabled, ...ALWAYS_ON_FIELDS]);
  // Required can only include enabled keys; athleteName always required
  const requiredSet = new Set<MemberFormFieldKey>(
    required.filter((k) => enabledSet.has(k)).concat(["athleteName"])
  );
  return {
    enabledFields: Array.from(enabledSet),
    requiredFields: Array.from(requiredSet),
  };
}

export function isDefaultConfig(cfg: MemberFormConfig): boolean {
  return (
    cfg.enabledFields.length === DEFAULT_MEMBER_FORM_CONFIG.enabledFields.length &&
    cfg.enabledFields.every((k) => DEFAULT_MEMBER_FORM_CONFIG.enabledFields.includes(k)) &&
    cfg.requiredFields.length === DEFAULT_MEMBER_FORM_CONFIG.requiredFields.length &&
    cfg.requiredFields.every((k) => DEFAULT_MEMBER_FORM_CONFIG.requiredFields.includes(k))
  );
}

export function isFieldEnabled(cfg: MemberFormConfig, key: MemberFormFieldKey): boolean {
  return cfg.enabledFields.includes(key);
}

export function isFieldRequired(cfg: MemberFormConfig, key: MemberFormFieldKey): boolean {
  return cfg.requiredFields.includes(key);
}
