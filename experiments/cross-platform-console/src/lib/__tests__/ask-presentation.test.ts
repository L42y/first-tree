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
      "",
      "The choice; use a dedicated token and resume in small batches.",
    ].join("\n");

    const presentation = buildAskPresentation(content);

    expect(presentation.decision).toBe("should I retry now or wait?");
    expect(presentation.recommendation).toBe("use a dedicated token and resume in small batches.");
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

  it("extracts the final direct question instead of the long paragraph containing one", () => {
    const content = [
      "The first diagnostic asks: does the monitor have data? It found no capture.",
      "",
      "I have not reviewed the prerequisite yet and will not endorse it as the fix.",
      "",
      "Question: Will you allow me to use the upstream token for the bounded retry?",
      "",
      "My recommendation: use a dedicated token and keep the batch small.",
    ].join("\n");

    const presentation = buildAskPresentation(content);

    expect(presentation.decision).toBe("Will you allow me to use the upstream token for the bounded retry?");
    expect(presentation.recommendation).toBe("use a dedicated token and keep the batch small.");
    expect(presentation.hasMore).toBe(true);
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
