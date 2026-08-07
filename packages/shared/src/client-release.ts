export const MIN_RUNTIME_SWITCH_CLIENT_VERSION = "0.5.12";

/**
 * Runtime reconfiguration first shipped in Client 0.5.12. The public release
 * line restarted at 0.5.0 after 0.14.8, so an ordinary semver comparison would
 * incorrectly treat the older 0.14.x line as supported.
 *
 * Keep this fail-closed to the current release epoch and the repository's
 * exact staging-package shape. A staging patch is the next patch after its
 * stable base, so 0.5.13-staging is the first staging line guaranteed to
 * contain the capability shipped in stable 0.5.12. A future release-line reset
 * must be added explicitly from release chronology before it can switch an
 * agent runtime.
 */
export function supportsRuntimeSwitchClientVersion(version: string | null): boolean {
  if (!version) return false;
  const match = /^v?0\.5\.(0|[1-9]\d*)(?:(?:\+[0-9A-Za-z.-]+)|(?:-staging\.([1-9]\d*)\.([1-9]\d*)))?$/.exec(version);
  if (!match) return false;
  const patch = Number(match[1]);
  const stagingRun = match[2] === undefined ? null : Number(match[2]);
  const stagingAttempt = match[3] === undefined ? null : Number(match[3]);
  if (!Number.isSafeInteger(patch)) return false;
  if (stagingRun === null || stagingAttempt === null) return patch >= 12;
  return Number.isSafeInteger(stagingRun) && Number.isSafeInteger(stagingAttempt) && patch >= 13;
}
