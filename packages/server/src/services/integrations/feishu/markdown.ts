/** Escape untrusted text so a Markdown renderer preserves it as literal text. */
export function escapeMarkdownText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([`*_{}[\]()<>#+.!|~-])/g, "\\$1");
}

/**
 * Render untrusted text as one CommonMark code span.
 *
 * Backslashes do not escape backticks inside code spans, so the delimiter must
 * be longer than every backtick run in the payload. CommonMark's padding rule
 * then preserves leading/trailing backticks and spaces as code-node content.
 */
export function renderCodeSpan(value: string): string {
  const delimiter = "`".repeat(Math.max(1, longestBacktickRun(value) + 1));
  const allSpaces = /^ +$/.test(value);
  const needsPadding = !allSpaces && (value.includes("`") || value.startsWith(" ") || value.endsWith(" "));
  return needsPadding ? `${delimiter} ${value} ${delimiter}` : `${delimiter}${value}${delimiter}`;
}

/** Render untrusted code inside a fence that its own contents cannot close. */
export function renderCodeBlock(value: string, language: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(value) + 1));
  const safeLanguage = language.replace(/[^a-zA-Z0-9_+.-]/g, "").slice(0, 40);
  return `\n${fence}${safeLanguage}\n${value}\n${fence}\n`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const character of value) {
    if (character === "`") {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}
