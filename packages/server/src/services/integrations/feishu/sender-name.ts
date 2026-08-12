import type { FeishuExternalAuthor } from "@first-tree/shared";
import type { NormalizedMessage } from "@larksuiteoapi/node-sdk";

type MemberPage = {
  code?: number;
  msg?: string;
  data?: {
    items?: Array<{
      member_id_type?: string;
      member_id?: string;
      name?: string;
      tenant_key?: string;
    }>;
    page_token?: string;
    has_more?: boolean;
  };
};

export type FeishuChatMembersReader = (input: {
  chatId: string;
  idType: "open_id" | "user_id" | "union_id";
  pageToken?: string;
}) => Promise<MemberPage>;

type CacheEntry = { value: string | null; expiresAt: number };

export type FeishuSenderNameResolver = {
  resolve(input: {
    botBindingId: string;
    tenantKey: string | null;
    chatId: string;
    idType: "open_id" | "user_id" | "union_id";
    id: string;
    eventName?: string | null;
    readMembers: FeishuChatMembersReader;
  }): Promise<string>;
  clearBinding(botBindingId: string): void;
};

export function createFeishuSenderNameResolver(options?: {
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
}): FeishuSenderNameResolver {
  const positiveTtlMs = options?.positiveTtlMs ?? 60 * 60 * 1_000;
  const negativeTtlMs = options?.negativeTtlMs ?? 2 * 60 * 1_000;
  const maxEntries = options?.maxEntries ?? 10_000;
  const now = options?.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();

  function cacheKey(input: { botBindingId: string; tenantKey: string | null; idType: string; id: string }): string {
    return [input.botBindingId, input.tenantKey ?? "", input.idType, input.id].join("\u0000");
  }

  function put(key: string, value: string | null): void {
    cache.delete(key);
    cache.set(key, { value, expiresAt: now() + (value ? positiveTtlMs : negativeTtlMs) });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as string | undefined;
      if (!oldest) break;
      cache.delete(oldest);
    }
  }

  return {
    async resolve(input) {
      const key = cacheKey(input);
      const eventName = input.eventName?.trim();
      if (eventName) {
        put(key, eventName);
        return eventName;
      }
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) return cached.value ?? input.id;
      if (cached) cache.delete(key);

      try {
        let pageToken: string | undefined;
        let pageCount = 0;
        do {
          const page = await input.readMembers({
            chatId: input.chatId,
            idType: input.idType,
            ...(pageToken ? { pageToken } : {}),
          });
          if (page.code && page.code !== 0)
            throw new Error(`Feishu Chat Members failed: ${page.code} ${page.msg ?? ""}`);
          for (const member of page.data?.items ?? []) {
            const id = member.member_id?.trim();
            const name = member.name?.trim();
            if (!id || !name) continue;
            put(
              cacheKey({
                botBindingId: input.botBindingId,
                tenantKey: member.tenant_key ?? input.tenantKey,
                idType: member.member_id_type ?? input.idType,
                id,
              }),
              name,
            );
          }
          const hit = cache.get(key);
          if (hit?.value) return hit.value;
          pageToken = page.data?.has_more ? page.data.page_token : undefined;
          pageCount += 1;
        } while (pageToken && pageCount < 100);
      } catch {
        // Name resolution is presentation-only. Ingress remains available and
        // stores the exact provider id when Chat Members cannot be read.
      }
      put(key, null);
      return input.id;
    },
    clearBinding(botBindingId) {
      const prefix = `${botBindingId}\u0000`;
      for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
    },
  };
}

export function externalAuthorIdentity(
  input: NormalizedMessage,
  fallbackTenantKey: string | null,
): Omit<FeishuExternalAuthor, "displayName"> & { eventName: string | null } {
  const raw = asRecord(input.raw);
  const event = asRecord(raw?.event) ?? raw;
  const sender = asRecord(event?.sender);
  const senderId = asRecord(sender?.sender_id);
  return {
    openId: input.senderId,
    unionId: readString(senderId, "union_id"),
    userId: readString(senderId, "user_id"),
    tenantKey: readString(sender, "tenant_key") ?? fallbackTenantKey,
    eventName:
      input.senderName?.trim() ||
      readString(sender, "sender_name") ||
      readString(sender, "name") ||
      readString(event, "sender_name"),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
