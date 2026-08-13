import type { Agent } from "@first-tree/shared";
import { canManageAgentDetail } from "../agent-detail/access.js";

/**
 * Pure step logic for the standalone `/opentag` entry.
 *
 * The Agent is materialized in one atomic create once its Computer and runtime
 * are known, so there is exactly one durable fact in this flow: whether the URL
 * carries an Agent. Before that, choosing a Template and a Computer are local
 * choices with nothing persisted to recover; after it, the Agent is already
 * bound and the only thing left is Feishu.
 *
 * That is also why there is no stored step index, draft, or completion stamp: a
 * reload before creation just re-asks two cheap questions, and a reload after it
 * is answered by reading the Agent. Keeping the decision here (and pure) makes
 * the recovery states testable without a DOM, matching this package's
 * `.test.ts` convention.
 */

/**
 * The guided path the member sees. `use-in-feishu` is the destination this
 * entry hands off to: the member reaches it by using their Agent in Feishu, not
 * by pressing anything here, so this flow only ever *observes* that it happened.
 */
export const OPENTAG_STEPS = ["choose-agent", "set-up-runtime", "connect-feishu", "use-in-feishu"] as const;
export type OpenTagStepId = (typeof OPENTAG_STEPS)[number];

/** The authoritative Agent read behind the URL's `?agent=` parameter. */
export type OpenTagAgentRead = {
  /** Currently selected Team. Null until `/me` resolves it. */
  organizationId: string | null;
  /** Whether `/me` has been read successfully this session. */
  meAuthoritative: boolean;
  /** The caller's membership in that Team, and its role. */
  memberId: string | null;
  role: string | null;
  /** Agent id carried by the URL, or null on a fresh entry. */
  agentUuid: string | null;
  /** Whether the Agent read is still in flight. */
  loading: boolean;
  /** Whether the last read failed, for any reason including transport errors. */
  failed: boolean;
  /** HTTP status of a failed read; null for a transport error or a success. */
  errorStatus: number | null;
  agent: Pick<Agent, "organizationId" | "type" | "status" | "clientId" | "managerId" | "visibility"> | null;
};

export type OpenTagAgentFacts =
  /** The URL carries no Agent — this is a fresh entry. */
  | { state: "none" }
  /** The Team or the Agent read has not settled yet. */
  | { state: "loading" }
  /** The Agent cannot be used here: missing, deleted, human, or another Team's. */
  | { state: "unavailable" }
  /** The read failed for a reason that says nothing about the Agent. */
  | { state: "unreadable" }
  /** `/me` never produced an authoritative Team, so nothing Team-scoped is safe. */
  | { state: "team-unreadable" }
  /** The Agent exists, belongs here, and is usable. */
  | { state: "resolved" };

/**
 * Turn one authoritative Agent read into the fact the flow branches on.
 *
 * The two failure classes are deliberately separate. A 404 / 403 / 410 is
 * evidence about the Agent itself, so the flow recovers by starting over. A
 * transport or server failure is evidence about the request, so the Agent in
 * the URL is kept and the read is retried — otherwise a momentary blip would
 * restart the flow and leave the member with a second Agent.
 */
export function classifyOpenTagAgent(read: OpenTagAgentRead): OpenTagAgentFacts {
  // Everything here is Team-scoped — creating the Agent as much as judging the
  // one in the URL — so nothing may proceed on a guessed Team. `RequireAuth`
  // only waits for `meLoaded`, which also flips after a `/me` transport
  // failure, so that is the state this has to catch and offer a retry for.
  if (!read.meAuthoritative || !read.organizationId) return { state: "team-unreadable" };
  if (!read.agentUuid) return { state: "none" };
  if (read.loading) return { state: "loading" };
  // Judge the failure before any cached row: a client that already read this
  // Agent keeps serving the old copy after a delete, and continuing on it
  // would offer setup for an Agent that no longer exists.
  if (read.errorStatus === 404 || read.errorStatus === 403 || read.errorStatus === 410) {
    return { state: "unavailable" };
  }
  // Any other failure says nothing about the Agent, so it stays retryable —
  // including a transport error, which never carries a status at all.
  if (read.failed && !read.agent) return { state: "unreadable" };
  if (!read.agent) return { state: "loading" };
  if (read.agent.organizationId !== read.organizationId) return { state: "unavailable" };
  if (read.agent.type === "human") return { state: "unavailable" };
  // Every non-active lifecycle, not just deleted: the first bind refuses a
  // suspended Agent outright, and a suspended bound Agent cannot receive work,
  // so advancing either one only produces a step that cannot complete.
  if (read.agent.status !== "active") return { state: "unavailable" };
  // Readable is not the same as usable here. An organization-visible Agent
  // owned by a teammate passes the read, but every write this flow makes —
  // the Client bind, the Feishu registration — needs manage authority, so
  // continuing on it would only produce a wall of 404s.
  if (!canManageAgentDetail(read.agent, read.memberId, read.role)) return { state: "unavailable" };
  // The Feishu registration this flow ends in rejects every Agent that is not
  // organization-visible, so a private Agent handed in through the URL would
  // bind a Computer and then hit a wall. OpenTag always creates
  // organization-visible Agents, so this only catches a foreign URL.
  if (read.agent.visibility !== "organization") return { state: "unavailable" };
  // Created atomically with its Computer, so a usable Agent is a bound Agent.
  // An unbound one is not something this flow produces or can finish.
  if (read.agent.clientId === null) return { state: "unavailable" };
  return { state: "resolved" };
}

/**
 * Whether this exact Agent has a real Feishu Task yet.
 *
 * `unknown` is deliberately not `absent`. A read that has not landed — or that
 * failed — is evidence about the request, not about the member: treating it as
 * "no Task" would be harmless here, but treating a failure as "Task" would
 * finish onboarding for someone who has never used their Agent. Both wrong
 * answers are kept out by making the absence of an answer its own state.
 */
export type OpenTagFirstUse =
  /** No answer yet: no Bot to have a Task, a read in flight, or a failed read. */
  | { state: "unknown" }
  /** Established: this Agent has no Feishu Task. */
  | { state: "absent" }
  /** Established: this Agent's Feishu Task exists, and this is its chat. */
  | { state: "present"; chatId: string };

/**
 * Where an Agent in the URL puts the member, or `null` while the facts have not
 * settled. An existing Agent is past both setup choices, so it lands on Feishu;
 * anything unusable starts over from the Agent choice, where nothing has been
 * created yet.
 *
 * Only a Task that is known to exist moves the member off the Bot step. A
 * connected Bot is not first use — the tail of this journey happens in Feishu,
 * and until it does the member still has something to finish here.
 */
export function resolveOpenTagStep(facts: OpenTagAgentFacts, firstUse: OpenTagFirstUse): OpenTagStepId | null {
  switch (facts.state) {
    case "none":
    case "unavailable":
      return "choose-agent";
    case "loading":
    case "unreadable":
    case "team-unreadable":
      return null;
    case "resolved":
      return firstUse.state === "present" ? "use-in-feishu" : "connect-feishu";
  }
}
