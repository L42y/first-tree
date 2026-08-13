import { describe, expect, it, vi } from "vitest";
import * as observability from "../observability/index.js";

describe("attachment retention dry-run logging", () => {
  it("logs the statistics line even when zero candidates are eligible", async () => {
    const { createTestApp } = await import("./helpers.js");
    const app = await createTestApp();
    const info = vi.fn();
    const originalCreateLogger = observability.createLogger;
    const spy = vi.spyOn(observability, "createLogger").mockImplementation((module: string) => {
      if (module === "attachment") {
        return { debug: vi.fn(), error: vi.fn(), info, warn: vi.fn(), child: vi.fn() } as never;
      }
      return originalCreateLogger(module);
    });
    try {
      const { sweepExpiredMessageAttachments } = await import("../services/attachment.js");
      const result = await sweepExpiredMessageAttachments(app.db, app.attachmentBlobStore, {
        deleteEnabled: false,
      });
      expect(result).toMatchObject({ eligibleObjects: 0, eligibleBytes: 0, deleted: 0 });
      // Observability is the point of the dry-run: a zero-candidate run must
      // still leave a structured trace so operators can tell "nothing to
      // clean" from "the sweep never ran". spyOn hits the live export even
      // when this module was already loaded by earlier isolate:false files.
      expect(info).toHaveBeenCalledWith(
        { eligibleObjects: 0, eligibleBytes: 0, cutoff: expect.any(Date) },
        "attachment retention sweep dry-run — no rows deleted",
      );
    } finally {
      spy.mockRestore();
      await app.close();
    }
  });
});
