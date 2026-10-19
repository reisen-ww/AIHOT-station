import { useEffect, useState, type ReactNode } from "react";
import { applyTheme, setThemePreference, useThemePreference, type ThemeChoice } from "../../lib/local-state";

const OPTIONS: Array<{ key: ThemeChoice; label: string; icon: ReactNode }> = [
  { key: "sepia", label: "报纸", icon: <IconBook size={14} /> },
  { key: "ink", label: "墨", icon: <IconInk size={14} /> },
];

/** A sheet of paper with a dog-eared corner: the warm, long-reading look. */
function IconBook({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </svg>
  );
}

/** A filled circle eating into an outline one: the deep, low-glare look. */
function IconInk({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Appearance switch: paper or ink, with a sliding thumb. */
export function ThemeSwitch({ className = "" }: { className?: string }) {
  const pref = useThemePreference();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Before the browser storage can be read, show the default rather than a wrong thumb.
  const current: ThemeChoice = mounted ? (pref ?? "sepia") : "sepia";
  const index = Math.max(0, OPTIONS.findIndex((o) => o.key === current));

  const choose = (key: ThemeChoice) => {
    const apply = () => {
      setThemePreference(key);
      applyTheme(key);
    };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      delete doc.documentElement.dataset.vt; // a cross-fade, not the last page change's slide (transitions.ts)
      doc.startViewTransition(apply);
    } else apply();
  };

  return (
    <div role="radiogroup" aria-label="外观" className={`relative grid h-[34px] grid-cols-2 rounded-full border border-line bg-bg-sunk p-[3px] ${className}`}>
      <span
        aria-hidden="true"
        className="absolute inset-y-[3px] left-[3px] w-[calc((100%-6px)/2)] rounded-full border border-line bg-surface shadow-[var(--shadow-card)] transition-transform duration-200 ease-[var(--ease-out-quart)]"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={current === o.key}
          title={o.label}
          onClick={() => choose(o.key)}
          className={`relative z-10 flex items-center justify-center rounded-full transition-colors duration-150 ${current === o.key ? "text-ink" : "text-ink-4 hover:text-ink-2"}`}
        >
          {o.icon}
          <span className="sr-only">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
