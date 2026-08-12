import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Re-point intra-monorepo imports to the source `.ts` entry instead of the
// built `./dist/*.mjs`, so vite/vitest compile workspace sources on the fly.
// `turbo test` still deliberately declares `dependsOn: ["^build"]`: tests do
// not consume those build outputs, but the upstream task hashes ensure that
// package changes invalidate downstream test caches. The cold-CI build cost is
// intentional because replaying tests against stale dependency code is worse.
//
// The runtime / publish paths (the `import` condition consumed by Node, by
// `tsdown` when it inlines `client`/`shared` into the published `command`
// tarball, and by Vite's prod build for `web`) are untouched.
const root = fileURLToPath(new URL("..", import.meta.url));

// Array form (not object) so each alias matches exactly with an anchored
// RegExp. An unanchored prefix like `@first-tree/client` would
// otherwise swallow `@first-tree/client/observability` and rewrite it
// to a bogus path with `/observability` appended to the file.
export const monorepoSourceAliases: { find: RegExp; replacement: string }[] = [
  {
    find: /^@first-tree\/shared\/channel$/,
    replacement: resolve(root, "packages/shared/src/channel/index.ts"),
  },
  {
    find: /^@first-tree\/shared\/config$/,
    replacement: resolve(root, "packages/shared/src/config/index.ts"),
  },
  {
    find: /^@first-tree\/shared\/observability$/,
    replacement: resolve(root, "packages/shared/src/observability/index.ts"),
  },
  {
    find: /^@first-tree\/shared$/,
    replacement: resolve(root, "packages/shared/src/index.ts"),
  },
  {
    find: /^@first-tree\/client\/observability$/,
    replacement: resolve(root, "packages/client/src/cloud/observability/index.ts"),
  },
  {
    find: /^@first-tree\/client$/,
    replacement: resolve(root, "packages/client/src/index.ts"),
  },
  {
    find: /^@first-tree\/server\/observability$/,
    replacement: resolve(root, "packages/server/src/observability/index.ts"),
  },
  {
    find: /^@first-tree\/server\/config$/,
    replacement: resolve(root, "packages/server/src/config.ts"),
  },
  {
    find: /^@first-tree\/server$/,
    replacement: resolve(root, "packages/server/src/app.ts"),
  },
];
