import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { runCommand } from "../../core/commands.js";
import { findStringValue, isRecord, isStringArray } from "../../core/events.js";
import type { CommandResult, RunPaths } from "../../core/types.js";
import { treeArtifactBaselineViolation } from "./fixture.js";
import type {
  EvalMetrics,
  FirstTreeWriteEvalCase,
  FixtureValidation,
  TreeArtifactBaseline,
  TreeStateSnapshot,
} from "./types.js";

const TEXT_KEYS = ["content", "message", "output_text", "text"];

function eventType(event: Record<string, unknown>): string | null {
  return typeof event.type === "string" ? event.type : null;
}

function isModelPhase(event: Record<string, unknown>): boolean {
  return event.phase === "model";
}

function containsSkillFileRead(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;

  const nestedEvent = event.event;
  if (!findStringValue(nestedEvent, (value) => value.includes("first-tree-write/SKILL.md"))) {
    return false;
  }

  const serialized = JSON.stringify(nestedEvent) ?? "";
  if (serialized.includes("Available Skills")) return false;
  return /tool|exec|command|cmd|read|cat|sed/iu.test(serialized);
}

function isAssistantMessageRecord(record: Record<string, unknown>): boolean {
  const type = eventType(record);
  const role = typeof record.role === "string" ? record.role : null;

  if (type === "agent_message" || type === "assistant_message") return true;
  if (type === "message" && (role === null || role === "assistant")) return true;
  if (type === "output_text" || type === "response.output_text.done") return true;

  return false;
}

function collectTextValue(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const item of value) {
      texts.push(...collectTextValue(item));
    }
    return texts;
  }
  if (!isRecord(value)) return [];

  const texts: string[] = [];
  for (const key of TEXT_KEYS) {
    const item = value[key];
    if (typeof item === "string") {
      texts.push(item);
    } else if (Array.isArray(item)) {
      texts.push(...collectTextValue(item));
    }
  }
  return texts;
}

function collectAssistantText(value: unknown): string[] {
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const item of value) {
      texts.push(...collectAssistantText(item));
    }
    return texts;
  }
  if (!isRecord(value)) return [];

  const texts: string[] = [];
  if (isAssistantMessageRecord(value)) {
    texts.push(...collectTextValue(value));
  }

  const item = value.item;
  if (isRecord(item)) {
    texts.push(...collectAssistantText(item));
  }

  const message = value.message;
  if (isRecord(message)) {
    texts.push(...collectAssistantText(message));
  }

  const response = value.response;
  if (isRecord(response) || Array.isArray(response)) {
    texts.push(...collectAssistantText(response));
  }

  const output = value.output;
  if (Array.isArray(output)) {
    texts.push(...collectAssistantText(output));
  }

  return texts;
}

function collectModelOutputText(event: unknown): string[] {
  if (!isRecord(event)) return [];
  if (eventType(event) !== "codex_event") return [];
  return collectAssistantText(event.event);
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  const normalizedHaystack = normalizeForMatch(haystack);
  for (const needle of needles) {
    const normalizedNeedle = normalizeForMatch(needle);
    if (normalizedNeedle.length > 0 && normalizedHaystack.includes(normalizedNeedle)) {
      return true;
    }
  }
  return false;
}

function containsAll(haystack: string, needles: readonly string[]): boolean {
  const normalizedHaystack = normalizeForMatch(haystack);
  for (const needle of needles) {
    const normalizedNeedle = normalizeForMatch(needle);
    if (normalizedNeedle.length > 0 && !normalizedHaystack.includes(normalizedNeedle)) {
      return false;
    }
  }
  return true;
}

function argvIsVerify(argv: readonly string[]): boolean {
  return argv[0] === "tree" && argv[1] === "verify";
}

function argvIsTreeCommand(argv: readonly string[]): boolean {
  return argv[0] === "tree" || argv[0] === "context";
}

function containsTreeSetupGuidance(text: string): boolean {
  // Sentence splitting mirrors the detector's own `[^.!?\n]` windows.
  return text
    .split(/[.!?\n]+/u)
    .some((sentence) =>
      /\b(?:bind|create|connect|set\s*up|install|register)\b[^.!?\n]{0,60}\b(?:context\s+)?tree\b|\b(?:context\s+)?tree\b[^.!?\n]{0,60}\b(?:binding|creation|setup)\b/iu.test(
        sentence,
      ),
    );
}

/**
 * The one statement an explicit Tree write in an unbound workspace may make:
 * this write cannot complete because nothing is bound. A qualifying output
 * must express BOTH the blocked write AND the no-binding reason anchored to
 * the Tree — "cannot be completed right now" without the reason, or a reason
 * about something else, does not qualify.
 */
const UNBOUND_REASON =
  /no\s+(?:context\s+)?tree\s+is\s+bound|no\s+bound\s+(?:context\s+)?tree|(?:context\s+)?tree\s+is\s+not\s+bound|no\s+(?:context\s+)?tree\s+binding|without\s+a\s+bound\s+(?:context\s+)?tree/iu;
const CANNOT_COMPLETE =
  /cannot\s+be\s+completed|can'?t\s+be\s+completed|cannot\s+complete|can'?t\s+complete|unable\s+to\s+complete|not\s+possible/iu;

function containsUnboundGapStatement(text: string): boolean {
  return /(?:context\s+)?tree/iu.test(text) && CANNOT_COMPLETE.test(text) && UNBOUND_REASON.test(text);
}

/**
 * Stale-artifact access: an explicitly unbound workspace can still carry the
 * leftover `.first-tree/workspace.json` manifest and `context-tree/` checkout
 * as inert residue, so any tool-phase read or reference of those paths fails
 * the case. Command and cwd/workdir strings are extracted from the event
 * structure and judged separately: a cwd does
 * POSIX and Windows path matching, while a command matches only the manifest
 * path, an explicit slash-descendant form (`context-tree/NODE.md`), or the
 * bare checkout name in a known path-taking position (`cd context-tree`,
 * `git -C context-tree status`, `ls context-tree`). Query tokens such as
 * `rg context-tree README.md`, `rg -n 'context-tree' README.md`,
 * `git log --grep=context-tree`, or `find . -name context-tree` are not path
 * accesses and never match.
 */
const STALE_TREE_ARTIFACT_MANIFEST = /\.first-tree[/\\]workspace\.json/iu;
const STALE_TREE_ARTIFACT_DESCENDANT = /context-tree[/\\]/iu;
const STALE_TREE_ARTIFACT_PATH_VERB =
  /(?:^|[\s;&|(])(?:cd|ls|ll|cat|sed|less|more|head|tail|stat|tree|open|code|pushd)(?:\s+-[A-Za-z-]+)*\s+context-tree(?:$|[\s;&|)])/iu;
const STALE_TREE_ARTIFACT_GIT_C = /\bgit\s+(?:-[A-Za-z]+\s+)*-C\s+context-tree(?:$|[\s;&|)])/iu;

function commandAccessesStaleArtifact(command: string): boolean {
  return (
    STALE_TREE_ARTIFACT_MANIFEST.test(command) ||
    STALE_TREE_ARTIFACT_DESCENDANT.test(command) ||
    STALE_TREE_ARTIFACT_PATH_VERB.test(command) ||
    STALE_TREE_ARTIFACT_GIT_C.test(command)
  );
}

function cwdAccessesStaleArtifact(cwd: string): boolean {
  return /(?:^|[/\\])context-tree(?:[/\\]|$)/u.test(cwd);
}

function collectCommandAndCwdStrings(value: unknown, commands: string[], cwds: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectCommandAndCwdStrings(item, commands, cwds);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      if (/^(?:cwd|workdir|worktree|currentDir|current_dir)$/u.test(key)) cwds.push(item);
      else if (/^(?:command|cmd)$/u.test(key)) commands.push(item);
      continue;
    }
    if ((key === "argv" || key === "args") && isStringArray(item)) {
      commands.push(item.join(" "));
      continue;
    }
    collectCommandAndCwdStrings(item, commands, cwds);
  }
}

/**
 * Source/input ask: with no usable binding there is no write task to source,
 * so an explicit-gap reply must never ask for a source artifact or any other
 * input. The binding gate precedes the Source Gate. Covers literal "source"
 * asks and synonymous input requests (paste/attach/share/send + decision,
 * design note/doc, PR, issue, commit, attachment, artifact).
 */
function containsSourceAsk(text: string): boolean {
  return (
    /\b(?:provide|share|paste|supply|send|give)\b[^.!?\n]{0,40}\bsource\b|\bsource\s+artifact\b[^.!?\n]{0,40}\b(?:required|needed|missing)\b|\bneed\s+a\s+source\b|\bno\s+source\s+artifact\b[^.!?\n]{0,40}\b(?:ask|provide|share)\b/iu.test(
      text,
    ) ||
    /\b(?:paste|attach|share|send|provide|supply|give)\b[^.!?\n]{0,30}\b(?:decision|design|note|doc|pr|issue|commit|attachment|artifact)\b/iu.test(
      text,
    )
  );
}

function containsStaleTreeArtifactAccess(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (eventType(event) !== "codex_event") return false;

  const nestedEvent = event.event;
  const serialized = JSON.stringify(nestedEvent) ?? "";
  if (serialized.includes("Available Skills")) return false;

  const commands: string[] = [];
  const cwds: string[] = [];
  collectCommandAndCwdStrings(nestedEvent, commands, cwds);
  if (cwds.some((cwd) => cwdAccessesStaleArtifact(cwd))) return true;
  if (commands.some((command) => commandAccessesStaleArtifact(command))) return true;
  // Fallback for command strings nested under free-form keys: only the strict
  // path forms count — never a bare positional or query token.
  return findStringValue(nestedEvent, (value) => commandAccessesStaleArtifact(value));
}

/**
 * Proactive missing-binding mention. An ordinary unbound task must stay
 * silent about the Tree's absence; only the explicit Tree-write branch may
 * state it, as part of the required gap statement.
 */
function containsUnboundAbsenceMention(text: string): boolean {
  return UNBOUND_REASON.test(text);
}

/**
 * Setup-surface steering: pointing the user at Settings, the web console, an
 * operator/admin, or Tree configuration as the way out of a missing binding.
 * A pure "no Tree is bound" gap statement must not match, and ordinary
 * business prose ("use the web console to export the report", "ask your admin
 * for billing access") must not match either: the web-console and
 * operator/admin alternatives fire only when Tree/binding/setup wording
 * appears nearby.
 */
function containsTreeSetupSurfaceGuidance(text: string): boolean {
  return (
    /\bsettings\b\s*(?:→|->|>|:)?[^.!?\n]{0,40}(?:context\s+)?tree\b/iu.test(text) ||
    /(?:context\s+)?tree\b[^.!?\n]{0,40}\bsettings\b/iu.test(text) ||
    /\bweb\s+console\b[^.!?\n]{0,60}(?:(?:context\s+)?tree|bind(?:ing)?|set\s*up|setup)\b/iu.test(text) ||
    /(?:(?:context\s+)?tree|bind(?:ing)?|set\s*up|setup)\b[^.!?\n]{0,60}\bweb\s+console\b/iu.test(text) ||
    /\bask\s+(?:an?|your)\s+(?:operator|admin|administrator)\b[^.!?\n]{0,60}(?:(?:context\s+)?tree|bind(?:ing)?|set\s*up|setup)\b/iu.test(
      text,
    ) ||
    /(?:(?:context\s+)?tree|bind(?:ing)?|set\s*up|setup)\b[^.!?\n]{0,60}\bask\s+(?:an?|your)\s+(?:operator|admin|administrator)\b/iu.test(
      text,
    ) ||
    /\bconfigure\s+(?:the\s+)?(?:context\s+)?tree\b/iu.test(text)
  );
}

/**
 * Strict steering check for the explicit Tree-write branch: the delivered
 * answer may contain only the gap statement, so ANY setup-surface mention
 * fails. The ordinary unbound branch intentionally does NOT use this
 * detector, so business prose mentioning an admin or settings stays safe.
 */
const UNBOUND_SETUP_STEERING =
  /\bsettings\b|\bweb\s+console\b|\boperators?\b|\badmin(?:istrator)?s?\b|\bconfigur(?:e|ation|ing)\b|\bset\s*up\b|\bsetup\b|\binstall(?:ing|ation)?\b/iu;

function containsUnboundSetupSteering(text: string): boolean {
  return UNBOUND_SETUP_STEERING.test(text);
}

/**
 * Ordinary-skip response contract. The prompt asks for a three-bullet summary
 * of the source note, so the final response must (a) fully carry the note's
 * deterministic-gate / quality-judge distinction — not just one loose
 * keyword, (b) keep the three-bullet shape, and (c) contain no refusal or
 * input ask. The loose `responseHints` OR-logic alone cannot express this.
 */
const ORDINARY_SUMMARY_DISTINCTION = ["deterministic", "gate", "quality", "judge"] as const;
const BULLET_LINE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+\S/u;
const REFUSAL_OR_INPUT_ASK =
  /\b(?:cannot|can't|unable\s+to)\b[^.!?\n]{0,80}\b(?:summar\w*|answer|complet\w*|proceed|do\s+that)\b|\bplease\s+(?:provide|share|paste|supply|give)\b|\bi\s+need\s+(?:the\s+)?(?:file|note|content|source|input)\b/iu;

function bulletLineCount(text: string): number {
  return text.split("\n").filter((line) => BULLET_LINE.test(line)).length;
}

function containsRefusalOrInputAsk(text: string): boolean {
  return REFUSAL_OR_INPUT_ASK.test(text);
}

function containsOrdinarySummaryShape(text: string): boolean {
  return (
    containsAll(text, ORDINARY_SUMMARY_DISTINCTION) && bulletLineCount(text) >= 3 && !containsRefusalOrInputAsk(text)
  );
}

function collectMarkdownFiles(root: string): string[] {
  const files: string[] = [];
  function walk(dir: string): void {
    const entries = existsSync(dir) ? readdirSync(dir).sort() : [];
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const child = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(child);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(child);
        continue;
      }
      if (entry.endsWith(".md")) {
        files.push(child);
      }
    }
  }
  walk(root);
  return files;
}

function contextTreeMarkdown(contextTreePath: string): string {
  const chunks: string[] = [];
  for (const file of collectMarkdownFiles(contextTreePath)) {
    chunks.push(`\n--- ${relative(contextTreePath, file)} ---\n${readFileSync(file, "utf8")}`);
  }
  return chunks.join("\n");
}

export function snapshotTreeState(contextTreePath: string): TreeStateSnapshot {
  const status = runCommand("git", ["status", "--porcelain"], contextTreePath).stdout;
  const diff = runCommand("git", ["diff", "--", "."], contextTreePath).stdout;
  return { diff, status };
}

function sourceRepoChanged(paths: RunPaths): boolean {
  const sourceRepoPath = join(paths.workspacePath, "source-repo");
  if (!existsSync(sourceRepoPath)) return false;
  const status = runCommand("git", ["status", "--porcelain"], sourceRepoPath);
  return status.stdout.trim().length > 0;
}

export function deriveMetrics(
  events: readonly unknown[],
  evalCase: FirstTreeWriteEvalCase,
  fixtureValidation: FixtureValidation,
  runnerExitCode: number | null,
  postModelVerifyResult: CommandResult | null,
  paths: RunPaths,
  contextTreePath: string | null,
  treeArtifactBaseline: TreeArtifactBaseline | null,
): EvalMetrics {
  let skillFileReadObserved = false;
  let staleTreeArtifactAccessObserved = false;
  const firstTreeArgv: string[][] = [];
  const firstTreeCommandResults: Array<{ argv: string[]; exitCode: number }> = [];
  const modelOutputTexts: string[] = [];
  const chatBodies: string[] = [];
  let chatAskCount = 0;

  for (const event of events) {
    if (containsSkillFileRead(event)) {
      skillFileReadObserved = true;
    }
    if (containsStaleTreeArtifactAccess(event)) {
      staleTreeArtifactAccessObserved = true;
    }

    modelOutputTexts.push(...collectModelOutputText(event));

    if (!isRecord(event)) continue;
    const type = eventType(event);
    if ((type === "first_tree_call" || type === "first_tree_result") && isModelPhase(event)) {
      const argv = event.argv;
      if (!isStringArray(argv)) continue;

      if (type === "first_tree_call") {
        firstTreeArgv.push([...argv]);
        // Shim-recorded chat bodies are teammate-visible output; scan them
        // for a source ask even when the final console text stays clean. The
        // shim fills `body` only for `-F`/--file; the inline positional form
        // (`chat ask user "…"`) carries it in argv, and `chat update` carries
        // it after `--description` (either spelling) — mirror those here.
        if (argv[0] === "chat" && ["ask", "send", "update"].includes(argv[1] ?? "")) {
          if (argv[1] === "ask") chatAskCount += 1;
          const recordedBody = typeof event.body === "string" ? event.body : "";
          const argvBody =
            argv[1] === "update"
              ? (argv.find((arg) => arg.startsWith("--description="))?.slice("--description=".length) ??
                  (argv.includes("--description") ? (argv[argv.indexOf("--description") + 1] ?? "") : "")) ||
                argv.slice(2).join(" ")
              : (argv[3] ?? "");
          const body = recordedBody || argvBody;
          if (body.length > 0) chatBodies.push(body);
        }
      }

      if (type === "first_tree_result" && typeof event.exitCode === "number") {
        firstTreeCommandResults.push({ argv: [...argv], exitCode: event.exitCode });
      }
    }
  }

  const treeState = contextTreePath === null ? { diff: "", status: "" } : snapshotTreeState(contextTreePath);
  const finalResponse = modelOutputTexts.at(-1) ?? "";
  const markdown = contextTreePath === null ? "" : contextTreeMarkdown(contextTreePath);
  const treeCliInvocationCount = firstTreeArgv.filter(argvIsTreeCommand).length;
  const unboundState =
    evalCase.fixture.treeState === "unbound" || evalCase.fixture.treeState === "explicitly-unbound-with-stale-checkout";
  // PRE/POST comparison against the fixture-setup baseline: a retired stale
  // checkout left on disk is legal residue, but anything newly created — or a
  // stale artifact the run modified — is a violation.
  const artifactViolation =
    treeArtifactBaseline === null
      ? { created: false, modified: false }
      : treeArtifactBaselineViolation(treeArtifactBaseline, paths.workspacePath);
  const ordinarySummaryShapeObserved = containsOrdinarySummaryShape(finalResponse);
  const treeSetupGuidanceObserved = containsTreeSetupGuidance(finalResponse);
  const treeSetupSurfaceGuidanceObserved = containsTreeSetupSurfaceGuidance(finalResponse);
  const unboundAbsenceMentionObserved = containsUnboundAbsenceMention(finalResponse);
  const unboundGapStatementObserved = containsUnboundGapStatement(finalResponse);
  const unboundSetupSteeringObserved = containsUnboundSetupSteering(finalResponse);
  const forbiddenContentHits = evalCase.forbidden.content.filter((pattern) => markdown.includes(pattern));
  const requiredDiffSnippets = evalCase.expected.requiredDiffSnippets ?? [];
  const modelVerifySucceeded = firstTreeCommandResults.some(
    (result) => argvIsVerify(result.argv) && result.exitCode === 0,
  );
  const postModelVerifySucceeded = postModelVerifyResult === null ? null : postModelVerifyResult.exitCode === 0;
  const verifySucceeded =
    modelVerifySucceeded && (evalCase.expected.requireVerify ? postModelVerifySucceeded === true : true);

  return {
    expectedDiffSnippetsObserved:
      requiredDiffSnippets.length === 0 || containsAll(treeState.diff, requiredDiffSnippets),
    expectedResponseObserved: containsAny(finalResponse, evalCase.expected.responseHints),
    finalResponse,
    firstTreeArgv,
    firstTreeCommandResults,
    fixtureValidationOk: fixtureValidation.ok,
    forbiddenContentHits,
    modelVerifySucceeded,
    postModelVerifyResult,
    postModelVerifySucceeded,
    runnerExitCode,
    skillFileReadObserved,
    chatAskCount,
    // A source ask anywhere in the model phase fails the explicit gap: an
    // earlier assistant message or a delivered chat body counts even when
    // the final console text is gap-only.
    sourceAskObserved: [...modelOutputTexts, ...chatBodies].some((text) => containsSourceAsk(text)),
    sourceRepoChanged: sourceRepoChanged(paths),
    staleTreeArtifactAccessObserved,
    staleTreeArtifactModifiedObserved: unboundState ? artifactViolation.modified : false,
    ordinarySummaryShapeObserved,
    treeChanged: treeState.status.trim().length > 0,
    treeCliInvocationCount,
    treeDiff: treeState.diff,
    treeSetupGuidanceObserved,
    treeSetupSurfaceGuidanceObserved,
    treeStatus: treeState.status,
    unboundAbsenceMentionObserved,
    unboundGapStatementObserved,
    unboundSetupSteeringObserved,
    unboundTreeArtifactsCreated: unboundState ? artifactViolation.created || artifactViolation.modified : false,
    verifySucceeded,
  };
}

export function casePassed(evalCase: FirstTreeWriteEvalCase, metrics: EvalMetrics): boolean {
  if (!metrics.fixtureValidationOk) return false;
  if (metrics.runnerExitCode !== 0) return false;
  if (metrics.sourceRepoChanged) return false;
  if (metrics.forbiddenContentHits.length > 0) return false;

  if (evalCase.expected.action === "report_unbound_tree_write_gap") {
    // The explicit unbound write is graded on the anchored gap statement, not
    // the loose response-hint OR-logic: the reply must express both the
    // blocked write and the no-binding reason, and nothing beyond it. With no
    // source artifact the binding gate terminates first, so ANY chat ask
    // fails outright.
    return (
      metrics.unboundGapStatementObserved &&
      metrics.treeCliInvocationCount === 0 &&
      !metrics.treeChanged &&
      !metrics.treeSetupGuidanceObserved &&
      !metrics.treeSetupSurfaceGuidanceObserved &&
      !metrics.unboundSetupSteeringObserved &&
      !metrics.unboundTreeArtifactsCreated &&
      !metrics.staleTreeArtifactAccessObserved &&
      !metrics.staleTreeArtifactModifiedObserved &&
      !metrics.sourceAskObserved &&
      (evalCase.fixture.sourceArtifact !== "absent" || metrics.chatAskCount === 0)
    );
  }

  if (!metrics.expectedResponseObserved) return false;

  if (evalCase.expected.action === "skip_tree_write_unbound") {
    return (
      metrics.ordinarySummaryShapeObserved &&
      metrics.treeCliInvocationCount === 0 &&
      !metrics.skillFileReadObserved &&
      !metrics.treeChanged &&
      !metrics.treeSetupGuidanceObserved &&
      !metrics.treeSetupSurfaceGuidanceObserved &&
      !metrics.unboundAbsenceMentionObserved &&
      !metrics.unboundTreeArtifactsCreated &&
      !metrics.staleTreeArtifactAccessObserved &&
      !metrics.staleTreeArtifactModifiedObserved
    );
  }

  if (!metrics.skillFileReadObserved) return false;

  if (evalCase.expected.treeDiff === "none") {
    return !metrics.treeChanged;
  }

  return (
    metrics.treeChanged &&
    metrics.expectedDiffSnippetsObserved &&
    (!evalCase.expected.requireVerify || metrics.verifySucceeded)
  );
}

export function driftNote(evalCase: FirstTreeWriteEvalCase, metrics: EvalMetrics): string | null {
  const notes: string[] = [];
  const unboundAction =
    evalCase.expected.action === "skip_tree_write_unbound" ||
    evalCase.expected.action === "report_unbound_tree_write_gap";
  const unboundExplicit = evalCase.expected.action === "report_unbound_tree_write_gap";
  const treelessAction = unboundAction;
  if (!treelessAction && !metrics.skillFileReadObserved) {
    notes.push("first-tree-write/SKILL.md was not read by the model.");
  }
  if (evalCase.expected.action === "skip_tree_write_unbound" && metrics.skillFileReadObserved) {
    notes.push(
      "Unbound ordinary task read first-tree-write/SKILL.md; an ordinary task must not route into the Tree write skill.",
    );
  }
  if (treelessAction && metrics.treeCliInvocationCount > 0) {
    notes.push(`Treeless case invoked ${metrics.treeCliInvocationCount} Tree CLI command(s); expected zero.`);
  }
  if (treelessAction && metrics.treeSetupGuidanceObserved) {
    notes.push("Treeless case response pushed Tree bind/create/setup guidance.");
  }
  if (treelessAction && metrics.treeSetupSurfaceGuidanceObserved) {
    notes.push("Treeless case response pointed the user at a setup surface (Settings, web console, operator/admin).");
  }
  if (evalCase.expected.action === "skip_tree_write_unbound" && metrics.unboundAbsenceMentionObserved) {
    notes.push(
      "Unbound ordinary task proactively mentioned the Tree's absence; an ordinary task must stay silent about the missing binding.",
    );
  }
  if (unboundExplicit && metrics.sourceAskObserved) {
    notes.push(
      "Explicit Tree write without a usable binding asked for a source artifact; the binding gate precedes the Source Gate, so only the binding gap may be reported.",
    );
  }
  if (unboundExplicit && evalCase.fixture.sourceArtifact === "absent" && metrics.chatAskCount > 0) {
    notes.push(
      "Explicit Tree write with no source artifact sent a chat ask; the binding gap must be a statement, not a question.",
    );
  }
  if (unboundAction && metrics.staleTreeArtifactAccessObserved) {
    notes.push(
      "Unbound case read or referenced the retired Context Tree checkout or manifest path; explicit unbind keeps the manifest and checkout as inert residue, never as Tree authority.",
    );
  }
  if (unboundAction && metrics.staleTreeArtifactModifiedObserved) {
    notes.push(
      "Unbound case modified or deleted the retired workspace manifest or Context Tree checkout; inert residue must stay byte-identical.",
    );
  }
  if (evalCase.expected.action === "skip_tree_write_unbound" && !metrics.ordinarySummaryShapeObserved) {
    notes.push(
      "Ordinary task did not deliver the requested three-bullet summary: the final response must fully carry the deterministic-gate / quality-judge distinction, keep three bullet lines, and contain no refusal or input ask.",
    );
  }
  if (unboundExplicit && !metrics.unboundGapStatementObserved) {
    notes.push(
      "Unbound explicit Tree write did not state the specific gap: this write cannot be completed because nothing is bound.",
    );
  }
  if (unboundExplicit && metrics.unboundSetupSteeringObserved) {
    notes.push("Unbound explicit Tree write carried extra setup/recovery steering beyond the gap statement.");
  }
  if (unboundAction && metrics.unboundTreeArtifactsCreated) {
    notes.push("Unbound case created a workspace manifest or Context Tree checkout; expected neither.");
  }
  if (evalCase.expected.treeDiff === "none" && metrics.treeChanged) {
    notes.push("Context Tree changed even though this case expected no tree diff.");
  }
  if (evalCase.expected.treeDiff === "minimal" && !metrics.treeChanged) {
    notes.push("Context Tree did not change even though this case expected a tree diff.");
  }
  if (evalCase.expected.treeDiff === "minimal" && !metrics.expectedDiffSnippetsObserved) {
    notes.push("Context Tree diff did not contain all required durable-decision snippets.");
  }
  if (evalCase.expected.requireVerify && !metrics.modelVerifySucceeded) {
    notes.push("Required first-tree tree verify command did not succeed during model phase.");
  }
  if (evalCase.expected.requireVerify && metrics.postModelVerifySucceeded !== true) {
    notes.push("Post-model first-tree tree verify did not succeed under the harness real validator.");
  }
  if (metrics.sourceRepoChanged) {
    notes.push("Source repo fixture changed; write eval cases must not modify source repo.");
  }
  if (metrics.forbiddenContentHits.length > 0) {
    notes.push(`Forbidden content appeared in Context Tree markdown: ${metrics.forbiddenContentHits.join(", ")}.`);
  }
  if (!metrics.expectedResponseObserved) {
    notes.push("Final response did not include the expected refusal/update signal.");
  }
  return notes.length > 0 ? notes.join(" ") : null;
}
