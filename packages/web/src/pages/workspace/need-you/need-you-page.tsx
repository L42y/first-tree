import { imageAttachmentRefsFromMetadata, type Message, type NeedYouRequestItem } from "@first-tree/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, ExternalLink, History, LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { getChat, listChatMessages } from "../../../api/chats.js";
import { useAuth } from "../../../auth/auth-context.js";
import { sendAskAnswer } from "../../../components/chat/ask-answer-transport.js";
import { type AskAnswer, AskTakeover, clearAskTakeoverDraft } from "../../../components/chat/ask-takeover.js";
import { readRequestPayload } from "../../../components/chat/request-state.js";
import { useAskAgent } from "../../../components/chat/use-ask-agent.js";
import type { MentionCandidate } from "../../../components/mention-autocomplete.js";
import { Markdown } from "../../../components/ui/markdown.js";
import { useGitlabEntityPresentation } from "../../../hooks/use-gitlab-entity-presentation.js";
import { selectEarlierChatPreview } from "./earlier-chat.js";
import { needYouQueryOptions, removeResolvedNeedYouRequest } from "./query.js";

const EARLIER_CHAT_LIMIT = 8;

export function NeedYouPage({
  mobile = false,
  onClose,
  onOpenFullChat,
}: {
  mobile?: boolean;
  onClose: () => void;
  onOpenFullChat: (chatId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { organizationId, agentId: humanAgentId } = useAuth();
  const queue = useQuery(needYouQueryOptions(organizationId));
  const item = queue.data?.items[0] ?? null;
  const [sendingRequestId, setSendingRequestId] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [earlierRequested, setEarlierRequested] = useState(false);
  const requestId = item?.request.id ?? null;

  useEffect(() => {
    // The selected request intentionally keys all transient review state.
    void requestId;
    setSendingRequestId(null);
    setSendError(null);
    setEarlierRequested(false);
  }, [requestId]);

  const chatDetail = useQuery({
    queryKey: ["chat-detail", item?.chat.id],
    queryFn: () => {
      if (!item) throw new Error("No request selected");
      return getChat(item.chat.id);
    },
    enabled: item !== null,
    staleTime: 10_000,
  });

  const mentionCandidates = useMemo<MentionCandidate[]>(
    () =>
      (chatDetail.data?.participants ?? []).flatMap((participant) => {
        if (participant.agentId === humanAgentId || !participant.name) return [];
        return [
          {
            agentId: participant.agentId,
            name: participant.name,
            displayName: participant.displayName,
            managedByMe: false,
            avatarColorToken: participant.avatarColorToken,
            avatarImageUrl: participant.avatarImageUrl,
          },
        ];
      }),
    [chatDetail.data?.participants, humanAgentId],
  );

  const earlierQuery = useQuery({
    queryKey: ["need-you", "earlier-chat", item?.chat.id, requestId],
    queryFn: () => {
      if (!item) throw new Error("No request selected");
      return listChatMessages(item.chat.id, { limit: 100 });
    },
    enabled: item !== null && earlierRequested,
    staleTime: 30_000,
  });

  const earlierContext = useMemo(() => {
    if (!item || !humanAgentId || !earlierRequested || !earlierQuery.data) return null;
    return selectEarlierChatPreview({
      messages: earlierQuery.data.items,
      requestId: item.request.id,
      requestCreatedAt: item.request.createdAt,
      humanAgentId,
      askerAgentId: item.asker.agentId,
      directChat: chatDetail.data?.type === "direct",
      limit: EARLIER_CHAT_LIMIT,
    });
  }, [chatDetail.data?.type, earlierQuery.data, earlierRequested, humanAgentId, item]);

  const askAgent = useAskAgent({
    chatId: item?.chat.id ?? "",
    requestId,
    humanAgentId,
    askerAgentId: item?.asker.agentId ?? null,
  });
  const { markdownComponents } = useGitlabEntityPresentation(organizationId);

  const resolveRequest = async (answer: AskAnswer): Promise<void> => {
    if (!item || sendingRequestId === item.request.id) return;
    const resolvingId = item.request.id;
    setSendError(null);
    setSendingRequestId(resolvingId);
    try {
      await sendAskAnswer({
        chatId: item.chat.id,
        request: item.request,
        answer,
      });
      clearAskTakeoverDraft(resolvingId);
      removeResolvedNeedYouRequest(queryClient, organizationId, resolvingId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["need-you"] }),
        queryClient.invalidateQueries({ queryKey: ["chat-open-requests", item.chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["chat-messages", item.chat.id] }),
        queryClient.invalidateQueries({ queryKey: ["request-thread", item.chat.id, resolvingId] }),
        queryClient.invalidateQueries({ queryKey: ["me", "chats"] }),
      ]);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "Failed to submit your answer");
      setSendingRequestId(null);
    }
  };

  return (
    <section
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
      style={{ background: "var(--bg)" }}
      aria-label="Need you"
    >
      <header
        className="flex h-[var(--sp-12)] shrink-0 items-center"
        style={{
          gap: "var(--sp-2)",
          padding: mobile ? "0 var(--sp-3)" : "0 var(--sp-5)",
          borderBottom: "var(--hairline) solid var(--border)",
          background: "var(--bg-raised)",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to Chat"
          className="inline-flex h-11 w-11 items-center justify-center"
          style={{ border: 0, borderRadius: "var(--radius-input)", background: "transparent", color: "var(--fg-2)" }}
        >
          <ArrowLeft aria-hidden className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className={mobile ? "text-mobile-subtitle" : "text-subtitle"} style={{ margin: 0, color: "var(--fg)" }}>
            Need you
          </h1>
          {item ? (
            <p className="text-caption truncate" style={{ margin: 0, color: "var(--fg-4)" }}>
              {item.chat.title} · {queue.data?.total ?? 0} waiting
            </p>
          ) : null}
        </div>
        {item ? (
          <button
            type="button"
            onClick={() => onOpenFullChat(item.chat.id)}
            className="text-label inline-flex items-center"
            style={{
              gap: "var(--sp-1)",
              minHeight: mobile ? 44 : 34,
              padding: "0 var(--sp-3)",
              border: "var(--hairline) solid var(--border)",
              borderRadius: "var(--radius-input)",
              background: "var(--bg-raised)",
              color: "var(--fg-2)",
            }}
          >
            <span>{mobile ? "Full chat" : "Open full chat"}</span>
            <ExternalLink aria-hidden className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </header>

      <div className="relative min-h-0 flex-1">
        {queue.isLoading ? (
          <CenteredState icon={<LoaderCircle className="h-8 w-8 animate-spin" />} title="Loading questions…" />
        ) : queue.isError ? (
          <CenteredState
            title="Couldn’t load Need you"
            detail={queue.error instanceof Error ? queue.error.message : "Try again."}
            action={
              <button type="button" onClick={() => void queue.refetch()}>
                Retry
              </button>
            }
          />
        ) : !item && (queue.data?.total ?? 0) > 0 ? (
          <CenteredState icon={<LoaderCircle className="h-8 w-8 animate-spin" />} title="Loading the next question…" />
        ) : !item ? (
          <CenteredState
            icon={<CheckCircle2 className="h-10 w-10" />}
            title="You’re all caught up"
            detail="New questions will appear here."
          />
        ) : (
          <AskTakeover
            key={item.request.id}
            requestId={item.request.id}
            body={
              typeof item.request.content === "string" ? item.request.content : JSON.stringify(item.request.content)
            }
            images={imageAttachmentRefsFromMetadata(item.request.metadata).map((ref) => ({
              imageId: ref.attachmentId,
              filename: ref.filename,
            }))}
            payload={readRequestPayload(item.request.metadata)}
            askerName={item.asker.displayName}
            sending={sendingRequestId === item.request.id}
            error={sendError ?? undefined}
            mentionCandidates={mentionCandidates}
            markdownComponents={markdownComponents}
            mobile={mobile}
            contextBefore={
              <EarlierChatContext
                item={item}
                requested={earlierRequested}
                loading={earlierQuery.isLoading}
                error={earlierQuery.error}
                result={earlierContext}
                humanAgentId={humanAgentId}
                onLoad={() => setEarlierRequested(true)}
              />
            }
            onRequestEarlierContext={!earlierRequested ? () => setEarlierRequested(true) : undefined}
            onEscape={onClose}
            askAgent={{
              exchanges: askAgent.exchanges,
              waiting: askAgent.waiting,
              sending: askAgent.sending,
              error: askAgent.error,
              onAsk: askAgent.ask,
            }}
            onReply={(answer) => {
              void resolveRequest(answer);
            }}
            onSkip={() => {
              void resolveRequest({
                content: "(Skipped — no answer provided.)",
                mentions: [],
                images: [],
              });
            }}
          />
        )}
      </div>
    </section>
  );
}

function EarlierChatContext({
  item,
  requested,
  loading,
  error,
  result,
  humanAgentId,
  onLoad,
}: {
  item: NeedYouRequestItem;
  requested: boolean;
  loading: boolean;
  error: unknown;
  result: { unavailable: boolean; messages: Message[] } | null;
  humanAgentId: string | null;
  onLoad: () => void;
}) {
  return (
    <div style={{ padding: "var(--sp-4) var(--sp-5)", background: "var(--bg-sunken)" }}>
      {item.chat.description ? (
        <div style={{ marginBottom: "var(--sp-3)" }}>
          <div className="text-eyebrow" style={{ color: "var(--fg-4)", marginBottom: "var(--sp-1)" }}>
            Current chat
          </div>
          <Markdown>{item.chat.description}</Markdown>
        </div>
      ) : null}
      {!requested ? (
        <button
          type="button"
          onClick={onLoad}
          className="text-label inline-flex items-center"
          style={{
            gap: "var(--sp-1_5)",
            padding: 0,
            border: 0,
            background: "transparent",
            color: "var(--fg-2)",
          }}
        >
          <History aria-hidden className="h-4 w-4" />
          Show earlier chat
        </button>
      ) : loading ? (
        <div role="status" className="text-label" style={{ color: "var(--fg-3)" }}>
          Loading earlier chat…
        </div>
      ) : error ? (
        <div className="text-label" style={{ color: "var(--state-error)" }}>
          Earlier chat could not be loaded.
        </div>
      ) : result?.unavailable ? (
        <div className="text-label" style={{ color: "var(--fg-3)" }}>
          Earlier chat preview is unavailable because this question is outside the recent message window.
        </div>
      ) : result && result.messages.length === 0 ? (
        <div className="text-label" style={{ color: "var(--fg-3)" }}>
          No recent messages between you and this agent before the question.
        </div>
      ) : result ? (
        <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
          <div className="text-eyebrow" style={{ color: "var(--fg-4)" }}>
            Earlier chat
          </div>
          {result.messages.map((message) => (
            <div
              key={message.id}
              style={{
                padding: "var(--sp-2_5) var(--sp-3)",
                border: "var(--hairline) solid var(--border-faint)",
                borderRadius: "var(--radius-input)",
                background: "var(--bg-raised)",
              }}
            >
              <div className="text-caption" style={{ color: "var(--fg-4)", marginBottom: "var(--sp-1)" }}>
                {message.senderId === humanAgentId ? "You" : item.asker.displayName}
              </div>
              <Markdown>
                {typeof message.content === "string" ? message.content : JSON.stringify(message.content)}
              </Markdown>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CenteredState({
  icon,
  title,
  detail,
  action,
}: {
  icon?: ReactNode;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center text-center"
      style={{ gap: "var(--sp-2)", padding: "var(--sp-8)", color: "var(--fg-3)" }}
    >
      <div style={{ color: "var(--fg-4)" }}>{icon}</div>
      <h2 className="text-subtitle" style={{ margin: 0, color: "var(--fg-2)" }}>
        {title}
      </h2>
      {detail ? (
        <p className="text-body" style={{ margin: 0 }}>
          {detail}
        </p>
      ) : null}
      {action}
    </div>
  );
}
