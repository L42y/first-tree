import { describe, expect, it, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  child: vi.fn(),
}));
loggerMocks.child.mockReturnValue(loggerMocks);

vi.doMock("../observability/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../observability/index.js")>()),
  createLogger: () => loggerMocks,
}));

describe("attachment retention dry-run logging", () => {
  it("logs the statistics line even when zero candidates are eligible", async () => {
    const { createTestApp } = await import("./helpers.js");
    const app = await createTestApp();
    try {
      const { sweepExpiredMessageAttachments } = await import("../services/attachment.js");
      const result = await sweepExpiredMessageAttachments(app.db, app.attachmentBlobStore, {
        deleteEnabled: false,
      });
      expect(result).toMatchObject({ eligibleObjects: 0, eligibleBytes: 0, deleted: 0 });
      // Observability is the point of the dry-run: a zero-candidate run must
      // still leave a structured trace so operators can tell "nothing to
      // clean" from "the sweep never ran".
      expect(loggerMocks.info).toHaveBeenCalledWith(
        { eligibleObjects: 0, eligibleBytes: 0, cutoff: expect.any(Date) },
        "attachment retention sweep dry-run — no rows deleted",
      );
    } finally {
      await app.close();
    }
  });
});
