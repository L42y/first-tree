import type { ReactElement } from "react";

/** The approved OpenTag mark, rendered with the production font/token stack. */
export function OpenTagLogo(): ReactElement {
  return (
    <span className="inline-flex items-center" style={{ gap: "var(--sp-2_25)" }}>
      <svg aria-hidden="true" viewBox="0 0 32 32" className="h-7.5 w-7.5 shrink-0">
        <path
          d="M3.5 8.25A7.25 7.25 0 0 1 10.75 1h10.5a7.25 7.25 0 0 1 7.25 7.25v7.2c0 8.2-6.65 14.85-14.85 14.85h-2.9a7.25 7.25 0 0 1-7.25-7.25V8.25Z"
          fill="var(--brand)"
          stroke="var(--fg)"
          strokeWidth="1.25"
        />
        <path
          d="m21.1 20.35 7.32-2.72a14.88 14.88 0 0 1-8.64 10.78l1.32-8.06Z"
          fill="var(--bg)"
          stroke="var(--fg)"
          strokeWidth="1.1"
        />
        <circle cx="20.8" cy="10.7" r="1.5" fill="var(--fg)" />
      </svg>
      <span className="text-lead font-bold" style={{ color: "var(--fg)" }}>
        OpenTag
      </span>
    </span>
  );
}
