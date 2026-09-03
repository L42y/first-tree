import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { addChatParticipants } from "./chats-api";
import type { DirectoryCandidate } from "./mentions";
import { listOrgAgents } from "./team-api";
import { useDebouncedValue } from "./use-debounced-value";

/**
 * Org identities the caller may pull into a chat. Search runs server-side and
 * is debounced, so an org past the roster's first page stays reachable without
 * firing a request per keystroke. Disabled surfaces fetch nothing.
 */
export function useDirectoryCandidates(args: { query: string; enabled: boolean; selfAgentId?: string | null }): {
  candidates: DirectoryCandidate[];
  isFetching: boolean;
} {
  const debounced = useDebouncedValue(args.query, 200);
  const directoryQuery = useQuery({
    queryKey: ["agents", "org-list", debounced],
    queryFn: ({ signal }) => listOrgAgents({ query: debounced || undefined }, signal),
    enabled: args.enabled,
    staleTime: 30_000,
  });
  const candidates = useMemo<DirectoryCandidate[]>(
    () =>
      (directoryQuery.data ?? [])
        .filter((agent) => agent.name && agent.status !== "suspended" && agent.uuid !== args.selfAgentId)
        .map((agent) => ({
          agentId: agent.uuid,
          name: agent.name as string,
          displayName: agent.displayName,
          type: agent.type,
          avatarColorToken: agent.avatarColorToken,
          avatarImageUrl: agent.avatarImageUrl,
        })),
    [directoryQuery.data, args.selfAgentId],
  );
  return { candidates, isFetching: directoryQuery.isFetching };
}

export type AddParticipantFlow = {
  /** The candidate awaiting confirmation, or null when nothing is pending. */
  pending: DirectoryCandidate | null;
  adding: boolean;
  error: string | null;
  /** Ask before joining someone to a conversation they are not in. */
  request: (candidate: DirectoryCandidate) => void;
  cancel: () => void;
  confirm: () => Promise<DirectoryCandidate | null>;
};

/**
 * Adding a participant is a membership change others can see, so it always
 * confirms first. `confirm` resolves with the added candidate after the chat
 * roster has been refreshed — callers that then address the new member (the
 * mention picker) depend on that ordering, because a mention resolves against
 * the roster at send time.
 */
export function useAddParticipant(chatId: string): AddParticipantFlow {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<DirectoryCandidate | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback((candidate: DirectoryCandidate) => {
    setPending(candidate);
    setError(null);
  }, []);

  const cancel = useCallback(() => {
    setPending(null);
    setError(null);
  }, []);

  const confirm = useCallback(async () => {
    if (!pending || adding) return null;
    setAdding(true);
    setError(null);
    try {
      await addChatParticipants(chatId, [pending.agentId]);
      await queryClient.invalidateQueries({ queryKey: ["chats", chatId] });
      setPending(null);
      return pending;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add them to this chat");
      return null;
    } finally {
      setAdding(false);
    }
  }, [adding, chatId, pending, queryClient]);

  return { pending, adding, error, request, cancel, confirm };
}
