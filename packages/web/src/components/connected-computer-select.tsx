import type { ReactElement } from "react";
import type { HubClient } from "../api/activity.js";
import { Select } from "./ui/select.js";

type ConnectedComputerSelectProps = {
  clients: HubClient[];
  value: string | null;
  onChange: (clientId: string) => void;
  id?: string;
};

function clientLabel(client: HubClient): string {
  return client.hostname ?? client.id;
}

function operatingSystemLabel(os: string | null): string {
  switch (os?.toLowerCase()) {
    case "darwin":
    case "macos":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
    case "windows":
      return "Windows";
    default:
      return os ?? "Unknown OS";
  }
}

function clientHint(client: HubClient): string {
  return `${operatingSystemLabel(client.os)} · online`;
}

/**
 * Compact multi-computer picker shared by both agent-creation surfaces.
 * The hostname and connection context stay visible in the collapsed trigger;
 * no extra "On" label is needed inside the surrounding execution field.
 */
export function ConnectedComputerSelect({ clients, value, onChange, id }: ConnectedComputerSelectProps): ReactElement {
  return (
    <Select
      id={id}
      value={value ?? ""}
      onChange={onChange}
      options={clients.map((client) => ({
        value: client.id,
        label: clientLabel(client),
        hint: clientHint(client),
      }))}
      placeholder="Choose a computer"
      aria-label="Choose a computer"
      hintLayout="stacked"
      triggerClassName="h-auto min-h-9 py-2"
    />
  );
}

/** Read-only counterpart for the common single-computer path. */
export function ConnectedComputerSummary({ client }: { client: HubClient }): ReactElement {
  return (
    <div className="min-w-0">
      <div className="truncate text-body font-medium">{clientLabel(client)}</div>
      <div className="text-caption text-muted-foreground">{clientHint(client)}</div>
    </div>
  );
}
