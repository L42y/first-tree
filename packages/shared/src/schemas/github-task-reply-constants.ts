export const GITHUB_TASK_REPLY_RUN_MARKER_PREFIX = "<!-- first-tree-github-task-reply-run:";

const GITHUB_COMMENT_MAX_BYTES = 64 * 1024;
const SERVER_RUN_ID_BYTES = 36;
const HIDDEN_SUFFIX_BYTES = 2 + GITHUB_TASK_REPLY_RUN_MARKER_PREFIX.length + SERVER_RUN_ID_BYTES + " -->".length;

/**
 * Conservative UTF-8 limit for the caller-authored portion. New task runs use
 * UUID ids, and the publisher appends two newlines plus the hidden run marker.
 * Keeping the composed payload at or below GitHub's 65,536 comment ceiling
 * prevents an accepted body from becoming a terminal provider-side 422.
 */
export const GITHUB_TASK_REPLY_BODY_MAX_BYTES = GITHUB_COMMENT_MAX_BYTES - HIDDEN_SUFFIX_BYTES;
