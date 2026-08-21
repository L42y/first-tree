import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { extractMentions } from "@first-tree/shared";
import type { ChatDetail, Message } from "@first-tree/shared";

import { getChat, listChatMessages, markMeChatRead, sendChatMessage } from "~/lib/chats-api";
import { useAuth } from "~/lib/auth-context";
import { ChatMessageBubble } from "~/components/chat-message-bubble";
import { Avatar } from "~/components/avatar";
import { colors } from "~/lib/theme";
import type { PaginatedMessages } from "~/lib/chats-api";

const PAGE_SIZE = 50;

export default function ChatDetailScreen() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  const router = useRouter();
  const { user, memberId, agentId: selfAgentId } = useAuth();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<Message>>(null);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  // Deterministic keyboard avoidance: lift the composer by the exact
  // keyboard height. Framework avoidance (KeyboardAvoidingView /
  // automaticallyAdjustKeyboardInsets) mis-measured or left the composer
  // behind the keyboard on iOS.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const showSub = Keyboard.addListener("keyboardDidShow", (e) =>
      setKeyboardHeight(e.endCoordinates.height),
    );
    const hideSub = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const chatQuery = useQuery<ChatDetail>({
    queryKey: ["chats", chatId],
    queryFn: () => getChat(chatId),
  });

  const messagesQuery = useQuery<PaginatedMessages>({
    queryKey: ["chats", chatId, "messages"],
    queryFn: () => listChatMessages(chatId, { limit: PAGE_SIZE }),
  });

  useEffect(() => {
    void markMeChatRead(chatId);
  }, [chatId]);

  const findParticipant = useCallback(
    (senderId: string) => chatQuery.data?.participants.find((p) => p.agentId === senderId),
    [chatQuery.data],
  );

  const participantNames = useCallback(
    (senderId: string) => findParticipant(senderId)?.displayName ?? senderId.slice(0, 8),
    [findParticipant],
  );

  const toBubbleAvatar = useCallback(
    (senderId: string) => {
      const p = findParticipant(senderId);
      if (!p) return undefined;
      return {
        name: p.displayName,
        seed: p.agentId,
        colorToken: p.avatarColorToken ?? null,
        imageUrl: p.avatarImageUrl ?? null,
        kind: p.type === "human" ? ("human" as const) : ("agent" as const),
      };
    },
    [findParticipant],
  );

  const handleSend = useCallback(async () => {
    if (!message.trim() || !memberId) return;
    const text = message.trim();
    setMessage("");
    setSending(true);

    try {
      const mentions = extractMentions(
        text,
        chatQuery.data?.participants.map((p) => ({ agentId: p.agentId, name: p.displayName })) ?? [],
      );

      await sendChatMessage(chatId, text, mentions);
      await queryClient.invalidateQueries({ queryKey: ["chats", chatId, "messages"] });
      await queryClient.invalidateQueries({ queryKey: ["me", "chats", "list"] });
      listRef.current?.scrollToEnd({ animated: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Send failed";
      // Re-show the message so the user can retry.
      setMessage(text);
      // eslint-disable-next-line no-console
      console.error("Send failed:", msg);
    } finally {
      setSending(false);
    }
  }, [message, memberId, chatId, chatQuery.data, queryClient]);

  const chat = chatQuery.data;
  const messages = messagesQuery.data?.items ?? [];
  const isLoading = chatQuery.isLoading || messagesQuery.isLoading;
  const error = chatQuery.error ?? messagesQuery.error;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Avatar
          name={chat?.participants.find((p) => p.agentId !== selfAgentId)?.displayName ?? chat?.title ?? chatId}
          seed={chat?.participants.find((p) => p.agentId !== selfAgentId)?.agentId ?? chatId}
          colorToken={chat?.participants.find((p) => p.agentId !== selfAgentId)?.avatarColorToken ?? null}
          imageUrl={chat?.participants.find((p) => p.agentId !== selfAgentId)?.avatarImageUrl ?? null}
          kind={chat?.participants.find((p) => p.agentId !== selfAgentId)?.type === "human" ? "human" : "agent"}
          size={32}
        />
        <View style={styles.headerText}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {chat?.title ?? chatId.slice(0, 8)}
          </Text>
          {chat?.participants && (
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {chat.participants.map((p) => p.displayName).join(", ")}
            </Text>
          )}
        </View>
      </View>

      {isLoading && (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      )}

      {error && !isLoading && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>
            {error instanceof Error ? error.message : "Failed to load chat"}
          </Text>
          <Pressable onPress={() => void chatQuery.refetch()} style={styles.retryButton}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        renderItem={({ item }) => (
          <ChatMessageBubble
            message={item}
            isMe={item.senderId === memberId || item.senderId === user?.id}
            senderName={participantNames(item.senderId)}
            avatar={toBubbleAvatar(item.senderId)}
          />
        )}
        contentContainerStyle={styles.messages}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
      />

      <View style={[styles.composer, keyboardHeight > 0 && { marginBottom: keyboardHeight }]}>
        <TextInput
          style={styles.input}
          value={message}
          onChangeText={setMessage}
          placeholder="Message…"
          multiline
          maxLength={4000}
        />
        <Pressable onPress={handleSend} disabled={sending || !message.trim()}>
          <View style={[styles.sendButton, (!message.trim() || sending) && styles.sendButtonDisabled]}>
            <Text style={styles.sendText}>Send</Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 48,
    paddingBottom: 12,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  backButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  backText: {
    fontSize: 14,
    color: colors.text,
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: colors.text,
  },
  headerSubtitle: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  messages: {
    paddingVertical: 8,
  },
  errorBox: {
    padding: 16,
    gap: 8,
    alignItems: "center",
  },
  errorText: {
    color: colors.danger,
    textAlign: "center",
  },
  retryButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: colors.accent,
  },
  retryText: {
    color: colors.accentText,
  },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: colors.surface,
  },
  sendButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: colors.accent,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendText: {
    color: colors.accentText,
    fontWeight: "bold",
  },
});
