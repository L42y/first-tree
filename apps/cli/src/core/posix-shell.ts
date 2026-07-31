export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
