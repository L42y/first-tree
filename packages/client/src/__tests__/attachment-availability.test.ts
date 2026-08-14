import { MESSAGE_ATTACHMENT_RETENTION_DAYS } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { SdkError } from "../cloud/sdk.js";
import {
  ATTACHMENT_UNAVAILABLE_NOTE,
  isAttachmentGoneError,
} from "../runtime/provider-support/attachment-availability.js";

describe("isAttachmentGoneError", () => {
  it("treats only a 404 SdkError as the attachment row being gone", () => {
    expect(isAttachmentGoneError(new SdkError(404, "Not Found"))).toBe(true);
    expect(isAttachmentGoneError(new SdkError(500, "Server Error"))).toBe(false);
    expect(isAttachmentGoneError(new SdkError(403, "Forbidden"))).toBe(false);
    expect(isAttachmentGoneError(new Error("network down"))).toBe(false);
  });

  it("interpolates the shared retention day-count into Agent copy", () => {
    expect(ATTACHMENT_UNAVAILABLE_NOTE).toBe(
      `Cloud message attachments are retained for ${MESSAGE_ATTACHMENT_RETENTION_DAYS} days`,
    );
    expect(ATTACHMENT_UNAVAILABLE_NOTE).toBe("Cloud message attachments are retained for 14 days");
  });
});
