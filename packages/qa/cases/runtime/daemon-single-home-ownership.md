---
id: daemon-single-home-ownership
description: Validate that one resolved First Tree home admits exactly one live daemon runtime while isolated channel and dev homes remain parallel.
areas: [runtime]
surfaces: [cli, client]
---

# Daemon Single-Home Ownership

## Goal

Verify the real process and supervisor boundary behind daemon ownership: one
resolved `FIRST_TREE_HOME` admits exactly one runtime before client config or
WebSocket startup, while prod, staging, dev, and separate explicit dev homes
remain independent.

Use this case for changes to daemon startup, service delegation, foreground
mode, process identity, stale-lock recovery, or channel-home isolation. Stable
record parsing and filesystem edge cases belong in product tests; this case
owns the live multi-process and supervisor behavior those tests cannot fully
prove.

## Preconditions

- Run only inside the complete isolated QA cell selected by the plan. Never
  reuse, stop, restart, inspect, or write the operator host's real prod,
  staging, or dev daemon homes.
- Build or install the exact candidate CLI variants needed for the channel
  matrix. Give every variant isolated run-cell credentials and client config
  against the run-cell server so a winning process can reach and hold its real
  WebSocket runtime.
- For service/foreground competition, provide a real supported supervisor
  boundary (launchd, systemd, or Windows Task Scheduler plus the First Tree
  wrapper). If the run cell cannot provide one, report that branch `BLOCKED`;
  do not replace it with a mocked service manager.
- Record every binary version, channel, resolved home, service identifier, PID,
  and test-only client id. Keep all temporary homes outside the source
  worktree.

## Operate And Observe

Exercise the following branches, resetting only run-cell state between them:

- Start prod, staging, and dev with their distinct channel-default home shapes.
  Confirm all three runtimes coexist, each owns
  `<home>/state/daemon-runtime.lock`, and each connects using only its own
  config.
- Gate two foreground processes on a common start barrier and release them
  concurrently against one explicit home. Exactly one process may progress to
  config/WebSocket startup; the other must fail closed with the live holder's
  instance id, PID, process-start identity, channel, mode, version, and start
  time.
- Start the real background service, then attempt `daemon start --foreground`
  for the same home. Confirm the foreground preflight gives actionable stop
  guidance. While that service remains active, start foreground with a
  different explicit home and confirm it is allowed to reach its own owner
  lock and WebSocket runtime. Also arrange a race where service-state
  observation alone is insufficient and verify the atomic home lock is still
  the final decision.
- Compete a foreground owner with a supervisor child. The child must log one
  holder summary and settle without repeated child restarts or repeated
  collision log lines.
- Stop a winning runtime normally and confirm its lock disappears. Start again
  and confirm a new instance id owns the home.
- Hard-kill a winning process without cleanup. The next start must prove the
  old PID/start identity stale, rename the old lock to a `.stale.*` diagnostic,
  retry once, and become the sole owner.
- Hard-kill a process after it creates the stale-lock `.recovery` guard but
  before cleanup. Race two later starts against that home. They must prove and
  quarantine the abandoned guard, and exactly one may become the owner; a live
  or unverifiable recovery guard must remain fail-closed.
- Replace the lock with malformed or incomplete content after proving no
  daemon owns the test home. Startup must refuse without deleting or rewriting
  the damaged file, and `daemon status` / `daemon doctor` must identify the
  untrusted lock.
- Point two different channel binaries at one explicit home. The second must be
  rejected even if its client id and server URL differ. Then point two dev
  binaries at two explicit homes and confirm they run in parallel.

Runtime marker files under `state/client-runtimes/` may support lifecycle
diagnosis, but their presence or absence must never allow a second runtime to
bypass the authoritative home lock.

## Expected Result

`PASS` means every available branch demonstrates one authoritative owner per
resolved home, independent homes remain parallel, foreground/service races are
closed by the atomic lock, stale recovery is evidence-based and bounded, and a
supervisor collision settles without a restart/log storm.

`FAIL` means two live runtimes enter config/WebSocket startup for one home, an
unverified or malformed lock is removed automatically, one owner releases a
different instance's lock, distinct default homes interfere, or a colliding
supervisor repeatedly restarts.

`BLOCKED` means the isolated cell cannot provide the required channel binary,
authenticated runtime, or real supervisor boundary. `INCONCLUSIVE` means the
process, lock, service, or WebSocket evidence cannot be attributed to the
candidate build.

## Evidence

Keep the exact commands and exit statuses; resolved home and service paths;
redacted owner records; process listings with start identities; service status
and bounded logs; WebSocket/client-registration evidence showing which process
entered the runtime; quarantine filenames; and before/after hashes of damaged
locks. Redact credentials, tokens, private user paths, and unrelated host
processes.
