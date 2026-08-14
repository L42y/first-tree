export function safeFeishuErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(Bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/(["']?app_secret["']?\s*[:=]\s*)["']?[^"',\s}]+/gi, "$1[REDACTED]")
    .slice(0, 2_000);
}

export function safeFeishuErrorContext(error: unknown): { errorCode: string | null; errorMessage: string } {
  return { errorCode: readErrorCode(error), errorMessage: safeFeishuErrorMessage(error) };
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? String(code) : null;
}
