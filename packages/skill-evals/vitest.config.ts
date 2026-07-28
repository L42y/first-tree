import { defineConfig } from "vitest/config";
import { monorepoSourceAliases } from "../../scripts/vitest-aliases.js";
import { isCiEnvironment, resolveVitestMaxForks } from "../../scripts/vitest-max-forks.js";

const maxForks = resolveVitestMaxForks(2);
const isCi = isCiEnvironment();

export default defineConfig({
  resolve: {
    // Unit collection should compile workspace sources directly instead of
    // racing a sibling package's dist cleanup/build.
    alias: monorepoSourceAliases,
  },
  test: {
    // Fixture suites create real temporary repositories and worktrees. Their
    // previous implicit 5s ceiling measured host contention, not correctness.
    testTimeout: 30_000,
    fileParallelism: !isCi && maxForks > 1,
    pool: "forks",
    poolOptions: {
      forks: {
        isolate: true,
        maxForks,
        minForks: 1,
      },
    },
  },
});
