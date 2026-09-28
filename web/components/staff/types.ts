// B21 — the staff profile payload (GET /api/staff/[id]) and the props every tab gets.
import type { PermissionKey, PermissionLevel } from "@/lib/permissions";

export type StaffProfileData = {
  staff: {
    id: string;
    clubId: string;
    email: string;
    firstName: string;
    lastName: string;
    role: "STAFF" | "OWNER";
    lastLoginAt: string | null;
    createdAt: string;
    invitePending: boolean;
    title: string | null;
    phone: string | null;
    bio: string | null;
    publicEmail: string | null;
    publicPhone: string | null;
    photoUrl: string | null;
    showOnPortal: boolean;
    permissions: Record<PermissionKey, PermissionLevel>;
    messagesSubScopes: Record<string, boolean> | null;
    billingSubScopes: Record<string, boolean> | null;
  };
  viewer: {
    isSelf: boolean;
    isOwner: boolean;
    targetIsOwner: boolean;
    canEditRecord: boolean;
    canEditAccess: boolean;
    canViewPay: boolean;
    canEditPay: boolean;
    canAssign: boolean;
    canEditHours: boolean;
    canEditOwnInfo: boolean;
    canRemove: boolean;
  };
  counts: { lessons: number; documents: number; w9Missing: boolean };
  activity: { id: string; kind: string; summary: string; actorName: string | null; selfMade: boolean; createdAt: string }[];
};

export const STAFF_TABS = [
  { key: "overview", label: "Overview" },
  // "Personal info" + "Portal profile" merged 2026-09-28. Old ?tab=personal /
  // ?tab=portal links land here (see LEGACY_TAB in StaffProfile).
  { key: "profile", label: "Profile" },
  { key: "schedule", label: "Schedule & availability" },
  { key: "access", label: "Access" },
  { key: "pay", label: "Pay" },
  { key: "lessons", label: "Lessons" },
  { key: "documents", label: "Documents" },
] as const;
export type StaffTabKey = (typeof STAFF_TABS)[number]["key"];

/** Props every tab component receives from the shell. */
export type StaffTabProps = {
  data: StaffProfileData;
  /** Re-fetch the profile payload (after a save). */
  reload: () => Promise<void>;
  /** Tell the shell this tab has unsaved changes (drives the brand dot + leave guard). */
  setDirty: (dirty: boolean) => void;
  /** Jump to another tab (goes through the leave guard). */
  goTo: (tab: StaffTabKey) => void;
  /** Report a problem that should put a red dot on this tab (e.g. assignment outside hours). */
  setProblem?: (problem: boolean) => void;
};

/** One-line "how this tab saves" rule shown under the tab bar. */
export const TAB_RULE: Record<StaffTabKey, string> = {
  overview: "Read-only summary. Open a tab to change something.",
  profile: "Your details edit in a drawer with one Save; the member-portal card has its own Save.",
  schedule: "Assignments save when you add or remove them. Time off saves on Add. Weekly hours use one Save bar.",
  access: "One Review and save — you'll see every change in plain words before it's applied.",
  pay: "One Save pay plan.",
  lessons: "Changes save as you toggle. There's no Save button on this tab.",
  documents: "Uploads and sharing save as you go.",
};
