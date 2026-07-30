import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_AGENT_TEMPLATE_IDS } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agentResourceBindings } from "../db/schema/agent-resource-bindings.js";
import { agentTemplates } from "../db/schema/agent-templates.js";
import { resources } from "../db/schema/resources.js";

type DrizzleTableRecord = Record<PropertyKey, unknown>;
type NamedExtraConfig = { name?: unknown; config?: { name?: unknown; unique?: unknown } };

function asDrizzleTableRecord(table: object): DrizzleTableRecord {
  // Drizzle stores table builders behind symbols without public test-facing types.
  return table as DrizzleTableRecord;
}

function findDrizzleSymbol(table: object, name: string): symbol {
  const symbol = Object.getOwnPropertySymbols(table).find((candidate) => String(candidate).includes(name));
  if (!symbol) throw new Error(`Missing Drizzle symbol ${name}`);
  return symbol;
}

function buildExtraConfigs(table: object): unknown[] {
  const record = asDrizzleTableRecord(table);
  const builder = record[findDrizzleSymbol(table, "ExtraConfigBuilder")];
  const columns = record[findDrizzleSymbol(table, "ExtraConfigColumns")];
  if (typeof builder !== "function") throw new Error("ExtraConfigBuilder is not callable");
  const built = builder(columns);
  if (!Array.isArray(built)) throw new Error("ExtraConfigBuilder did not return an array");
  return built;
}

function extraConfigNames(table: object): string[] {
  return buildExtraConfigs(table).map((config) => {
    if (typeof config !== "object" || config === null) throw new Error("Extra config is not an object");
    const named = config as NamedExtraConfig;
    const name = named.config?.name ?? named.name;
    if (typeof name !== "string") throw new Error("Extra config has no string name");
    return name;
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, "../../drizzle");
const migrationFile = readdirSync(drizzleDir).find((file) => /^0090_.*\.sql$/.test(file));
if (!migrationFile) throw new Error("Expected a generated 0090 agent-template migration file");
const migrationSql = readFileSync(join(drizzleDir, migrationFile), "utf8");

describe("agent_templates table", () => {
  it("has the expected columns and defaults", () => {
    expect(agentTemplates.id.name).toBe("id");
    expect(agentTemplates.slug.name).toBe("slug");
    expect(agentTemplates.slug.notNull).toBe(true);
    expect(agentTemplates.name.notNull).toBe(true);
    expect(agentTemplates.status.notNull).toBe(true);
    expect(agentTemplates.status.default).toBe("draft");
    expect(agentTemplates.payload.notNull).toBe(true);
    expect(agentTemplates.replacementTemplateId.notNull).toBe(false);
    expect(agentTemplates.createdBy.notNull).toBe(true);
    expect(agentTemplates.updatedBy.notNull).toBe(true);
  });

  it("declares the slug unique index, status index, and status CHECK", () => {
    expect(extraConfigNames(agentTemplates)).toEqual([
      "uq_agent_templates_slug",
      "idx_agent_templates_status",
      "ck_agent_templates_status",
    ]);
  });
});

describe("agent_configs template_ids column", () => {
  it("is a NOT NULL text array defaulting to an empty set", () => {
    expect(agentConfigs.templateIds.name).toBe("template_ids");
    expect(agentConfigs.templateIds.notNull).toBe(true);
    expect(agentConfigs.templateIds.getSQLType()).toBe("text[]");
  });

  it("declares the cardinality CHECK and GIN index", () => {
    expect(extraConfigNames(agentConfigs)).toEqual([
      "ck_agent_configs_template_ids_cardinality",
      "idx_agent_configs_template_ids",
    ]);
  });
});

describe("resources Template provenance", () => {
  it("adds nullable provenance columns", () => {
    expect(resources.originTemplateId.notNull).toBe(false);
    expect(resources.originComponentKey.notNull).toBe(false);
    expect(resources.originContentDigest.notNull).toBe(false);
  });

  it("declares the all-null-or-all-set CHECK and the active/stale unique index", () => {
    const names = extraConfigNames(resources);
    expect(names).toContain("ck_resources_template_origin_consistency");
    expect(names).toContain("uq_resources_template_origin_active");
  });
});

describe("agent_resource_bindings Template provenance", () => {
  it("adds nullable provenance columns", () => {
    expect(agentResourceBindings.originTemplateId.notNull).toBe(false);
    expect(agentResourceBindings.originComponentKey.notNull).toBe(false);
  });

  it("declares the all-null-or-all-set CHECK and the agent+template index", () => {
    const names = extraConfigNames(agentResourceBindings);
    expect(names).toContain("ck_agent_resource_bindings_template_origin_consistency");
    expect(names).toContain("idx_agent_resource_bindings_template_origin");
  });
});

describe("0090 agent template migration", () => {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  it("is purely additive (no data backfill, drops, or rewrites)", () => {
    for (const statement of statements) {
      expect(statement).not.toMatch(/^(UPDATE|DELETE|DROP|TRUNCATE|INSERT)\b/i);
      expect(statement).not.toMatch(/\bDROP COLUMN\b/i);
      expect(statement).not.toMatch(/\bALTER COLUMN\b/i);
    }
    expect(statements.every((statement) => /^(CREATE TABLE|ALTER TABLE|CREATE (UNIQUE )?INDEX)/.test(statement))).toBe(
      true,
    );
  });

  it("creates the agent_templates table with lifecycle CHECK", () => {
    expect(migrationSql).toContain('CREATE TABLE "agent_templates"');
    expect(migrationSql).toContain("ck_agent_templates_status");
    expect(migrationSql).toContain("uq_agent_templates_slug");
  });

  it("adds template_ids with an empty-array default so existing agents adopt zero Templates", () => {
    expect(migrationSql).toContain(
      'ALTER TABLE "agent_configs" ADD COLUMN "template_ids" text[] DEFAULT \'{}\'::text[] NOT NULL',
    );
    // Build the cardinality bound from the shared constant so a change to
    // MAX_AGENT_TEMPLATE_IDS surfaces schema/migration drift here.
    expect(migrationSql).toContain(
      `CONSTRAINT "ck_agent_configs_template_ids_cardinality" CHECK (cardinality("agent_configs"."template_ids") <= ${MAX_AGENT_TEMPLATE_IDS})`,
    );
    expect(migrationSql).toContain('CREATE INDEX "idx_agent_configs_template_ids" ON "agent_configs" USING gin');
  });

  it("adds Resource and binding provenance with consistency CHECKs and no Template FK", () => {
    expect(migrationSql).toContain('ALTER TABLE "resources" ADD COLUMN "origin_template_id" text');
    expect(migrationSql).toContain('ALTER TABLE "resources" ADD COLUMN "origin_component_key" text');
    expect(migrationSql).toContain('ALTER TABLE "resources" ADD COLUMN "origin_content_digest" text');
    expect(migrationSql).toContain("ck_resources_template_origin_consistency");
    // Dedup identity is (org, template, component key) — `type` is not part
    // of it — restricted to active/stale rows with provenance.
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "uq_resources_template_origin_active" ON "resources" USING btree ("organization_id","origin_template_id","origin_component_key") WHERE "resources"."status" IN (\'active\', \'stale\') AND "resources"."origin_template_id" IS NOT NULL',
    );
    expect(migrationSql).toContain('ALTER TABLE "agent_resource_bindings" ADD COLUMN "origin_template_id" text');
    expect(migrationSql).toContain('ALTER TABLE "agent_resource_bindings" ADD COLUMN "origin_component_key" text');
    expect(migrationSql).toContain("ck_agent_resource_bindings_template_origin_consistency");
    // Partial index: ordinary bindings with NULL provenance stay out of it.
    expect(migrationSql).toContain(
      'CREATE INDEX "idx_agent_resource_bindings_template_origin" ON "agent_resource_bindings" USING btree ("agent_id","origin_template_id") WHERE "agent_resource_bindings"."origin_template_id" IS NOT NULL',
    );
    // The only FK in this migration is the agent_templates self-reference.
    const foreignKeys = migrationSql.match(/FOREIGN KEY/g) ?? [];
    expect(foreignKeys).toHaveLength(1);
    expect(migrationSql).toContain('REFERENCES "public"."agent_templates"("id") ON DELETE set null');
  });
});
