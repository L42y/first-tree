import { Navigate } from "react-router";
import { FeishuSection } from "./feishu-section.js";
import { useAgentDetailContext } from "./layout-context.js";

export function ChannelsTab() {
  const ctx = useAgentDetailContext();
  if (ctx.isHuman) return <Navigate to="../profile" replace />;

  const openProfile = ctx.canManageAgent
    ? () => ctx.navigateAway(`/agents/${encodeURIComponent(ctx.uuid)}/profile`)
    : undefined;

  return <FeishuSection onOpenProfile={openProfile} />;
}
