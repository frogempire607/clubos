"use client";

/**
 * Overlapping stack of guardian initials (2a "Family & access" rows).
 * Presentational only — pass the guardians' display names.
 */
export default function GuardianAvatars({
  names,
  size = 22,
  max = 3,
  className = "",
}: {
  names: string[];
  size?: number;
  max?: number;
  className?: string;
}) {
  if (!names.length) return null;
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span
      className={`inline-flex items-center ${className}`}
      aria-label={`Guardians: ${names.join(", ")}`}
      title={names.join(", ")}
    >
      {shown.map((name, i) => {
        const initials = name
          .split(" ")
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0])
          .join("")
          .toUpperCase();
        return (
          <span
            key={`${name}-${i}`}
            className="rounded-full flex items-center justify-center font-extrabold border-2 border-white flex-shrink-0"
            style={{
              width: size,
              height: size,
              fontSize: Math.max(7, size * 0.36),
              background: "var(--club-accent-soft)",
              color: "var(--club-accent)",
              marginLeft: i === 0 ? 0 : -Math.round(size * 0.3),
            }}
          >
            {initials || "?"}
          </span>
        );
      })}
      {extra > 0 && (
        <span
          className="rounded-full flex items-center justify-center font-bold border-2 border-white bg-stone-100 text-stone-500 flex-shrink-0"
          style={{
            width: size,
            height: size,
            fontSize: Math.max(7, size * 0.34),
            marginLeft: -Math.round(size * 0.3),
          }}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
