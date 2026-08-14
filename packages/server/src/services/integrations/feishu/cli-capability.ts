export type FeishuCliCapability = {
  available: boolean;
  sdkVersion: string | null;
};

/** Parse the Client-reported official lark-cli capability without trusting its shape. */
export function readFeishuCliCapability(
  metadata: Record<string, unknown> | null | undefined,
): FeishuCliCapability | null {
  const capabilities = metadata?.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return null;
  const entry = (capabilities as Record<string, unknown>)["lark-cli"];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const value = entry as Record<string, unknown>;
  return {
    available: value.available === true,
    sdkVersion: typeof value.sdkVersion === "string" ? value.sdkVersion : null,
  };
}
