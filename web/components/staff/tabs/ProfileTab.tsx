"use client";

// Staff profile → Profile (2026-09-28): "Personal info" and "Portal profile"
// merged into one tab. It renders the two existing tabs one after the other
// and keeps both of their save models: the contact card edits in a drawer
// with one Save, the member-portal card has its own Save.
//
// Dirty state: each half reports its own dirty flag; the tab is dirty when
// EITHER is. The combining callbacks are stable (they depend only on the
// shell's stable setDirty) and hold the two flags in refs, not state, so a
// half re-reporting the same value never re-renders anything — the update
// loop fixed in useLeaveGuard/StaffProfile (2026-09-26) can't come back
// through here.
import { useCallback, useMemo, useRef } from "react";
import type { StaffTabProps } from "@/components/staff/types";
import PersonalTab, { PORTAL_CARD_ID } from "@/components/staff/tabs/PersonalTab";
import PortalTab from "@/components/staff/tabs/PortalTab";

export default function ProfileTab(props: StaffTabProps) {
  const { setDirty } = props;
  const personalDirty = useRef(false);
  const portalDirty = useRef(false);

  const setPersonalDirty = useCallback(
    (d: boolean) => {
      personalDirty.current = d;
      setDirty(personalDirty.current || portalDirty.current);
    },
    [setDirty],
  );
  const setPortalDirty = useCallback(
    (d: boolean) => {
      portalDirty.current = d;
      setDirty(personalDirty.current || portalDirty.current);
    },
    [setDirty],
  );

  const personalProps = useMemo(() => ({ ...props, setDirty: setPersonalDirty }), [props, setPersonalDirty]);
  const portalProps = useMemo(() => ({ ...props, setDirty: setPortalDirty }), [props, setPortalDirty]);

  return (
    <div className="space-y-6">
      <PersonalTab {...personalProps} />
      <div id={PORTAL_CARD_ID} className="scroll-mt-28">
        <PortalTab {...portalProps} />
      </div>
    </div>
  );
}
