"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

// Reusable QR code modal. Renders a scannable code for `url` plus quick
// actions (open, copy, print). Used for class-session / event attendance.
export default function QRModal({
  open,
  onClose,
  url,
  title,
  subtitle,
}: {
  open: boolean;
  onClose: () => void;
  url: string;
  title: string;
  subtitle?: string;
}) {
  const [dataUrl, setDataUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !url) return;
    let cancelled = false;
    QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: "M" })
      .then((d) => {
        if (!cancelled) setDataUrl(d);
      })
      .catch(() => {
        if (!cancelled) setDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [open, url]);

  if (!open) return null;

  function copyLink() {
    navigator.clipboard?.writeText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }

  function printQR() {
    const w = window.open("", "_blank", "width=480,height=640");
    if (!w) return;
    w.document.write(
      `<html><head><title>${title}</title></head><body style="font-family:system-ui;text-align:center;padding:32px">` +
        `<h2 style="margin:0 0 4px">${title}</h2>` +
        (subtitle ? `<p style="margin:0 0 16px;color:#666">${subtitle}</p>` : "") +
        `<img src="${dataUrl}" style="width:320px;height:320px" />` +
        `<p style="margin-top:16px;color:#999;font-size:12px;word-break:break-all">${url}</p>` +
        `</body></html>`,
    );
    w.document.close();
    w.focus();
    w.print();
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl w-full max-w-sm overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-app-border flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-text-primary truncate">{title}</h2>
            {subtitle && <p className="text-xs text-text-muted truncate">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary text-xl leading-none flex-shrink-0 ml-3"
          >
            ×
          </button>
        </div>

        <div className="p-6 flex flex-col items-center">
          {dataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={dataUrl}
              alt="Attendance QR code"
              className="w-60 h-60 rounded-lg border border-app-border"
            />
          ) : (
            <div className="w-60 h-60 rounded-lg border border-app-border flex items-center justify-center text-text-muted text-sm">
              Generating…
            </div>
          )}
          <p className="text-xs text-text-muted mt-4 text-center">
            Staff: scan with a phone or tablet to open check-in for this session.
          </p>

          <div className="grid grid-cols-3 gap-2 w-full mt-5">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-center text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
            >
              Open
            </a>
            <button
              onClick={copyLink}
              className="text-sm px-3 py-2 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <button
              onClick={printQR}
              disabled={!dataUrl}
              className="text-sm px-3 py-2 bg-brand text-white rounded-lg hover:bg-brand-hover disabled:opacity-50"
            >
              Print
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
