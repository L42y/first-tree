import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENSURE_SERVICE_DEFERRED_EXIT_CODE } from "../commands/daemon/ensure-service.js";

const outputMocks = vi.hoisted(() => ({
  print: { line: vi.fn() },
}));

const coreMocks = vi.hoisted(() => ({
  isServiceSupported: vi.fn(),
  loadCredentials: vi.fn(),
  getClientServiceStatus: vi.fn(),
  isServiceUnitDriftDetected: vi.fn(),
  installClientService: vi.fn(),
  restartClientService: vi.fn(),
}));

vi.mock("../core/output.js", () => outputMocks);
vi.mock("../core/index.js", () => coreMocks);

async function runEnsureService(): Promise<void> {
  const { registerDaemonEnsureServiceCommand } = await import("../commands/daemon/ensure-service.js");
  const daemon = new Command();
  registerDaemonEnsureServiceCommand(daemon);
  await daemon.parseAsync(["ensure-service"], { from: "user" });
}

/**
 * The portable installer decides whether to tell the operator the background
 * service is set up purely from this command's exit status. "Did nothing" is
 * the normal first-install path, so it must be distinguishable from readiness:
 * a zero here would make the installer print a success line directly under the
 * command's own "run login" notice.
 */
describe("daemon ensure-service — ready / deferred / failed exit contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
      throw Object.assign(new Error(`process.exit ${code}`), { exitCode: code });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("keeps the deferred exit code in sync with the portable installer", () => {
    // scripts/portable/install.sh mirrors this as ENSURE_SERVICE_DEFERRED=3.
    expect(ENSURE_SERVICE_DEFERRED_EXIT_CODE).toBe(3);
  });

  it("defers rather than reporting readiness when no credentials exist yet", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.loadCredentials.mockReturnValue(null);

    await expect(runEnsureService()).rejects.toMatchObject({ exitCode: ENSURE_SERVICE_DEFERRED_EXIT_CODE });

    expect(outputMocks.print.line).toHaveBeenCalledWith(expect.stringContaining("no credentials found"));
    expect(coreMocks.installClientService).not.toHaveBeenCalled();
  });

  it("defers when service control is unsupported on this platform", async () => {
    coreMocks.isServiceSupported.mockReturnValue(false);

    await expect(runEnsureService()).rejects.toMatchObject({ exitCode: ENSURE_SERVICE_DEFERRED_EXIT_CODE });

    expect(outputMocks.print.line).toHaveBeenCalledWith(expect.stringContaining("not supported"));
    expect(coreMocks.loadCredentials).not.toHaveBeenCalled();
  });

  it("exits zero only when the unit is actually installed and running", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.loadCredentials.mockReturnValue({ clientId: "c1" });
    coreMocks.getClientServiceStatus.mockReturnValue({ state: "active", platform: "launchd" });
    coreMocks.isServiceUnitDriftDetected.mockReturnValue(false);

    await runEnsureService();

    expect(process.exit).not.toHaveBeenCalled();
    expect(outputMocks.print.line).toHaveBeenCalledWith(expect.stringContaining("already running"));
  });

  it("reports failure distinctly when service repair is attempted and fails", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.loadCredentials.mockReturnValue({ clientId: "c1" });
    coreMocks.getClientServiceStatus.mockReturnValue({ state: "inactive", platform: "launchd" });
    coreMocks.isServiceUnitDriftDetected.mockReturnValue(false);
    coreMocks.installClientService.mockReturnValue({ state: "inactive", platform: "launchd", detail: "boom" });

    // Distinct from the deferred code so the installer can warn instead of
    // quietly deferring to a login that would not fix this.
    await expect(runEnsureService()).rejects.toMatchObject({ exitCode: 1 });
  });
});
