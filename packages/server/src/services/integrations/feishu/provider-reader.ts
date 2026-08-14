import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuParentMessage } from "./inbound-trigger.js";

export type FeishuHistoryItem = {
  message_id?: string;
  thread_id?: string;
  chat_id?: string;
  msg_type?: string;
  create_time?: string;
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
    sender_name?: string;
    open_bot_id?: string;
  };
  body?: { content: string };
  mentions?: Array<{ key: string; id: string; id_type: string; name: string }>;
};

export type FeishuHistoryPage = {
  items: FeishuHistoryItem[];
  hasMore: boolean;
  pageToken?: string;
};

type FeishuMessageResponse = {
  code?: number;
  msg?: string;
  data?: {
    items?: FeishuHistoryItem[];
    has_more?: boolean;
    page_token?: string;
  };
};

export class FeishuProviderResponseError extends Error {
  readonly code: string;

  constructor(code: number, message: string | undefined) {
    super(message?.trim() || `Feishu provider returned code ${code}`);
    this.name = "FeishuProviderResponseError";
    this.code = String(code);
  }
}

export async function readFeishuParentMessage(
  client: Pick<Client, "request">,
  messageId: string,
  timeoutMs: number,
): Promise<FeishuParentMessage | null> {
  return withFeishuAbortTimeout(
    async (signal) => {
      const response = await client.request<FeishuMessageResponse>({
        method: "GET",
        url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        params: { user_id_type: "open_id" },
        signal,
        timeout: timeoutMs,
      });
      assertFeishuSuccess(response);
      const parent = response.data?.items?.[0];
      return parent
        ? {
            chatId: parent.chat_id ?? null,
            sender: {
              id: parent.sender?.id ?? null,
              idType: parent.sender?.id_type ?? null,
              senderType: parent.sender?.sender_type ?? null,
              openBotId: parent.sender?.open_bot_id ?? null,
            },
          }
        : null;
    },
    timeoutMs,
    "Timed out verifying Feishu reply parent",
  );
}

export async function readFeishuHistoryPage(
  client: Pick<Client, "request">,
  input: {
    scope: "thread" | "chat";
    containerId: string;
    pageSize: number;
    pageToken?: string;
    signal: AbortSignal;
  },
): Promise<FeishuHistoryPage> {
  const response = await client.request<FeishuMessageResponse>({
    method: "GET",
    url: "/open-apis/im/v1/messages",
    params: {
      container_id_type: input.scope,
      container_id: input.containerId,
      sort_type: "ByCreateTimeDesc",
      page_size: input.pageSize,
      with_sender_name: true,
      ...(input.pageToken ? { page_token: input.pageToken } : {}),
    },
    signal: input.signal,
  });
  assertFeishuSuccess(response);
  return {
    items: response.data?.items ?? [],
    hasMore: response.data?.has_more === true && Boolean(response.data.page_token),
    pageToken: response.data?.page_token,
  };
}

export async function withFeishuAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertFeishuSuccess(response: FeishuMessageResponse): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new FeishuProviderResponseError(response.code, response.msg);
  }
}
