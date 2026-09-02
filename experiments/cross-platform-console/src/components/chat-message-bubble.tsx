import type { Message } from "@first-tree/shared";
import { StyleSheet, Text, View } from "react-native";
import { Avatar, type AvatarKind } from "~/components/avatar";
import { MarkdownText } from "~/components/markdown-text";
import { MessageImage } from "~/components/message-image";
import { messageImageAttachments, messageInlineImage } from "~/lib/message-content";
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
        {message.format === "file" ? (
          (() => {
            const { caption, images } = messageImageAttachments(message);
            const inlineImage = messageInlineImage(message);
            if (inlineImage) {
              return <MessageImage dataUri={inlineImage.data} filename="image" />;
            }
            if (images.length === 0) {
              return <Text style={styles.unsupported}>Attachment</Text>;
            }
            return (
              <View style={styles.attachmentGroup}>
                {caption ? <MarkdownText value={caption} /> : null}
                {images.map((image) => (
                  <MessageImage
                    key={image.imageId}
                    imageId={image.imageId}
                    filename={image.filename}
                    style={images.length > 1 ? styles.galleryImage : undefined}
                  />
                ))}
              </View>
            );
          })()
        ) : (
          <MarkdownText value={content} />
        )}
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
  time: {
    fontSize: 11,
    color: colors.textMuted,
    textAlign: "right",
    marginTop: 4,
  },
  attachmentGroup: {
    gap: 6,
  },
  galleryImage: {
    width: 164,
    height: 164,
  },
  unsupported: {
    color: colors.textMuted,
    fontSize: 13,
    fontStyle: "italic",
  },
});
