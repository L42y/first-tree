import type { DocStatus, DocSummary, DocWithVersion } from "@first-tree/shared";
import { api, withOrg } from "./api";

export type { DocStatus, DocSummary, DocWithVersion };

/**
 * Document review (docloop) API — same org-scoped `/documents` surface the
 * web console's Context → Docs pages use.
 */

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export async function listDocs(
  input: { status?: DocStatus; limit?: number; slug?: string } = {},
  signal?: AbortSignal,
): Promise<{ items: DocSummary[] }> {
  return api.get<{ items: DocSummary[] }>(
    `${withOrg("/documents")}${query({ ...input })}`,
    { signal },
  );
}

/** Resolve a slug to its doc id via the list surface, then fetch the full document. */
export async function getDocBySlug(
  slug: string,
  signal?: AbortSignal,
): Promise<{ doc: DocSummary; content: string } | null> {
  const list = await listDocs({ slug }, signal);
  const summary = list.items[0];
  if (!summary) return null;
  const doc = await api.get<DocWithVersion>(withOrg(`/documents/${summary.id}`), { signal });
  return { doc: summary, content: doc.version?.content ?? "" };
}
