import type { Command } from "commander";
import { channelConfig } from "../../core/channel.js";
import {
  getClientServiceStatus,
  installClientService,
  isServiceSupported,
  isServiceUnitDriftDetected,
  loadCredentials,
  restartClientService,
} from "../../core/index.js";
import { print } from "../../core/output.js";

/**
 * Returned instead of `0` when the command intentionally did nothing: service
 * control is unsupported on this platform, or no credentials exist yet and the
 * follow-up `login` owns starting the daemon.
 *
 * The exit status is a three-state contract, because "did nothing" is the
 * normal first-install path and callers must not report the service as ready
 * there: `0` means the unit is installed and running, this code means setup is
 * deferred, and any other non-zero means repair was attempted and failed.
 * Consumed by `ensure_daemon_service` in `scripts/portable/install.sh`.
 */
export const ENSURE_SERVICE_DEFERRED_EXIT_CODE = 3;

/**
 * Hidden recovery hook used by the portable installer after it has switched the
 * channel shim to the freshly installed version. It is intentionally narrower
 * than `login <code>`: credentials are never created or replaced here. If a
 * previous login left valid credentials behind, this refreshes the supervised
 * unit and starts it; if credentials are gone, the follow-up `login` owns that
 * recovery step.
 */
export function registerDaemonEnsureServiceCommand(daemon: Command): void {
  daemon
    .command("ensure-service", { hidden: true })
    .description("Ensure the background service is installed and running when credentials already exist")
    .action(() => {
      const binName = channelConfig.binName;
      if (!isServiceSupported()) {
        print.line(`  ensure-service: service control is not supported on ${process.platform}; skipping.\n`);
        process.exit(ENSURE_SERVICE_DEFERRED_EXIT_CODE);
      }

      if (!loadCredentials()) {
        print.line(`  ensure-service: no credentials found; run \`${binName} login <code>\` after install.\n`);
        process.exit(ENSURE_SERVICE_DEFERRED_EXIT_CODE);
      }

      const svc = getClientServiceStatus();
      const drift = isServiceUnitDriftDetected();
      if (svc.state === "active" && !drift) {
        print.line(`  ensure-service: ${svc.platform} service is already running.\n`);
        return;
      }

      try {
        const info = installClientService();
        if (svc.state === "active") {
          const restart = restartClientService();
          if (!restart.ok) {
            print.line(
              `  ensure-service: ${info.platform} service refresh succeeded but restart failed: ${restart.reason}\n`,
            );
            process.exit(1);
          }
          const after = getClientServiceStatus();
          if (after.state !== "active") {
            print.line(
              `  ensure-service: ${after.platform} service restarted but is not running` +
                `${after.detail ? ` (${after.detail})` : ""}.\n`,
            );
            process.exit(1);
          }
          print.line(`  ensure-service: ${after.platform} service refreshed and restarted.\n`);
          return;
        }

        if (info.state !== "active") {
          print.line(
            `  ensure-service: ${info.platform} service installed but not running` +
              `${info.detail ? ` (${info.detail})` : ""}.\n`,
          );
          process.exit(1);
        }
        print.line(`  ensure-service: ${info.platform} service installed and running.\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        print.line(`  ensure-service: failed to install/start service: ${msg}\n`);
        process.exit(1);
      }
    });
}
