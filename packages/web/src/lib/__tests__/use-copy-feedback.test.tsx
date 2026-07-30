// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../test-utils/dom-harness.js";
import { type CopyFeedbackStatus, useCopyFeedback } from "../use-copy-feedback.js";

let h: DomHarness;
const writeText = vi.fn<(text: string) => Promise<void>>();

/** Tiny probe component: exposes the hook's status as text + a copy button. */
function Probe({ text }: { text: string }) {
  const { status, copy, reset } = useCopyFeedback();
  return (
    <>
      <button type="button" data-status={status satisfies CopyFeedbackStatus} onClick={() => void copy(text)}>
        {status}
      </button>
      <button type="button" onClick={reset}>
        reset
      </button>
    </>
  );
}

function probeButton(): HTMLButtonElement {
  const btn = h.container.querySelector<HTMLButtonElement>("button");
  if (!btn) throw new Error("probe button not found");
  return btn;
}

async function clickCopy(): Promise<void> {
  await act(async () => {
    probeButton().click();
    await Promise.resolve();
  });
  await h.flush();
}

beforeEach(() => {
  h = createDomHarness();
  writeText.mockReset();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  h.cleanup();
});

describe("useCopyFeedback", () => {
  it("flips to copied on success and back to idle after the window", async () => {
    vi.useFakeTimers();
    try {
      writeText.mockResolvedValue(undefined);
      h.render(<Probe text="hello" />);
      await clickCopy();
      expect(writeText).toHaveBeenCalledWith("hello");
      expect(probeButton().textContent).toBe("copied");
      await act(async () => {
        vi.advanceTimersByTime(1_500);
      });
      expect(probeButton().textContent).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flips to failed when the clipboard write rejects", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    h.render(<Probe text="nope" />);
    await clickCopy();
    expect(probeButton().textContent).toBe("failed");
  });

  it("restarts the full feedback window on a rapid second copy", async () => {
    vi.useFakeTimers();
    try {
      writeText.mockResolvedValue(undefined);
      h.render(<Probe text="again" />);
      await clickCopy();
      // 1.4s in: still within the first window; copy again.
      await act(async () => {
        vi.advanceTimersByTime(1_400);
      });
      await clickCopy();
      // 0.2s after the second copy the first timer's deadline has passed —
      // clear-before-set means the status must still be "copied".
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(probeButton().textContent).toBe("copied");
      await act(async () => {
        vi.advanceTimersByTime(1_300);
      });
      expect(probeButton().textContent).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a deferred clipboard result after reset", async () => {
    let rejectCopy: ((reason?: unknown) => void) | undefined;
    writeText.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectCopy = reject;
        }),
    );
    h.render(<Probe text="stale" />);

    await clickCopy();
    await act(async () => h.container.querySelector<HTMLButtonElement>("button:last-of-type")?.click());
    await act(async () => {
      rejectCopy?.(new Error("late denial"));
      await Promise.resolve();
    });

    expect(probeButton().textContent).toBe("idle");
  });

  it("does not schedule feedback after a deferred clipboard result resolves post-unmount", async () => {
    vi.useFakeTimers();
    try {
      let resolveCopy: (() => void) | undefined;
      writeText.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCopy = resolve;
          }),
      );
      h.render(<Probe text="unmounted" />);
      await clickCopy();

      h.cleanup();
      await act(async () => {
        resolveCopy?.();
        await Promise.resolve();
      });

      expect(vi.getTimerCount()).toBe(0);
      h = createDomHarness();
    } finally {
      vi.useRealTimers();
    }
  });
});
