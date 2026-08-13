import { SdkError } from "../cloud/sdk.js";

/**
 * Agent-facing note for an attachment the server no longer has. A 404 can
 * mean the 14-day message-attachment retention sweep reclaimed the bytes, the
 * 24-hour orphan cleanup removed them, or they were released explicitly —
 * the agent only needs to know the bytes are gone, not which cleanup ran.
 */
export const ATTACHMENT_UNAVAILABLE_NOTE = "Cloud message attachments are retained for 14 days";

/**
 * True when a fetch failure means the attachment row is gone server-side.
 * Only a 404 qualifies: 5xx and network errors are transient and must keep
 * the generic "not available on this device" placeholder.
 */
export function isAttachmentGoneError(error: unknown): boolean {
  return error instanceof SdkError && error.statusCode === 404;
}
