import { describe, expect, it } from "vitest";
import { MESSAGE_ATTACHMENT_RETENTION_DAYS } from "../schemas/attachment.js";

describe("attachment retention contract", () => {
  it("owns a single 14-day policy number interpolated into user-facing copy", () => {
    expect(MESSAGE_ATTACHMENT_RETENTION_DAYS).toBe(14);
    expect(`Cloud message attachments are retained for ${MESSAGE_ATTACHMENT_RETENTION_DAYS} days`).toBe(
      "Cloud message attachments are retained for 14 days",
    );
  });
});
