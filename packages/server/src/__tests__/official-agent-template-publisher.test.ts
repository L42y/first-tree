import { type AgentTemplateDetail, agentTemplatePayloadSchema, type CreateAgentTemplate } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { syncOfficialAgentTemplateCatalog } from "../services/agents/templates/official-catalog-publisher.js";

const TOKEN = "2026-08-12T09:00:00.000Z";
const NEXT_TOKEN = "2026-08-12T09:05:00.000Z";

const DEFINITION: CreateAgentTemplate = {
  slug: "team-assistant",
  name: "Team Assistant",
  public: {
    tagline: "Recommended for a team's first AI teammate.",
    purpose: "Helps with everyday team work.",
    targetUsers: "Teams adopting their first agent.",
    userValue: "Start from a useful responsibility.",
    instructionsSummary: "Grounds work in team context.",
    toolsAndSkillsSummary: "Uses Team Resources after import.",
    exampleTasks: ["Summarize this discussion.", "Research an option and recommend a path."],
  },
  components: [
    {
      key: "team-assistant-instructions",
      type: "prompt",
      name: "Team Assistant Instructions",
      payload: { body: "Help the team.", description: "Core responsibilities." },
    },
  ],
};

function detail(overrides: Partial<AgentTemplateDetail> = {}): AgentTemplateDetail {
  return {
    id: "0190f000-0000-7000-8000-000000000001",
    slug: DEFINITION.slug,
    name: DEFINITION.name,
    status: "active",
    payload: agentTemplatePayloadSchema.parse({
      schemaVersion: 1,
      public: DEFINITION.public,
      components: DEFINITION.components,
    }),
    replacementTemplateId: null,
    createdBy: "member-1",
    updatedBy: "member-1",
    createdAt: TOKEN,
    updatedAt: TOKEN,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("official Agent Template catalog publisher", () => {
  it("previews missing launch Templates without mutating the catalog", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ templates: [] }));

    const result = await syncOfficialAgentTemplateCatalog({
      baseUrl: "https://opentag.example",
      accessToken: "publisher-token",
      definitions: [DEFINITION],
      apply: false,
      fetcher,
    });

    expect(result).toEqual([{ slug: DEFINITION.slug, action: "would-create-and-publish" }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://opentag.example/api/v1/internal/agent-templates",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer publisher-token" }) }),
    );
  });

  it("creates and publishes a missing Template through the governed endpoints", async () => {
    const draft = detail({ status: "draft" });
    const active = detail();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ templates: [] }))
      .mockResolvedValueOnce(jsonResponse(draft, 201))
      .mockResolvedValueOnce(jsonResponse(active));

    const result = await syncOfficialAgentTemplateCatalog({
      baseUrl: "https://opentag.example/",
      accessToken: "publisher-token",
      definitions: [DEFINITION],
      apply: true,
      fetcher,
    });

    expect(result).toEqual([{ slug: DEFINITION.slug, action: "created-and-published" }]);
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://opentag.example/api/v1/internal/agent-templates");
    const createRequest = fetcher.mock.calls[1]?.[1];
    expect(createRequest).toEqual(expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(createRequest?.body))).toEqual(DEFINITION);
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      `https://opentag.example/api/v1/internal/agent-templates/${draft.id}/publish`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedUpdatedAt: draft.updatedAt }) }),
    );
  });

  it("leaves an identical active Template unchanged", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ templates: [detail()] }));

    const result = await syncOfficialAgentTemplateCatalog({
      baseUrl: "https://opentag.example",
      accessToken: "publisher-token",
      definitions: [DEFINITION],
      apply: true,
      fetcher,
    });

    expect(result).toEqual([{ slug: DEFINITION.slug, action: "unchanged" }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("updates a changed active Template with its optimistic-concurrency token", async () => {
    const stored = detail({ name: "Old Team Assistant" });
    const updated = detail({ updatedAt: NEXT_TOKEN });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ templates: [stored] }))
      .mockResolvedValueOnce(jsonResponse(updated));

    const result = await syncOfficialAgentTemplateCatalog({
      baseUrl: "https://opentag.example",
      accessToken: "publisher-token",
      definitions: [DEFINITION],
      apply: true,
      fetcher,
    });

    expect(result).toEqual([{ slug: DEFINITION.slug, action: "updated" }]);
    expect(fetcher.mock.calls[1]?.[0]).toBe(`https://opentag.example/api/v1/internal/agent-templates/${stored.id}`);
    const updateRequest = fetcher.mock.calls[1]?.[1];
    expect(updateRequest).toEqual(expect.objectContaining({ method: "PATCH" }));
    expect(JSON.parse(String(updateRequest?.body))).toEqual({
      expectedUpdatedAt: TOKEN,
      name: DEFINITION.name,
      public: DEFINITION.public,
      components: DEFINITION.components,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("updates and publishes a changed draft using the refreshed concurrency token", async () => {
    const stored = detail({ name: "Old Team Assistant", status: "draft" });
    const updatedDraft = detail({ status: "draft", updatedAt: NEXT_TOKEN });
    const active = detail({ updatedAt: "2026-08-12T09:06:00.000Z" });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ templates: [stored] }))
      .mockResolvedValueOnce(jsonResponse(updatedDraft))
      .mockResolvedValueOnce(jsonResponse(active));

    const result = await syncOfficialAgentTemplateCatalog({
      baseUrl: "https://opentag.example",
      accessToken: "publisher-token",
      definitions: [DEFINITION],
      apply: true,
      fetcher,
    });

    expect(result).toEqual([{ slug: DEFINITION.slug, action: "updated-and-published" }]);
    expect(fetcher.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "PATCH" }));
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      `https://opentag.example/api/v1/internal/agent-templates/${stored.id}/publish`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedUpdatedAt: NEXT_TOKEN }) }),
    );
  });

  it("publishes a matching draft without issuing an update", async () => {
    const draft = detail({ status: "draft" });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ templates: [draft] }))
      .mockResolvedValueOnce(jsonResponse(detail()));

    const result = await syncOfficialAgentTemplateCatalog({
      baseUrl: "https://opentag.example",
      accessToken: "publisher-token",
      definitions: [DEFINITION],
      apply: true,
      fetcher,
    });

    expect(result).toEqual([{ slug: DEFINITION.slug, action: "published" }]);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      `https://opentag.example/api/v1/internal/agent-templates/${draft.id}/publish`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ expectedUpdatedAt: TOKEN }) }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed instead of replacing a retired official slug", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ templates: [detail({ status: "retired" })] }));

    await expect(
      syncOfficialAgentTemplateCatalog({
        baseUrl: "https://opentag.example",
        accessToken: "publisher-token",
        definitions: [DEFINITION],
        apply: true,
        fetcher,
      }),
    ).rejects.toThrow('Official Agent Template "team-assistant" is retired');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
