#!/usr/bin/env node

import { parseArgs, readJson, validateArtifactBundle } from "./lib.mjs";

try {
  const args = parseArgs(process.argv.slice(2), ["bundle"]);
  const prepared = validateArtifactBundle(readJson(args.bundle));
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "return-meeting-context.prepared-artifacts.v1",
        source_revision: prepared.source_revision,
        source_status: prepared.source_status,
        artifact_count: prepared.bundle.artifacts.length,
        input_kinds: [...new Set(prepared.bundle.artifacts.map((artifact) => artifact.input_kind))],
        source_roles: [...new Set(prepared.bundle.artifacts.map((artifact) => artifact.source_role))],
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
