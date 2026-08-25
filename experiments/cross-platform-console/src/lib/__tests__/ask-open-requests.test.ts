import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../api", () => ({ api: { get } }));

const { fetchOpenRequests, fetchRequestThread } = await import("../ask");

const message = { id: "req-1", format: "request" } as never;

beforeEach(() => {
  get.mockReset();
});

describe("fetchOpenRequests", () => {
  // The regression this exists for: the route answers `{ items }` and the
  // transport returns the body verbatim, so an `Array.isArray(body)` test
  // silently yielded [] for every chat and the server-authoritative ask source
  // never reported anything.
  it("unwraps the items envelope the route actually returns", async () => {
    get.mockResolvedValue({ items: [message] });
    await expect(fetchOpenRequests("chat-1")).resolves.toEqual([message]);
  });

  it("still accepts a bare array", async () => {
    get.mockResolvedValue([message]);
    await expect(fetchOpenRequests("chat-1")).resolves.toEqual([message]);
  });

  it("yields an empty list for an unexpected body", async () => {
    get.mockResolvedValue({ unexpected: true });
    await expect(fetchOpenRequests("chat-1")).resolves.toEqual([]);
  });

  it("requests the chat-scoped open-requests route", async () => {
    get.mockResolvedValue({ items: [] });
    await fetchOpenRequests("chat/1");
    expect(get).toHaveBeenCalledWith("/chats/chat%2F1/open-requests", { signal: undefined });
  });
});

describe("fetchRequestThread", () => {
  it("returns the durable thread items", async () => {
    get.mockResolvedValue({ items: [message] });
    await expect(fetchRequestThread("chat-1", "req-1")).resolves.toEqual([message]);
  });

  it("addresses the thread by request id", async () => {
    get.mockResolvedValue({ items: [] });
    await fetchRequestThread("chat-1", "req/1");
    expect(get).toHaveBeenCalledWith("/chats/chat-1/requests/req%2F1/thread", {
      signal: undefined,
    });
  });
});
