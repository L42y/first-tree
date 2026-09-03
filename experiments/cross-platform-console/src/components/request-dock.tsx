import type { Message } from "@first-tree/shared";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MarkdownText } from "~/components/markdown-text";
import type { ParsedRequest } from "~/lib/ask";
import { colors } from "~/lib/theme";

/**
 * Docked ask card — bottom-docked above the composer, modeled on the web
 * console's AskTakeover, but per mobile feedback the dock carries NO input
 * and NO footer buttons: the always-in-place composer is shared (Send =
 * Submit while the ask is open; an "Ask agent" mode toggle posts the note
 * as a clarification without resolving). Skip lives in the card header.
 */
export function RequestDock({
  question,
  parsed,
  collapsed,
  onToggleCollapsed,
  onSkip,
  selected,
  onToggleOption,
  askMode,
  onToggleAskMode,
  thread = [],
  selfAgentId = null,
}: {
  question: Message;
  parsed: ParsedRequest;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSkip: () => void;
  selected: number[];
  onToggleOption: (index: number) => void;
  askMode: "submit" | "clarify";
  onToggleAskMode: () => void;
  /**
   * The question's durable thread, oldest first and excluding the question
   * itself: clarifications raised here and the agent's answers to them. It is
   * fetched by request id, so it stays intact once those messages fall out of
   * the latest page of the chat.
   */
  thread?: Message[];
  selfAgentId?: string | null;
}) {
  const options = parsed.request.options ?? [];
  const multiSelect = parsed.request.multiSelect === true;

  if (collapsed) {
    return (
      <Pressable onPress={onToggleCollapsed} style={({ pressed }) => [styles.collapsedBar, pressed && styles.pressed]}>
        <Text style={styles.collapsedKicker}>Open question</Text>
        <Text style={styles.collapsedText}>Tap to answer</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.dock}>
      <View style={styles.kickerRow}>
        <Text style={styles.kicker}>Asked you</Text>
        <View style={styles.headerActions}>
          <Pressable onPress={onToggleAskMode} hitSlop={6}>
            <Text style={[styles.headerAction, askMode === "clarify" && styles.headerActionActive]}>
              {askMode === "clarify" ? "Asking agent" : "Ask agent"}
            </Text>
          </Pressable>
          <Pressable onPress={onSkip} hitSlop={6}>
            <Text style={[styles.headerAction, styles.skipAction]}>Skip</Text>
          </Pressable>
          <Pressable onPress={onToggleCollapsed} hitSlop={6}>
            <Text style={styles.headerAction}>Show earlier chat</Text>
          </Pressable>
        </View>
      </View>
      <ScrollView style={styles.scroll} nestedScrollEnabled bounces={false}>
        <MarkdownText value={typeof question.content === "string" ? question.content : ""} />
        {options.length > 0 && (
          <View style={styles.options}>
            {options.map((option, index) => {
              const isSelected = selected.includes(index);
              return (
                <Pressable
                  key={`${index}-${option.label}`}
                  onPress={() => onToggleOption(index)}
                  style={[styles.option, isSelected && styles.optionSelected]}
                >
                  <Text style={styles.optionLabel}>
                    {multiSelect ? `${isSelected ? "☑" : "☐"} ` : ""}
                    {option.label}
                  </Text>
                  {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
                </Pressable>
              );
            })}
          </View>
        )}
        {thread.length > 0 && (
          <View style={styles.thread}>
            {thread.map((entry) => (
              <View key={entry.id} style={styles.threadEntry}>
                <Text style={styles.threadAuthor}>
                  {entry.senderId === selfAgentId ? "You asked" : "Agent replied"}
                </Text>
                <MarkdownText value={typeof entry.content === "string" ? entry.content : ""} />
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: {
    maxHeight: 260,
    backgroundColor: colors.surfaceStrong,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 6,
  },
  kickerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  kicker: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
  },
  headerActions: {
    flexDirection: "row",
    gap: 12,
    alignItems: "center",
  },
  headerAction: {
    fontSize: 12,
    color: colors.accent,
    fontWeight: "600",
  },
  headerActionActive: {
    color: colors.text,
    fontWeight: "700",
  },
  skipAction: {
    color: colors.textMuted,
  },
  scroll: {
    flexGrow: 0,
  },
  options: {
    marginTop: 8,
    gap: 6,
    paddingBottom: 4,
  },
  thread: {
    marginTop: 10,
    gap: 8,
    paddingTop: 8,
    paddingBottom: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  threadEntry: {
    gap: 2,
  },
  threadAuthor: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  option: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  optionSelected: {
    borderColor: colors.accent,
    backgroundColor: "rgba(59,130,246,0.18)",
  },
  optionLabel: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 14,
  },
  optionDescription: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  collapsedBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceStrong,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  collapsedKicker: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.accent,
  },
  collapsedText: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  pressed: {
    opacity: 0.75,
  },
});
