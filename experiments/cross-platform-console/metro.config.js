const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the workspace package sources so Metro can follow pnpm symlinks
// (e.g. node_modules/@first-tree/shared -> packages/shared).
config.watchFolders = [
  projectRoot,
  path.resolve(workspaceRoot, "packages/shared"),
];

// Make sure Metro looks in the project's node_modules for dependencies.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

// Required for pnpm-style symlinks and packages that use the modern
// "exports" field (like @first-tree/shared).
config.resolver.unstable_enableSymlinks = true;
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
