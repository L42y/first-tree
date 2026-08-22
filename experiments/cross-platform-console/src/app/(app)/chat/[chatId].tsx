import { useLocalSearchParams } from "expo-router";

import { ChatDetailContent } from "~/components/chat-detail";

/** Route wrapper for the chat detail — the UI lives in ChatDetailContent. */
export default function ChatDetailScreen() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>();
  return <ChatDetailContent chatId={chatId} />;
}
