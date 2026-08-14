import type { ReactElement } from "react";

/** The approved self-hosted OpenTag lockup, using the production font stack. */
export function OpenTagLogo(): ReactElement {
  return (
    <span className="inline-flex items-center" style={{ gap: "var(--sp-3)" }} role="img" aria-label="OpenTag">
      <img src="/opentag-mark.svg" alt="" aria-hidden="true" className="h-12 w-12 shrink-0" />
      <span className="text-headline font-bold" style={{ color: "var(--fg)" }} aria-hidden="true">
        OpenTag
      </span>
    </span>
  );
}
