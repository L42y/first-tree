import Ionicons from "@expo/vector-icons/Ionicons";
import type { Message } from "@first-tree/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { AskThread } from "~/components/ask-thread";
import { ChatMessageBubble } from "~/components/chat-message-bubble";
import { fetchOpenRequests } from "~/lib/ask";
import { useAuth } from "~/lib/auth-context";
import type { CatchUpCard } from "~/lib/catch-up";
import { flattenNewestFirstMessages } from "~/lib/chat-read-state";
import { getChat, listChatMessages, markMeChatRead } from "~/lib/chats-api";
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
  const { memberId, user } = useAuth();
  const [working, setWorking] = useState(false);

  // Swipe defers, in either direction, and resolves nothing: putting a card
  // off is the reversible decision, so it is the one a stray flick may make.
  // Marking read stays a button you have to mean.
  const slideX = useRef(new Animated.Value(0)).current;
  const deferCard = useCallback(
    (direction: number) => {
      Animated.timing(slideX, {
        toValue: direction * Dimensions.get("window").width,
        duration: 180,
        useNativeDriver: true,
      }).start(() => {
        slideX.setValue(0);
        onDone("kept");
      });
    },
    [onDone, slideX],
  );
  const swipe = useMemo(
    () =>
      PanResponder.create({
        // Claim only a clear horizontal drag, so the card's own scrolling and
        // its buttons keep working.
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onPanResponderMove: (_event, gesture) => slideX.setValue(gesture.dx),
        onPanResponderRelease: (_event, gesture) => {
          if (Math.abs(gesture.dx) > 110 || Math.abs(gesture.vx) > 0.8) {
            deferCard(Math.sign(gesture.dx) || 1);
            return;
          }
          Animated.spring(slideX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(slideX, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
        },
      }),
    [deferCard, slideX],
  );

  const openChat = () => router.push({ pathname: `/chat/${card.chatId}` } as never);

  const asksQuery = useQuery({
    queryKey: ["chats", card.chatId, "open-requests"],
    queryFn: ({ signal }) => fetchOpenRequests(card.chatId, signal),
    enabled: card.kind === "ask",
  });
  // A card shows the conversation, so it must name people the way the
  // conversation does — a truncated uuid is not a sender.
  const chatQuery = useQuery({
    queryKey: ["chats", card.chatId],
    queryFn: () => getChat(card.chatId),
    enabled: card.kind === "unread",
  });
  const participants = useMemo(() => {
    const byId = new Map<
      string,
      { displayName: string; colorToken: string | null; imageUrl: string | null; human: boolean }
    >();
    for (const participant of chatQuery.data?.participants ?? []) {
      byId.set(participant.agentId, {
        displayName: participant.displayName,
        colorToken: participant.avatarColorToken,
        imageUrl: participant.avatarImageUrl,
        human: participant.type === "human",
      });
    }
    return byId;
  }, [chatQuery.data]);

  const messagesQuery = useQuery({
    queryKey: ["chats", card.chatId, "catch-up-window"],
    queryFn: ({ signal }) => listChatMessages(card.chatId, { limit: CARD_MESSAGE_LIMIT }, signal),
    enabled: card.kind === "unread",
  });

  const asks: Message[] = asksQuery.data ?? [];
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
    <Animated.View
      style={[
        styles.card,
        {
          transform: [
            { translateX: slideX },
            { rotate: slideX.interpolate({ inputRange: [-300, 0, 300], outputRange: ["-4deg", "0deg", "4deg"] }) },
          ],
        },
      ]}
      {...swipe.panHandlers}
    >
      <Pressable onPress={openChat} style={({ pressed }) => [styles.cardHead, pressed && styles.pressed]}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {card.title}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
      </Pressable>

      <ScrollView style={styles.cardBody} contentContainerStyle={styles.cardBodyContent}>
        {card.kind === "ask" ? (
          asks.length > 0 ? (
            // The card carries the thread itself — the question, everything
            // already said under it, the options and the reply box — so the
            // card is answerable rather than a link to somewhere answerable.
            // A chat can hold more than one open question; the card is done
            // when its last one is.
            asks.map((ask) => (
              <AskThread
                key={ask.id}
                chatId={card.chatId}
                requestId={ask.id}
                question={ask}
                onResolved={() => {
                  void asksQuery.refetch().then((result) => {
                    if ((result.data ?? []).length === 0) onDone("cleared");
                  });
                }}
              />
            ))
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
            {messages.map((message) => {
              const sender = participants.get(message.senderId);
              return (
                <ChatMessageBubble
                  key={message.id}
                  message={message}
                  isMe={message.senderId === memberId || message.senderId === user?.id}
                  senderName={sender?.displayName ?? message.senderId.slice(0, 8)}
                  avatar={
                    sender
                      ? {
                          name: sender.displayName,
                          seed: message.senderId,
                          colorToken: sender.colorToken,
                          imageUrl: sender.imageUrl,
                          kind: sender.human ? "human" : "agent",
                        }
                      : undefined
                  }
                />
              );
            })}
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
    </Animated.View>
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
