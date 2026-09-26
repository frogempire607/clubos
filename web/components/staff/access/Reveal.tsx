"use client";

// B21 — in-place reveal: grid-template-rows 0fr → 1fr with an opacity fade,
// ~220ms. Content below moves down smoothly instead of jumping. Reduced
// motion: no transition. Closed content is inert so it can't take focus.
export default function Reveal({ open, children, className = "" }: { open: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-[220ms] ease-out motion-reduce:transition-none ${
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      } ${className}`}
      aria-hidden={!open}
      {...(!open ? { inert: "" as unknown as boolean } : {})}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
