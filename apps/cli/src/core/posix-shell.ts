import type { ResolvedBinary } from "./supervisor/types.js";

export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function renderCliInvocation(invocation: ResolvedBinary): string {
  return invocation.kind === "bin"
    ? quotePosixShellArg(invocation.program)
    : [invocation.program, ...(invocation.args ?? [])].map(quotePosixShellArg).join(" ");
}
