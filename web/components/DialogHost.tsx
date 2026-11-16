"use client";

// Draws the dialogs queued by lib/dialogs.ts (confirmDialog / alertDialog /
// promptDialog), one at a time, as a bottom sheet on a phone and a centred
// card on a wider screen. Mounted once in the root layout.

import { useEffect, useRef, useState } from "react";
import Sheet from "@/components/Sheet";
import { subscribeDialogs, type DialogRequest } from "@/lib/dialogs";

export default function DialogHost() {
  const [queue, setQueue] = useState<readonly DialogRequest[]>([]);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const current = queue[0] ?? null;

  useEffect(() => subscribeDialogs(setQueue), []);

  // Each prompt starts from its own default, focused and selected.
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (current?.kind !== "prompt") return;
    setText(current.defaultValue);
    const t = setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  if (!current) return null;

  const cancel = () => {
    if (current.kind === "confirm") current.resolve(false);
    else if (current.kind === "prompt") current.resolve(null);
    else current.resolve();
  };
  const accept = () => {
    if (current.kind === "confirm") current.resolve(true);
    else if (current.kind === "prompt") current.resolve(text);
    else current.resolve();
  };

  const secondary = "min-h-[44px] rounded-lg border border-app-border px-4 text-sm font-medium text-text-primary hover:bg-app-bg";
  const primary = "min-h-[44px] rounded-lg px-4 text-sm font-semibold text-white";

  return (
    <Sheet
      open
      onClose={cancel}
      title={current.kind === "alert" ? "Heads up" : current.kind === "prompt" ? "One more thing" : "Please confirm"}
      width={440}
      footer={
        current.kind === "alert" ? (
          <button type="button" autoFocus onClick={accept} className={`${primary} bg-brand hover:bg-brand-hover`}>OK</button>
        ) : (
          <>
            <button type="button" onClick={cancel} className={secondary}>
              {current.kind === "confirm" ? current.cancelLabel : "Cancel"}
            </button>
            <button
              type="button"
              onClick={accept}
              className={`${primary} ${current.kind === "confirm" && current.danger ? "bg-red-600 hover:bg-red-700" : "bg-brand hover:bg-brand-hover"}`}
            >
              {current.confirmLabel}
            </button>
          </>
        )
      }
    >
      <p className="whitespace-pre-line text-sm leading-relaxed text-text-primary">{current.message}</p>
      {current.kind === "prompt" && (
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); accept(); } }}
          className="mt-3 min-h-[44px] w-full rounded-lg border border-app-border bg-surface px-3 text-[16px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
        />
      )}
    </Sheet>
  );
}
