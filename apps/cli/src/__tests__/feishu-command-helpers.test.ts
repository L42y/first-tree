import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setCliBinding } from "@first-tree/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestTenantAccessToken, writeCredentialEnvironment } from "../commands/feishu/credential-env.js";
import { credentialEnvironmentHint, describeFile } from "../commands/feishu/intent.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Feishu agentic CLI helpers", () => {
  it("writes Bot credentials to a private file without returning the secret", async () => {
    const path = await writeCredentialEnvironment(
      {
        appId: "cli_app",
        appSecret: "secret-with-'quote",
        bindingId: "binding-1",
      },
      "tenant-token",
    );
    cleanup.push(dirname(path));
    const content = await readFile(path, "utf8");
    expect(content).toContain("LARKSUITE_CLI_APP_ID");
    expect(content).toContain("LARKSUITE_CLI_APP_SECRET");
    expect(content).toContain("LARKSUITE_CLI_CONFIG_DIR");
    expect(content).toContain("LARKSUITE_CLI_BRAND");
    expect(content).toContain("LARKSUITE_CLI_TENANT_ACCESS_TOKEN");
    expect(content).toContain("tenant-token");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("exchanges the bound Bot App credential for a tenant token", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 0, tenant_access_token: "tenant-token", expire: 7200 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      requestTenantAccessToken({ appId: "cli_app", appSecret: "bot-secret", bindingId: "binding-1" }, request),
    ).resolves.toBe("tenant-token");
    expect(request).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ app_id: "cli_app", app_secret: "bot-secret" }),
      }),
    );
  });

  it("rejects an invalid tenant token response", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 10003, msg: "invalid app credential" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(
      requestTenantAccessToken({ appId: "cli_app", appSecret: "bad-secret", bindingId: "binding-1" }, request),
    ).rejects.toThrow("Feishu tenant token exchange failed: invalid app credential");
  });

  it("identifies media by bytes rather than by mutable path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "first-tree-feishu-test-"));
    cleanup.push(directory);
    const path = join(directory, "report.pdf");
    await writeFile(path, "first bytes");
    const first = await describeFile(path);
    await writeFile(path, "changed bytes");
    const second = await describeFile(path);

    expect(first.filename).toBe("report.pdf");
    expect(first.sha256).not.toBe(second.sha256);
    expect(first.size).not.toBe(second.size);
  });

  it.each([
    ["prod", "first-tree", "first-tree"],
    ["staging", "first-tree-staging", "first-tree-staging"],
    ["dev", "first-tree-dev", null],
  ])("uses the %s channel CLI name in the credential hint", (_channel, binName, packageName) => {
    setCliBinding({ binName, packageName });
    expect(credentialEnvironmentHint()).toContain(`\`${binName} feishu credential-env\``);
  });
});
