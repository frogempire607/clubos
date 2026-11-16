"use client";

import { useMemo, useState } from "react";
import { createSingleFlight } from "@/lib/singleFlight";

/**
 * `const flight = useSingleFlight()` then
 *   onClick={() => flight.run(`paid:${id}`, () => markPaid(id))}
 *   disabled={flight.isBusy(`paid:${id}`)}
 * A second tap while the first is still running does nothing. See
 * lib/singleFlight.ts for why `disabled` alone is not enough.
 */
export function useSingleFlight() {
  const [busy, setBusy] = useState<string[]>([]);
  const flight = useMemo(() => createSingleFlight(setBusy), []);
  return useMemo(
    () => ({ run: flight.run, isBusy: (key: string) => busy.includes(key) }),
    [flight, busy],
  );
}
