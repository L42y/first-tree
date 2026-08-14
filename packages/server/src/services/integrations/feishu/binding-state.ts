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

/** An existing Bot stays usable while a new QR authorization is pending. */
export function isFeishuBotUsable(binding: FeishuBindingState): binding is UsableFeishuBinding {
  if (!binding.appId || !binding.appSecretCipher || !binding.botOpenId) return false;
  if (binding.status === "active") return true;
  return binding.status === "provisioning" && binding.registrationStateCipher !== null;
}
