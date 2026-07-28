import type { RequestThreadResponse } from "@first-tree/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatAgentStatusQueryKey, fetchChatAgentStatuses } from "../../api/agent-status.js";
import { listRequestThread, sendAskAgentQuestion } from "../../api/chats.js";
import { useToast } from "../ui/toast.js";
import { type AskAgentExchange, projectAskAgentExchanges } from "./ask-agent-state.js";

const ASK_AGENT_REPLY_TIMEOUT_MS = 45_000;

export type AskAgentController = {
  exchanges: AskAgentExchange[];
  waiting: boolean;
  sending: boolean;
  error: string | null;
  ask: (question: string) => Promise<void>;
};

/**
 * Shared Ask agent controller used by the Need you review page and the normal
 * Chat takeover. It watches durable `chat send --reply-to` messages, not
 * assistant/session text.
 */
export function useAskAgent({
  chatId,
  requestId,
  humanAgentId,
  askerAgentId,
}: {
  chatId: string;
  requestId: string | null;
  humanAgentId: string | null;
  askerAgentId: string | null;
}): AskAgentController {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [failedIds, setFailedIds] = useState<Set<string>>(() => new Set());
  const observedWorking = useRef<Set<string>>(new Set());
  const toasted = useRef<Set<string>>(new Set());

  const enabled = requestId !== null && humanAgentId !== null && askerAgentId !== null;
  const threadQueryKey = ["request-thread", chatId, requestId] as const;
  const threadQuery = useQuery({
    queryKey: threadQueryKey,
    queryFn: () => {
      if (!requestId) throw new Error("Ask agent requires an open request");
      return listRequestThread(chatId, requestId);
    },
    enabled,
    refetchInterval: (query) => {
      if (!requestId || !humanAgentId || !askerAgentId) return false;
      const data = query.state.data as RequestThreadResponse | undefined;
      const latestExchange = projectAskAgentExchanges({
        thread: data?.items ?? [],
        requestId,
        humanAgentId,
        askerAgentId,
      }).at(-1);
      return latestExchange?.reply === null && !failedIds.has(latestExchange.clarification.id) ? 2_000 : false;
    },
  });

  const exchanges = useMemo(
    () =>
      enabled && requestId && humanAgentId && askerAgentId
        ? projectAskAgentExchanges({
            thread: threadQuery.data?.items ?? [],
            requestId,
            humanAgentId,
            askerAgentId,
          })
        : [],
    [askerAgentId, enabled, humanAgentId, requestId, threadQuery.data?.items],
  );
  const latest = exchanges[exchanges.length - 1] ?? null;
  const pending = latest?.reply === null && !failedIds.has(latest.clarification.id) ? latest : null;
  const statusQuery = useQuery({
    queryKey: chatAgentStatusQueryKey(chatId),
    queryFn: () => fetchChatAgentStatuses(chatId),
    enabled: enabled && pending !== null,
    refetchInterval: 2_000,
  });
  const askerStatus = enabled ? (statusQuery.data?.find((status) => status.agentId === askerAgentId) ?? null) : null;

  const failAttempt = useCallback(
    (messageId: string): void => {
      setFailedIds((current) => {
        if (current.has(messageId)) return current;
        return new Set([...current, messageId]);
      });
      if (!toasted.current.has(messageId)) {
        toasted.current.add(messageId);
        addToast({ title: "Agent 没有响应", description: "You can retry Ask agent, or Submit / Skip this request." });
      }
    },
    [addToast],
  );

  useEffect(() => {
    // The request id intentionally keys this local attempt state.
    void requestId;
    setFailedIds(new Set());
    observedWorking.current.clear();
    toasted.current.clear();
  }, [requestId]);

  // A ready/idle status is meaningful only after this attempt was observed
  // working; otherwise it may be the pre-delivery baseline. Failure is always
  // terminal for the waiting indicator.
  useEffect(() => {
    if (!pending || !askerStatus) return;
    const id = pending.clarification.id;
    if (askerStatus.main === "working") {
      observedWorking.current.add(id);
      return;
    }
    if (askerStatus.main === "failed") {
      failAttempt(id);
      return;
    }
    if (observedWorking.current.has(id)) {
      const timer = setTimeout(() => failAttempt(id), 1_250);
      return () => clearTimeout(timer);
    }
  }, [askerStatus, failAttempt, pending]);

  // Missing status frames or an agent that never leaves idle still terminate
  // after a bounded wait. A late matching reply remains in the thread and will
  // render normally even after this local timeout.
  useEffect(() => {
    if (!pending) return;
    const elapsed = Date.now() - Date.parse(pending.clarification.createdAt);
    const timer = setTimeout(
      () => failAttempt(pending.clarification.id),
      Math.max(0, ASK_AGENT_REPLY_TIMEOUT_MS - elapsed),
    );
    return () => clearTimeout(timer);
  }, [failAttempt, pending]);

  const mutation = useMutation({
    mutationFn: (content: string) => {
      if (!requestId) throw new Error("This request is no longer available");
      return sendAskAgentQuestion(chatId, requestId, content);
    },
    onSuccess: (message) => {
      queryClient.setQueryData<RequestThreadResponse>(threadQueryKey, (current) => {
        if (!current) return { items: [message] };
        if (current.items.some((item) => item.id === message.id)) return current;
        return { items: [...current.items, message] };
      });
      void queryClient.invalidateQueries({ queryKey: threadQueryKey });
      void queryClient.invalidateQueries({ queryKey: ["chat-messages", chatId] });
      void queryClient.invalidateQueries({ queryKey: ["need-you"] });
    },
  });

  return {
    exchanges,
    waiting: pending !== null,
    sending: mutation.isPending,
    error:
      mutation.error instanceof Error
        ? mutation.error.message
        : threadQuery.error instanceof Error
          ? threadQuery.error.message
          : null,
    ask: async (question: string) => {
      await mutation.mutateAsync(question);
    },
  };
}
