import { describe, expect, it } from "vitest";
import { SdkError } from "../cloud/sdk.js";
import { isAttachmentGoneError } from "../runtime/attachment-availability.js";

describe("isAttachmentGoneError", () => {
  it("treats only a 404 SdkError as the attachment row being gone", () => {
    expect(isAttachmentGoneError(new SdkError(404, "Not Found"))).toBe(true);
    expect(isAttachmentGoneError(new SdkError(500, "Server Error"))).toBe(false);
    expect(isAttachmentGoneError(new SdkError(403, "Forbidden"))).toBe(false);
    expect(isAttachmentGoneError(new Error("network down"))).toBe(false);
  });
});
