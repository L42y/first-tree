import { parse } from "yaml";
import { z } from "zod";

export const CONTEXT_TREE_SCOPE_MAX_BYTES = 16 * 1024;

export const credentialFreeRepositoryUrlSchema = z.url().superRefine((value, context) => {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "Related repository URLs must use HTTP or HTTPS." });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    context.addIssue({
      code: "custom",
      message: "Related repository URLs must not contain credentials, query parameters, or fragments.",
    });
  }
});

export const contextTreeScopeFrontmatterSchema = z
  .object({
    schemaVersion: z.literal(1),
    relatedRepositories: z.array(credentialFreeRepositoryUrlSchema).max(64).optional(),
  })
  .strict();
export type ContextTreeScopeFrontmatter = z.infer<typeof contextTreeScopeFrontmatterSchema>;

export const contextTreeScopeSchema = z
  .object({
    frontmatter: contextTreeScopeFrontmatterSchema,
    body: z.string().trim().min(1, "SCOPE.md body must describe what this Context Tree covers."),
  })
  .strict();
export type ContextTreeScope = z.infer<typeof contextTreeScopeSchema>;

export function parseContextTreeScopeMarkdown(markdown: string): ContextTreeScope {
  if (Buffer.byteLength(markdown, "utf8") > CONTEXT_TREE_SCOPE_MAX_BYTES) {
    throw new Error(`SCOPE.md exceeds the ${CONTEXT_TREE_SCOPE_MAX_BYTES}-byte limit.`);
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(markdown);
  if (!match?.[1]) throw new Error("SCOPE.md must contain YAML frontmatter.");
  let parsed: unknown;
  try {
    parsed = parse(match[1]);
  } catch (error) {
    throw new Error(`SCOPE.md frontmatter is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const frontmatter = contextTreeScopeFrontmatterSchema.parse(parsed);
  return contextTreeScopeSchema.parse({ frontmatter, body: match[2] ?? "" });
}
