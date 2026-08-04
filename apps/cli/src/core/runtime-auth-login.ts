import {
  BROWSER_LOGIN_TIMEOUT_MS,
  type LoginOutcome,
  RUNTIME_AUTH_DRIVERS,
  type RuntimeAuthCommand,
  type RuntimeAuthDriver,
  type RuntimeAuthDriverTable,
  type RuntimeAuthLoginResolution,
  redactErrorPreview,
} from "@first-tree/client";
import type { CapabilityEntry, PendingAuth, RuntimeAuthFailureReason } from "@first-tree/shared";

/**
 * Daemon-side orchestrator for an in-product runtime-auth login.
 *
 * Triggered by a `runtime-auth:start` reverse command from the server, this
 * drives the provider's official login on the host and surfaces progress by
 * re-PATCHing the capabilities snapshot (via {@link RuntimeAuthLoginDeps}),
 * which the web console already polls — so progress reaches the operator's
 * screen with no bespoke realtime channel, and the capability probe stays the
 * single source of truth. The OAuth token never transits First Tree.
 *
 * This module is provider-neutral on purpose: it owns the part of the flow that
 * is identical for every browser-OAuth provider, and dispatches by typed key
 * into the Client's `RUNTIME_AUTH_DRIVERS` composition root for the three steps
 * that differ (resolve the artifact, spawn the login, re-probe the affected
 * capability rows). Adding a provider must not add a branch here.
 */

export type RuntimeAuthLoginDeps = {
  /** Latest known entry for a provider, to preserve fields while pending. */
  currentEntry: (provider: string) => CapabilityEntry | undefined;
  /** Merge a provider entry into the snapshot and upload it (deduped). */
  setProviderEntry: (provider: string, entry: CapabilityEntry) => Promise<void>;
  /** Status logger (symbol + message). */
  log: (symbol: string, message: string) => void;
  /** Seam for tests — production callers omit this and get the frozen table. */
  drivers?: RuntimeAuthDriverTable;
  now?: () => number;
};

/**
 * Hard ceiling on the length of a login failure republished on a capability
 * entry, ellipsis included. Sized to the probe's own error budget so a provider
 * that streams a huge stack trace, or a resolver that echoes a
 * credential-bearing path, cannot grow the snapshot the daemon PATCHes. The cap
 * lives here rather than on the shared wire schema: a `.max()` there would make
 * a new server reject an older daemon's payload and break the rolling-upgrade
 * contract the capability map depends on.
 */
export const RUNTIME_AUTH_ERROR_MAX_LEN = 500;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A terminal login failure to record on the provider entry. */
type AuthFailure = { reason: RuntimeAuthFailureReason; message?: string };

/**
 * Every error/failure string this orchestrator republishes goes through here:
 * `CapabilityEntry.error` and `lastAuthError.message`. Structured fields the
 * daemon itself produces — `pendingAuth.authUrl`, the detected version, the
 * runtime source — are not error text and deliberately do not pass through.
 *
 * `redactErrorPreview` treats its argument as the body budget and appends a
 * single ellipsis when it truncates, so hand it one less than the ceiling to
 * keep the result within {@link RUNTIME_AUTH_ERROR_MAX_LEN}.
 */
function boundedErrorText(raw: string): string {
  return redactErrorPreview(raw, RUNTIME_AUTH_ERROR_MAX_LEN - 1);
}

/**
 * A driver's re-probe reports detection failures in `error`, and that text
 * comes from the same hosts, paths and subprocesses as a login failure — so it
 * gets the same treatment before it reaches the snapshot. Sanitising here
 * rather than in each driver keeps one publish boundary to audit, and covers
 * the extra rows a shared-credential driver returns alongside its own.
 */
function sanitizeProbedEntry(entry: CapabilityEntry): CapabilityEntry {
  if (!entry.error) return entry;
  return { ...entry, error: boundedErrorText(entry.error) };
}

/**
 * Stamp a terminal `lastAuthError` onto a freshly re-probed entry so the web can
 * tell "sign-in failed — retry" from "never attempted".
 *
 * Capability detection is now install-only — it no longer reports an auth state
 * (an installed provider is always `ok` regardless of login). So login
 * progress/outcome rides the entry's `pendingAuth` / `lastAuthError` markers,
 * decoupled from `state`: a failure stamps `lastAuthError` whenever present
 * (success passes `null`, which leaves the re-probed entry marker-free and thus
 * clears any prior failure). The in-chat "needs login" entry point reads these
 * markers, the same way the prior card-side Connect control did.
 *
 * Provider, resolver, spawn and thrown text becomes published state here, so
 * it passes through {@link boundedErrorText} first: a provider's stderr tail
 * can carry a token or an authenticated URL, and it must not reach the snapshot
 * verbatim or unbounded.
 */
function attachAuthError(entry: CapabilityEntry, failure: AuthFailure | null, nowMs: number): CapabilityEntry {
  if (!failure) return entry;
  const preview = failure.message ? boundedErrorText(failure.message) : "";
  return {
    ...entry,
    lastAuthError: {
      reason: failure.reason,
      ...(preview ? { message: preview } : {}),
      at: new Date(nowMs).toISOString(),
    },
  };
}

/**
 * The provider's install entry (which login only runs for, so it is `ok`) with
 * an in-flight `pendingAuth` marker layered on. Detection no longer carries an
 * auth state, so we preserve the install entry's fields and only add the marker;
 * if no prior entry exists, fall back to a minimal installed entry.
 */
function pendingEntry(base: CapabilityEntry | undefined, pending: PendingAuth, nowMs: number): CapabilityEntry {
  const baseEntry: CapabilityEntry = base ?? {
    state: "ok",
    available: true,
    detectedAt: new Date(nowMs).toISOString(),
  };
  // Starting a login clears the previous attempt's verdict, so the stale
  // `error` / `lastAuthError` of the snapshot we are layering onto are dropped
  // rather than spread forward: keeping detection-failure text on an entry we
  // are about to force to `ok` contradicts itself, and republishing it would
  // slip old (possibly credential-bearing) text past the sanitising boundary.
  const { error: _staleError, lastAuthError: _staleAuthError, ...carried } = baseEntry;
  // A login only starts after the provider binary resolved, so the provider IS
  // installed: force the install fields rather than inheriting a possibly-stale
  // non-`ok` base (which would yield a contradictory `missing` + pendingAuth
  // entry). `authenticated`/`authMethod` are deprecated wire-compat for older
  // servers (see the client-capabilities schema).
  return {
    ...carried,
    state: "ok",
    available: true,
    authenticated: true,
    authMethod: "none",
    pendingAuth: pending,
  };
}

/**
 * A `browser` pending marker so the web shows "finish sign-in in your browser".
 * `authUrl` (the provider's sign-in URL, once the login process prints it) lets
 * the web offer a "didn't open? open sign-in" link when the host browser does
 * not auto-launch.
 */
function browserPending(nowMs: number, authUrl?: string): PendingAuth {
  return {
    method: "browser",
    expiresAt: new Date(nowMs + BROWSER_LOGIN_TIMEOUT_MS).toISOString(),
    ...(authUrl ? { authUrl } : {}),
  };
}

/**
 * Dispatch on the typed auth provider. Never throws — failures are logged and
 * reflected in capabilities.
 */
export async function runRuntimeAuthLogin(command: RuntimeAuthCommand, deps: RuntimeAuthLoginDeps): Promise<void> {
  const driver: RuntimeAuthDriver | undefined = (deps.drivers ?? RUNTIME_AUTH_DRIVERS)[command.provider];
  // Unreachable through the Zod-parsed reverse command, which only yields keys
  // of the table. Kept because this orchestrator is exported and a table built
  // elsewhere could still be short an entry.
  if (!driver) {
    deps.log("⚠️", `runtime-auth: provider "${command.provider}" is not supported yet (ref ${command.ref})`);
    return;
  }
  await driveRuntimeAuthLogin(command, driver, deps);
}

async function driveRuntimeAuthLogin(
  command: RuntimeAuthCommand,
  driver: RuntimeAuthDriver,
  deps: RuntimeAuthLoginDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const { logLabel, loginLabel, artifactLabel } = driver;

  // Re-probe the real state and, on a terminal failure, stamp `lastAuthError`
  // onto the login target's entry so the web shows "sign-in failed — retry"
  // instead of silently resetting to a fresh Connect button. A driver may
  // return more than one row when providers share a credential; only the
  // target row carries the failure.
  const reflect = async (label: string, failure: AuthFailure | null): Promise<void> => {
    try {
      for (const { provider, entry } of await driver.reprobe()) {
        const safe = sanitizeProbedEntry(entry);
        const published = provider === command.provider ? attachAuthError(safe, failure, now()) : safe;
        await deps.setProviderEntry(provider, published);
      }
    } catch (err) {
      deps.log("⚠️", `runtime-auth: ${logLabel} re-probe ${label} failed: ${message(err)}`);
    }
  };

  deps.log("•", `runtime-auth: starting ${loginLabel} (method=browser, ref ${command.ref})`);

  // A resolver reaches into PATH and the host filesystem, so it can throw as
  // well as report a missing artifact. To an operator both mean the login never
  // started, and neither may escape this orchestrator.
  let resolution: RuntimeAuthLoginResolution;
  try {
    resolution = await driver.resolveLogin();
  } catch (err) {
    deps.log("⚠️", `runtime-auth: ${logLabel} ${artifactLabel} lookup threw: ${message(err)}`);
    await reflect(`after ${artifactLabel} lookup threw`, { reason: "spawn-error", message: message(err) });
    return;
  }
  if (!resolution.ok) {
    deps.log("⚠️", `runtime-auth: ${logLabel} ${artifactLabel} unavailable: ${resolution.error}`);
    await reflect(`after unresolved ${artifactLabel}`, { reason: "spawn-error", message: resolution.error });
    return;
  }

  // `onAuthUrl` fires from the login's output stream, so its entry write races
  // the terminal re-probe that follows the login. Chaining the pending writes
  // and draining them before the terminal reflection keeps the operator's view
  // moving forwards — pending, then pending + URL, then the outcome — instead
  // of a late pending marker landing on top of an already finished login.
  let pendingWrites: Promise<void> = Promise.resolve();
  const setPending = (authUrl?: string): Promise<void> => {
    pendingWrites = pendingWrites.then(async () => {
      try {
        await deps.setProviderEntry(
          command.provider,
          pendingEntry(deps.currentEntry(command.provider), browserPending(now(), authUrl), now()),
        );
      } catch (err) {
        deps.log("⚠️", `runtime-auth: ${logLabel} pending update failed: ${message(err)}`);
      }
    });
    return pendingWrites;
  };
  await setPending();
  deps.log("•", `runtime-auth: ${logLabel} browser sign-in opened on this host`);

  let outcome: LoginOutcome;
  try {
    // Surface the sign-in URL into the pending marker once the login prints it,
    // so the web can offer a fallback link when the host browser does not open.
    outcome = await resolution.login({ onAuthUrl: (url) => void setPending(url) });
  } catch (err) {
    deps.log("⚠️", `runtime-auth: ${loginLabel} threw: ${message(err)}`);
    await pendingWrites;
    await reflect("after login threw", { reason: "spawn-error", message: message(err) });
    return;
  }

  await pendingWrites;
  await reflect("after login", outcome.ok ? null : { reason: outcome.reason, message: outcome.error });
  logOutcome(logLabel, command.ref, outcome, deps);
}

function logOutcome(provider: string, ref: string, outcome: LoginOutcome, deps: RuntimeAuthLoginDeps): void {
  if (outcome.ok) {
    deps.log("✓", `runtime-auth: ${provider} login complete (ref ${ref})`);
  } else {
    deps.log("⚠️", `runtime-auth: ${provider} login failed (${outcome.reason}): ${outcome.error}`);
  }
}
