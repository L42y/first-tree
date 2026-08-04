---
id: portable-legacy-global-migration
description: Validate migration from a legacy npm-global CLI to the portable installer without losing portable service or update identity.
areas: [cross-surface]
surfaces: [cli, runtime, systemd, launchd, distribution]
---

# Portable migration from a legacy global install

## Goal

Confirm that portable bootstrap, service installation, and one managed update remain bound to the explicit stable
portable shim when a stale npm-global binary for the same channel appears first on the operator's inherited `PATH`.
The portable version tree is immutable throughout the handoff.

## Preconditions

- Use a disposable Linux systemd-user cell and, when available, a disposable macOS launchd cell. Do not run this case
  against an operator's real First Tree home or service definitions.
- Install an older channel-correct npm-global CLI in a legacy prefix and place its bin directory first on the parent
  process `PATH`.
- Prepare the candidate channel portable installer, two consecutive portable artifacts, a temporary portable prefix,
  and a custom shim directory that is not already on `PATH`.
- Capture service definitions, executable resolution, version-tree hashes, CLI/daemon versions, update logs, and npm
  prefix probes without retaining credentials or connect codes.

## Operate and observe

1. Run the candidate portable installer with the temporary prefix and custom shim directory, then invoke login through
   the absolute portable channel shim. Verify the service entrypoint is that stable shim, not the legacy global binary.
2. Inspect the generated supervisor environment. Its `PATH` starts with the authoritative shim directory and
   `<prefix>/current/node/bin`; it contains no concrete `versions/<version>/node/bin` entry and does not depend on a
   login-shell profile.
3. Trigger one managed update to the second artifact. Verify the update prepares both shims before atomically switching
   `current`, invokes `daemon refresh-unit` through the absolute stable shim, and restarts into the advertised version.
4. Compare the first version directory before and after the update. Its file list and content hashes are unchanged,
   including any bundled Node npm prefix. The legacy global prefix is also unchanged.
5. Force a shim preparation failure in a fresh disposable install and verify `current` still targets the previous
   version. Then rerun the installer and verify it converges by repairing the shims and service definition.
6. Start a legacy/global process whose npm global prefix points inside a validated portable `versions/<version>/node`
   tree. Verify the update refuses before `npm install -g`, reports a non-retryable portable-repair error, and changes
   no files.

## Expected result

`PASS` requires both initial service installation and managed refresh to use the explicit stable portable identity,
matching CLI/daemon versions after restart, stable supervisor paths, and byte-for-byte preservation of every old
portable version directory.

`FAIL` means ambient `PATH` selects the legacy CLI, a service definition contains a concrete portable version path,
`npm install -g` writes under a portable version, refresh uses a bare channel command, a reported pre-commit failure
switches `current`, or the final CLI and daemon versions differ.

`BLOCKED` means disposable supervisor access, candidate artifacts, or the managed-update trigger cannot be prepared.
`INCONCLUSIVE` means only mocked command arguments or source inspection are available without real executable
resolution, filesystem hashes, and supervisor definitions.

## Evidence

Retain the target ref, installer/update commands with exit codes, sanitized inherited and rendered PATH values,
resolved service entrypoint, before/after version-tree manifests and hashes, npm prefix probe, managed-refresh log, and
CLI/daemon version output. Keep all run artifacts outside the source repository.
