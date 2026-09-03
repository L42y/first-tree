import Ionicons from "@expo/vector-icons/Ionicons";
import type { Message } from "@first-tree/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { AskThread } from "~/components/ask-thread";
import { ChatMessageBubble } from "~/components/chat-message-bubble";
import { fetchOpenRequests } from "~/lib/ask";
import type { CatchUpCard } from "~/lib/catch-up";
import { flattenNewestFirstMessages } from "~/lib/chat-read-state";
import { listChatMessages, markMeChatRead } from "~/lib/chats-api";
import { colors } from "~/lib/theme";

/** How much of the conversation a card shows before it asks you to open it. */
const CARD_MESSAGE_LIMIT = 8;

/**
 * One card in the deck. Slack's card is the conversation itself — its name at
 * the top, its unread messages inside — and the two decisions underneath. Ours
 * splits by what the card owes you: a question is cleared by answering it, so
 * the answer surface is in the card; unread mentions are cleared by reading
 * them, so they get Slack's pair verbatim.
 */
export function CatchUpCardView({
  card,
  onDone,
}: {
  card: CatchUpCard;
  /** Advance the deck; `keepUnread` leaves the chat exactly as it was. */
  onDone: (outcome: "cleared" | "kept") => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [working, setWorking] = useState(false);

  const openChat = () => router.push({ pathname: `/chat/${card.chatId}` } as never);

  const asksQuery = useQuery({
    queryKey: ["chats", card.chatId, "open-requests"],
    queryFn: ({ signal }) => fetchOpenRequests(card.chatId, signal),
    enabled: card.kind === "ask",
  });
  const messagesQuery = useQuery({
    queryKey: ["chats", card.chatId, "catch-up-window"],
    queryFn: ({ signal }) => listChatMessages(card.chatId, { limit: CARD_MESSAGE_LIMIT }, signal),
    enabled: card.kind === "unread",
  });

  const ask: Message | null = asksQuery.data?.[0] ?? null;
  const messages = messagesQuery.data ? flattenNewestFirstMessages([messagesQuery.data.items]) : [];

  const markRead = async () => {
    setWorking(true);
    try {
      await markMeChatRead(card.chatId);
      await queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });
      onDone("cleared");
    } finally {
      setWorking(false);
    }
  };

  return (
    <View style={styles.card}>
      <Pressable onPress={openChat} style={({ pressed }) => [styles.cardHead, pressed && styles.pressed]}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {card.title}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
      </Pressable>

      <ScrollView style={styles.cardBody} contentContainerStyle={styles.cardBodyContent}>
        {card.kind === "ask" ? (
          ask ? (
            // Answering is the whole point of the card, so the thread — options,
            // reply box and all — lives in it. No round trip to the chat.
            <AskThread chatId={card.chatId} requestId={ask.id} question={ask} onResolved={() => onDone("cleared")} />
          ) : (
            <View style={styles.cardLoading}>
              {asksQuery.isLoading ? (
                <ActivityIndicator color={colors.textMuted} />
              ) : (
                <Text style={styles.hint}>This question was already answered.</Text>
              )}
            </View>
          )
        ) : messages.length > 0 ? (
          <>
            <View style={styles.newDivider}>
              <View style={styles.newLine} />
              <Text style={styles.newText}>New</Text>
              <View style={styles.newLine} />
            </View>
            {messages.map((message) => (
              <ChatMessageBubble
                key={message.id}
                message={message}
                isMe={false}
                senderName={message.senderId.slice(0, 8)}
              />
            ))}
          </>
        ) : (
          <View style={styles.cardLoading}>
            {messagesQuery.isLoading ? (
              <ActivityIndicator color={colors.textMuted} />
            ) : (
              <Text style={styles.hint}>Nothing left to read here.</Text>
            )}
          </View>
        )}
      </ScrollView>

      {/* Slack's pair, named for what they do here. A question is never
          "marked read" — it is answered above, or left for later. */}
      <View style={styles.cardActions}>
        <Pressable
          onPress={() => onDone("kept")}
          disabled={working}
          style={({ pressed }) => [styles.secondaryAction, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryActionText}>{card.kind === "ask" ? "Later" : "Keep unread"}</Text>
        </Pressable>
        {card.kind === "unread" && (
          <Pressable
            onPress={() => void markRead()}
            disabled={working}
            style={({ pressed }) => [styles.primaryAction, pressed && styles.pressed]}
          >
            {working ? (
              <ActivityIndicator size="small" color={colors.accentText} />
            ) : (
              <Text style={styles.primaryActionText}>Mark as read</Text>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surfaceFloating,
    overflow: "hidden",
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  cardTitle: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  cardBody: {
    flex: 1,
  },
  cardBodyContent: {
    padding: 12,
    gap: 8,
  },
  cardLoading: {
    paddingVertical: 32,
    alignItems: "center",
  },
  hint: {
    color: colors.textMuted,
    fontSize: 13,
  },
  newDivider: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingBottom: 4,
  },
  newLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.danger,
    opacity: 0.5,
  },
  newText: {
    color: colors.danger,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  secondaryAction: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  secondaryActionText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  primaryAction: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    borderRadius: 14,
    backgroundColor: colors.accent,
  },
  primaryActionText: {
    color: colors.accentText,
    fontSize: 15,
    fontWeight: "700",
  },
  pressed: {
    opacity: 0.85,
  },
});
