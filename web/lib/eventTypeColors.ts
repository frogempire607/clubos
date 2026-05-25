// Single source of truth for built-in EventType badge colors.
// Owners can override any/all of these via Club.builtInEventColors (Manage
// Event Types modal). Missing entries fall back to these defaults.

export type BuiltInEventType =
  | "CLASS"
  | "PRIVATE"
  | "CLINIC"
  | "CAMP"
  | "TOURNAMENT"
  | "OTHER";

export type ColorPair = { bg: string; fg: string };

export const DEFAULT_BUILT_IN_COLORS: Record<BuiltInEventType, ColorPair> = {
  CLASS:      { bg: "#6D5DF6", fg: "#ffffff" }, // violet
  PRIVATE:    { bg: "#6D5DF6", fg: "#ffffff" },
  CLINIC:     { bg: "#A3E635", fg: "#1F1F23" }, // lime
  CAMP:       { bg: "#FF6A00", fg: "#ffffff" }, // orange
  TOURNAMENT: { bg: "#FF6A00", fg: "#ffffff" },
  OTHER:      { bg: "#F7F7F9", fg: "#6B7280" }, // neutral
};

export const BUILT_IN_LABELS: Record<BuiltInEventType, string> = {
  CLASS: "Class",
  PRIVATE: "Private",
  CLINIC: "Clinic",
  CAMP: "Camp",
  TOURNAMENT: "Tournament",
  OTHER: "Other",
};

// Owner overrides are stored on Club as a partial map. Anything missing
// (or invalid) falls back to the default for that type.
export function resolveBuiltInColor(
  type: string,
  overrides?: unknown,
): ColorPair {
  const def =
    DEFAULT_BUILT_IN_COLORS[type as BuiltInEventType] ??
    DEFAULT_BUILT_IN_COLORS.OTHER;
  const map =
    overrides && typeof overrides === "object"
      ? (overrides as Record<string, Partial<ColorPair> | undefined>)
      : undefined;
  const o = map?.[type];
  return {
    bg: typeof o?.bg === "string" && o.bg ? o.bg : def.bg,
    fg: typeof o?.fg === "string" && o.fg ? o.fg : def.fg,
  };
}

// The full built-in type list — for UI loops in the picker.
export const BUILT_IN_EVENT_TYPES: BuiltInEventType[] = [
  "CLASS",
  "PRIVATE",
  "CLINIC",
  "CAMP",
  "TOURNAMENT",
  "OTHER",
];
