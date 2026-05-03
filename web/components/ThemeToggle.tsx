"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";
const STORAGE_KEY = "athletixos-theme";

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

export function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const v = window.localStorage.getItem(STORAGE_KEY);
  return v === "dark" ? "dark" : "light";
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  // On mount, hydrate from storage
  useEffect(() => {
    const t = readStoredTheme();
    setTheme(t);
    applyTheme(t);
    setMounted(true);
  }, []);

  function flip() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }

  if (!mounted) return null;

  return (
    <button
      type="button"
      onClick={flip}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        width: "100%",
        padding: "7px 12px",
        background: "transparent",
        color: "rgba(229,231,235,0.72)",
        fontSize: 12,
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        cursor: "pointer",
        transition: "color 0.15s, background 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.04)";
        (e.currentTarget as HTMLElement).style.color = "#fff";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
        (e.currentTarget as HTMLElement).style.color = "rgba(229,231,235,0.72)";
      }}
    >
      <span style={{ fontSize: 14, lineHeight: 1 }}>{theme === "dark" ? "☀" : "☾"}</span>
      {theme === "dark" ? "Light mode" : "Dark mode"}
    </button>
  );
}
