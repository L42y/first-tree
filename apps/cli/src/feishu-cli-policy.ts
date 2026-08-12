export type OfficialResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

/** Build the child-only Bot environment without persisting CLI credentials. */
export function buildBotEnvironment(parent: NodeJS.ProcessEnv, appId: string, appSecret: string): NodeJS.ProcessEnv {
  const env = { ...parent };
  env.LARKSUITE_CLI_APP_ID = appId;
  env.LARKSUITE_CLI_APP_SECRET = appSecret;
  delete env.LARKSUITE_CLI_USER_ACCESS_TOKEN;
  delete env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN;
  return env;
}

/** Block every known stock-CLI path that could bypass canonical First Tree message creation. */
export function isUncontrolledMessageMutation(args: readonly string[]): boolean {
  if (args[0] === "api") {
    const method = args[1]?.toUpperCase();
    const path = args[2]?.split("?", 1)[0] ?? "";
    if (!method || ["GET", "HEAD", "OPTIONS"].includes(method)) return false;
    return (
      /^\/open-apis\/im\/v1\/messages\/?$/.test(path) ||
      /^\/open-apis\/im\/v1\/messages\/[^/]+(?:\/reply|\/forward|\/merge_forward)?\/?$/.test(path) ||
      /^\/open-apis\/im\/v1\/threads\/[^/]+\/forward\/?$/.test(path)
    );
  }
  if (args[0] !== "im") return false;
  if (args[1] === "+messages-send" || args[1] === "+messages-reply") return false;
  if (args[1] === "messages") {
    return ["create", "delete", "forward", "merge_forward", "urgent_app", "urgent_phone", "urgent_sms"].includes(
      args[2] ?? "",
    );
  }
  return args[1] === "threads" && args[2] === "forward";
}

/** Only transient failures are eligible for bounded retries in the current CLI invocation. */
export function retryableFailure(result: OfficialResult): boolean {
  if (result.timedOut) return true;
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    /\b429\b|rate.?limit|too many requests/.test(output) ||
    /\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/.test(output) ||
    /econnreset|econnrefused|enotfound|etimedout|socket hang up|network error|fetch failed/.test(output)
  );
}
