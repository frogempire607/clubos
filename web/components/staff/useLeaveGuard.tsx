"use client";

// B21 — "Leaving a tab with unsaved changes asks first." In-app Sheet, never
// window.confirm(). Also warns on reload / closing the window.
import { useCallback, useEffect, useRef, useState } from "react";
import Sheet from "@/components/Sheet";

export function useLeaveGuard() {
  const [dirtyTabs, setDirtyTabs] = useState<string[]>([]);
  const pending = useRef<null | (() => void)>(null);
  const [asking, setAsking] = useState<string | null>(null);

  const setTabDirty = useCallback((tab: string, dirty: boolean) => {
    setDirtyTabs((cur) => (dirty ? (cur.includes(tab) ? cur : [...cur, tab]) : cur.filter((t) => t !== tab)));
  }, []);

  useEffect(() => {
    if (dirtyTabs.length === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyTabs.length]);

  /** Run `go` now, or ask first when `fromTab` has unsaved changes. */
  const guard = useCallback(
    (fromTab: string, tabLabel: string, go: () => void) => {
      if (!dirtyTabs.includes(fromTab)) return go();
      pending.current = () => {
        setTabDirty(fromTab, false);
        go();
      };
      setAsking(tabLabel);
    },
    [dirtyTabs, setTabDirty],
  );

  const dialog = (
    <Sheet
      open={asking != null}
      onClose={() => setAsking(null)}
      title={`Leave without saving ${asking ?? ""}?`}
      description="Your changes on this tab haven't been saved."
      footer={
        <>
          <button
            type="button"
            onClick={() => setAsking(null)}
            className="min-h-[44px] rounded-lg border border-app-border px-4 text-sm text-text-primary hover:bg-app-bg md:min-h-[36px]"
          >
            Stay on this tab
          </button>
          <button
            type="button"
            onClick={() => {
              const go = pending.current;
              pending.current = null;
              setAsking(null);
              go?.();
            }}
            className="min-h-[44px] rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 md:min-h-[36px]"
          >
            Discard and leave
          </button>
        </>
      }
    />
  );

  return { dirtyTabs, setTabDirty, guard, dialog };
}
