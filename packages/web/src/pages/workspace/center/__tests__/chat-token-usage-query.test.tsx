// @vitest-environment happy-dom

import { focusManager, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_TOKEN_USAGE_REFETCH_INTERVAL_MS, chatTokenUsageQueryOptions } from "../chat-token-usage-query.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const chatMocks = vi.hoisted(() => ({
  getChatTokenUsage: vi.fn(),
}));

vi.mock("../../../../api/chats.js", () => ({
  getChatTokenUsage: chatMocks.getChatTokenUsage,
}));

function TokenUsageQueryProbe() {
  useQuery(chatTokenUsageQueryOptions("chat-1"));
  return null;
}

async function renderProbe(queryClient: QueryClient): Promise<Root> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TokenUsageQueryProbe />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  return root;
}

beforeEach(() => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  chatMocks.getChatTokenUsage.mockResolvedValue({
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  focusManager.setFocused(undefined);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("chatTokenUsageQueryOptions", () => {
  it("fetches on mount and focus, polls every minute while visible, and pauses while hidden", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          refetchOnWindowFocus: false,
        },
      },
    });
    const root = await renderProbe(queryClient);

    try {
      expect(chatMocks.getChatTokenUsage).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHAT_TOKEN_USAGE_REFETCH_INTERVAL_MS);
      });
      expect(chatMocks.getChatTokenUsage).toHaveBeenCalledTimes(2);

      focusManager.setFocused(false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHAT_TOKEN_USAGE_REFETCH_INTERVAL_MS);
      });
      expect(chatMocks.getChatTokenUsage).toHaveBeenCalledTimes(2);

      await act(async () => {
        focusManager.setFocused(true);
        await Promise.resolve();
      });
      expect(chatMocks.getChatTokenUsage).toHaveBeenCalledTimes(3);
    } finally {
      await act(async () => root.unmount());
      queryClient.clear();
    }
  });
});
