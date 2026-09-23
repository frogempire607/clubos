"use client";
import { useState } from "react";

// Focal point on the cover image, 0–100% of width/height. Persisted to
// Event.imagePositionX/Y and read by /e/[slug] via CSS object-position.
// Moved out of app/dashboard/events/page.tsx for the slice-2 editor.
export default function EventImageFocalPicker({
  imageUrl,
  x,
  y,
  onChange,
}: {
  imageUrl: string;
  x: number;
  y: number;
  onChange: (x: number, y: number) => void;
}) {
  const [dragging, setDragging] = useState(false);

  function pickFromEvent(e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) {
    const box = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    const point =
      "touches" in e && e.touches.length > 0
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY };
    const nx = Math.max(0, Math.min(100, Math.round(((point.x - box.left) / box.width) * 100)));
    const ny = Math.max(0, Math.min(100, Math.round(((point.y - box.top) / box.height) * 100)));
    onChange(nx, ny);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-text-primary">Adjust image position</label>
        <button
          type="button"
          onClick={() => onChange(50, 50)}
          className="text-xs text-text-muted hover:text-text-primary underline"
        >
          Reset to center
        </button>
      </div>
      <div
        role="button"
        tabIndex={0}
        onMouseDown={(e) => { setDragging(true); pickFromEvent(e); }}
        onMouseMove={(e) => { if (dragging) pickFromEvent(e); }}
        onMouseUp={() => setDragging(false)}
        onMouseLeave={() => setDragging(false)}
        onTouchStart={(e) => { setDragging(true); pickFromEvent(e); }}
        onTouchMove={(e) => { if (dragging) pickFromEvent(e); }}
        onTouchEnd={() => setDragging(false)}
        className="relative w-full overflow-hidden rounded-lg border border-app-border bg-app-bg cursor-crosshair select-none"
        style={{ aspectRatio: "16 / 9" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
          style={{ objectPosition: `${x}% ${y}%` }}
        />
        {/* Focal point indicator */}
        <div
          className="absolute pointer-events-none w-5 h-5 rounded-full border-2 border-white"
          style={{
            left: `${x}%`,
            top: `${y}%`,
            transform: "translate(-50%, -50%)",
            boxShadow: "0 0 0 1px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.6)",
          }}
        />
      </div>
      <p className="text-xs text-text-muted">
        Click or drag inside the preview to set the part of the image that should
        stay visible on the public registration page.
      </p>
    </div>
  );
}
