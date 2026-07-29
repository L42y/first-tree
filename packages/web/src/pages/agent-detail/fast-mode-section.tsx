import { Switch } from "../../components/ui/switch.js";
import { ConfigRow } from "./flat-section.js";

const FAST_MODE_HELP =
  "Applies to new sessions. Requests Codex's provider-native Fast service tier, which uses credits faster. Unsupported model or account combinations fail visibly without a fallback.";

export type FastModeSectionProps = {
  serviceTier: string;
  onChange: (serviceTier: string) => void;
  disabled?: boolean;
};

export function FastModeSection({ serviceTier, onChange, disabled }: FastModeSectionProps) {
  const enabled = serviceTier === "fast";
  const label = enabled ? "Fast" : serviceTier === "default" ? "Standard" : serviceTier;

  return (
    <ConfigRow label="Fast mode" helpText={FAST_MODE_HELP}>
      <div className="flex items-center gap-2">
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => onChange(checked ? "fast" : "default")}
          disabled={disabled}
          aria-label="Fast mode"
        />
        <span className="text-label" style={{ color: "var(--fg-3)" }}>
          {label}
        </span>
      </div>
    </ConfigRow>
  );
}
