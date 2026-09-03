import Ionicons from "@expo/vector-icons/Ionicons";
import { StyleSheet, Text, View } from "react-native";

import {
  type AgentActivity,
  type AgentRuntimeSummary,
  agentActivity,
  effortLabel,
  modelLabel,
} from "~/lib/agent-runtime";
import { colors } from "~/lib/theme";

/**
 * The secondary line of an agent row: what model it runs and how hard it
 * thinks. Humans have neither, and a row whose config this member cannot read
 * falls back to the runtime name alone — in both cases the line is simply
 * absent rather than padded with a label that says nothing ("Agent").
 */
export function AgentMetaLine({
  summary,
  showActivity = false,
}: {
  summary?: AgentRuntimeSummary;
  /** Rosters show what the agent is doing; the mention picker does not. */
  showActivity?: boolean;
}) {
  if (!summary) return null;
  const model = modelLabel(summary);
  const effort = effortLabel(summary);
  const activity = showActivity ? agentActivity(summary) : null;
  if (!model && !effort && !activity) return null;
  return (
    <View style={styles.line}>
      {activity && <ActivityChip activity={activity} />}
      {model && (
        <View style={styles.chip}>
          <Ionicons name="hardware-chip-outline" size={11} color={colors.textMuted} />
          <Text style={styles.text} numberOfLines={1}>
            {model}
          </Text>
        </View>
      )}
      {effort && (
        <View style={styles.chip}>
          <Ionicons name="flash-outline" size={11} color={colors.textMuted} />
          <Text style={styles.text} numberOfLines={1}>
            {effort}
          </Text>
        </View>
      )}
    </View>
  );
}

/** Status glyph plus its word — the icon alone is not a label. */
export function ActivityChip({ activity }: { activity: AgentActivity }) {
  const tone = TONE_COLORS[activity.tone];
  return (
    <View style={styles.chip}>
      <Ionicons name={activity.icon as never} size={11} color={tone} />
      <Text style={[styles.text, { color: tone }]} numberOfLines={1}>
        {activity.label}
      </Text>
    </View>
  );
}

const TONE_COLORS: Record<AgentActivity["tone"], string> = {
  positive: "#33AC5A",
  warning: "#C99F00",
  danger: colors.danger,
  muted: colors.textMuted,
};

const styles = StyleSheet.create({
  line: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    flexShrink: 1,
  },
  text: {
    color: colors.textSecondary,
    fontSize: 12,
  },
});
