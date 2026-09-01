import { describe, expect, it } from "vitest";

import { buildAskPresentation } from "../ask-presentation";

describe("buildAskPresentation", () => {
  it("promotes the decision and recommendation while hiding background", () => {
    const content = [
      "**What happened:** GitHub rejected the dispatch because the shared identity hit its rate limit.",
      "",
      "**Current verified state:** the previous workflow is still pending.",
      "",
      "**Recommendation:** wait for the pending run before dispatching another promotion.",
      "",
      "**Question:** should I retry now or wait?",
    ].join("\n");

    const presentation = buildAskPresentation(content);

    expect(presentation.decision).toBe("**Question:** should I retry now or wait?");
    expect(presentation.recommendation).toBe(
      "**Recommendation:** wait for the pending run before dispatching another promotion.",
    );
    expect(presentation.context).toHaveLength(2);
    expect(presentation.hasMore).toBe(true);
  });

  it("uses the only paragraph directly when no labeled sections exist", () => {
    const presentation = buildAskPresentation("Should we ship the fix now?");

    expect(presentation.decision).toBe("Should we ship the fix now?");
    expect(presentation.recommendation).toBeNull();
    expect(presentation.context).toHaveLength(0);
    expect(presentation.hasMore).toBe(false);
  });

  it("keeps an empty body renderable", () => {
    expect(buildAskPresentation("")).toEqual({
      decision: "",
      recommendation: null,
      context: [],
      hasMore: false,
    });
  });
});
