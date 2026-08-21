import { StyleSheet, Text, View } from "react-native";

import type { Message } from "@first-tree/shared";

type ChatMessageBubbleProps = {
  message: Message;
  isMe: boolean;
  senderName: string;
};

export function ChatMessageBubble({ message, isMe, senderName }: ChatMessageBubbleProps) {
  const content = typeof message.content === "string" ? message.content : "";
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <View style={[styles.row, isMe ? styles.meRow : styles.otherRow]}>
      <View style={[styles.bubble, isMe ? styles.meBubble : styles.otherBubble]}>
        {!isMe && (
          <Text style={styles.senderName} numberOfLines={1}>
            {senderName}
          </Text>
        )}
        <Text style={styles.body}>{content}</Text>
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
  bubble: {
    minWidth: 80,
    maxWidth: "80%",
    padding: 12,
    borderRadius: 12,
  },
  meBubble: {
    backgroundColor: "rgba(59,130,246,0.2)",
  },
  otherBubble: {
    backgroundColor: "rgba(128,128,128,0.15)",
  },
  senderName: {
    fontSize: 12,
    fontWeight: "bold",
    opacity: 0.6,
    marginBottom: 4,
  },
  body: {
    fontSize: 15,
  },
  time: {
    fontSize: 11,
    opacity: 0.5,
    textAlign: "right",
    marginTop: 4,
  },
});
