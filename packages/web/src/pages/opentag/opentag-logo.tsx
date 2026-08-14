import type { ReactElement } from "react";

/** The approved self-hosted OpenTag lockup, using the production font stack. */
export function OpenTagLogo(): ReactElement {
  return (
    <span className="inline-flex items-center" style={{ gap: "var(--sp-2_25)" }}>
      <img src="/opentag-mark.svg" alt="" aria-hidden="true" className="h-7.5 w-7.5 shrink-0" />
      <span className="text-lead font-bold" style={{ color: "var(--fg)" }}>
        OpenTag
      </span>
    </span>
  );
}
