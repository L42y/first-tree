import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CreateAgentTemplate, createAgentTemplateSchema } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { members } from "../db/schema/members.js";
import { organizations } from "../db/schema/organizations.js";
import { createAgent } from "../services/agents/identity.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, useTestApp } from "./helpers.js";

const PUBLISHER_ORG_ID = "official-launch-template-publisher-org-test";
const INTERNAL_URL = "/api/v1/internal/agent-templates";
const PUBLIC_URL = "/api/v1/agent-templates";
const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(here, "../../catalog/official-agent-templates.json");

type TestApp = ReturnType<ReturnType<typeof useTestApp>>;

function loadCatalog(): CreateAgentTemplate[] {
  const source: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
  return createAgentTemplateSchema.array().length(3).parse(source);
}

async function createPublisherAdmin(app: TestApp) {
  const admin = await createTestAdmin(app, { username: `launch-publisher-${crypto.randomUUID().slice(0, 8)}` });
  await app.db
    .insert(organizations)
    .values({ id: PUBLISHER_ORG_ID, name: "launch-publisher", displayName: "Launch Publisher" })
    .onConflictDoNothing();
  const memberId = uuidv7();
  await app.db.transaction(async (tx) => {
    const human = await createAgent(tx as unknown as typeof app.db, {
      name: `launch-publisher-human-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "Launch Publisher Human",
      managerId: memberId,
      organizationId: PUBLISHER_ORG_ID,
    });
    await tx.insert(members).values({
      id: memberId,
      userId: admin.userId,
      organizationId: PUBLISHER_ORG_ID,
      agentId: human.uuid,
      role: "admin",
    });
  });
  return admin;
}

describe("official launch Agent Template catalog", () => {
  const getApp = useTestApp({ agentTemplatePublisherOrgId: PUBLISHER_ORG_ID });

  it("defines the three bounded, importable launch Templates", () => {
    const catalog = loadCatalog();
    expect(catalog.map((template) => template.slug)).toEqual(["team-assistant", "software-engineer", "researcher"]);
    expect(catalog.map((template) => template.name)).toEqual(["Team Assistant", "Software Engineer", "Researcher"]);
    expect(catalog[0]?.public.tagline).toBe("For team questions, decisions, and follow-through.");
    expect(catalog[0]?.public.purpose).toContain("recommended starting point");

    for (const template of catalog) {
      expect(template.public.exampleTasks).toHaveLength(3);
      expect(template.components.length).toBeGreaterThan(0);
    }
  });

  it("publishes every definition through the governed API and exposes only the safe public projection", async () => {
    const app = getApp();
    const publisher = await createPublisherAdmin(app);
    const headers = { authorization: `Bearer ${publisher.accessToken}` };

    for (const definition of loadCatalog()) {
      const created = await app.inject({ method: "POST", url: INTERNAL_URL, headers, payload: definition });
      expect(created.statusCode).toBe(201);
      const draft = created.json<{ id: string; updatedAt: string }>();
      const published = await app.inject({
        method: "POST",
        url: `${INTERNAL_URL}/${draft.id}/publish`,
        headers,
        payload: { expectedUpdatedAt: draft.updatedAt },
      });
      expect(published.statusCode).toBe(200);
    }

    const publicList = await app.inject({ method: "GET", url: PUBLIC_URL });
    expect(publicList.statusCode).toBe(200);
    const officialSlugs = new Set(loadCatalog().map((template) => template.slug));
    const templates = publicList
      .json<{ templates: Array<{ slug: string; public: { exampleTasks?: string[] } }> }>()
      .templates.filter((template) => officialSlugs.has(template.slug));
    expect(templates.map((template) => template.slug).sort()).toEqual([
      "researcher",
      "software-engineer",
      "team-assistant",
    ]);
    expect(templates.every((template) => template.public.exampleTasks?.length === 3)).toBe(true);

    for (const definition of loadCatalog()) {
      const detail = await app.inject({ method: "GET", url: `${PUBLIC_URL}/${definition.slug}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json<{ public: { exampleTasks: string[] } }>().public.exampleTasks).toEqual(
        definition.public.exampleTasks,
      );
      const serialized = JSON.stringify(detail.json());
      expect(serialized).not.toContain("components");
      expect(serialized).not.toContain("payload");
      expect(serialized).not.toContain(
        definition.components[0]?.type === "prompt" ? definition.components[0].payload.body : "",
      );
    }
  });
});
