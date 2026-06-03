"use client";

import React from "react";
import Link from "next/link";

// Shared empty-state primitive for dashboard tables and lists. Replaces
// the ad-hoc "No X yet." text-only messages each section currently
// hand-rolls. Three slots: icon (glyph or React node), title, and
// optional description/action.
//
// Usage:
//   <EmptyState
//     icon="◉"
//     title="No members yet"
//     description="Add your first member to get started."
//     action={{ label: "Add member", href: "/dashboard/members?add=1" }}
//   />
export default function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: { label: string; href: string } | { label: string; onClick: () => void };
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center px-6 py-12 ${
        className ?? ""
      }`}
    >
      {icon && (
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center mb-4"
          style={{
            background: "rgba(163, 230, 53, 0.12)",
            color: "#5C8C1F",
          }}
        >
          {icon}
        </div>
      )}
      <div className="text-base font-semibold text-text-primary mb-1.5">{title}</div>
      {description && (
        <div className="text-xs text-text-muted max-w-sm">{description}</div>
      )}
      {action && (
        <div className="mt-4">
          {"href" in action ? (
            <Link
              href={action.href}
              className="text-xs px-3 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover transition"
            >
              {action.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={action.onClick}
              className="text-xs px-3 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover transition"
            >
              {action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
