"use client";

import { useEffect } from "react";
import {
  getActiveProfileId,
  onActiveProfileChange,
  resolveActiveProfileId,
} from "@/lib/activeProfile";

export type AccessibleProfile = {
  id: string;
  firstName: string;
  lastName: string;
  kind: "self" | "child";
  isMinor?: boolean;
};

/**
 * Per-page athlete context for the member portal.
 *
 * This used to render its own pill row ("Membership for" / "Buying for" /
 * "Registering for"), independent of the shared "Managing" switcher in the
 * member layout — so a parent saw two competing toggles and switching one
 * didn't move the other. Now the layout's ProfileSwitcher (backed by
 * lib/activeProfile) is the ONLY control: this component just keeps the
 * page's `value` in sync with the shared selection (calling `onChange` so
 * existing refetch effects keyed on the selected member still fire) and
 * renders a one-line context note naming the selected athlete.
 */
export default function ProfileSwitcher({
  accessible,
  value,
  onChange,
  label = "Who is this for?",
}: {
  accessible: AccessibleProfile[];
  value: string | null;
  onChange: (memberId: string) => void;
  label?: string;
}) {
  const ids = accessible?.map((m) => m.id) ?? [];
  const idsKey = ids.join(",");

  // Adopt the shared selection on mount / whenever the accessible list
  // arrives, and follow later changes from the layout switcher.
  useEffect(() => {
    if (ids.length === 0) return;
    const resolved = resolveActiveProfileId(ids);
    if (resolved && resolved !== value) onChange(resolved);
    return onActiveProfileChange((id) => {
      if (id && ids.includes(id)) onChange(id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  if (!accessible || accessible.length <= 1) return null;

  const selected =
    accessible.find((m) => m.id === (value ?? getActiveProfileId())) ?? accessible[0];
  const name =
    selected.kind === "self" ? "you" : `${selected.firstName} ${selected.lastName}`;

  return (
    <p className="mb-4 text-xs text-stone-500">
      {label.replace(/\?$/, "")}{" "}
      <span className="font-semibold text-stone-800">{name}</span>
      <span className="text-stone-400"> — switch athletes with the Managing bar above.</span>
    </p>
  );
}
