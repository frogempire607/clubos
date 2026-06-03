"use client";

import { useEffect } from "react";

// Slide-in drawer that wraps DashboardSidebar for mobile. Renders a
// dimmed backdrop + a left-aligned column that holds children. Escape
// or backdrop tap closes it. Locks body scroll while open so the
// drawer scrolls but the underlying page doesn't.
export default function DashboardMobileDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div
      aria-hidden={!open}
      className={`fixed inset-0 z-50 md:hidden transition-opacity ${
        open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
        aria-label="Close menu"
      />
      <aside
        className={`absolute left-0 top-0 bottom-0 w-[280px] max-w-[85vw] shadow-2xl transition-transform ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </aside>
    </div>
  );
}
