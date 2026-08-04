import { Navigate } from "react-router";
import { useAgentResources } from "./capability-section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { ResponsibilitiesSection } from "./responsibilities-section.js";

export function ResponsibilitiesTab() {
  const ctx = useAgentDetailContext();
  const resources = useAgentResources(ctx.uuid, { enabled: !!ctx.uuid && !ctx.isHuman });

  if (ctx.isHuman) return <Navigate to="../profile" replace />;
  if (resources.isLoading) {
    return (
      <p className="text-body" style={{ color: "var(--fg-3)" }}>
        Loading responsibilities…
      </p>
    );
  }
  if (resources.error || !resources.data) {
    return (
      <p className="text-body" style={{ color: "var(--state-error)" }}>
        {resources.error instanceof Error ? resources.error.message : "Failed to load responsibilities"}
      </p>
    );
  }

  return (
    <ResponsibilitiesSection
      agentUuid={ctx.agent.uuid}
      agentStatus={ctx.agent.status}
      canManage={ctx.canEditConfig}
      templateIds={resources.data.templateIds}
      adoptedTemplates={resources.data.adoptedTemplates}
      version={resources.data.version}
    />
  );
}
