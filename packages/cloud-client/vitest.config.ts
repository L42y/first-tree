import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";
import { unitCoverageConfig } from "../../scripts/vitest-coverage.js";
import { resolveVitestMaxForks } from "../../scripts/vitest-max-forks.js";

const maxForks = resolveVitestMaxForks(2);

export default defineConfig({
  resolve: { alias: monorepoSourceAliases },
  test: {
    coverage: unitCoverageConfig(),
    pool: "forks",
    poolOptions: { forks: { maxForks, minForks: 1 } },
  },
});
