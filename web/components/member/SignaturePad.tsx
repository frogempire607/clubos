"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Dependency-free drawn-signature pad (mouse + touch via Pointer Events).
 *
 * Emits a trimmed PNG **data URL** through `onChange` after each stroke, and
 * `onChange(null)` when cleared. Self-contained so it works both inside the
 * member portal and on the public onboarding/activation page.
 */
export default function SignaturePad({
  onChange,
  accent = "#1C1917",
  height = 180,
  disabled = false,
}: {
  onChange: (dataUrl: string | null) => void;
  accent?: string;
  height?: number;
  disabled?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  // Size the canvas backing store to the container width at device pixel ratio
  // so strokes are crisp and coordinates map 1:1 with CSS pixels.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssWidth = wrap.clientWidth;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#1c1917";
    }
  }, [height]);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    e.preventDefault();
    drawing.current = true;
    last.current = pos(e);
    canvasRef.current?.setPointerCapture(e.pointerId);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || disabled) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !last.current) return;
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!hasInk.current) {
      hasInk.current = true;
      setEmpty(false);
    }
  }

  function end(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    e.preventDefault();
    drawing.current = false;
    last.current = null;
    if (hasInk.current && canvasRef.current) {
      onChange(canvasRef.current.toDataURL("image/png"));
    }
  }

  function clear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    hasInk.current = false;
    setEmpty(true);
    onChange(null);
  }

  return (
    <div>
      <div
        ref={wrapRef}
        className="relative rounded-xl border bg-white overflow-hidden"
        style={{ borderColor: empty ? "#d6d3d1" : accent }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          onPointerCancel={end}
          className="block w-full touch-none cursor-crosshair"
          style={{ touchAction: "none" }}
        />
        {empty && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="text-sm text-stone-400">✍️ Sign here with your finger or mouse</span>
          </div>
        )}
        {/* Signature guide line */}
        <div className="pointer-events-none absolute left-4 right-4" style={{ bottom: 34, borderTop: "1px dashed #e7e5e4" }} />
      </div>
      <div className="flex items-center justify-between mt-2">
        <p className="text-[11px] text-stone-400">Draw your signature above.</p>
        <button
          type="button"
          onClick={clear}
          disabled={empty || disabled}
          className="text-xs text-stone-500 hover:text-stone-900 underline disabled:opacity-40 disabled:no-underline"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
