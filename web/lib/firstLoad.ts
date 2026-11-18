"use client";

// A loading flag that can blank the screen exactly once (crash audit
// 2026-11-18, docs/CRASH-AUDIT-2026-11-18.md).
//
// The usual page looks like this:
//
//     const [loading, setLoading] = useState(true);
//     const load = () => { setLoading(true); fetch(…).then(() => setLoading(false)); };
//     if (loading) return <Skeleton />;
//     return <>…{editing && <EditSheet onSaved={load} />}</>;
//
// The second time `load` runs — after a save, after a child reports a change,
// after a background refresh — `loading` goes true again, the whole component
// is replaced by the skeleton, and the open sheet is unmounted with everything
// typed in it. When the data arrives the page comes back, with the sheet
// closed.
//
// Swap the declaration, change nothing else:
//
//     const [loading, setLoading, refreshing] = useFirstLoad();
//
// `loading` is true until the first `setLoading(false)` and never again. Later
// `setLoading(true)` calls raise `refreshing` instead, which a page may use to
// dim a list or spin an icon — never to take content off the screen.

import { useCallback, useRef, useState } from "react";

export function useFirstLoad(initial = true): [loading: boolean, setLoading: (next: boolean) => void, refreshing: boolean] {
  const [loading, setLoadingState] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  // Once the first load has finished, the screen has content worth keeping.
  const loadedOnce = useRef(!initial);

  const setLoading = useCallback((next: boolean) => {
    if (!next) {
      loadedOnce.current = true;
      setLoadingState(false);
      setRefreshing(false);
      return;
    }
    if (loadedOnce.current) setRefreshing(true);
    else setLoadingState(true);
  }, []);

  return [loading, setLoading, refreshing];
}
