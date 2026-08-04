import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_REGEX,
  AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES,
  type Agent,
  type AgentTemplatePublicTemplate,
  type AgentVisibility,
  asRuntimeProvider,
  type ClientCapabilities,
  isReservedAgentName,
  isRuntimeProviderEnabled,
  MAX_AGENT_TEMPLATE_IDS,
  pickPreferredRuntimeProvider,
  type RuntimeProvider,
  runtimeProviderLabel,
} from "@first-tree/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trackEvent } from "../analytics.js";
import { type ConnectTokenResponse, getClientCapabilities, type HubClient, listClients } from "../api/activity.js";
import { listAgentTemplates } from "../api/agent-templates.js";
import { checkAgentNameAvailability, createAgent } from "../api/agents.js";
import { ApiError, api, type ValidationIssue } from "../api/client.js";
import { useAuth } from "../auth/auth-context.js";
import { useCopyFeedback } from "../lib/use-copy-feedback.js";
import { runVisibilityAwareInterval } from "../lib/visibility-interval.js";
import { slugify } from "../utils/agent-naming.js";
import { Button } from "./ui/button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { OptionCard } from "./ui/option-card.js";

const DISPLAY_NAME_MAX = 200;

// How many `-N` suffixes we try when auto-deduping a colliding handle before
// giving up and asking the user to pick one (the manual fallback). Collisions
// are rare, so the first probe almost always wins; the cap just bounds the
// pathological "team has 25 `dev-assistant`s" case.
const HANDLE_DEDUP_LIMIT = 25;

type FieldKey = "name" | "displayName" | "clientId" | "templates";
type FieldErrors = Partial<Record<FieldKey | "_root", string>>;

function issuesToFieldErrors(issues: ValidationIssue[] | undefined): FieldErrors {
  if (!issues || issues.length === 0) return {};
  const out: FieldErrors = {};
  const known: readonly FieldKey[] = ["name", "displayName", "clientId", "templates"];
  for (const issue of issues) {
    const head = issue.path[0];
    if (typeof head === "string" && (known as readonly string[]).includes(head)) {
      const key = head as FieldKey;
      if (!out[key]) out[key] = issue.message;
    } else {
      out._root = issue.message;
    }
  }
  return out;
}

/**
 * Simplified agent creation dialog for the onboarding flow.
 *
 * Display-name-first layout (see first-tree-context:agent-hub/agent-naming.md §3.6):
 *   - "Display name" is the primary input at the top (required-feeling, unicode).
 *   - The derived @handle is shown read-only beneath it as a quiet
 *     `@my-dev-assistant · permanent` line. The slug always follows the display
 *     name and is auto-deduped on collision, so users never edit it directly.
 *   - A minimal fallback @handle input appears ONLY when a usable handle can't
 *     be derived — a pure-CJK / emoji display name (empty slug), or when
 *     auto-dedup is exhausted. Normal names stay zero-edit, zero-noise.
 *
 * Hidden defaults:
 *   - type = "agent"
 *   - manager = current user
 *   - delegateMention = not surfaced here; the server auto-adopts a
 *     member's FIRST agent as their delegate (createAgent in
 *     services/agent.ts), so the common case needs no manual step.
 *
 * Surfaced choices: visibility (visible to your team / private to you), the
 * connected computer the agent will run on, and the runtime provider —
 * filtered to whatever is actually installed and signed-in on that
 * computer (mirrors onboarding step 2).
 */

// Runtime selection sources its values from `RuntimeProvider`; new providers
// extend the union in `@first-tree/shared` and the
// dialog picks them up automatically.

/**
 * Lightweight normalizer applied to every keystroke in the fallback agent-name
 * input: downcase + fold illegal runs to `-`, but keep trailing `-` /
 * `_` so users can type `alice-bot` one character at a time. Leading
 * separators are still stripped because the server regex will reject
 * them on submit and live-feedback is more useful than tolerating an
 * input that can't be saved.
 */
function normalizeNameInput(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, AGENT_NAME_MAX_LENGTH);
}

/**
 * Build the `n`th dedup candidate for a base slug. `n <= 1` is the bare base;
 * higher `n` appends `-n`, trimming the base so the suffix stays within the
 * length cap (and never leaves a dangling separator before the `-n`).
 */
function handleCandidate(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  const room = Math.max(0, AGENT_NAME_MAX_LENGTH - suffix.length);
  const trimmed = base.slice(0, room).replace(/[-_]+$/g, "");
  return `${trimmed}${suffix}`;
}

/**
 * Resolve the first available handle derived from `base`: tries `base`,
 * `base-2`, `base-3`, … up to `HANDLE_DEDUP_LIMIT`, skipping syntactically
 * invalid / reserved candidates. Returns the winning handle, or `null` when
 * none is free (→ caller shows the manual fallback). On a network error it
 * optimistically returns the current candidate — the server validates
 * authoritatively on submit. `isStale` lets the caller abandon a superseded
 * run mid-probe.
 */
async function resolveAvailableHandle(base: string, isStale: () => boolean): Promise<string | null> {
  for (let n = 1; n <= HANDLE_DEDUP_LIMIT; n++) {
    if (isStale()) return null;
    const candidate = handleCandidate(base, n);
    if (!candidate || !AGENT_NAME_REGEX.test(candidate) || isReservedAgentName(candidate)) continue;
    try {
      const res = await checkAgentNameAvailability(candidate);
      if (isStale()) return null;
      if (res.available) return candidate;
      // `invalid` won't improve by adding a suffix — bail to the fallback.
      if (res.reason === "invalid") return null;
    } catch {
      return candidate;
    }
  }
  return null;
}

/**
 * Pick the preferred runtime among the ones in `ok` state on a given client.
 * Order and disabled filtering come from the shared provider catalog
 * (`RUNTIME_PROVIDER_DISPLAY_ORDER` + `DISABLED_RUNTIME_PROVIDERS`).
 */
function pickPreferredRuntime(caps: ClientCapabilities): RuntimeProvider | null {
  return pickPreferredRuntimeProvider(caps);
}

function availabilityReasonMessage(reason: "invalid" | "reserved" | "taken"): string {
  switch (reason) {
    case "taken":
      return "That agent name is already in use in this organization. Pick a different one.";
    case "reserved":
      return "That agent name is reserved — pick a different one.";
    case "invalid":
      return "Agent name must start with a letter or digit and contain only lowercase letters, digits, hyphens (-), and underscores (_).";
  }
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (agent: Agent, runtimeProvider: RuntimeProvider, templateCount: number) => void;
  /**
   * Optional public Template slug to preselect (e.g. from the canonical
   * `/templates/:slug?use=1` intent). Applied ONCE per dialog open, after the
   * catalog resolves — later manual add/remove is never overwritten, and an
   * ordinary open without the prop starts clean. A slug that is no longer an
   * active Template degrades to an explanatory notice; no stale id is ever
   * submitted.
   */
  initialTemplateSlug?: string;
};

type AvailabilityState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok" }
  | { status: "bad"; reason: "invalid" | "reserved" | "taken" };

// Resolution state for the auto-derived handle. `manual` means we couldn't
// derive a usable handle and the fallback input is shown.
type HandleState = { status: "idle" } | { status: "checking" } | { status: "ok" } | { status: "manual" };

export function NewAgentDialog({ open, onOpenChange, onCreated, initialTemplateSlug }: Props) {
  const queryClient = useQueryClient();
  const { refreshMe, organizationId } = useAuth();
  const [displayName, setDisplayName] = useState("");
  // Default is "private": newly-created agents are scoped to the creator
  // by default, matching the conservative "only I see it" framing. Sharing
  // with the team is an explicit decision the user opts into; the previous
  // default ("organization") quietly published every onboarding agent into
  // the team roster, which surprised users who expected new agents to be
  // personal until explicitly shared.
  const [visibility, setVisibility] = useState<AgentVisibility>("private");
  const [runtime, setRuntime] = useState<RuntimeProvider>("claude-code");

  // Handle resolution. The slug follows the display name (auto-deduped on
  // collision); `resolvedHandle` is the winner. `manualHandle` is only used
  // when `handleState.status === "manual"` (no derivable handle).
  const [resolvedHandle, setResolvedHandle] = useState("");
  const [handleState, setHandleState] = useState<HandleState>({ status: "idle" });
  const [manualHandle, setManualHandle] = useState("");
  const [manualAvailability, setManualAvailability] = useState<AvailabilityState>({ status: "idle" });

  // Computer + runtime detection — lifted into the form so the user sees
  // which machine will host the agent (and which runtimes are actually
  // installed there) before clicking Create. Mirrors onboarding step 2.
  const [connectedClients, setConnectedClients] = useState<HubClient[]>([]);
  const [clientsLoaded, setClientsLoaded] = useState(false);
  const [pickedClientId, setPickedClientId] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<ClientCapabilities | null>(null);
  const [capabilitiesClientId, setCapabilitiesClientId] = useState<string | null>(null);
  // Connect-token state for the zero-computer recovery affordance. We only
  // generate one when 0 clients are connected; the dialog then shows the
  // real channel-aware install/login command instead of a useless
  // bare-command hint (codex review caught this). We hold the full
  // bootstrap string from the server response so installer URLs and CLI names
  // stay a server-side concern — if either changes the dialog won't drift.
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [connectCommand, setConnectCommand] = useState<string | null>(null);
  const [connectTokenExpiresAt, setConnectTokenExpiresAt] = useState<number | null>(null);
  // Shared copy → transient-feedback machine for the zero-computer block's
  // connect command (success label only here).
  const { status: tokenCopyStatus, copy: copyToken, reset: resetTokenCopy } = useCopyFeedback();

  const [clientErrors, setClientErrors] = useState<FieldErrors>({});

  // Optional official Template responsibilities (0-3, unordered,
  // single-template-first). Loaded from the public-safe catalog only; a
  // failed/empty catalog simply hides the section and leaves the plain
  // create path untouched.
  const [templateCatalog, setTemplateCatalog] = useState<AgentTemplatePublicTemplate[]>([]);
  const [templateCatalogLoaded, setTemplateCatalogLoaded] = useState(false);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  // The caller-supplied initial Template is applied exactly once per open,
  // bound to the CURRENT open generation's CURRENT catalog response. A reopen
  // bumps `openGenRef` before the apply effect can read the previous open's
  // catalog state, so a Template retired between two opens can never be
  // preselected (or submitted) from stale state.
  //
  // Explicit-intent state machine: while `pending` (the slug has not yet been
  // resolved against this open's catalog), submission is BLOCKED with a
  // visible resolving state — a slow/hung lookup must never silently convert
  // an explicit adoption into a plain Agent. `removed` is the user's explicit
  // escape: plain creation unlocks and a late response can never reapply.
  // `unavailable` (retired/vanished/failed lookup) explains and also unlocks
  // plain creation; nothing stale is submitted in any state.
  type InitialTemplateState = "idle" | "pending" | "applied" | "unavailable" | "removed";
  const openGenRef = useRef(0);
  const wasOpenRef = useRef(false);
  const [catalogGen, setCatalogGen] = useState(0);
  const initialAppliedForGenRef = useRef(0);
  const [initialTemplateState, setInitialTemplateState] = useState<InitialTemplateState>("idle");

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    // One generation per closed→open transition. This effect is declared
    // before the reset and apply effects, so the bump is visible to them in
    // the same commit.
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      openGenRef.current += 1;
    }
    const gen = openGenRef.current;
    let cancelled = false;
    void listAgentTemplates()
      .then((res) => {
        if (cancelled) return;
        setTemplateCatalog(res.templates.filter((template) => template.status === "active"));
        setCatalogGen(gen);
        setTemplateCatalogLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setTemplateCatalog([]);
        setCatalogGen(gen);
        setTemplateCatalogLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setDisplayName("");
      setVisibility("private");
      setRuntime("claude-code");
      setResolvedHandle("");
      setHandleState({ status: "idle" });
      setManualHandle("");
      setManualAvailability({ status: "idle" });
      setConnectedClients([]);
      setClientsLoaded(false);
      setPickedClientId(null);
      setCapabilities(null);
      setCapabilitiesClientId(null);
      setConnectToken(null);
      setConnectCommand(null);
      setConnectTokenExpiresAt(null);
      resetTokenCopy();
      setClientErrors({});
      setTemplateCatalog([]);
      setTemplateCatalogLoaded(false);
      setCatalogGen(0);
      setSelectedTemplateIds([]);
      setTemplatePickerOpen(false);
      setInitialTemplateState(initialTemplateSlug ? "pending" : "idle");
    }
  }, [open, resetTokenCopy, initialTemplateSlug]);

  // Resolve the caller-supplied initial Template slug against the catalog
  // exactly once per open generation. The catalog only carries ACTIVE
  // Templates, so a retired/vanished slug simply has no match — degrade to a
  // notice instead of submitting a stale id. The generation guard means a
  // reopen never applies the previous open's catalog, the applied guard means
  // a late or repeated response never overwrites the user's later manual
  // add/remove, and the removed guard means the user's explicit
  // create-without-it choice can never be re-blocked by a late response.
  useEffect(() => {
    if (!open || !templateCatalogLoaded || !initialTemplateSlug) return;
    if (catalogGen === 0 || catalogGen !== openGenRef.current) return;
    if (initialAppliedForGenRef.current === catalogGen) return;
    if (initialTemplateState === "removed") return;
    initialAppliedForGenRef.current = catalogGen;
    const match = templateCatalog.find((template) => template.slug === initialTemplateSlug);
    if (match) {
      setSelectedTemplateIds([match.id]);
      setInitialTemplateState("applied");
    } else {
      setInitialTemplateState("unavailable");
    }
  }, [open, templateCatalogLoaded, templateCatalog, catalogGen, initialTemplateSlug, initialTemplateState]);

  const baseSlug = useMemo(() => slugify(displayName), [displayName]);
  const hasDisplay = displayName.trim().length > 0;

  // Auto-resolve the @handle from the display name. A syntactically-valid,
  // non-reserved slug is usable *immediately* (submit isn't gated on the
  // network) — the dedup probe then runs in the background and quietly swaps
  // in `base-N` if the base turns out to be taken. Cases that have no usable
  // handle up front (empty slug from a pure CJK/emoji name → `manual`;
  // reserved base → `checking` until the probe finds an alternative) wait for
  // the probe. Keyed on `baseSlug` + `hasDisplay` so typing within a stable
  // slug doesn't re-probe on every keystroke.
  const resolveSeqRef = useRef(0);
  useEffect(() => {
    if (!open) return;
    const seq = ++resolveSeqRef.current;
    const isStale = () => seq !== resolveSeqRef.current;

    if (!baseSlug) {
      setResolvedHandle("");
      setHandleState(hasDisplay ? { status: "manual" } : { status: "idle" });
      return;
    }
    // Optimistic: a clean base is immediately submittable; a reserved one
    // can't be used as-is, so hold submit until the probe resolves a suffix.
    const usableNow = AGENT_NAME_REGEX.test(baseSlug) && !isReservedAgentName(baseSlug);
    setResolvedHandle(usableNow ? baseSlug : "");
    setHandleState(usableNow ? { status: "ok" } : { status: "checking" });

    const timer = window.setTimeout(() => {
      void resolveAvailableHandle(baseSlug, isStale).then((found) => {
        if (isStale()) return;
        if (found) {
          setResolvedHandle(found);
          setHandleState({ status: "ok" });
        } else {
          setResolvedHandle("");
          setHandleState({ status: "manual" });
        }
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [open, baseSlug, hasDisplay]);

  // Debounced availability probe for the manual fallback handle. Mirrors the
  // local format / reserved checks before spending a round-trip; only active
  // while the fallback input is shown.
  const manualSeqRef = useRef(0);
  useEffect(() => {
    // Bump the sequence BEFORE any early return so an in-flight probe from a
    // prior run can never write back after the input changed or cleared
    // (otherwise a stale `{ available: true }` could re-mark a now-empty /
    // invalid value as `ok`).
    const seq = ++manualSeqRef.current;
    if (!open || handleState.status !== "manual") {
      setManualAvailability({ status: "idle" });
      return;
    }
    // Probe the exact value that gets submitted (`effectiveHandle` is the slug),
    // not the raw input — `normalizeNameInput` keeps a trailing `-`/`_` for
    // mid-typing, so checking the raw value would verify a different string
    // than the one we POST.
    const candidate = slugify(manualHandle);
    if (!candidate) {
      setManualAvailability({ status: "idle" });
      return;
    }
    if (!AGENT_NAME_REGEX.test(candidate)) {
      setManualAvailability({ status: "bad", reason: "invalid" });
      return;
    }
    if (isReservedAgentName(candidate)) {
      setManualAvailability({ status: "bad", reason: "reserved" });
      return;
    }
    setManualAvailability({ status: "checking" });
    const timer = window.setTimeout(() => {
      checkAgentNameAvailability(candidate)
        .then((res) => {
          if (seq !== manualSeqRef.current) return;
          setManualAvailability(res.available ? { status: "ok" } : { status: "bad", reason: res.reason });
        })
        .catch(() => {
          if (seq !== manualSeqRef.current) return;
          // Network failure shouldn't block submission — the server validates
          // authoritatively on POST.
          setManualAvailability({ status: "idle" });
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [open, handleState.status, manualHandle]);

  // Poll `listClients` to keep the connected-computer list fresh while the
  // dialog is open. 5s cadence so a computer coming online (or going
  // offline) reflects without the user closing and reopening the dialog.
  // `runVisibilityAwareInterval` truly pauses the timer while the tab is
  // hidden (clearInterval, not a tick-time skip) and fires a catch-up
  // tick when the user returns.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const list = await listClients();
        if (cancelled) return;
        const connected = list
          .filter((c) => c.status === "connected")
          .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
        setConnectedClients(connected);
        setClientsLoaded(true);
      } catch {
        // Best-effort. Mark as loaded so the empty-state UI shows instead of
        // a forever spinner — the user can still see *something* and the
        // next tick will recover.
        if (!cancelled) setClientsLoaded(true);
      }
    };
    const dispose = runVisibilityAwareInterval(tick, 5_000);
    return () => {
      cancelled = true;
      dispose();
    };
  }, [open]);

  // Auto-pick the most-recently-seen connected client, but stay on the
  // user's manual choice as long as it's still in the list.
  useEffect(() => {
    if (connectedClients.length === 0) {
      setPickedClientId(null);
      return;
    }
    setPickedClientId((prev) => {
      if (prev && connectedClients.some((c) => c.id === prev)) return prev;
      return connectedClients[0]?.id ?? null;
    });
  }, [connectedClients]);

  // Capability fetch — exposed as a callback so an in-dialog Connect can force
  // an immediate refresh (otherwise the just-signed-in runtime only flips to ok
  // on the next 5s tick). Staleness is gated by `capabilitiesClientId`, so a
  // late write from a previous client is ignored by `activeCapabilities`.
  const refreshCapabilities = useCallback(async (): Promise<void> => {
    if (!pickedClientId) return;
    try {
      const res = await getClientCapabilities(pickedClientId);
      setCapabilities(res.capabilities);
      setCapabilitiesClientId(pickedClientId);
    } catch {
      // Transient — keep whatever we have (initial null shows "detecting…",
      // prior success keeps the chips). The next tick will retry.
    }
  }, [pickedClientId]);

  // Polls every 5s while a client is picked. Same cadence as the listClients
  // poll above so a transient API failure self-heals on the next tick rather
  // than freezing the UI in "Detecting installed runtimes…" until the user
  // reopens the dialog. Visibility-aware (see `runVisibilityAwareInterval`).
  useEffect(() => {
    if (!pickedClientId) {
      setCapabilities(null);
      setCapabilitiesClientId(null);
      return;
    }
    const dispose = runVisibilityAwareInterval(refreshCapabilities, 5_000);
    return () => dispose();
  }, [pickedClientId, refreshCapabilities]);

  // Connect-token generation. Only fires when the dialog is open AND the
  // user has zero connected computers — so an existing user creating their
  // Nth agent doesn't burn a token just by opening the dialog. Mirrors
  // onboarding step 2's token-refresh logic: schedule a clear at expiry
  // and let the next render fetch a fresh one.
  useEffect(() => {
    if (!open) return;
    if (connectedClients.length > 0) return;
    if (connectToken && connectTokenExpiresAt && connectTokenExpiresAt > Date.now()) {
      const refreshAt = Math.max(connectTokenExpiresAt - Date.now(), 0);
      const handle = window.setTimeout(() => {
        setConnectToken(null);
        setConnectTokenExpiresAt(null);
      }, refreshAt);
      return () => window.clearTimeout(handle);
    }
    if (connectToken) {
      // Expired token still hanging around — clear it before fetching anew.
      setConnectToken(null);
      setConnectCommand(null);
      setConnectTokenExpiresAt(null);
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.post<ConnectTokenResponse>("/me/connect-tokens", {});
        if (cancelled) return;
        setConnectToken(r.token);
        setConnectCommand(r.bootstrapCommand);
        setConnectTokenExpiresAt(Date.now() + r.expiresIn * 1000);
      } catch {
        // Best-effort. The UI shows "Generating token…" until the user
        // reopens the dialog; we don't surface this as a hard error since
        // the user's primary path (connect any machine that's already
        // configured) doesn't depend on it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, connectedClients.length, connectToken, connectTokenExpiresAt]);

  // Capabilities tied to the *currently* picked client only — guards
  // against acting on stale data right after the user switches machines.
  const activeCapabilities = pickedClientId && capabilitiesClientId === pickedClientId ? capabilities : null;
  const okRuntimes = useMemo<RuntimeProvider[]>(() => {
    if (!activeCapabilities) return [];
    const out: RuntimeProvider[] = [];
    for (const [provider, entry] of Object.entries(activeCapabilities)) {
      if (entry.state !== "ok") continue;
      const rt = asRuntimeProvider(provider);
      // Skip temporarily-disabled providers so they never appear as a
      // selectable runtime, even if a stale snapshot still reports them `ok`.
      if (rt && isRuntimeProviderEnabled(rt)) out.push(rt);
    }
    return out;
  }, [activeCapabilities]);

  // Realign the runtime selection whenever the picked client's capabilities
  // change — if the previous selection isn't `ok` on the new machine, fall
  // back to whatever the new machine prefers. Same pattern as onboarding.
  useEffect(() => {
    if (!activeCapabilities) return;
    setRuntime((prev) => {
      if (activeCapabilities[prev]?.state === "ok") return prev;
      return pickPreferredRuntime(activeCapabilities) ?? prev;
    });
  }, [activeCapabilities]);

  // The handle that will actually be submitted: the auto-resolved one, or the
  // user's manual fallback (slugified) when no handle could be derived.
  const manualSlug = slugify(manualHandle);
  const effectiveHandle = handleState.status === "manual" ? manualSlug : resolvedHandle;

  // Whether the handle is settled enough to submit. In manual mode the gate is
  // tied to the CURRENT submitted slug (not just a possibly-stale `ok` flag):
  // the slug must be non-empty, valid and non-reserved, AND availability must be
  // `ok` (explicitly available) or `idle` (probe network-failed → optimistic,
  // server arbitrates on POST).
  const manualSlugSubmittable =
    manualSlug.length > 0 && AGENT_NAME_REGEX.test(manualSlug) && !isReservedAgentName(manualSlug);
  const handleReady =
    handleState.status === "ok"
      ? true
      : handleState.status === "manual"
        ? manualSlugSubmittable && (manualAvailability.status === "ok" || manualAvailability.status === "idle")
        : false;

  const createMut = useMutation({
    mutationFn: async (opts: { clientId?: string; templateIds: string[] }) => {
      const effectiveDisplay = displayName.trim() || effectiveHandle || "Untitled assistant";
      return createAgent({
        name: effectiveHandle || undefined,
        type: "agent",
        displayName: effectiveDisplay,
        clientId: opts.clientId,
        runtimeProvider: runtime,
        visibility,
        // Pin the agent to the org the user is currently viewing in the
        // dropdown — the JWT default org is non-deterministic across logins
        // (auth.ts member pick) and creating into "wherever the JWT lands"
        // is the source of "I created it in atf, why is it in gandy02?".
        ...(organizationId ? { organizationId } : {}),
        ...(opts.templateIds.length > 0 ? { templateIds: opts.templateIds } : {}),
      });
    },
    onSuccess: (agent, variables) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
      // Refresh /me so onboardingStep flips to "completed" — otherwise the
      // onboarding banner sticks around even though the user just
      // created an agent through this non-onboarding path.
      void refreshMe();
      // Every count comes from the submit-time snapshot, so a later
      // Remove/close during the pending window cannot misreport it.
      if (variables.templateIds.length > 0) {
        trackEvent("agent_template_create_success", { template_count: variables.templateIds.length });
      }
      // The draft-open event belongs to the caller's navigate path — this
      // component only reports creation, never navigation.
      onCreated(agent, runtime, variables.templateIds.length);
    },
  });

  const serverErrors = useMemo<FieldErrors>(() => {
    const err = createMut.error;
    if (!err) return {};
    if (err instanceof ApiError) {
      const fromIssues = issuesToFieldErrors(err.issues);
      if (Object.keys(fromIssues).length > 0) return fromIssues;
      if (err.status === 409) {
        // Branch only on stable wire codes — never guess name from a bare 409.
        if (err.code === AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.NAME_CONFLICT) {
          return { name: "That agent name is already in use in this organization. Pick a different one." };
        }
        if (err.code === AGENT_TEMPLATE_LIFECYCLE_ERROR_CODES.ADOPTION_CONFLICT) {
          // Bind feedback to the submit-time snapshot. A late rejection after
          // the user changed the draft during pending must not paint the old
          // adoption error onto a different (or empty) selection.
          const submitted = [...(createMut.variables?.templateIds ?? [])].sort();
          const current = [...selectedTemplateIds].sort();
          const matchesSnapshot =
            submitted.length === current.length && submitted.every((id, index) => id === current[index]);
          if (!matchesSnapshot) return {};
          return { templates: err.message };
        }
        return { _root: err.message };
      }
      return { _root: err.message };
    }
    if (err instanceof Error) return { _root: err.message };
    return {};
  }, [createMut.error, createMut.variables, selectedTemplateIds]);

  const manualError =
    handleState.status === "manual" && manualAvailability.status === "bad"
      ? availabilityReasonMessage(manualAvailability.reason)
      : undefined;
  const fieldErrors: FieldErrors = {
    ...(manualError ? { name: manualError } : {}),
    ...serverErrors,
    ...clientErrors,
  };

  function validateForm(): FieldErrors {
    const errs: FieldErrors = {};
    if (displayName.length > DISPLAY_NAME_MAX) {
      errs.displayName = `Display name must be at most ${DISPLAY_NAME_MAX} characters (got ${displayName.length}).`;
    }
    return errs;
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const errs = validateForm();
    setClientErrors(errs);
    if (Object.keys(errs).length > 0) return;
    if (!handleReady) return;
    if (!pickedClientId) return;
    // An explicit Template intent that has not resolved yet must not silently
    // become a plain create — guard the handler itself, not just the button
    // (Enter / programmatic submit bypasses the disabled attribute).
    if (initialTemplateState === "pending") return;
    // Defense in depth: the Create button is disabled when the picked client
    // has no ok runtime or when the current selection isn't ok on it. Guard
    // here too so a button-disabled bypass (browser quirk, Enter while a
    // focused element re-enables submit, etc.) doesn't push an
    // un-runnable agent through.
    if (okRuntimes.length === 0 || !okRuntimes.includes(runtime)) return;
    // Snapshot the selection at submit time; mutation variables keep it
    // stable through the pending window.
    createMut.mutate({ clientId: pickedClientId, templateIds: [...selectedTemplateIds] });
  }

  const canSubmit =
    displayName.trim().length > 0 &&
    handleReady &&
    !createMut.isPending &&
    initialTemplateState !== "pending" &&
    !!pickedClientId &&
    okRuntimes.length > 0 &&
    okRuntimes.includes(runtime);

  const selectedTemplates = useMemo(
    () =>
      selectedTemplateIds
        .map((id) => templateCatalog.find((template) => template.id === id))
        .filter((template): template is AgentTemplatePublicTemplate => template !== undefined),
    [selectedTemplateIds, templateCatalog],
  );
  const addableTemplates = useMemo(
    () => templateCatalog.filter((template) => !selectedTemplateIds.includes(template.id)),
    [templateCatalog, selectedTemplateIds],
  );

  function toggleTemplate(template: AgentTemplatePublicTemplate): void {
    if (selectedTemplateIds.includes(template.id)) {
      setSelectedTemplateIds((prev) => prev.filter((id) => id !== template.id));
      trackEvent("agent_template_select", { surface: "new_agent", action: "remove", slug: template.slug });
      return;
    }
    if (selectedTemplateIds.length >= MAX_AGENT_TEMPLATE_IDS) return;
    setSelectedTemplateIds((prev) => [...prev, template.id]);
    trackEvent("agent_template_select", { surface: "new_agent", action: "add", slug: template.slug });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Agent</DialogTitle>
        </DialogHeader>
        {/* min-w-0 lets the grid item (this form) shrink below its
            content's intrinsic width — without it, a long command/token in
            the zero-computer state would push the dialog past max-w-lg. */}
        <form onSubmit={handleSubmit} className="space-y-5 min-w-0">
          <div className="space-y-2">
            <Label htmlFor="new-agent-display-name">Display name</Label>
            <Input
              id="new-agent-display-name"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                if (clientErrors.displayName) setClientErrors((prev) => ({ ...prev, displayName: undefined }));
              }}
              placeholder="My Dev Assistant"
              autoFocus
              maxLength={DISPLAY_NAME_MAX}
              aria-invalid={fieldErrors.displayName ? true : undefined}
              aria-describedby="new-agent-display-name-help new-agent-display-name-error"
            />
            <p id="new-agent-display-name-help" className="text-caption text-muted-foreground">
              How teammates see this agent in chats and lists. Can be changed anytime.
            </p>
            {fieldErrors.displayName && (
              <p id="new-agent-display-name-error" className="text-caption text-destructive">
                {fieldErrors.displayName}
              </p>
            )}

            {/* Derived @handle. Read-only in the common case (slug follows the
                display name, auto-deduped on collision). The minimal fallback
                input appears only when no handle can be derived. */}
            {handleState.status === "manual" ? (
              <div className="space-y-1.5 pt-1">
                <Label htmlFor="new-agent-name">Pick an @handle</Label>
                <div className="flex items-stretch">
                  <span
                    aria-hidden
                    className="inline-flex items-center px-2 font-mono text-body text-muted-foreground border border-r-0 border-input rounded-l-[var(--radius-input)] bg-muted/40"
                  >
                    @
                  </span>
                  <Input
                    id="new-agent-name"
                    value={manualHandle}
                    autoFocus
                    onChange={(e) => {
                      // `normalizeNameInput` keeps trailing `-`/`_` so users can
                      // type `alice-bot` one char at a time; the stricter
                      // `slugify` fires on blur to tidy a dangling separator.
                      setManualHandle(normalizeNameInput(e.target.value));
                      if (clientErrors.name) setClientErrors((prev) => ({ ...prev, name: undefined }));
                    }}
                    onBlur={(e) => {
                      const cleaned = slugify(e.target.value);
                      if (cleaned !== manualHandle) setManualHandle(cleaned);
                    }}
                    placeholder="my-dev-assistant"
                    className="rounded-l-none font-mono"
                    maxLength={AGENT_NAME_MAX_LENGTH}
                    aria-invalid={fieldErrors.name ? true : undefined}
                    aria-describedby="new-agent-name-help new-agent-name-status new-agent-name-error"
                  />
                </div>
                <p id="new-agent-name-help" className="text-caption text-muted-foreground">
                  We couldn&apos;t build an @handle from this display name. Pick one — lowercase letters, digits,
                  hyphens (-), and underscores (_). Permanent after creation.
                </p>
                {manualHandle && !fieldErrors.name && manualAvailability.status !== "idle" && (
                  <p
                    id="new-agent-name-status"
                    className="text-caption"
                    style={{ color: manualAvailability.status === "ok" ? "var(--success)" : "var(--fg-3)" }}
                  >
                    {manualAvailability.status === "checking" && "Checking availability…"}
                    {manualAvailability.status === "ok" && "Available."}
                  </p>
                )}
                {fieldErrors.name && (
                  <p id="new-agent-name-error" className="text-caption text-destructive">
                    {fieldErrors.name}
                  </p>
                )}
              </div>
            ) : (
              handleState.status !== "idle" && (
                <div className="flex items-baseline gap-2 text-caption text-muted-foreground">
                  {handleState.status === "checking" ? (
                    <span className="italic">Reserving @handle…</span>
                  ) : (
                    <>
                      <span className="font-mono text-foreground">@{effectiveHandle}</span>
                      <span aria-hidden>·</span>
                      <span>permanent</span>
                    </>
                  )}
                </div>
              )
            )}
            {handleState.status !== "manual" && fieldErrors.name && (
              <p className="text-caption text-destructive">{fieldErrors.name}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Visibility</Label>
            <div className="space-y-2">
              <OptionCard
                name="visibility"
                checked={visibility === "organization"}
                onSelect={() => setVisibility("organization")}
              >
                <div>
                  <div className="text-body font-medium">Visible to your team</div>
                  <div className="text-caption text-muted-foreground">
                    Anyone on your team can @mention it and start work with it — it runs on your computer and uses your
                    plan.
                  </div>
                </div>
              </OptionCard>
              <OptionCard
                name="visibility"
                checked={visibility === "private"}
                onSelect={() => setVisibility("private")}
              >
                <div>
                  <div className="text-body font-medium">Private to you</div>
                  <div className="text-caption text-muted-foreground">Only you can see and chat with it.</div>
                </div>
              </OptionCard>
            </div>
          </div>

          {/* Optional official Template responsibilities. Hidden entirely when
              the catalog is empty or failed to load — the plain create path
              stays byte-identical in those cases. */}
          {initialTemplateState === "pending" && (
            <div className="space-y-2">
              <p className="text-caption text-muted-foreground" role="status">
                Resolving your template…
              </p>
              {/* Explicit escape hatch: the user may always choose plain
                  creation instead of waiting for the lookup. Once removed, a
                  late response can never reapply or re-block the intent. */}
              <Button type="button" variant="ghost" size="sm" onClick={() => setInitialTemplateState("removed")}>
                Create without it
              </Button>
            </div>
          )}
          {initialTemplateState === "unavailable" && (
            <p className="text-caption text-muted-foreground" role="status">
              {templateCatalog.length > 0
                ? "The template you started from is no longer available — pick another responsibility below, or create from scratch."
                : "The template you started from is no longer available — you can still create your agent from scratch."}
            </p>
          )}
          {templateCatalogLoaded && templateCatalog.length > 0 && (
            <div className="space-y-2">
              <Label>Responsibilities (optional)</Label>
              {selectedTemplates.length === 0 && !templatePickerOpen && (
                <div className="space-y-2">
                  <p className="text-caption text-muted-foreground">
                    Start from an official template — or create from scratch.
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={() => setTemplatePickerOpen(true)}>
                    Choose a template
                  </Button>
                </div>
              )}
              {selectedTemplates.map((template) => (
                <div
                  key={template.id}
                  className="rounded-[var(--radius-panel)] border border-border px-3 py-2 space-y-1"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-body font-medium">{template.name}</div>
                    <Button type="button" variant="ghost" size="sm" onClick={() => toggleTemplate(template)}>
                      Remove
                    </Button>
                  </div>
                  <div className="text-caption text-muted-foreground">{template.public.tagline}</div>
                  <div className="text-caption text-muted-foreground">{template.public.purpose}</div>
                  <div className="text-caption text-muted-foreground">For {template.public.targetUsers}</div>
                  <div className="text-caption text-muted-foreground">{template.public.userValue}</div>
                  <div className="text-caption text-muted-foreground">{template.public.toolsAndSkillsSummary}</div>
                </div>
              ))}
              {selectedTemplates.length > 0 &&
                selectedTemplates.length < MAX_AGENT_TEMPLATE_IDS &&
                !templatePickerOpen &&
                addableTemplates.length > 0 && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setTemplatePickerOpen(true)}>
                    Add another responsibility
                  </Button>
                )}
              {selectedTemplates.length >= MAX_AGENT_TEMPLATE_IDS && (
                <p className="text-caption text-muted-foreground">
                  Up to {MAX_AGENT_TEMPLATE_IDS} responsibilities per agent.
                </p>
              )}
              {templatePickerOpen && addableTemplates.length > 0 && (
                <div className="space-y-2">
                  {addableTemplates.map((template) => (
                    <OptionCard
                      key={template.id}
                      name="agent-template"
                      checked={selectedTemplateIds.includes(template.id)}
                      onSelect={() => {
                        toggleTemplate(template);
                        setTemplatePickerOpen(false);
                      }}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-body font-medium">{template.name}</div>
                        <div className="text-caption text-muted-foreground">{template.public.tagline}</div>
                        <div className="text-caption text-muted-foreground">{template.public.purpose}</div>
                      </div>
                    </OptionCard>
                  ))}
                </div>
              )}
              {fieldErrors.templates && (
                <p className="text-caption text-destructive" role="alert">
                  {fieldErrors.templates}
                </p>
              )}
            </div>
          )}

          {/*
            "Where it runs" block. The computer card and runtime row each render
            a dimension-matched skeleton while their async data loads
            (`ComputerCardSkeleton` / `RuntimeChipsSkeleton`), so the block
            holds a stable height through the detect → loaded transition without
            a hand-tuned `minHeight`. The 0-computer and N-radio states may grow
            taller — that's expected; the jump we cared about was the initial
            detection swap, which the skeletons absorb.
          */}
          <div className="space-y-3">
            <Label>Where it runs</Label>

            {/* Computer picker. 0 / 1 / N branches keep the most common
                case (1 connected computer) free of radio-button noise. */}
            {!clientsLoaded ? (
              <ComputerCardSkeleton label="Detecting connected computers…" />
            ) : connectedClients.length === 0 ? (
              <ZeroComputerBlock
                command={connectCommand}
                copied={tokenCopyStatus === "copied"}
                onCopy={() => {
                  if (!connectCommand) return;
                  void copyToken(connectCommand);
                }}
              />
            ) : connectedClients.length === 1 ? (
              <SingleComputerCard client={connectedClients[0]} />
            ) : (
              <div className="space-y-2">
                {connectedClients.map((client) => (
                  <OptionCard
                    key={client.id}
                    name="picked-client"
                    checked={pickedClientId === client.id}
                    onSelect={() => setPickedClientId(client.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-body font-medium truncate">{client.hostname ?? client.id}</div>
                      <div className="text-caption text-muted-foreground">{client.os ?? "unknown OS"} · online</div>
                    </div>
                  </OptionCard>
                ))}
              </div>
            )}

            {/* Runtime row. Renders *whenever* a computer is picked OR while
                we're still detecting computers — keeping a stable "Powered
                by" slot below the computer card prevents the second jump
                (skeleton paragraph being replaced by the runtime chip row).
                Only the inner content swaps; the section header and a
                skeleton chip row hold the space. */}
            {(pickedClientId || !clientsLoaded) && (
              <div className="space-y-1.5">
                <div className="text-caption text-muted-foreground">Powered by</div>
                {!pickedClientId || activeCapabilities === null ? (
                  <RuntimeChipsSkeleton />
                ) : okRuntimes.length === 0 ? (
                  <NoOkRuntimeBlock />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {okRuntimes.map((provider) => (
                      <OptionCard
                        key={provider}
                        name="runtime"
                        layout="pill"
                        checked={runtime === provider}
                        onSelect={() => setRuntime(provider)}
                      >
                        <span className="text-body">{runtimeProviderLabel(provider)}</span>
                      </OptionCard>
                    ))}
                  </div>
                )}
              </div>
            )}

            {fieldErrors.clientId && <p className="text-caption text-destructive">{fieldErrors.clientId}</p>}
          </div>

          {fieldErrors._root && (
            <div className="rounded-[var(--radius-panel)] border border-destructive/50 bg-destructive/5 px-3 py-2 text-body text-destructive">
              {fieldErrors._root}
            </div>
          )}

          <DialogFooter>
            <Button type="submit" variant="cta" disabled={!canSubmit}>
              {createMut.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Computer is connected but no runtime is installed" block. Detection is
 * install-only, so the dialog no longer offers an in-product Connect here —
 * it points the user at the computer's setup card to install a runtime. Once
 * a runtime reports `ok` (installed), the parent's 5s caps poll swaps this for
 * the runtime picker and unblocks Create.
 */
function NoOkRuntimeBlock() {
  return (
    <p className="text-caption text-destructive">
      No runtime installed on this computer. Upgrade First Tree for bundled Kimi Code, or install Claude Code, Codex, or
      Cursor — open this computer&apos;s setup card in Settings → Computers, then come back.
    </p>
  );
}

/**
 * Empty-state block for "0 computers connected." Shows the real
 * channel-aware install/login command (with a one-shot connect
 * token generated by the parent) so the user can actually recover from
 * this state without leaving the dialog.
 */
function ZeroComputerBlock({
  command,
  copied,
  onCopy,
}: {
  command: string | null;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="space-y-2">
      {/* Regular weight + a slightly lighter tone (`--fg-2`) so the section
          label "Where it runs" stays the heading and this reads as status,
          not a competing second title. */}
      <div className="text-body text-fg-2">No computer connected yet.</div>
      <div className="text-caption text-muted-foreground">
        Run this on the machine where this agent should live. We&apos;ll pick it up here automatically.
      </div>
      <div className="flex items-stretch gap-2 min-w-0">
        <pre
          className="m-0 flex-1 min-w-0 overflow-x-auto whitespace-pre-wrap break-words font-mono text-caption px-2 py-1.5 bg-muted/50 border border-border rounded-[var(--radius-input)]"
          title={command ?? undefined}
          style={{ overflowWrap: "anywhere" }}
        >
          <code>{command ?? "Generating token…"}</code>
        </pre>
        <Button type="button" variant="outline" size="sm" onClick={onCopy} disabled={!command} className="shrink-0">
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/**
 * Single-computer confirmation. Used in the common case where the user only
 * has one computer connected — non-interactive, so it's just a plain two-line
 * readout of where the agent will live (no card / border / fill; the framed
 * box was over-packaging for read-only content).
 *
 * Layout note: mirrors `ComputerCardSkeleton`'s two-line shape so the
 * "Where it runs" block holds a stable height across the detect → loaded
 * swap. If you change this readout's line count, mirror it in the skeleton.
 */
function SingleComputerCard({ client }: { client: HubClient | undefined }) {
  if (!client) return null;
  return (
    <div>
      <div className="text-body font-medium truncate">{client.hostname ?? client.id}</div>
      <div className="text-caption text-muted-foreground">{client.os ?? "unknown OS"} · online</div>
    </div>
  );
}

/**
 * Loading placeholder that mirrors `SingleComputerCard`'s two-line readout
 * (same plain, borderless shape) so the surrounding form keeps a stable
 * height while `listClients` is in flight. The previous placeholder was a
 * single-line paragraph, which is what made the dialog visibly jump when the
 * real readout replaced it.
 */
function ComputerCardSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" aria-label={label}>
      <div className="text-body font-medium" style={{ color: "var(--fg-3)" }}>
        {label}
      </div>
      <div className="text-caption text-muted-foreground">Looking for a machine running the First Tree daemon…</div>
    </div>
  );
}

/**
 * Loading placeholder for the runtime chip row. A single greyed chip-shaped
 * box reserves the height the real chips will occupy. Pairs with
 * `ComputerCardSkeleton` so the whole "Where it runs" block reaches its
 * steady-state height on first paint — no second jump when capabilities
 * resolve.
 */
function RuntimeChipsSkeleton() {
  return (
    <div className="flex flex-wrap gap-2" role="status" aria-live="polite" aria-label="Detecting installed runtimes">
      <span
        className="inline-flex items-center rounded-[var(--radius-panel)] border border-border bg-muted/30 px-3 py-1.5 text-body"
        style={{ color: "var(--fg-4)" }}
      >
        Detecting installed runtimes…
      </span>
    </div>
  );
}
