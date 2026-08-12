import { isDeepStrictEqual } from "node:util";
import {
  type AgentTemplateComponent,
  type AgentTemplateComponentInput,
  type AgentTemplateDetail,
  agentTemplateDetailListSchema,
  agentTemplateDetailSchema,
  type CreateAgentTemplate,
  createAgentTemplateSchema,
} from "@first-tree/shared";

export type OfficialCatalogSyncAction =
  | "would-create-and-publish"
  | "would-update"
  | "would-update-and-publish"
  | "would-publish"
  | "created-and-published"
  | "updated"
  | "updated-and-published"
  | "published"
  | "unchanged";

export type OfficialCatalogSyncResult = {
  slug: string;
  action: OfficialCatalogSyncAction;
};

export type SyncOfficialAgentTemplateCatalogOptions = {
  baseUrl: string;
  accessToken: string;
  definitions: readonly CreateAgentTemplate[];
  apply: boolean;
  fetcher?: typeof fetch;
};

function catalogUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Agent Template publisher base URL must use HTTP or HTTPS.");
  }
  return new URL("/api/v1/internal/agent-templates", parsed).toString();
}

async function requestJson(
  fetcher: typeof fetch,
  accessToken: string,
  url: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
): Promise<unknown> {
  const response = await fetcher(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`Agent Template publisher request ${method} ${new URL(url).pathname} returned ${response.status}.`);
  }
  return response.json();
}

function componentMatches(stored: AgentTemplateComponent, source: AgentTemplateComponentInput): boolean {
  if (stored.type !== source.type || stored.key !== source.key) return false;
  if (source.type === "skill") {
    return stored.type === "skill" && stored.bundle.attachmentId === source.bundleAttachmentId;
  }
  return isDeepStrictEqual(stored, source);
}

function templateMatches(stored: AgentTemplateDetail, source: CreateAgentTemplate): boolean {
  if (stored.name !== source.name || !isDeepStrictEqual(stored.payload.public, source.public)) return false;
  if (stored.payload.components.length !== source.components.length) return false;
  return source.components.every((component, index) => {
    const storedComponent = stored.payload.components[index];
    return storedComponent !== undefined && componentMatches(storedComponent, component);
  });
}

async function createTemplate(
  fetcher: typeof fetch,
  accessToken: string,
  url: string,
  definition: CreateAgentTemplate,
): Promise<AgentTemplateDetail> {
  const response = await requestJson(fetcher, accessToken, url, "POST", definition);
  return agentTemplateDetailSchema.parse(response);
}

async function updateTemplate(
  fetcher: typeof fetch,
  accessToken: string,
  url: string,
  stored: AgentTemplateDetail,
  definition: CreateAgentTemplate,
): Promise<AgentTemplateDetail> {
  const response = await requestJson(fetcher, accessToken, `${url}/${stored.id}`, "PATCH", {
    expectedUpdatedAt: stored.updatedAt,
    name: definition.name,
    public: definition.public,
    components: definition.components,
  });
  return agentTemplateDetailSchema.parse(response);
}

async function publishTemplate(
  fetcher: typeof fetch,
  accessToken: string,
  url: string,
  draft: AgentTemplateDetail,
): Promise<AgentTemplateDetail> {
  const response = await requestJson(fetcher, accessToken, `${url}/${draft.id}/publish`, "POST", {
    expectedUpdatedAt: draft.updatedAt,
  });
  return agentTemplateDetailSchema.parse(response);
}

/**
 * Reconcile checked-in official definitions through the existing Publisher
 * Team API. Preview is read-only; apply never retires Templates or replaces a
 * retired slug, and every mutation remains guarded by the server's live
 * Publisher Team membership check and optimistic-concurrency token.
 */
export async function syncOfficialAgentTemplateCatalog(
  options: SyncOfficialAgentTemplateCatalogOptions,
): Promise<OfficialCatalogSyncResult[]> {
  if (options.accessToken.length === 0) throw new Error("Agent Template publisher access token is required.");
  const definitions = createAgentTemplateSchema.array().parse(options.definitions);
  const fetcher = options.fetcher ?? fetch;
  const url = catalogUrl(options.baseUrl);
  const current = agentTemplateDetailListSchema.parse(await requestJson(fetcher, options.accessToken, url, "GET"));
  const bySlug = new Map(current.templates.map((template) => [template.slug, template]));
  const results: OfficialCatalogSyncResult[] = [];

  for (const definition of definitions) {
    const stored = bySlug.get(definition.slug);
    if (!stored) {
      if (!options.apply) {
        results.push({ slug: definition.slug, action: "would-create-and-publish" });
        continue;
      }
      const draft = await createTemplate(fetcher, options.accessToken, url, definition);
      await publishTemplate(fetcher, options.accessToken, url, draft);
      results.push({ slug: definition.slug, action: "created-and-published" });
      continue;
    }

    if (stored.status === "retired") {
      throw new Error(`Official Agent Template "${definition.slug}" is retired; publish a new slug instead.`);
    }

    const matches = templateMatches(stored, definition);
    if (!matches && !options.apply) {
      results.push({
        slug: definition.slug,
        action: stored.status === "draft" ? "would-update-and-publish" : "would-update",
      });
      continue;
    }
    if (matches && stored.status === "draft" && !options.apply) {
      results.push({ slug: definition.slug, action: "would-publish" });
      continue;
    }
    if (matches && stored.status === "active") {
      results.push({ slug: definition.slug, action: "unchanged" });
      continue;
    }

    const reconciled = matches ? stored : await updateTemplate(fetcher, options.accessToken, url, stored, definition);
    if (reconciled.status === "draft") {
      await publishTemplate(fetcher, options.accessToken, url, reconciled);
      results.push({ slug: definition.slug, action: matches ? "published" : "updated-and-published" });
    } else {
      results.push({ slug: definition.slug, action: "updated" });
    }
  }

  return results;
}
