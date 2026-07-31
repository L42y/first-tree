import { describe, expect, it } from "vitest";
import {
  AGENT_TEMPLATE_MCP_STRING_MAX,
  AGENT_TEMPLATE_STATUSES,
  AGENT_TEMPLATE_WRITE_BODY_LIMIT,
  agentTemplateComponentSchema,
  agentTemplateDetailSchema,
  agentTemplateIdsSchema,
  agentTemplatePayloadSchema,
  agentTemplatePublicTemplateSchema,
  agentTemplateSlugSchema,
  agentTemplateStatusSchema,
  createAgentTemplateSchema,
  MAX_AGENT_TEMPLATE_COMPONENTS,
  MAX_AGENT_TEMPLATE_IDS,
  publishAgentTemplateSchema,
  retireAgentTemplateSchema,
  updateAgentTemplateSchema,
} from "../schemas/agent-template.js";
import { PROMPT_RESOURCE_BODY_MAX_CHARS } from "../schemas/resource.js";

const TEMPLATE_ID_A = "0190f000-0000-7000-8000-00000000000a";
const TEMPLATE_ID_B = "0190f000-0000-7000-8000-00000000000b";
const TEMPLATE_ID_C = "0190f000-0000-7000-8000-00000000000c";
const TEMPLATE_ID_D = "0190f000-0000-7000-8000-00000000000d";

const VALID_PUBLIC_PROFILE = {
  tagline: "Ship production-ready PRs faster",
  purpose: "A complete starting point for a pull-request engineering agent.",
  targetUsers: "Engineers running multiple agents in parallel.",
  userValue: "Start from a curated workflow instead of a blank configuration.",
  instructionsSummary: "Guides the agent through review-ready PR delivery.",
  toolsAndSkillsSummary: "Adds a review skill and a GitHub MCP server.",
};

const VALID_PROMPT_COMPONENT = {
  key: "instructions",
  type: "prompt",
  name: "PR Engineer Instructions",
  payload: { body: "You are a PR engineer.", description: "Core instructions" },
};

const VALID_SKILL_COMPONENT = {
  key: "review-skill",
  type: "skill",
  name: "Review Skill",
  payload: {
    name: "review",
    description: "Review a pull request.",
    body: "# Review\nDo the review.",
    metadata: {},
  },
  bundle: { attachmentId: TEMPLATE_ID_A, format: "zip", sizeBytes: 1024 },
};

const VALID_MCP_COMPONENT = {
  key: "github-mcp",
  type: "mcp",
  name: "GitHub MCP",
  payload: { name: "github", transport: "http", url: "https://mcp.github.example/mcp" },
};

function validPayload(components: unknown[] = [VALID_PROMPT_COMPONENT, VALID_SKILL_COMPONENT, VALID_MCP_COMPONENT]) {
  return { schemaVersion: 1, public: VALID_PUBLIC_PROFILE, components };
}

describe("agentTemplateStatusSchema", () => {
  it("accepts the three lifecycle states", () => {
    for (const status of Object.values(AGENT_TEMPLATE_STATUSES)) {
      expect(agentTemplateStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects unknown states", () => {
    expect(agentTemplateStatusSchema.safeParse("archived").success).toBe(false);
  });
});

describe("agentTemplateIdsSchema", () => {
  it("accepts 0 to MAX_AGENT_TEMPLATE_IDS ids", () => {
    expect(agentTemplateIdsSchema.parse([])).toEqual([]);
    expect(agentTemplateIdsSchema.parse([TEMPLATE_ID_A])).toEqual([TEMPLATE_ID_A]);
    expect(MAX_AGENT_TEMPLATE_IDS).toBe(3);
    expect(agentTemplateIdsSchema.parse([TEMPLATE_ID_A, TEMPLATE_ID_B, TEMPLATE_ID_C])).toHaveLength(3);
  });

  it("rejects more than MAX_AGENT_TEMPLATE_IDS ids", () => {
    const result = agentTemplateIdsSchema.safeParse([TEMPLATE_ID_A, TEMPLATE_ID_B, TEMPLATE_ID_C, TEMPLATE_ID_D]);
    expect(result.success).toBe(false);
  });

  it("rejects duplicate ids", () => {
    const result = agentTemplateIdsSchema.safeParse([TEMPLATE_ID_A, TEMPLATE_ID_B, TEMPLATE_ID_A]);
    expect(result.success).toBe(false);
  });

  it("normalizes uppercase hex to lowercase", () => {
    const upper = TEMPLATE_ID_A.toUpperCase();
    expect(agentTemplateIdsSchema.parse([upper])).toEqual([TEMPLATE_ID_A]);
  });

  it("treats mixed-case spellings of the same UUID as duplicates", () => {
    const result = agentTemplateIdsSchema.safeParse([TEMPLATE_ID_A, TEMPLATE_ID_A.toUpperCase()]);
    expect(result.success).toBe(false);
  });

  it("normalizes to a canonical sorted order so position carries no priority", () => {
    expect(agentTemplateIdsSchema.parse([TEMPLATE_ID_C, TEMPLATE_ID_A, TEMPLATE_ID_B])).toEqual([
      TEMPLATE_ID_A,
      TEMPLATE_ID_B,
      TEMPLATE_ID_C,
    ]);
  });

  it("rejects non-uuid ids", () => {
    expect(agentTemplateIdsSchema.safeParse(["not-a-uuid"]).success).toBe(false);
  });
});

describe("agentTemplatePayloadSchema", () => {
  it("accepts a complete payload with prompt, skill, and mcp components", () => {
    const parsed = agentTemplatePayloadSchema.parse(validPayload());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.components).toHaveLength(3);
  });

  it("requires schemaVersion 1", () => {
    expect(agentTemplatePayloadSchema.safeParse({ ...validPayload(), schemaVersion: 2 }).success).toBe(false);
  });

  it("rejects unknown top-level fields (strict)", () => {
    const result = agentTemplatePayloadSchema.safeParse({ ...validPayload(), internalNotes: "secret" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields in the public profile (strict)", () => {
    const result = agentTemplatePayloadSchema.safeParse(
      validPayloadWithPublic({ ...VALID_PUBLIC_PROFILE, rawInstructions: "do not leak" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects duplicate component keys within one Template", () => {
    const secondPrompt = { ...VALID_PROMPT_COMPONENT, name: "Other Instructions" };
    const result = agentTemplatePayloadSchema.safeParse(validPayload([VALID_PROMPT_COMPONENT, secondPrompt]));
    expect(result.success).toBe(false);
  });

  it("rejects repo components", () => {
    const repoComponent = {
      key: "repo",
      type: "repo",
      name: "Repo",
      payload: { url: "https://github.com/example/repo" },
    };
    expect(agentTemplateComponentSchema.safeParse(repoComponent).success).toBe(false);
  });

  it("rejects invalid component keys", () => {
    const bad = { ...VALID_PROMPT_COMPONENT, key: "Not A Key" };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects component keys that are not strict kebab-case segments", () => {
    for (const key of ["trailing-", "-leading", "double--dash", "UPPER", "under_score", ""]) {
      const bad = { ...VALID_PROMPT_COMPONENT, key };
      expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
    }
    for (const key of ["a", "segment", "many-segment-key", "with-123-numbers"]) {
      const good = { ...VALID_PROMPT_COMPONENT, key };
      expect(agentTemplateComponentSchema.safeParse(good).success).toBe(true);
    }
  });

  it("prompt components reject unknown nested payload fields (strict payload)", () => {
    const bad = {
      ...VALID_PROMPT_COMPONENT,
      payload: { ...VALID_PROMPT_COMPONENT.payload, resourceId: TEMPLATE_ID_A },
    };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });

  it("skill components reject unknown nested payload fields (strict payload)", () => {
    const bad = {
      ...VALID_SKILL_COMPONENT,
      payload: { ...VALID_SKILL_COMPONENT.payload, resourceId: TEMPLATE_ID_A },
    };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects mcp payloads carrying url credentials", () => {
    const bad = {
      ...VALID_MCP_COMPONENT,
      payload: { name: "github", transport: "http", url: "https://user:pass@mcp.github.example/mcp" },
    };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects http/sse mcp urls carrying query or fragment data", () => {
    const cases = [
      { name: "github", transport: "http", url: "https://mcp.github.example/mcp?token=abc" },
      { name: "github", transport: "http", url: "https://mcp.github.example/mcp#token=abc" },
      { name: "github", transport: "sse", url: "https://mcp.github.example/sse?key=abc" },
      { name: "github", transport: "sse", url: "https://mcp.github.example/sse#fragment" },
    ];
    for (const payload of cases) {
      const bad = { ...VALID_MCP_COMPONENT, payload };
      expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("fails invalid http/sse mcp urls as ordinary Zod failures without throwing", () => {
    const cases = [
      { name: "github", transport: "http", url: "not-a-url" },
      { name: "github", transport: "sse", url: "not-a-url" },
    ];
    for (const payload of cases) {
      const bad = { ...VALID_MCP_COMPONENT, payload };
      let result: ReturnType<typeof agentTemplateComponentSchema.safeParse> | undefined;
      expect(() => {
        result = agentTemplateComponentSchema.safeParse(bad);
      }).not.toThrow();
      expect(result?.success).toBe(false);
    }
  });

  it("rejects stdio mcp servers carrying command arguments", () => {
    const bad = {
      ...VALID_MCP_COMPONENT,
      payload: { name: "local", transport: "stdio", command: "npx", args: ["--token=secret"] },
    };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts stdio mcp servers without arguments", () => {
    const withoutArgs = {
      ...VALID_MCP_COMPONENT,
      payload: { name: "local", transport: "stdio", command: "github-mcp-server" },
    };
    expect(agentTemplateComponentSchema.safeParse(withoutArgs).success).toBe(true);
    const emptyArgs = {
      ...VALID_MCP_COMPONENT,
      payload: { name: "local", transport: "stdio", command: "github-mcp-server", args: [] },
    };
    expect(agentTemplateComponentSchema.safeParse(emptyArgs).success).toBe(true);
  });

  it("rejects prompt bodies containing the generated-briefing marker", () => {
    const bad = {
      ...VALID_PROMPT_COMPONENT,
      payload: {
        body: "<!-- first-tree:generated -->\n# Working in First Tree\n...",
        description: "Copied assembled briefing",
      },
    };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts clean prompt bodies", () => {
    expect(agentTemplateComponentSchema.safeParse(VALID_PROMPT_COMPONENT).success).toBe(true);
  });

  it("skill components reuse the runtime complete-directory bundle descriptor", () => {
    const parsed = agentTemplateComponentSchema.parse(VALID_SKILL_COMPONENT);
    expect(parsed.type).toBe("skill");
    if (parsed.type !== "skill") throw new Error("unreachable");
    // The bundle descriptor references an immutable ZIP attachment holding the
    // complete Skill directory (SKILL.md plus supporting files) — the same
    // shape Team Skills use at runtime.
    expect(parsed.bundle).toEqual({ attachmentId: TEMPLATE_ID_A, format: "zip", sizeBytes: 1024 });
  });

  it("skill components require a bundle descriptor", () => {
    const { bundle: _bundle, ...withoutBundle } = VALID_SKILL_COMPONENT;
    expect(agentTemplateComponentSchema.safeParse(withoutBundle).success).toBe(false);
  });

  it("skill components reject non-zip bundle formats", () => {
    const bad = { ...VALID_SKILL_COMPONENT, bundle: { ...VALID_SKILL_COMPONENT.bundle, format: "tar" } };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown fields inside components (strict)", () => {
    const bad = { ...VALID_MCP_COMPONENT, resourceId: "0190f000-0000-7000-8000-0000000000ff" };
    expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
  });
});

function validPayloadWithPublic(publicProfile: unknown) {
  return { schemaVersion: 1, public: publicProfile, components: [VALID_PROMPT_COMPONENT] };
}

describe("catalog governance contracts", () => {
  const TOKEN = "2026-07-31T03:00:23.568911Z";

  function validCreate() {
    return {
      slug: "pr-engineer",
      name: "PR Engineer",
      public: VALID_PUBLIC_PROFILE,
      components: [VALID_PROMPT_COMPONENT],
    };
  }

  it("accepts strict kebab-case slugs and rejects malformed ones", () => {
    expect(agentTemplateSlugSchema.parse("pr-engineer-2")).toBe("pr-engineer-2");
    for (const slug of ["PR-Engineer", "trailing-", "double--dash", "with space", "under_score", ""]) {
      expect(agentTemplateSlugSchema.safeParse(slug).success).toBe(false);
    }
  });

  it("create rejects unknown top-level fields", () => {
    const bad = { ...validCreate(), components2: [] };
    expect(createAgentTemplateSchema.safeParse(bad).success).toBe(false);
  });

  it("skill write source carries only key and bundleAttachmentId", () => {
    const source = { key: "review", type: "skill", bundleAttachmentId: TEMPLATE_ID_A };
    const accepted = createAgentTemplateSchema.safeParse({ ...validCreate(), components: [source] });
    expect(accepted.success).toBe(true);

    for (const smuggled of [
      { ...source, name: "caller-chosen" },
      { ...source, payload: { name: "x", description: "y", body: "z", metadata: {} } },
      { ...source, bundle: { attachmentId: TEMPLATE_ID_A, format: "zip", sizeBytes: 1 } },
    ]) {
      const rejected = createAgentTemplateSchema.safeParse({ ...validCreate(), components: [smuggled] });
      expect(rejected.success).toBe(false);
    }
  });

  it("rejects duplicate component keys across types", () => {
    const create = createAgentTemplateSchema.safeParse({
      ...validCreate(),
      components: [
        { ...VALID_PROMPT_COMPONENT, key: "shared-key" },
        { key: "shared-key", type: "skill", bundleAttachmentId: TEMPLATE_ID_A },
      ],
    });
    expect(create.success).toBe(false);

    const update = updateAgentTemplateSchema.safeParse({
      expectedUpdatedAt: TOKEN,
      components: [
        { ...VALID_PROMPT_COMPONENT, key: "shared-key" },
        { key: "shared-key", type: "skill", bundleAttachmentId: TEMPLATE_ID_A },
      ],
    });
    expect(update.success).toBe(false);
  });

  it("rejects an update carrying no fields", () => {
    expect(updateAgentTemplateSchema.safeParse({ expectedUpdatedAt: TOKEN }).success).toBe(false);
    expect(updateAgentTemplateSchema.safeParse({ expectedUpdatedAt: TOKEN, name: "New name" }).success).toBe(true);
  });

  it("lifecycle requests are strict and require a valid timestamp token", () => {
    expect(publishAgentTemplateSchema.safeParse({ expectedUpdatedAt: TOKEN }).success).toBe(true);
    expect(publishAgentTemplateSchema.safeParse({ expectedUpdatedAt: TOKEN, extra: 1 }).success).toBe(false);
    expect(publishAgentTemplateSchema.safeParse({ expectedUpdatedAt: "not-a-time" }).success).toBe(false);
    expect(
      retireAgentTemplateSchema.safeParse({ expectedUpdatedAt: TOKEN, replacementTemplateId: TEMPLATE_ID_B }).success,
    ).toBe(true);
    expect(
      retireAgentTemplateSchema.safeParse({ expectedUpdatedAt: TOKEN, replacementTemplateId: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("public and internal DTOs reject out-of-contract fields", () => {
    const publicTemplate = {
      id: TEMPLATE_ID_A,
      slug: "pr-engineer",
      name: "PR Engineer",
      status: "active",
      public: VALID_PUBLIC_PROFILE,
      updatedAt: TOKEN,
      replacement: null,
    };
    expect(agentTemplatePublicTemplateSchema.safeParse(publicTemplate).success).toBe(true);
    expect(agentTemplatePublicTemplateSchema.safeParse({ ...publicTemplate, components: [] }).success).toBe(false);
    expect(agentTemplatePublicTemplateSchema.safeParse({ ...publicTemplate, updatedAt: "whenever" }).success).toBe(
      false,
    );

    const detail = {
      id: TEMPLATE_ID_A,
      slug: "pr-engineer",
      name: "PR Engineer",
      status: "draft",
      payload: { schemaVersion: 1, public: VALID_PUBLIC_PROFILE, components: [VALID_PROMPT_COMPONENT] },
      replacementTemplateId: null,
      createdBy: "member-1",
      updatedBy: "member-1",
      createdAt: TOKEN,
      updatedAt: TOKEN,
    };
    expect(agentTemplateDetailSchema.safeParse(detail).success).toBe(true);
    expect(agentTemplateDetailSchema.safeParse({ ...detail, secret: true }).success).toBe(false);
    expect(agentTemplateDetailSchema.safeParse({ ...detail, createdAt: "whenever" }).success).toBe(false);
  });
});

describe("MCP runtime-faithful contract", () => {
  it("requires the canonical MCP name pattern on http/sse payloads", () => {
    for (const name of ["GitHub MCP", "with space", "-leading-dash", "name/with", ""]) {
      const bad = { ...VALID_MCP_COMPONENT, payload: { name, transport: "http", url: "https://mcp.example/x" } };
      expect(agentTemplateComponentSchema.safeParse(bad).success).toBe(false);
    }
    for (const name of ["github", "github-mcp", "mcp_2", "A-valid"]) {
      const good = { ...VALID_MCP_COMPONENT, payload: { name, transport: "http", url: "https://mcp.example/x" } };
      expect(agentTemplateComponentSchema.safeParse(good).success).toBe(true);
    }
  });

  it("rejects duplicate MCP payload names case-insensitively, across transports and keys", () => {
    const httpGithub = {
      key: "a",
      type: "mcp",
      name: "A",
      payload: { name: "github", transport: "http", url: "https://mcp.example/a" },
    };
    const httpGithubCase = {
      key: "b",
      type: "mcp",
      name: "B",
      payload: { name: "GitHub", transport: "http", url: "https://mcp.example/b" },
    };
    const stdioGithub = {
      key: "c",
      type: "mcp",
      name: "C",
      payload: { name: "GITHUB", transport: "stdio", command: "github-mcp" },
    };

    const payloadDup = agentTemplatePayloadSchema.safeParse({
      schemaVersion: 1,
      public: VALID_PUBLIC_PROFILE,
      components: [httpGithub, httpGithubCase],
    });
    expect(payloadDup.success).toBe(false);
    if (!payloadDup.success) {
      expect(payloadDup.error.issues.some((issue) => issue.path.join(".") === "components.1.payload.name")).toBe(true);
    }

    const crossTransport = agentTemplatePayloadSchema.safeParse({
      schemaVersion: 1,
      public: VALID_PUBLIC_PROFILE,
      components: [httpGithub, stdioGithub],
    });
    expect(crossTransport.success).toBe(false);

    const createDup = createAgentTemplateSchema.safeParse({
      slug: "dup-mcp",
      name: "Dup",
      public: VALID_PUBLIC_PROFILE,
      components: [httpGithub, httpGithubCase],
    });
    expect(createDup.success).toBe(false);

    const updateDup = updateAgentTemplateSchema.safeParse({
      expectedUpdatedAt: "2026-07-31T03:00:23.568911Z",
      components: [httpGithub, stdioGithub],
    });
    expect(updateDup.success).toBe(false);

    const distinct = agentTemplatePayloadSchema.safeParse({
      schemaVersion: 1,
      public: VALID_PUBLIC_PROFILE,
      components: [
        httpGithub,
        { key: "b", type: "mcp", name: "B", payload: { name: "gitlab", transport: "stdio", command: "gitlab-mcp" } },
      ],
    });
    expect(distinct.success).toBe(true);
  });
});

describe("write-size contract", () => {
  it("links the component cap and the write body limit", () => {
    expect(MAX_AGENT_TEMPLATE_COMPONENTS).toBe(100);
    expect(Number.isFinite(AGENT_TEMPLATE_WRITE_BODY_LIMIT)).toBe(true);
    // The limit must cover the largest schema-valid payload: 100 full-size
    // Prompt bodies at the 6x worst JSON escape inflation.
    expect(AGENT_TEMPLATE_WRITE_BODY_LIMIT).toBeGreaterThanOrEqual(
      MAX_AGENT_TEMPLATE_COMPONENTS * PROMPT_RESOURCE_BODY_MAX_CHARS * 6,
    );

    const components = Array.from({ length: MAX_AGENT_TEMPLATE_COMPONENTS }, (_, index) => ({
      ...VALID_PROMPT_COMPONENT,
      key: `prompt-${index}`,
    }));
    const atCap = createAgentTemplateSchema.safeParse({
      slug: "at-cap",
      name: "At Cap",
      public: VALID_PUBLIC_PROFILE,
      components,
    });
    expect(atCap.success).toBe(true);
    const overCap = createAgentTemplateSchema.safeParse({
      slug: "over-cap",
      name: "Over Cap",
      public: VALID_PUBLIC_PROFILE,
      components: [...components, { ...VALID_PROMPT_COMPONENT, key: "prompt-100" }],
    });
    expect(overCap.success).toBe(false);
  });

  it("covers the fully-filled maximum contract within the body limit", () => {
    // U+0001 is PostgreSQL-persistable but still requires a six-byte JSON
    // escape, so filling every free-text field with it produces the largest
    // schema-valid write the route limit must accept. (Actual U+0000 is
    // rejected by the Template text contract — see the next describe.)
    const escaped = (length: number) => String.fromCharCode(1).repeat(length);
    const payload = {
      slug: "a".repeat(100),
      name: escaped(200),
      public: {
        tagline: escaped(200),
        purpose: escaped(2000),
        targetUsers: escaped(1000),
        userValue: escaped(2000),
        instructionsSummary: escaped(2000),
        toolsAndSkillsSummary: escaped(2000),
      },
      components: Array.from({ length: MAX_AGENT_TEMPLATE_COMPONENTS }, (_, index) => ({
        key: `${"p".repeat(97)}${String(index).padStart(3, "0")}`,
        type: "prompt",
        name: escaped(200),
        payload: { body: escaped(PROMPT_RESOURCE_BODY_MAX_CHARS), description: escaped(1000) },
      })),
    };
    // The shape itself is schema-valid — the escape cost is transport-only.
    expect(createAgentTemplateSchema.safeParse(payload).success).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    expect(bytes).toBeGreaterThan(MAX_AGENT_TEMPLATE_COMPONENTS * PROMPT_RESOURCE_BODY_MAX_CHARS * 4);
    expect(bytes).toBeLessThan(AGENT_TEMPLATE_WRITE_BODY_LIMIT);
  });

  it("caps Template MCP urls and stdio commands at 8 KiB", () => {
    const longUrl = `https://mcp.example/${"a".repeat(AGENT_TEMPLATE_MCP_STRING_MAX)}`;
    const urlTooLong = {
      ...VALID_MCP_COMPONENT,
      payload: { name: "github", transport: "http", url: longUrl },
    };
    expect(agentTemplateComponentSchema.safeParse(urlTooLong).success).toBe(false);
    const urlAtCap = {
      ...VALID_MCP_COMPONENT,
      payload: {
        name: "github",
        transport: "sse",
        url: `https://mcp.example/${"a".repeat(AGENT_TEMPLATE_MCP_STRING_MAX - 24)}`,
      },
    };
    expect(agentTemplateComponentSchema.safeParse(urlAtCap).success).toBe(true);

    const commandTooLong = {
      ...VALID_MCP_COMPONENT,
      payload: { name: "github", transport: "stdio", command: "x".repeat(AGENT_TEMPLATE_MCP_STRING_MAX + 1) },
    };
    expect(agentTemplateComponentSchema.safeParse(commandTooLong).success).toBe(false);
    const commandAtCap = {
      ...VALID_MCP_COMPONENT,
      payload: { name: "github", transport: "stdio", command: "x".repeat(AGENT_TEMPLATE_MCP_STRING_MAX) },
    };
    expect(agentTemplateComponentSchema.safeParse(commandAtCap).success).toBe(true);
  });
});

describe("PostgreSQL text compatibility", () => {
  const NUL = String.fromCharCode(0);

  function createWith(components: unknown[], overrides: Record<string, unknown> = {}) {
    return { slug: "nul-check", name: "NUL check", public: VALID_PUBLIC_PROFILE, components, ...overrides };
  }

  function expectPath(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } }, path: string) {
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues.some((issue) => issue.path.join(".") === path)).toBe(true);
  }

  it("rejects actual U+0000 in Template name and public profile", () => {
    expectPath(
      createAgentTemplateSchema.safeParse(createWith([VALID_PROMPT_COMPONENT], { name: `bad${NUL}name` })),
      "name",
    );
    const badPublic = { ...VALID_PUBLIC_PROFILE, tagline: `bad${NUL}tagline` };
    expectPath(
      createAgentTemplateSchema.safeParse(createWith([VALID_PROMPT_COMPONENT], { public: badPublic })),
      "public.tagline",
    );
  });

  it("rejects actual U+0000 in prompt body and description", () => {
    const badBody = {
      ...VALID_PROMPT_COMPONENT,
      payload: { body: `run${NUL}this`, description: "ok" },
    };
    expectPath(createAgentTemplateSchema.safeParse(createWith([badBody])), "components.0.payload.body");
    const badDescription = {
      ...VALID_PROMPT_COMPONENT,
      payload: { body: "ok", description: `bad${NUL}desc` },
    };
    expectPath(
      updateAgentTemplateSchema.safeParse({
        expectedUpdatedAt: "2026-07-31T03:00:23.568911Z",
        components: [badDescription],
      }),
      "components.0.payload.description",
    );
  });

  it("rejects actual U+0000 in stdio commands", () => {
    const badCommand = {
      key: "mcp",
      type: "mcp",
      name: "MCP",
      payload: { name: "local", transport: "stdio", command: `run${NUL}cmd` },
    };
    expectPath(createAgentTemplateSchema.safeParse(createWith([badCommand])), "components.0.payload.command");
  });

  it("rejects actual U+0000 in the canonical payload, including skill text and nested metadata", () => {
    const base = { schemaVersion: 1, public: VALID_PUBLIC_PROFILE };
    const badSkillBody = agentTemplatePayloadSchema.safeParse({
      ...base,
      components: [
        {
          ...VALID_SKILL_COMPONENT,
          payload: { ...VALID_SKILL_COMPONENT.payload, body: `body${NUL}here` },
        },
      ],
    });
    expectPath(badSkillBody, "components.0.payload.body");

    const badSkillDescription = agentTemplatePayloadSchema.safeParse({
      ...base,
      components: [
        {
          ...VALID_SKILL_COMPONENT,
          payload: { ...VALID_SKILL_COMPONENT.payload, description: `desc${NUL}here` },
        },
      ],
    });
    expectPath(badSkillDescription, "components.0.payload.description");

    const nestedMetadataValue = agentTemplatePayloadSchema.safeParse({
      ...base,
      components: [
        {
          ...VALID_SKILL_COMPONENT,
          payload: { ...VALID_SKILL_COMPONENT.payload, metadata: { outer: { list: ["ok", `bad${NUL}`] } } },
        },
      ],
    });
    expectPath(nestedMetadataValue, "components.0.payload.metadata.outer.list.1");

    const nulMetadataKey: Record<string, unknown> = {};
    nulMetadataKey[`bad${NUL}key`] = "value";
    const badMetadataKey = agentTemplatePayloadSchema.safeParse({
      ...base,
      components: [
        {
          ...VALID_SKILL_COMPONENT,
          payload: { ...VALID_SKILL_COMPONENT.payload, metadata: { nested: nulMetadataKey } },
        },
      ],
    });
    expect(badMetadataKey.success).toBe(false);
  });

  it("keeps the literal six-character text legal", () => {
    const literal = {
      ...VALID_PROMPT_COMPONENT,
      payload: { body: "literal \\u0000 text stays legal", description: "ok" },
    };
    expect(createAgentTemplateSchema.safeParse(createWith([literal])).success).toBe(true);
    expect(
      agentTemplatePayloadSchema.safeParse({ schemaVersion: 1, public: VALID_PUBLIC_PROFILE, components: [literal] })
        .success,
    ).toBe(true);
  });
});
