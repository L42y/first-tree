const fs = require("node:fs");
const path = require("node:path");

const { IOSConfig, withDangerousMod, withPodfile, withXcodeProject } = require("expo/config-plugins");

const CATALYST_ENTITLEMENTS_SUFFIX = "-MacCatalyst.entitlements";

function withMacCatalyst(config) {
  config = withDangerousMod(config, ["ios", createCatalystEntitlements]);
  config = withPodfile(config, enableMacCatalystPods);
  return withXcodeProject(config, enableMacCatalystTarget);
}

function createCatalystEntitlements(config) {
  const { platformProjectRoot, projectName } = config.modRequest;
  const entitlementsFile = `${projectName}${CATALYST_ENTITLEMENTS_SUFFIX}`;
  const entitlementsDirectory = path.join(platformProjectRoot, projectName);
  const entitlementsPath = path.join(entitlementsDirectory, entitlementsFile);

  fs.mkdirSync(entitlementsDirectory, { recursive: true });
  if (!fs.existsSync(entitlementsPath)) {
    fs.writeFileSync(entitlementsPath, `${CATALYST_ENTITLEMENTS}\n`);
  }

  return config;
}

function enableMacCatalystPods(config) {
  const podfile = config.modResults.contents;
  const catalystOption = /:mac_catalyst_enabled\s*=>\s*(?:true|false)/;

  if (catalystOption.test(podfile)) {
    config.modResults.contents = podfile.replace(catalystOption, ":mac_catalyst_enabled => true");
    return config;
  }

  const postInstallCall = /(react_native_post_install\(\s*installer,\s*config\[:reactNativePath\],)/;
  if (!postInstallCall.test(podfile)) {
    throw new Error("Could not find react_native_post_install in the generated Podfile.");
  }

  config.modResults.contents = podfile.replace(postInstallCall, "$1\n        :mac_catalyst_enabled => true,");
  return config;
}

function enableMacCatalystTarget(config) {
  const project = config.modResults;
  const [, applicationTarget] = IOSConfig.Target.findFirstNativeTarget(project);
  const buildConfigurations = IOSConfig.XcodeUtils.getBuildConfigurationsForListId(
    project,
    applicationTarget.buildConfigurationList,
  );
  const entitlementsPath = `${config.modRequest.projectName}/${config.modRequest.projectName}${CATALYST_ENTITLEMENTS_SUFFIX}`;

  for (const [, buildConfiguration] of buildConfigurations) {
    buildConfiguration.buildSettings.SUPPORTED_PLATFORMS = '"iphoneos iphonesimulator macosx"';
    buildConfiguration.buildSettings.SUPPORTS_MACCATALYST = "YES";
    buildConfiguration.buildSettings.SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD = "NO";
    buildConfiguration.buildSettings.DERIVE_MACCATALYST_PRODUCT_BUNDLE_IDENTIFIER = "NO";
    buildConfiguration.buildSettings['"CODE_SIGN_ENTITLEMENTS[sdk=macosx*]"'] = entitlementsPath;
  }

  IOSConfig.XcodeUtils.addFileToGroupAndLink({
    filepath: entitlementsPath,
    groupName: config.modRequest.projectName,
    project,
    addFileToProject({ file, project: xcodeProject }) {
      xcodeProject.addToPbxFileReferenceSection(file);
    },
  });

  return config;
}

const CATALYST_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
</dict>
</plist>`;

module.exports = withMacCatalyst;
