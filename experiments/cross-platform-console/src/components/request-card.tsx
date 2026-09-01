import type { Message } from "@first-tree/shared";
import { StyleSheet, Text, View } from "react-native";
import { MarkdownText } from "~/components/markdown-text";
import { findResolutionMessage, parseAskRequest } from "~/lib/ask";
import { colors } from "~/lib/theme";

/**
 * Read-only timeline card for `format="request"` messages ("ask user").
 *
 * Answering lives in the root native modal. Only the targeted human sees the
 * open-question affordance; everyone else sees the read-only state.
 */
export function RequestCard({
  message,
  messages,
  selfAgentId,
}: {
  message: Message;
  messages: Message[];
  selfAgentId: string | null;
}) {
  const parsed = parseAskRequest(message);
  const resolution = findResolutionMessage(messages, message.id) ?? null;

  if (!parsed) {
    // Malformed request payload — render the body as a plain card.
    return (
      <View style={styles.card}>
        <MarkdownText value={typeof message.content === "string" ? message.content : ""} />
      </View>
    );
  }

  const isTarget = selfAgentId !== null && parsed.targetAgentId === selfAgentId;

  return (
    <View style={styles.wrap}>
      <View style={[styles.card, resolution ? styles.resolvedCard : styles.openCard]}>
        <Text style={styles.kicker}>{resolution ? "Question · answered" : isTarget ? "Asked you" : "Question"}</Text>
        <MarkdownText value={typeof message.content === "string" ? message.content : ""} />
        {isTarget && !resolution ? (
          <Text style={styles.waitingNote}>Open question — answer in the modal above.</Text>
        ) : null}

        {resolution ? (
          <Text style={styles.resolutionNote}>
            {(() => {
              const kind = (resolution.metadata?.resolves as { kind?: string } | undefined)?.kind;
              const body = typeof resolution.content === "string" ? resolution.content : "";
              return kind === "closed"
                ? body
                  ? `Skipped — ${body}`
                  : "Skipped"
                : body
                  ? `Answered — ${body}`
                  : "Answered";
            })()}
          </Text>
        ) : !isTarget ? (
          <Text style={styles.waitingNote}>Waiting for an answer</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    marginVertical: 4,
    paddingHorizontal: 12,
  },
  card: {
    flex: 1,
    borderRadius: 12,
    padding: 12,
    gap: 10,
    borderWidth: 1,
  },
  openCard: {
    backgroundColor: colors.surfaceStrong,
    borderColor: colors.accent,
  },
  resolvedCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    opacity: 0.85,
  },
  kicker: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: colors.textMuted,
  },
  resolutionNote: {
    color: colors.textMuted,
    fontSize: 13,
  },
  waitingNote: {
    color: colors.textMuted,
    fontSize: 13,
  },
});
