import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CAPTURE_SCHEMA = "return-meeting-context.capture.v1";
export const CONFIG_SCHEMA = "return-meeting-context.config.v1";
export const INPUT_SCHEMA = "return-meeting-context.analysis-input.v1";
export const OUTPUT_SCHEMA = "return-meeting-context.analysis-output.v1";
export const VALIDATED_SCHEMA = "return-meeting-context.validated-output.v1";
export const STATE_SCHEMA = "return-meeting-context.state.v1";

export const CANDIDATE_DISPOSITIONS = new Set([
  "draft-eligible",
  "already-present",
  "already-proposed",
  "revisit",
  "skip",
  "blocked-source",
  "failed",
]);

export const MEETING_DISPOSITIONS = new Set(["no-change", "candidates", "blocked-source", "failed"]);

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replaceAll("-", "_");
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function readJsonIfExists(file, fallback) {
  try {
    return readJson(file);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function writeJsonAtomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, mode);
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : stableStringify(value))
    .digest("hex");
}

export function requireAbsolute(file, label) {
  assert(typeof file === "string" && path.isAbsolute(file), `${label} must be an absolute path`);
  return path.resolve(file);
}

export function ensurePrivateStateDir(stateDir) {
  const resolved = requireAbsolute(stateDir, "config.state_dir");
  const existed = fs.existsSync(resolved);
  if (existed) {
    const existing = fs.lstatSync(resolved);
    assert(existing.isDirectory() && !existing.isSymbolicLink(), "config.state_dir must be a real directory");
  } else {
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  const canonical = fs.realpathSync(resolved);
  const forbiddenParts = new Set(["context-tree", "source-repos", "worktrees", ".git"]);
  for (const part of canonical.split(path.sep)) {
    assert(!forbiddenParts.has(part), `config.state_dir must stay outside ${part}`);
  }
  if (existed && process.platform !== "win32") {
    assert((fs.statSync(canonical).mode & 0o077) === 0, "config.state_dir must not be accessible by group or others");
  } else if (!existed) {
    fs.chmodSync(canonical, 0o700);
  }
  return canonical;
}

export function safeStem(value) {
  const cleaned = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || sha256(String(value ?? "")).slice(0, 16);
}

export function normalizeIso(value, label) {
  const date = new Date(value);
  assert(!Number.isNaN(date.getTime()), `${label} must be an ISO-8601 timestamp`);
  return date.toISOString();
}

export function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function systemTempRoot() {
  return fs.realpathSync(os.tmpdir());
}

export function ensureDedicatedTempDir(name) {
  assert(/^return-meeting-context(?:-[a-z0-9-]+)?$/.test(name), "invalid dedicated temp directory name");
  const systemRoot = systemTempRoot();
  const root = path.join(systemRoot, name);
  const existed = fs.existsSync(root);
  if (existed) {
    const existing = fs.lstatSync(root);
    assert(existing.isDirectory() && !existing.isSymbolicLink(), `${name} must be a real directory`);
  } else {
    fs.mkdirSync(root, { mode: 0o700 });
  }
  const canonical = fs.realpathSync(root);
  assert(
    path.dirname(canonical) === systemRoot,
    `${name} must stay directly beneath the operating-system temp directory`,
  );
  if (existed && process.platform !== "win32") {
    assert((fs.statSync(canonical).mode & 0o077) === 0, `${name} must not be accessible by group or others`);
  } else if (!existed) {
    fs.chmodSync(canonical, 0o700);
  }
  return canonical;
}

export function runTempRoot(explicitRoot) {
  if (!explicitRoot) return ensureDedicatedTempDir("return-meeting-context");
  const root = requireAbsolute(explicitRoot, "--tmp-root");
  assert(
    /^return-meeting-context(?:-[a-z0-9-]+)?$/.test(path.basename(root)),
    "--tmp-root must use a dedicated return-meeting-context name",
  );
  const systemRoot = systemTempRoot();
  const existed = fs.existsSync(root);
  let canonical;
  if (existed) {
    const existing = fs.lstatSync(root);
    assert(existing.isDirectory() && !existing.isSymbolicLink(), "--tmp-root must be a real directory");
    canonical = fs.realpathSync(root);
  } else {
    const parent = path.dirname(root);
    const parentStat = fs.lstatSync(parent);
    assert(parentStat.isDirectory() && !parentStat.isSymbolicLink(), "--tmp-root parent must be a real directory");
    const canonicalParent = fs.realpathSync(parent);
    assert(within(systemRoot, canonicalParent), "--tmp-root parent must stay within the OS temp directory");
    canonical = path.join(canonicalParent, path.basename(root));
    assert(
      canonical !== systemRoot && within(systemRoot, canonical),
      "--tmp-root must stay strictly beneath the OS temp directory",
    );
    fs.mkdirSync(canonical, { mode: 0o700 });
  }
  canonical = fs.realpathSync(canonical);
  assert(
    canonical !== systemRoot && within(systemRoot, canonical),
    "--tmp-root resolves outside the OS temp directory",
  );
  if (existed && process.platform !== "win32") {
    assert((fs.statSync(canonical).mode & 0o077) === 0, "--tmp-root must not be accessible by group or others");
  } else if (!existed) {
    fs.chmodSync(canonical, 0o700);
  }
  return canonical;
}

export function acquireLock(stateDir, runId, { recoverStale = false, staleAfterMs = 6 * 60 * 60 * 1000 } = {}) {
  const lockPath = path.join(stateDir, "run.lock.json");
  const lock = {
    schema: "return-meeting-context.lock.v1",
    run_id: runId,
    created_at: new Date().toISOString(),
  };
  try {
    const descriptor = fs.openSync(lockPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`);
    } catch (error) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // The original write failure is authoritative.
      }
      throw error;
    } finally {
      fs.closeSync(descriptor);
    }
    return lockPath;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const existing = readJsonIfExists(lockPath, null);
  const age = existing ? Date.now() - new Date(existing.created_at).getTime() : Number.NaN;
  assert(
    existing && recoverStale && Number.isFinite(age) && age > staleAfterMs,
    `another run is active or needs explicit stale-lock recovery: ${existing?.run_id ?? "unknown"}`,
  );
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return acquireLock(stateDir, runId);
}

export function assertLockOwned(lockPath, runId) {
  const lock = readJsonIfExists(lockPath, null);
  assert(lock?.run_id === runId, "run lock is missing or owned by another run");
}

export function releaseLock(lockPath, runId) {
  const lock = readJsonIfExists(lockPath, null);
  if (!lock) return;
  assert(lock.run_id === runId, "refusing to release a lock owned by another run");
  fs.unlinkSync(lockPath);
}

export function defaultState() {
  return {
    schema: STATE_SCHEMA,
    source_revisions: {},
    watermarks: {},
    processed_run_keys: {},
    meeting_dispositions: {},
    candidate_dispositions: {},
    updated_at: null,
  };
}

export function readState(file) {
  const state = readJsonIfExists(file, defaultState());
  assert(state.schema === STATE_SCHEMA, `unsupported state schema: ${state.schema}`);
  return state;
}

export function meetingKey(provider, profile, providerMeetingId) {
  return `${provider}:${profile}:${providerMeetingId}`;
}

export function sourceRevision(meeting, segmentHashes) {
  return sha256({
    provider_meeting_id: meeting.provider_meeting_id,
    calendar_event_id: meeting.calendar_event_id,
    started_at: meeting.started_at,
    ended_at: meeting.ended_at ?? null,
    source_status: meeting.source_status,
    source_refs: meeting.source_refs ?? [],
    segment_hashes: segmentHashes,
  });
}

export function normalizeClaimText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

export function claimHash(candidate) {
  return sha256({
    what: normalizeClaimText(candidate.claim?.what),
    why: normalizeClaimText(candidate.claim?.why),
    constraints: (candidate.claim?.constraints ?? []).map(normalizeClaimText),
    target_hint: normalizeClaimText(candidate.target?.path_hint),
  });
}

export function candidateId(meetingId, hash) {
  return `meeting-${safeStem(meetingId)}-${hash.slice(0, 16)}`;
}

export function removeRunDir(runDir, tempRoot) {
  const resolved = path.resolve(runDir);
  const root = fs.realpathSync(requireAbsolute(tempRoot, "run temp root"));
  const base = path.basename(resolved);
  assert(base.startsWith("run-"), "refusing to remove a directory without the run- prefix");
  assert(path.dirname(resolved) === root, "refusing to remove a run outside its bound temp root");
  assert(
    root !== systemTempRoot() &&
      within(systemTempRoot(), root) &&
      /^return-meeting-context(?:-[a-z0-9-]+)?$/.test(path.basename(root)),
    "run temp root must be a dedicated directory beneath the operating-system temp directory",
  );
  const canonicalRun = fs.realpathSync(resolved);
  assert(path.dirname(canonicalRun) === root, "run directory resolves outside its bound temp root");
  fs.rmSync(resolved, { recursive: true, force: true });
}

export function cleanObject(value) {
  if (Array.isArray(value)) return value.map(cleanObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cleanObject(child)]));
  }
  return value;
}
