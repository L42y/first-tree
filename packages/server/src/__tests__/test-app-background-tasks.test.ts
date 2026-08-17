import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retentionSweep = vi.fn();

beforeEach(() => {
  vi.resetModules();
  retentionSweep.mockReset();
});

afterEach(() => {
  vi.doUnmock("../services/attachment.js");
  vi.resetModules();
  retentionSweep.mockReset();
});

describe("createTestApp background-task isolation", () => {
  it("does not start the attachment-retention sweep by default", async () => {
    retentionSweep.mockResolvedValue({
      eligibleObjects: 0,
      eligibleBytes: 0,
      deleted: 0,
      reclaimedBytes: 0,
      batches: 0,
    });
    vi.doMock("../services/attachment.js", async () => {
      const actual = await vi.importActual<typeof import("../services/attachment.js")>("../services/attachment.js");
      return {
        ...actual,
        sweepExpiredMessageAttachments: retentionSweep,
      };
    });
    const { createTestApp } = await import("./helpers.js");
    const app = await createTestApp();

    try {
      expect(retentionSweep).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
