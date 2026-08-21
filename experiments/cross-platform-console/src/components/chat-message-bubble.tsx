import { StyleSheet, Text, View } from "react-native";

import type { Message } from "@first-tree/shared";
import { Avatar, type AvatarKind } from "~/components/avatar";
import { EnrichedMarkdownText } from "react-native-enriched-markdown";
import { colors } from "~/lib/theme";

export type BubbleAvatar = {
  name: string;
  seed: string;
  colorToken: string | null;
  imageUrl: string | null;
  kind: AvatarKind;
};

type ChatMessageBubbleProps = {
  message: Message;
  isMe: boolean;
  senderName: string;
  /** Sender identity for the leading avatar on incoming messages. */
  avatar?: BubbleAvatar;
};

export function ChatMessageBubble({ message, isMe, senderName, avatar }: ChatMessageBubbleProps) {
  const content = typeof message.content === "string" ? message.content : "";
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <View style={[styles.row, isMe ? styles.meRow : styles.otherRow]}>
      {!isMe && (
        <View style={styles.avatarSlot}>
          <Avatar
            name={avatar?.name ?? senderName}
            seed={avatar?.seed ?? senderName}
            colorToken={avatar?.colorToken ?? null}
            imageUrl={avatar?.imageUrl ?? null}
            kind={avatar?.kind ?? "agent"}
            size={28}
          />
        </View>
      )}
      <View style={[styles.bubble, isMe ? styles.meBubble : styles.otherBubble]}>
        {!isMe && (
          <Text style={styles.senderName} numberOfLines={1}>
            {senderName}
          </Text>
        )}
        <EnrichedMarkdownText
          markdown={content}
          containerStyle={styles.body}
          markdownStyle={{ paragraph: { color: colors.text } }}
        />
        <Text style={styles.time}>{time}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginVertical: 4,
    paddingHorizontal: 12,
  },
  meRow: {
    justifyContent: "flex-end",
  },
  otherRow: {
    justifyContent: "flex-start",
  },
  avatarSlot: {
    alignSelf: "flex-end",
    marginRight: 6,
  },
  bubble: {
    minWidth: 80,
    maxWidth: "80%",
    padding: 12,
    borderRadius: 12,
  },
  meBubble: {
    backgroundColor: "rgba(59,130,246,0.28)",
  },
  otherBubble: {
    backgroundColor: colors.surfaceStrong,
  },
  senderName: {
    fontSize: 12,
    fontWeight: "bold",
    color: colors.textMuted,
    marginBottom: 4,
  },
  body: {
    fontSize: 15,
    color: colors.text,
  },
  time: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: "right",
    marginTop: 4,
  },
});
