import { AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES, type AgentTemplateAdoptionSummary } from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { trackEvent } from "../../analytics.js";
import { updateAgentTemplates } from "../../api/agent-templates.js";
import { ApiError } from "../../api/client.js";
import { TemplateResponsibilityLabel } from "../../components/template-responsibility-label.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Section } from "../../components/ui/section.js";
import { agentResourcesMutationHandlers } from "./capability-section.js";
import { titleWithSemantics, useJustSaved } from "./save-semantics.js";

/**
 * Compact Template provenance inside Profile. This section explains only the
 * responsibilities already adopted by the agent; discovery and adoption stay
 * in agent creation and the Template Library.
 */
export type ResponsibilitiesSectionProps = {
  agentUuid: string;
  agentStatus: string;
  canManage: boolean;
  templateIds: string[];
  adoptedTemplates: AgentTemplateAdoptionSummary[];
  version: number;
};

const VERSION_CAS_FEEDBACK =
  "This agent changed elsewhere. Its responsibilities were refreshed — review and remove again.";

export function ResponsibilitiesSection({
  agentUuid,
  agentStatus,
  canManage,
  templateIds,
  adoptedTemplates,
  version,
}: ResponsibilitiesSectionProps) {
  const queryClient = useQueryClient();
  const { justSaved, markSaved } = useJustSaved();
  const [removeTarget, setRemoveTarget] = useState<AgentTemplateAdoptionSummary | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const canEdit = canManage && agentStatus === "active";
  const closeRemoveDialog = () => {
    setRemoveTarget(null);
    setFeedback(null);
  };

  const ordered = useMemo(() => {
    const byId = new Map(adoptedTemplates.map((summary) => [summary.id, summary]));
    return templateIds.map((id) => byId.get(id) ?? missingSummary(id)).sort(compareResponsibilitySummaries);
  }, [adoptedTemplates, templateIds]);

  const mutationHandlers = agentResourcesMutationHandlers(queryClient, agentUuid, { onSuccessAfter: markSaved });
  const removeMutation = useMutation({
    mutationFn: (target: AgentTemplateAdoptionSummary) =>
      updateAgentTemplates(agentUuid, {
        expectedVersion: version,
        templateIds: templateIds.filter((id) => id !== target.id),
      }),
    onSuccess: async (next) => {
      await mutationHandlers.onSuccess(next);
      trackEvent("agent_template_replace_set", { result: "success" });
      closeRemoveDialog();
    },
    onError: (error) => {
      mutationHandlers.onError(error);
      trackEvent("agent_template_replace_set", { result: "failure" });
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.VERSION_CONFLICT
      ) {
        setFeedback(VERSION_CAS_FEEDBACK);
        return;
      }
      setFeedback(error instanceof Error ? error.message : "Failed to remove responsibility");
    },
  });

  if (ordered.length === 0) return null;

  const targetName = removeTarget?.name ?? "this unavailable template";

  return (
    <>
      <Section
        headingLevel={3}
        title={titleWithSemantics("Responsibilities", justSaved)}
        count={ordered.length}
        description="One-time starting points imported from Agent Templates. Instructions and tools are managed in their own sections."
      >
        <ul className="m-0 list-none p-0">
          {ordered.map((summary) => (
            <li
              key={summary.id}
              className="flex items-start justify-between gap-3 py-3"
              style={{ borderBottom: "var(--hairline) solid var(--border-faint)" }}
            >
              <TemplateResponsibilityLabel template={summary} variant="assigned" />
              {canEdit ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="shrink-0"
                  aria-label={`Manage ${summary.name ?? `Unavailable template ${summary.id}`} responsibility`}
                  onClick={() => {
                    setFeedback(null);
                    setRemoveTarget(summary);
                  }}
                >
                  Manage
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !removeMutation.isPending) {
            closeRemoveDialog();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove responsibility?</DialogTitle>
            <DialogDescription>
              Only this agent’s bindings created by {targetName} will be removed. Team Resources will remain available.
            </DialogDescription>
          </DialogHeader>
          {feedback ? (
            <p className="text-body text-destructive" role="alert">
              {feedback}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={removeMutation.isPending} onClick={closeRemoveDialog}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!removeTarget || removeMutation.isPending}
              onClick={() => {
                if (removeTarget) removeMutation.mutate(removeTarget);
              }}
            >
              {removeMutation.isPending ? "Removing…" : "Remove responsibility"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function compareResponsibilitySummaries(
  left: AgentTemplateAdoptionSummary,
  right: AgentTemplateAdoptionSummary,
): number {
  if (left.name === null && right.name !== null) return 1;
  if (left.name !== null && right.name === null) return -1;
  if (left.name !== null && right.name !== null) {
    const leftName = left.name.toLocaleLowerCase();
    const rightName = right.name.toLocaleLowerCase();
    if (leftName < rightName) return -1;
    if (leftName > rightName) return 1;
  }
  return left.id.localeCompare(right.id);
}

function missingSummary(id: string): AgentTemplateAdoptionSummary {
  return { id, status: "missing", slug: null, name: null, public: null, replacement: null };
}
