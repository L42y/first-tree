---
id: macos-launchd-update-handoff
description: Validate that a managed macOS update survives launchd on-demand-only mode and that stopped services are reported accurately.
areas: [runtime]
surfaces: [cli, client, launchd, distribution]
---

# macOS launchd update handoff

## Goal

Confirm that a managed CLI update on macOS reconnects through the already-running
launchd wrapper even when the GUI launchd domain defers KeepAlive spawns, and
that CLI status surfaces distinguish `running` from `not running` exactly.

## Preconditions

- Use a disposable macOS launchd user session, First Tree home, client, and
  service label. Never stop, rewrite, or inspect an operator's real service.
- Prepare two consecutive channel-correct candidate artifacts and a test server
  that advertises the second version to the first.
- Capture sanitized launchd state, unified launchd logs, wrapper and daemon PIDs,
  client registration state, CLI version, and daemon version.
- Prefer a real locked-screen or display-sleep transition that produces
  `pending spawn, domain in on-demand-only mode`. If the run cell cannot produce
  that state, report that branch `BLOCKED`; do not claim it from mocks alone.

## Operate and observe

1. Install the first artifact and its launchd service. Verify the generated
   wrapper remains the launchd-owned process and starts the daemon child.
2. Trigger a managed update to the second artifact while the GUI launchd domain
   is in on-demand-only mode. The daemon child exits with status 75; the same
   live wrapper immediately starts the newly installed daemon without waiting
   for launchd to spawn a new job.
3. Verify the client re-registers, all owned agents rebind, CLI and daemon report
   the second version, and no persistent computer-disconnected interval remains.
4. Repeat one more managed update after a normal display wake. Confirm the
   wrapper loop remains intact after `daemon refresh-unit` atomically replaces
   the on-disk wrapper and plist.
5. Stop the disposable service normally and inspect `launchctl print`. When it
   reports `state = not running`, both `status` and `daemon doctor` must report
   the service as stopped rather than matching the `running` substring.
6. Start the service again and force a non-75 daemon failure. Confirm the
   wrapper returns that status to launchd so ordinary launchd crash throttling
   and recovery semantics remain in control.

## Expected result

`PASS` requires two managed version handoffs with matching CLI/daemon versions,
continuous wrapper ownership across exit 75, a recovered WebSocket registration,
no deferred launchd respawn dependency, exact stopped-state reporting, and
preserved non-75 launchd behavior.

`FAIL` means exit 75 leaves the client offline, the wrapper itself exits during
the managed handoff, refresh truncates or corrupts the live wrapper, CLI/daemon
versions diverge, `state = not running` is reported as running, or non-75 exits
are hidden from launchd.

`BLOCKED` means the disposable macOS session, real launchd boundary, two
artifacts, server update advertisement, or on-demand-only state cannot be
prepared. `INCONCLUSIVE` means only rendered templates, mocked launchctl output,
or product tests are available without real service and registration evidence.

## Evidence

Retain the exact target and artifact versions; install/update commands with exit
codes; sanitized wrapper and child PIDs before and after each handoff; relevant
launchd state and unified-log excerpts; generated wrapper/plist hashes; client
registration and agent-rebind timestamps; CLI/daemon status output; and reset
confirmation for the disposable service and home. Keep run artifacts outside
the source repository.
