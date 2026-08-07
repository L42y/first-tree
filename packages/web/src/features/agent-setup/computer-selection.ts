import type { RuntimeProvider } from "@first-tree/shared";

export type ComputerSelectionInput = {
  clientIds: readonly string[];
  currentClientId: string | null;
  explicitlySelectedClientId: string | null;
  requireExplicitWhenMultiple: boolean;
};

/**
 * Resolves the computer shown by an agent-creation surface.
 *
 * A sole connected computer is unambiguous. With several computers, creation
 * surfaces accept only a still-connected explicit choice; monitoring surfaces
 * may preserve their current client or fall back to the freshest roster entry.
 */
export function resolveComputerSelection({
  clientIds,
  currentClientId,
  explicitlySelectedClientId,
  requireExplicitWhenMultiple,
}: ComputerSelectionInput): string | null {
  const onlyClientId = clientIds.length === 1 ? clientIds[0] : undefined;
  if (onlyClientId) return onlyClientId;
  if (clientIds.length === 0) return null;

  if (requireExplicitWhenMultiple) {
    return explicitlySelectedClientId && clientIds.includes(explicitlySelectedClientId)
      ? explicitlySelectedClientId
      : null;
  }

  return currentClientId && clientIds.includes(currentClientId) ? currentClientId : (clientIds[0] ?? null);
}

export type RuntimeSelectionInput = {
  currentRuntime: RuntimeProvider | null;
  selectionIsManual: boolean;
  readyRuntimes: readonly RuntimeProvider[];
};

export type RuntimeSelection = {
  runtime: RuntimeProvider | null;
  selectionIsManual: boolean;
};

/**
 * Keeps an explicit runtime choice while it remains available on the selected
 * computer. Automatic choices are recalculated from the catalog-ordered ready
 * list whenever the computer changes.
 */
export function resolveRuntimeSelection({
  currentRuntime,
  selectionIsManual,
  readyRuntimes,
}: RuntimeSelectionInput): RuntimeSelection {
  if (selectionIsManual && currentRuntime && readyRuntimes.includes(currentRuntime)) {
    return { runtime: currentRuntime, selectionIsManual: true };
  }

  return {
    runtime: readyRuntimes[0] ?? currentRuntime,
    selectionIsManual: false,
  };
}
