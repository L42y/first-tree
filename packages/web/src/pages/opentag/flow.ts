import type { Agent } from "@first-tree/shared";
import { canManageAgentDetail } from "../agent-detail/access.js";

/**
 * Pure step logic for the standalone `/opentag` entry.
 *
 * OpenTag deliberately has NO persisted onboarding state: there is no step
 * index in storage, no server-side progress record, and no browser draft. The
 * only thing that survives a reload, a lost response, or a retry is the exact
 * Agent in the URL — every step is then re-derived from authoritative reads of
 * that Agent, its Client binding, and its Feishu binding. Keeping the decision
 * here (and pure) is what makes the recovery states testable without a DOM,
 * matching this package's `.test.ts` convention.
 */

/**
 * The guided path the member sees. `use-in-feishu` is the destination this
 * entry hands off to — real first use in Feishu is owned by the Feishu Task
 * lifecycle, not by this flow, so {@link resolveOpenTagStep} never selects it.
 * It stays in the sequence because hiding the last leg would misrepresent how
 * far the member still has to go.
 */
export const OPENTAG_STEPS = ["choose-agent", "set-up-runtime", "connect-feishu", "use-in-feishu"] as const;
export type OpenTagStepId = (typeof OPENTAG_STEPS)[number];

/** Steps this entry can actually land on. */
export type OpenTagActiveStepId = Exclude<OpenTagStepId, "use-in-feishu">;

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
  | { state: "resolved"; bound: boolean };

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
  return { state: "resolved", bound: read.agent.clientId !== null };
}

/**
 * The step to render, or `null` while the facts have not settled.
 *
 * A bound Agent skips Runtime setup outright: the bind already happened, so
 * re-running the step would offer a move the one-shot bind path cannot make.
 */
export function resolveOpenTagStep(facts: OpenTagAgentFacts): OpenTagActiveStepId | null {
  switch (facts.state) {
    case "none":
    case "unavailable":
      return "choose-agent";
    case "loading":
    case "unreadable":
    case "team-unreadable":
      return null;
    case "resolved":
      return facts.bound ? "connect-feishu" : "set-up-runtime";
  }
}
