import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type CanonicalResourceRepoKey, canonicalizeResourceRepoUrl, repoUrlSchema } from "@first-tree/shared";
import { loadCredentials } from "../bootstrap.js";

export type ContextClientPreflight = {
  checkoutRoot: string;
  repositoryKey: CanonicalResourceRepoKey;
  originUrl: string;
};

export function inspectContextClientPreflight(cwd = process.cwd()): ContextClientPreflight {
  if (!loadCredentials()) {
    throw new Error("First Tree is not signed in. Run `first-tree login <code>` first.");
  }

  const absoluteCwd = realpathSync(resolve(cwd));
  const checkoutRoot = runGit(absoluteCwd, ["rev-parse", "--show-toplevel"]);
  const normalizedCheckoutRoot = realpathSync(checkoutRoot);
  const originUrl = runGit(normalizedCheckoutRoot, ["remote", "get-url", "origin"]);
  repoUrlSchema.parse(originUrl);

  return {
    checkoutRoot: normalizedCheckoutRoot,
    repositoryKey: canonicalizeResourceRepoUrl(originUrl),
    originUrl,
  };
}

function runGit(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch {
    throw new Error(
      args[0] === "remote"
        ? "The current Git checkout has no readable `origin` remote."
        : "Run this command inside the target Git checkout.",
    );
  }
}
