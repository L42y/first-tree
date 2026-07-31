import { queryOptions } from "@tanstack/react-query";
import { getChatTokenUsage } from "../../../api/chats.js";

export const CHAT_TOKEN_USAGE_REFETCH_INTERVAL_MS = 60_000;

export function chatTokenUsageQueryOptions(chatId: string) {
  return queryOptions({
    queryKey: ["chat-token-usage", chatId],
    queryFn: () => getChatTokenUsage(chatId),
    enabled: !!chatId,
    refetchInterval: CHAT_TOKEN_USAGE_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
