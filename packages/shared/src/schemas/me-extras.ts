import { z } from "zod";
import { agentNameSchema, agentVisibilitySchema } from "./agent.js";
import { agentTemplateIdsSchema } from "./agent-template.js";
import { landingCampaignActionContextSchema } from "./landing-campaign.js";

/**
 * Inferred onboarding step returned by `GET /me`. The server derives this
 * from live `clients` / `agents` rows on every request — no persisted
 * `members.onboarding_state` column. The advantage is that deleting the
 * client or the first agent automatically rewinds onboarding, so the UI
 * always reflects truth-on-the-ground rather than a snapshot.
 */
export const onboardingStepSchema = z.enum(["connect", "create_agent", "completed"]);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

/** Brief org descriptor returned to onboarding / the org switcher. */
export const orgBriefSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  role: z.enum(["admin", "member"]),
});
export type OrgBrief = z.infer<typeof orgBriefSchema>;

/**
 * Body for `POST /me/organizations` — operator wants to create another team.
 *
 * Only the display name is a user input. The org slug (`organizations.name`)
 * is a server-derived internal identifier, so the client must not supply it:
 * a client-chosen slug turns the global slug UNIQUE constraint into a
 * user-visible 409 on a field the user never typed.
 */
export const createOrgFromMeSchema = z.object({
  displayName: z.string().min(1).max(200),
});
export type CreateOrgFromMe = z.infer<typeof createOrgFromMeSchema>;

/**
 * Body for `PATCH /me/onboarding`. `dismissed=true` is the "finish later"
 * action: it suppresses future auto-open for the selected membership only.
 */
export const patchOnboardingSchema = z.object({
  dismissed: z.boolean().optional(),
  organizationId: z.string().optional(),
});
export type PatchOnboarding = z.infer<typeof patchOnboardingSchema>;

/** Body for `POST /me/onboarding-completed`. */
export const completeOnboardingSchema = z.object({
  organizationId: z.string().optional(),
});
export type CompleteOnboarding = z.infer<typeof completeOnboardingSchema>;

/**
 * Body for `POST /me/onboarding/kickoff` — the idempotent server-side chat
 * creation/send tail for the user's first agent chat. Callers decide whether
 * this kickoff should stamp completion after the chat exists; background/support
 * chats can pass `complete: false`.
 *
 * `agentUuid` is the bootstrap agent the chat is opened with. `bootstrap` is
 * the first message body. `topic` is the display title for the chat.
 * `organizationId` scopes the membership whose completion is stamped (defaults
 * to the caller's default membership).
 */
export const kickoffOnboardingSchema = z
  .object({
    organizationId: z.string().optional(),
    agentUuid: z.string().min(1),
    bootstrap: z.string().min(1),
    topic: z.string().trim().min(1).max(120).optional(),
    complete: z.boolean().optional(),
    /**
     * Web capability handshake for the optional first-chat Orientation UI.
     * Version 1 asks the server to mark the visible bootstrap and defer the
     * target agent until the user's next visible turn.
     */
    orientation: z.literal(1).optional(),
    // How the membership's onboarding state is stamped once the kickoff chat
    // exists. Takes precedence over the older boolean `complete` when both are
    // present:
    //   - "completed"    — terminal completion (same as `complete: true`).
    //   - "invitee_skip" — Team-agent quick start: write only the auto-open
    //     suppressor (reason="invitee_skip"), never the completion stamp, so
    //     personal-agent setup stays resumable.
    //   - "none"         — stamp nothing (same as `complete: false`).
    stamp: z.enum(["completed", "invitee_skip", "none"]).optional(),
    // Trusted landing-campaign action context. Direct and onboarding paths use
    // the same server-composed idempotency key for this campaign + repo.
    campaignAction: landingCampaignActionContextSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.orientation && value.campaignAction) {
      ctx.addIssue({
        code: "custom",
        path: ["orientation"],
        message: "Orientation is only available for ordinary onboarding kickoffs.",
      });
    }
  });
export type KickoffOnboarding = z.infer<typeof kickoffOnboardingSchema>;

/**
 * Body for `POST /orgs/:orgId/context-tree/setup-chat` — the dedicated Context
 * Tree setup chat. Organization scope comes from the route, and tree setup
 * never changes onboarding completion state.
 */
export const treeSetupKickoffSchema = z
  .object({
    agentUuid: z.string().min(1),
  })
  .strict();
export type TreeSetupKickoff = z.infer<typeof treeSetupKickoffSchema>;

/** Response for `POST /me/onboarding/kickoff` — the (stable) kickoff chat id. */
export const kickoffOnboardingResultSchema = z.object({
  chatId: z.string(),
});
export type KickoffOnboardingResult = z.infer<typeof kickoffOnboardingResultSchema>;

/**
 * Body for `POST /me/onboarding/events`. The web SPA reports key
 * milestones so the server can log them as a single funnel-trackable
 * stream alongside server-emitted events (`team_created`, `dismissed`).
 *
 * Server emits:
 *   - `team_created`           — when an explicit first-Agent start creates the Team
 *   - `dismissed`              — when PATCH /me/onboarding flips dismissed
 *
 * Web reports:
 *   - `step_viewed`            — a visible standalone onboarding step mounted
 *   - `step_completed`         — the user satisfied a visible step and advanced
 *   - `step_failed`            — a visible step hit a classified, user-impacting failure
 *   - `step_paused`            — the user chose "finish later" from a step
 *   - `resumed`                — the user resumed guided setup from Settings
 *   - `team_renamed`           — Step 1 user changed the auto-named team
 *   - `agent_created`          — Step 2 successfully created the agent
 *   - `kickoff_chat_started`   — a first-chat or tree-setup kickoff was created
 *   - `tree_chat_started`      — legacy name for the Step 3 tree kickoff event
 *   - `tree_intro_dismissed`   — Step 3 [I'll do it later] clicked
 */
export const onboardingEventNameSchema = z.enum([
  "step_viewed",
  "step_completed",
  "step_failed",
  "step_paused",
  "resumed",
  "team_renamed",
  "agent_created",
  "kickoff_chat_started",
  "tree_chat_started",
  "tree_intro_dismissed",
]);
export type OnboardingEventName = z.infer<typeof onboardingEventNameSchema>;

export const onboardingEventSchema = z.object({
  event: onboardingEventNameSchema,
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type OnboardingEvent = z.infer<typeof onboardingEventSchema>;

/**
 * One element of `GET /me memberships`. Powers the web client's
 * `currentMembership` derivation (decouple-client-from-identity §C1).
 * `agentId` is the human-agent UUID seeded for the user in that org —
 * the web admin gate keys off it.
 *
 * `orgHasOtherMembers` is true when the org has at least one other active
 * member besides the caller (`COUNT(members WHERE status='active') > 1`).
 * The web onboarding flow uses this to derive "is this a solo team or a
 * team-of-teammates" without relying on the per-tab `joinPath` flag, which
 * can be lost on a different tab / device mid-onboarding.
 *
 * `hasUsableAgent` is true when this member can use a non-human agent in
 * that org — one they manage themselves OR one another member set to
 * `visibility="organization"`. This is the general product availability bit
 * for team/chat surfaces; it is not sufficient to complete onboarding because
 * a joining member still needs their own personal agent.
 *
 * `hasPersonalAgent` is true when this membership manages at least one active
 * non-human agent in the org. Onboarding uses this own-agent readiness bit for
 * the create-agent step so a returning user who joins a mature team with a
 * shared org-visible agent still creates their own teammate before kickoff.
 */
export const meMembershipSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  role: z.enum(["admin", "member"]),
  agentId: z.string(),
  orgHasOtherMembers: z.boolean(),
  hasUsableAgent: z.boolean(),
  hasPersonalAgent: z.boolean(),
  onboardingSuppressedAt: z.string().nullable(),
  onboardingSuppressedReason: z.enum(["finish_later", "completed", "invitee_skip"]).nullable(),
  onboardingCompletedAt: z.string().nullable(),
});
export type MeMembership = z.infer<typeof meMembershipSchema>;

/**
 * Body of `POST /me/team-agents` — the user-scoped provisioning call a signed-in
 * user makes when they confirm their first Team Agent. It is user-scoped (Class
 * A) rather than org-scoped because the starting state has no organization at
 * all: browsing and signing in no longer mint an empty Team, so the Team is
 * created by this call. Existing-Team Agent creation remains exclusively on
 * the Team-scoped `POST /orgs/:orgId/agents` surface.
 */
export const provisionFirstTeamAgentSchema = z
  .object({
    /**
     * Stable UUID v7 generated once for this explicit confirmation. The
     * server derives the Agent identity from it, so only the same logical
     * request can resolve a completed retry.
     */
    requestId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    name: agentNameSchema.optional(),
    displayName: z.string().min(1).max(200).optional(),
    templateIds: agentTemplateIdsSchema.optional(),
  })
  .strict();
export type ProvisionFirstTeamAgent = z.infer<typeof provisionFirstTeamAgentSchema>;

/**
 * Result of `POST /me/team-agents`. `teamCreated` / `agentCreated` are false on
 * a converged retry: the call is idempotent, so a repeat resolves the same
 * first Team and first Agent instead of minting a second one.
 */
export const provisionFirstTeamAgentResultSchema = z.object({
  organizationId: z.string(),
  memberId: z.string(),
  teamCreated: z.boolean(),
  agentCreated: z.boolean(),
  agent: z.object({
    uuid: z.string(),
    name: z.string().nullable(),
    displayName: z.string(),
    visibility: agentVisibilitySchema,
    clientId: z.string().nullable(),
  }),
});
export type ProvisionFirstTeamAgentResult = z.infer<typeof provisionFirstTeamAgentResultSchema>;
