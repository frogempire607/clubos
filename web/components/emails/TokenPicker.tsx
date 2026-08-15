"use client";

// Pick a personalization field instead of remembering its exact spelling.
//
// The composer's hint used to read "Type {{member_first_name}} or any other
// token" — which asks the sender to recall fourteen exact strings, and gives
// no signal that five of them cannot resolve on a send composed by hand.

import { useEffect, useRef, useState } from "react";
import { Braces } from "lucide-react";
import { groupedTokens, tokenSyntax, SOURCE_LABEL, SOURCE_NOTE } from "@/lib/personalizationCatalog";

export function TokenPicker({
  onInsert,
  label = "Insert field",
  className = "",
}: {
  onInsert: (syntax: string) => void;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  return (
    <div ref={wrap} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-app-border text-text-primary hover:bg-app-bg"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Braces className="h-3.5 w-3.5" strokeWidth={2} />
        {label}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute z-30 mt-1 w-80 max-h-96 overflow-y-auto rounded-xl border border-app-border bg-surface shadow-lg p-1 right-0"
        >
          {groupedTokens().map((group) => (
            <div key={group.source} className="mb-1 last:mb-0">
              <div className="px-2 pt-2 pb-1">
                <div className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
                  {SOURCE_LABEL[group.source]}
                </div>
                {SOURCE_NOTE[group.source] && (
                  <div className="text-[11px] text-orange-accent mt-0.5 leading-snug">
                    {SOURCE_NOTE[group.source]}
                  </div>
                )}
              </div>
              {group.tokens.map((t) => (
                <button
                  key={t.token}
                  type="button"
                  role="menuitem"
                  onClick={() => { onInsert(tokenSyntax(t.token)); setOpen(false); }}
                  className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-app-bg"
                >
                  <div className="text-sm text-text-primary">{t.label}</div>
                  <div className="text-[11px] text-text-muted leading-snug">{t.description}</div>
                  <div className="text-[11px] font-mono text-text-muted mt-0.5">{tokenSyntax(t.token)}</div>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
