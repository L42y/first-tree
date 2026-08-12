import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setCliBinding } from "@first-tree/client";
import { afterEach, describe, expect, it } from "vitest";
import { writeCredentialEnvironment } from "../commands/feishu/credential-env.js";
import { credentialEnvironmentHint, describeFile } from "../commands/feishu/intent.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Feishu agentic CLI helpers", () => {
  it("writes Bot credentials to a private file without returning the secret", async () => {
    const path = await writeCredentialEnvironment({
      appId: "cli_app",
      appSecret: "secret-with-'quote",
      bindingId: "binding-1",
    });
    cleanup.push(dirname(path));
    const content = await readFile(path, "utf8");
    expect(content).toContain("LARKSUITE_CLI_APP_ID");
    expect(content).toContain("LARKSUITE_CLI_APP_SECRET");
    expect(content).toContain("LARKSUITE_CLI_CONFIG_DIR");
    expect(content).toContain("LARKSUITE_CLI_BRAND");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
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
