import { ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { strToU8, type ZipOptions, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { attachments } from "../db/schema/attachments.js";
import { organizations } from "../db/schema/organizations.js";
import { resources } from "../db/schema/resources.js";
import { sweepOrphanAttachments } from "../services/attachment.js";
import { ensureMembership } from "../services/membership.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, seedAgentFactory, useTestApp } from "./helpers.js";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;
type TestZipEntry = Uint8Array | [Uint8Array, ZipOptions];

function skillMarkdown(name: string): Uint8Array {
  return strToU8(
    `---\nname: ${name}\ndescription: ${name} description\nmetadata:\n  owner: platform\n---\n\n# ${name}\n\nRun carefully.`,
  );
}

function rawZip(entries: Record<string, TestZipEntry>): Buffer {
  return Buffer.from(zipSync(entries));
}

function skillZip(name: string, entries: Record<string, TestZipEntry> = {}, wrapper = ""): Buffer {
  const prefix = wrapper ? `${wrapper}/` : "";
  return rawZip({
    [`${prefix}SKILL.md`]: skillMarkdown(name),
    ...entries,
  });
}

async function upload(app: FastifyInstance, admin: Admin, bytes: Buffer, organizationId = admin.organizationId) {
  const reply = await app.inject({
    method: "POST",
    url: `/api/v1/orgs/${organizationId}/attachments`,
    headers: {
      authorization: `Bearer ${admin.accessToken}`,
      "content-type": "application/octet-stream",
      [ATTACHMENT_MIME_HEADER]: "application/zip",
      [ATTACHMENT_FILENAME_HEADER]: "skill.zip",
    },
    payload: bytes,
  });
  expect(reply.statusCode).toBe(201);
  return reply.json<{ id: string }>().id;
}

async function createSkill(
  app: FastifyInstance,
  admin: Admin,
  bundleAttachmentId: string,
  defaultEnabled: "available" | "recommended" = "available",
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${admin.organizationId}/resources`,
    headers: { authorization: `Bearer ${admin.accessToken}` },
    payload: { type: "skill", bundleAttachmentId, defaultEnabled },
  });
}

describe("Team Skill bundles", () => {
  const getApp = useTestApp();

  it("creates a Skill from a wrapped complete directory and derives its projection", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const bundleId = await upload(
      app,
      admin,
      skillZip("release-notes", { "release-notes/scripts/run.sh": strToU8("echo ok") }, "release-notes"),
    );

    const reply = await createSkill(app, admin, bundleId);
    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toMatchObject({
      type: "skill",
      name: "release-notes",
      bundleAttachmentId: bundleId,
      payload: {
        name: "release-notes",
        description: "release-notes description",
        body: "# release-notes\n\nRun carefully.",
        metadata: { owner: "platform" },
      },
    });
  });

  it("atomically replaces a bundle, bumps impacted configs, and removes the old object", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const createAgent = await seedAgentFactory(app);
    const agent = await createAgent({ name: `bundle-agent-${crypto.randomUUID().slice(0, 6)}` });
    const oldBundleId = await upload(app, admin, skillZip("reviewer"));
    const created = await createSkill(app, admin, oldBundleId, "recommended");
    expect(created.statusCode).toBe(201);
    const resource = created.json<{ id: string }>();
    const [before] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid));

    const newBundleId = await upload(app, admin, skillZip("reviewer-next"));
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/resources/${resource.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { bundleAttachmentId: newBundleId },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      id: resource.id,
      name: "reviewer-next",
      bundleAttachmentId: newBundleId,
    });

    const [after] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid));
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, oldBundleId))).toHaveLength(0);
  });

  it("rejects cross-organization, reserved-name, and unsafe-path bundles", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const otherOrgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: otherOrgId, name: otherOrgId.slice(0, 30), displayName: "Other team" });
    await ensureMembership(app.db, {
      userId: admin.userId,
      organizationId: otherOrgId,
      role: "member",
      displayName: "Other uploader",
      username: admin.username,
    });

    const foreign = await upload(app, admin, skillZip("foreign"), otherOrgId);
    expect((await createSkill(app, admin, foreign)).statusCode).toBe(400);

    const reserved = await upload(app, admin, skillZip("first-tree-write"));
    expect((await createSkill(app, admin, reserved)).statusCode).toBe(400);

    const unsafe = await upload(
      app,
      admin,
      Buffer.from(zipSync({ "../SKILL.md": strToU8("---\nname: unsafe\ndescription: unsafe\n---\n") })),
    );
    expect((await createSkill(app, admin, unsafe)).statusCode).toBe(400);
  });

  it.each([
    ["non-exact manifest filename", () => rawZip({ "skill.md": skillMarkdown("lowercase") })],
    [
      "excessive directory depth",
      () =>
        skillZip("deep", {
          [`${Array.from({ length: 18 }, (_, index) => `d${index}`).join("/")}/file.txt`]: strToU8("deep"),
        }),
    ],
    ["Windows-reserved segment", () => skillZip("portable", { "references/CON/file.txt": strToU8("bad") })],
    ["trailing-dot segment", () => skillZip("portable", { "references/bad./file.txt": strToU8("bad") })],
    [
      "reserved ownership marker tree",
      () => skillZip("portable", { ".first-tree-managed.json/child": strToU8("bad") }),
    ],
    [
      "Unix special file",
      () =>
        skillZip("portable", {
          "scripts/fifo": [new Uint8Array(), { os: 3, attrs: 0o010644 << 16 }],
        }),
    ],
    [
      "regular-file wrapper anchor",
      () =>
        rawZip({
          wrapper: strToU8("not a directory"),
          "wrapper/SKILL.md": skillMarkdown("wrapped"),
        }),
    ],
    [
      "Unicode-normalized path collision",
      () =>
        skillZip("portable", {
          "assets/Café.bin": Uint8Array.from([1]),
          "assets/Cafe\u0301.bin": Uint8Array.from([2]),
        }),
    ],
    ["overlong path segment", () => skillZip("portable", { [`assets/${"a".repeat(241)}`]: strToU8("bad") })],
    [
      "overlong relative path",
      () =>
        skillZip("portable", {
          [`${Array.from({ length: 4 }, () => "a".repeat(200)).join("/")}/file.txt`]: strToU8("bad"),
        }),
    ],
    [
      "excessive file count",
      () =>
        skillZip(
          "too-many-files",
          Object.fromEntries(
            Array.from({ length: 256 }, (_, index) => [`assets/${index}.txt`, strToU8(String(index))]),
          ),
        ),
    ],
    [
      "excessive entry count",
      () =>
        skillZip(
          "too-many-entries",
          Object.fromEntries(
            Array.from({ length: 512 }, (_, index) => [
              `empty/${index}/`,
              [new Uint8Array(), { os: 3, attrs: 0o040755 << 16 }] as TestZipEntry,
            ]),
          ),
        ),
    ],
    [
      "excessive total uncompressed size",
      () => skillZip("too-large", { "assets/large.bin": new Uint8Array(25 * 1024 * 1024 + 1) }),
    ],
  ])("rejects a %s bundle before Resource configuration", async (_label, build) => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const bundleId = await upload(app, admin, build());
    expect((await createSkill(app, admin, bundleId)).statusCode).toBe(400);
  });

  it.each([
    "first_tree_read",
    "first-tree-read-",
    "CON",
    "a".repeat(64),
  ])("rejects manifest name %s when its normalized provider target is not portable", async (name) => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const bundleId = await upload(app, admin, skillZip(name));
    expect((await createSkill(app, admin, bundleId)).statusCode).toBe(400);
  });

  it("accepts owner-inaccessible uploaded modes because the Client normalizes them safely", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const bundleId = await upload(
      app,
      admin,
      skillZip("mode-safe", {
        "locked/": [new Uint8Array(), { os: 3, attrs: 0o040000 << 16 }],
        "locked/run.sh": [strToU8("echo safe"), { os: 3, attrs: 0o100000 << 16 }],
      }),
    );
    expect((await createSkill(app, admin, bundleId)).statusCode).toBe(201);
  });

  it("keeps an uploaded bundle orphaned on validation failure and sweeps it after 24 hours", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const bundleId = await upload(app, admin, skillZip("first-tree-read"));
    expect((await createSkill(app, admin, bundleId)).statusCode).toBe(400);

    await app.db
      .update(attachments)
      .set({ updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1_000) })
      .where(eq(attachments.id, bundleId));
    const result = await sweepOrphanAttachments(app.db, app.attachmentBlobStore);
    expect(result.deleted).toBe(1);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, bundleId))).toHaveLength(0);
  });

  it("keeps referenced bundles and advances their bounded sweep timestamp", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const bundleId = await upload(app, admin, skillZip("referenced"));
    expect((await createSkill(app, admin, bundleId)).statusCode).toBe(201);
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await app.db.update(attachments).set({ updatedAt: stale }).where(eq(attachments.id, bundleId));

    const result = await sweepOrphanAttachments(app.db, app.attachmentBlobStore);
    const [stored] = await app.db
      .select({ updatedAt: attachments.updatedAt })
      .from(attachments)
      .where(eq(attachments.id, bundleId));
    expect(result.deleted).toBe(0);
    expect(stored?.updatedAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("rejects duplicate active Team Skill names and independent payload edits", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const firstBundle = await upload(app, admin, skillZip("dedupe"));
    const created = await createSkill(app, admin, firstBundle);
    expect(created.statusCode).toBe(201);
    const resourceId = created.json<{ id: string }>().id;

    const duplicateBundle = await upload(app, admin, skillZip("dedupe"));
    expect((await createSkill(app, admin, duplicateBundle)).statusCode).toBe(409);
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/v1/resources/${resourceId}`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { name: "manual-name", payload: { body: "manual" } },
    });
    expect(edit.statusCode).toBe(400);

    const [stored] = await app.db.select().from(resources).where(eq(resources.id, resourceId));
    expect(stored?.name).toBe("dedupe");
  });
});
