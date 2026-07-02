"use client";

import React from "react";

// Shared section-header primitive for /dashboard/* pages. Lets every
// section render a consistent title block + actions slot without
// hand-rolling spacing / font sizes per page.
//
// Usage:
//   <PageHeader
//     title="Members"
//     description="Everyone in your club."
//     actions={<button>Add member</button>}
//   />
export default function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4 mb-6">
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted mb-1">
            {eyebrow}
          </div>
        )}
        <h1 className="text-xl sm:text-2xl font-semibold text-text-primary leading-tight tracking-tight">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-text-muted mt-1.5 max-w-xl">
            {description}
          </p>
        )}
      </div>
      {actions && (
        // Keep wrapping enabled through tablet widths — pages like Members have
        // five header actions, and sm:flex-nowrap forced them to overflow the
        // viewport on tablets. Only pin to one line on large screens.
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 lg:flex-nowrap lg:shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
