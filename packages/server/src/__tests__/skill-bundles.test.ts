import { ATTACHMENT_FILENAME_HEADER, ATTACHMENT_MIME_HEADER, TEAM_SKILL_BUNDLE_LIMITS } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { attachments } from "../db/schema/attachments.js";
import { organizations } from "../db/schema/organizations.js";
import { resources } from "../db/schema/resources.js";
import { sweepOrphanAttachments } from "../services/attachment.js";
import { ensureMembership } from "../services/membership.js";
import { backfillSkillResourceBundles } from "../services/skill-bundle.js";
import { uuidv7 } from "../uuid.js";
import { createTestAdmin, seedAgentFactory, useTestApp } from "./helpers.js";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;

function skillZip(name: string, entries: Record<string, Uint8Array> = {}, wrapper = ""): Buffer {
  const prefix = wrapper ? `${wrapper}/` : "";
  const markdown = `---\nname: ${name}\ndescription: ${name} description\nmetadata:\n  owner: platform\n---\n\n# ${name}\n\nRun carefully.`;
  return Buffer.from(
    zipSync({
      [`${prefix}SKILL.md`]: strToU8(markdown),
      ...entries,
    }),
  );
}

function maximumAdmissibleSkillZip(): Buffer {
  const manifest = strToU8(
    ["---", "name: at-limit", "description: At the exact runtime limits.", "---", "", "# At limit", ""].join("\n"),
  );
  const entries: Record<string, Uint8Array> = { "SKILL.md": manifest };
  const tinyFiles = 251;
  for (let index = 0; index < tinyFiles; index++) {
    entries[`references/tiny-${index}.txt`] = Uint8Array.of(index % 256);
  }
  for (let index = 0; index < 3; index++) {
    entries[`references/full-${index}.bin`] = new Uint8Array(TEAM_SKILL_BUNDLE_LIMITS.fileBytes);
  }
  const remaining =
    TEAM_SKILL_BUNDLE_LIMITS.totalBytes - manifest.byteLength - tinyFiles - 3 * TEAM_SKILL_BUNDLE_LIMITS.fileBytes;
  entries["references/remainder.bin"] = new Uint8Array(remaining);
  return Buffer.from(zipSync(entries));
}

function mutateFirstZipEntry(
  source: Buffer,
  mutateLocal: (bytes: Buffer, offset: number) => void,
  mutateCentral: (bytes: Buffer, offset: number) => void,
): Buffer {
  const bytes = Buffer.from(source);
  const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  if (local < 0 || central < 0) throw new Error("fixture ZIP headers are missing");
  mutateLocal(bytes, local);
  mutateCentral(bytes, central);
  return bytes;
}

function encryptedZip(source: Buffer): Buffer {
  return mutateFirstZipEntry(
    source,
    (bytes, offset) => bytes.writeUInt16LE(bytes.readUInt16LE(offset + 6) | 0x1, offset + 6),
    (bytes, offset) => bytes.writeUInt16LE(bytes.readUInt16LE(offset + 8) | 0x1, offset + 8),
  );
}

function unixTypeZip(source: Buffer, mode: number): Buffer {
  return mutateFirstZipEntry(
    source,
    () => {},
    (bytes, offset) => {
      bytes.writeUInt16LE((3 << 8) | 20, offset + 4);
      bytes.writeUInt32LE((mode << 16) >>> 0, offset + 38);
    },
  );
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
    expect(reply.statusCode, reply.body).toBe(201);
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

  it("accepts a bundle at the exact shared file and uncompressed-byte limits", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const bundleId = await upload(app, admin, maximumAdmissibleSkillZip());

    const reply = await createSkill(app, admin, bundleId);

    expect(reply.statusCode, reply.body).toBe(201);
    expect(reply.json()).toMatchObject({ name: "at-limit", bundleAttachmentId: bundleId });
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
    [
      "wrong-case manifest",
      Buffer.from(zipSync({ "skill.md": strToU8("---\nname: unsafe\ndescription: unsafe\n---\n") })),
    ],
    [
      "backslash path",
      Buffer.from(zipSync({ "wrapped\\SKILL.md": strToU8("---\nname: unsafe\ndescription: unsafe\n---\n") })),
    ],
    [
      "case collision",
      skillZip("case-collision", {
        "scripts/run.sh": strToU8("one"),
        "scripts/RUN.sh": strToU8("two"),
      }),
    ],
    ["wrapped-root extra content", skillZip("wrapped-extra", { "outside.txt": strToU8("outside") }, "wrapped")],
    ["Windows device name", skillZip("device-name", { "scripts/CON": strToU8("device") })],
    ["trailing-dot path", skillZip("trailing-dot", { "references./policy.md": strToU8("unsafe") })],
    ["reserved ownership marker", skillZip("managed-marker", { ".first-tree-managed.json": strToU8("{}") })],
    [
      "reserved ownership marker directory",
      skillZip("managed-marker-directory", { ".first-tree-managed.json/": new Uint8Array() }),
    ],
    ["case-varied ownership marker", skillZip("managed-marker-case", { ".FIRST-TREE-MANAGED.JSON": strToU8("{}") })],
    [
      "ownership marker child",
      skillZip("managed-marker-child", { ".first-tree-managed.json/data": strToU8("unsafe") }),
    ],
    [
      "file parent",
      skillZip("file-parent", {
        scripts: strToU8("file"),
        "scripts/run.sh": strToU8("nested"),
      }),
    ],
    ["wrapped-root outside empty directory", skillZip("wrapped-empty", { "outside/": new Uint8Array() }, "wrapped")],
    ["excessive depth", skillZip("deep-tree", { [`${"nested/".repeat(17)}file.txt`]: strToU8("deep") })],
    [
      "overlong path segment",
      skillZip("long-segment", {
        [`references/${"a".repeat(TEAM_SKILL_BUNDLE_LIMITS.segmentCodeUnits + 1)}.txt`]: strToU8("unsafe"),
      }),
    ],
    [
      "overlong extracted path",
      skillZip("long-path", {
        [`${Array.from({ length: 8 }, () => "a".repeat(100)).join("/")}/file.txt`]: strToU8("unsafe"),
      }),
    ],
    ["oversized file", skillZip("large-file", { "references/large.bin": new Uint8Array(4 * 1024 * 1024 + 1) })],
    ["runtime name longer than 63 characters", skillZip("a".repeat(64))],
    [
      "invalid YAML accepted differently by another parser",
      Buffer.from(
        zipSync({
          "SKILL.md": strToU8(
            "---\nname: invalid-yaml\ndescription: invalid YAML\nmetadata:\n  values: [a,,b]\n---\n\n# Invalid\n",
          ),
        }),
      ),
    ],
    ["encrypted entry", encryptedZip(skillZip("encrypted"))],
    ["symlink entry", unixTypeZip(skillZip("symlink"), 0o120777)],
    ["special entry", unixTypeZip(skillZip("special"), 0o010644)],
  ])("rejects a runtime-inadmissible bundle with %s", async (_label, bytes) => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const bundleId = await upload(app, admin, bytes);
    expect((await createSkill(app, admin, bundleId)).statusCode).toBe(400);
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

  it("backfills a legacy bundle with an atomic config-version fence and runtime notification", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const createAgent = await seedAgentFactory(app);
    const agent = await createAgent({ name: `legacy-bundle-${crypto.randomUUID().slice(0, 6)}` });
    const resourceId = uuidv7();
    await app.db.insert(resources).values({
      id: resourceId,
      organizationId: admin.organizationId,
      type: "skill",
      scope: "team",
      ownerAgentId: null,
      name: "legacy-backfill",
      repoCanonicalKey: null,
      bundleAttachmentId: null,
      defaultEnabled: "recommended",
      status: "active",
      payload: {
        name: "legacy-backfill",
        description: "Legacy backfill.",
        body: "# Legacy backfill",
        metadata: {},
      },
      createdBy: admin.memberId,
      updatedBy: admin.memberId,
    });
    const [before] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid));
    const notifyAgent = vi.fn(async () => {});

    const result = await backfillSkillResourceBundles(app.db, app.attachmentBlobStore, { notifyAgent });

    const [stored] = await app.db
      .select({ bundleAttachmentId: resources.bundleAttachmentId })
      .from(resources)
      .where(eq(resources.id, resourceId));
    const [after] = await app.db
      .select({ version: agentConfigs.version })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid));
    expect(result).toMatchObject({ migrated: 1, affectedAgentCount: expect.any(Number) });
    expect(stored?.bundleAttachmentId).toBeTruthy();
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    expect(notifyAgent).toHaveBeenCalledWith(agent.uuid);
  });

  it("keeps a legacy inline Skill when generated frontmatter would exceed runtime bundle limits", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const resourceId = uuidv7();
    await app.db.insert(resources).values({
      id: resourceId,
      organizationId: admin.organizationId,
      type: "skill",
      scope: "team",
      ownerAgentId: null,
      name: "legacy-too-large",
      repoCanonicalKey: null,
      bundleAttachmentId: null,
      defaultEnabled: "recommended",
      status: "active",
      payload: {
        name: "legacy-too-large",
        description: "Legacy Skill that must remain inline.",
        body: "x".repeat(TEAM_SKILL_BUNDLE_LIMITS.skillMarkdownBytes),
        metadata: {},
      },
      createdBy: admin.memberId,
      updatedBy: admin.memberId,
    });

    const result = await backfillSkillResourceBundles(app.db, app.attachmentBlobStore);

    const [stored] = await app.db
      .select({ bundleAttachmentId: resources.bundleAttachmentId })
      .from(resources)
      .where(eq(resources.id, resourceId));
    expect(result).toMatchObject({ migrated: 0, skipped: 1, affectedAgentCount: 0 });
    expect(stored?.bundleAttachmentId).toBeNull();
  });
});
