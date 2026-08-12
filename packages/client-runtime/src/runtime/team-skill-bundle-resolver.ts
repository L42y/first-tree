import type { FirstTreeHubSDK } from "@first-tree/cloud-client";
import type { RuntimeSkillBundle } from "@first-tree/shared";
import type { TeamSkillBundleResolver } from "./managed-skills.js";

/**
 * Keep authenticated transport outside the filesystem reconciler. Handlers
 * adapt their session SDK to the reconciler's narrow immutable-bundle seam.
 */
export function teamSkillBundleResolverFromSdk(sdk: Pick<FirstTreeHubSDK, "fetchAttachment">): TeamSkillBundleResolver {
  return async (bundle: RuntimeSkillBundle): Promise<Buffer> => {
    const resolved = await sdk.fetchAttachment({ id: bundle.attachmentId });
    if (resolved.size !== resolved.bytes.byteLength) {
      throw new Error(`attachment ${bundle.attachmentId} returned inconsistent size metadata`);
    }
    return resolved.bytes;
  };
}
