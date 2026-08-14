type FeishuBindingState = {
  status: string;
  appId: string | null;
  appSecretCipher: string | null;
  botOpenId: string | null;
  registrationStateCipher: string | null;
};

type UsableFeishuBinding = FeishuBindingState & {
  appId: string;
  appSecretCipher: string;
  botOpenId: string;
};

type ReachableFeishuBindingState = FeishuBindingState & {
  connectionStatus: string;
  connectionOwnerInstanceId: string | null;
  connectionLeaseExpiresAt: Date | null;
};

/** An existing Bot stays usable while a new QR authorization is pending. */
export function isFeishuBotUsable(binding: FeishuBindingState): binding is UsableFeishuBinding {
  if (!binding.appId || !binding.appSecretCipher || !binding.botOpenId) return false;
  if (binding.status === "active") return true;
  return binding.status === "provisioning" && binding.registrationStateCipher !== null;
}

/** Server-authoritative handoff predicate: usable credentials plus a live connection lease. */
export function isFeishuBotReachable(binding: ReachableFeishuBindingState, now = new Date()): boolean {
  return (
    isFeishuBotUsable(binding) &&
    binding.connectionStatus === "connected" &&
    binding.connectionOwnerInstanceId !== null &&
    binding.connectionLeaseExpiresAt !== null &&
    binding.connectionLeaseExpiresAt > now
  );
}
