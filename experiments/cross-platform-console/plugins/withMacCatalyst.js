const fs = require("node:fs");
const path = require("node:path");

const {
  IOSConfig,
  withDangerousMod,
  withPodfile,
  withPodfileProperties,
  withXcodeProject,
} = require("expo/config-plugins");

const CATALYST_ENTITLEMENTS_SUFFIX = "-MacCatalyst.entitlements";

function withMacCatalyst(config) {
  // Expo's prebuilt XCFrameworks don't include Mac Catalyst slices; build from source.
  config = withPodfileProperties(config, (cfg) => {
    cfg.modResults["EXPO_USE_PRECOMPILED_MODULES"] = "false";
    // Build React Native core from source so the React XCFramework module map
    // doesn't exist, preventing <react/renderer/...> includes from being
    // intercepted by the framework module resolver on Mac Catalyst.
    cfg.modResults["ios.buildReactNativeFromSource"] = "true";
    return cfg;
  });
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
  let podfile = config.modResults.contents;

  // 1. Enable :mac_catalyst_enabled in react_native_post_install.
  const catalystOption = /:mac_catalyst_enabled\s*=>\s*(?:true|false)/;
  if (catalystOption.test(podfile)) {
    podfile = podfile.replace(catalystOption, ":mac_catalyst_enabled => true");
  } else {
    const postInstallCall = /(react_native_post_install\(\s*installer,\s*config\[:reactNativePath\],)/;
    if (!postInstallCall.test(podfile)) {
      throw new Error("Could not find react_native_post_install in the generated Podfile.");
    }
    podfile = podfile.replace(postInstallCall, "$1\n        :mac_catalyst_enabled => true,");
  }

  // 2. Exclude x86_64 from every pod target for Mac Catalyst builds.
  //    react-native-enriched-markdown has a C++11 narrowing error on x86_64-macabi.
  //    Also add hermes-engine/destroot/include to React-RuntimeHermes HEADER_SEARCH_PATHS;
  //    when building RN from source, the hermes headers aren't on the default xcconfig path.
  if (!podfile.includes("EXCLUDED_ARCHS[sdk=macosx*]")) {
    const ARCHS_SNIPPET = `
    installer.pods_project.targets.each do |pod_target|
      pod_target.build_configurations.each do |cfg|
        cfg.build_settings["EXCLUDED_ARCHS[sdk=macosx*]"] = "x86_64"
        if pod_target.name == "React-RuntimeHermes"
          existing = cfg.build_settings["HEADER_SEARCH_PATHS"] || "$(inherited)"
          paths = existing.is_a?(Array) ? existing.join(" ") : existing
          hermes_path = '"$\{PODS_ROOT}/hermes-engine/destroot/include"'
          cfg.build_settings["HEADER_SEARCH_PATHS"] = paths + " " + hermes_path unless paths.include?("destroot/include")
        end
      end
    end`;
    podfile = podfile.replace(/(\n  end\nend\s*)$/, `${ARCHS_SNIPPET}\n  end\nend\n`);
  }

  config.modResults.contents = podfile;
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
    // Restrict Mac Catalyst to arm64; react-native-enriched-markdown has a
    // C++11 narrowing error on x86_64-macabi.
    buildConfiguration.buildSettings['"EXCLUDED_ARCHS[sdk=macosx*]"'] = "x86_64";
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
