const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// SDK 57's expo metro-config already enables symlinks and package exports
// (stable), so no resolver flags here — expo doctor flags them as drift.
// Only extend what the defaults miss:
config.watchFolders = [
  ...(config.watchFolders ?? []),
  // Follow pnpm workspace symlinks (e.g. @first-tree/shared -> packages/shared).
  path.resolve(workspaceRoot, "packages/shared"),
];

// react-native-markdown-display -> markdown-it requires Node's built-in
// `punycode`, which doesn't exist in RN. Map it to the userland package.
config.resolver.extraNodeModules = {
  punycode: path.resolve(projectRoot, "node_modules/punycode"),
};

module.exports = config;
