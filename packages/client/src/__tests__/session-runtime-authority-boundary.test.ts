import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = join(here, "..", "runtime");

const HOST_FILE = "session-runtime.ts";
const AUTHORITY_FILES = [
  "route-teardown-authority.ts",
  "reset-replay-authority.ts",
  "slot-scheduler-authority.ts",
  "session-projection-authority.ts",
] as const;

const MIGRATED_SESSION_FIELDS = [
  "activeSlotHeld",
  "retryAttempt",
  "retryNextAt",
  "retryTimer",
  "lastRetryReason",
  "lastRetryCategory",
  "lastRetryScope",
  "lastRetryRawError",
  "retryHeadMessage",
  "deferredMessages",
  "retryFromEvicted",
  "routeTransitionGeneration",
  "routeTransition",
  "routeInjectReady",
] as const;

const ARRAY_MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "copyWithin", "fill"]);

const FORBIDDEN_PUBLIC_TYPE_NAMES = new Set(["Map", "Set", "ReplayFenceStore", "SlotState", "RouteState", "WeakMap"]);

const AUTHORITY_LEDGER_NAMES = new Set([
  "sessions",
  "evictedMappings",
  "currentTrigger",
  "sessionRuntimeStates",
  "lastReportedStates",
  "runtimeProofRecoveryChats",
  "terminatingChats",
  "terminatePersistFailures",
  "awaitingResetFenceRelease",
  "resetGenerations",
  "replayFence",
  "pendingTeardowns",
  "quarantinedSessions",
  "routeProducers",
  "pendingQueue",
  "admissionGenerations",
  "retryFlights",
  "activeCount",
  "slotBySession",
  "routeBySession",
]);

function parseFile(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function readRuntime(name: string): string {
  return readFileSync(join(runtimeDir, name), "utf8");
}

function typeNameOf(node: ts.TypeNode | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) return node.typeName.text;
  if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isArrayTypeNode(node)) return "Array";
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return typeNameOf(node.type);
  }
  if (ts.isUnionTypeNode(node)) {
    for (const part of node.types) {
      const name = typeNameOf(part);
      if (name && FORBIDDEN_PUBLIC_TYPE_NAMES.has(name)) return name;
    }
  }
  return undefined;
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | ts.LeftHandSideExpression): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isIdentifier(expr)) return expr.text;
  }
  return undefined;
}

function collectSessionEntryPropertyNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(stmt) || stmt.name.text !== "SessionEntry") continue;
    if (!ts.isTypeLiteralNode(stmt.type)) continue;
    for (const member of stmt.type.members) {
      if (!ts.isPropertySignature(member) || !member.name) continue;
      const text = propertyNameText(member.name);
      if (text) names.push(text);
    }
  }
  return names;
}

type WriteHit = { kind: string; name: string; text: string };

function walkWrites(sourceFile: ts.SourceFile, fieldNames: ReadonlySet<string>): WriteHit[] {
  const hits: WriteHit[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const prop of node.properties) {
        if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) {
          const name = prop.name ? propertyNameText(prop.name) : undefined;
          if (name && fieldNames.has(name)) {
            hits.push({ kind: "object-literal", name, text: prop.getText(sourceFile) });
          }
        }
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      collectAssignmentTarget(node.left, "assignment");
    }
    if (ts.isBinaryExpression(node) && isCompoundAssignment(node.operatorToken.kind)) {
      collectAssignmentTarget(node.left, "compound-assignment");
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const operand = node.operand;
      if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
        collectAssignmentTarget(operand, "increment");
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      collectBinding(node.name, "destructure");
    }
    if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
      collectBinding(node.name, "destructure");
    }
    if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        if (fieldNames.has(arg.text)) {
          hits.push({ kind: "bracket-access", name: arg.text, text: node.getText(sourceFile) });
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && fieldNames.has(node.name.text)) {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node && ARRAY_MUTATORS.has(node.name.text)) {
        hits.push({ kind: "array-mutator", name: node.name.text, text: parent.getText(sourceFile) });
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ARRAY_MUTATORS.has(node.expression.name.text)
    ) {
      const recv = node.expression.expression;
      if (ts.isPropertyAccessExpression(recv) && fieldNames.has(recv.name.text)) {
        hits.push({ kind: "array-mutator", name: recv.name.text, text: node.getText(sourceFile) });
      }
      if (ts.isElementAccessExpression(recv)) {
        const arg = recv.argumentExpression;
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && fieldNames.has(arg.text)) {
          hits.push({ kind: "array-mutator", name: arg.text, text: node.getText(sourceFile) });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  const collectAssignmentTarget = (target: ts.Node, kind: string): void => {
    if (ts.isPropertyAccessExpression(target) && fieldNames.has(target.name.text)) {
      hits.push({ kind, name: target.name.text, text: target.parent.getText(sourceFile) });
    }
    if (ts.isElementAccessExpression(target)) {
      const arg = target.argumentExpression;
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && fieldNames.has(arg.text)) {
        hits.push({ kind: `${kind}-bracket`, name: arg.text, text: target.parent.getText(sourceFile) });
      }
    }
    if (ts.isObjectBindingPattern(target)) collectBinding(target, kind);
  };

  const collectBinding = (pattern: ts.ObjectBindingPattern, kind: string): void => {
    for (const element of pattern.elements) {
      const name = propertyNameText(element.propertyName ?? element.name);
      if (name && fieldNames.has(name)) {
        hits.push({ kind, name, text: element.getText(sourceFile) });
      }
      if (ts.isObjectBindingPattern(element.name)) collectBinding(element.name, kind);
    }
  };

  visit(sourceFile);
  return hits;
}

function isCompoundAssignment(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.PlusEqualsToken ||
    kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken ||
    kind === ts.SyntaxKind.SlashEqualsToken ||
    kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.AmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarEqualsToken ||
    kind === ts.SyntaxKind.CaretEqualsToken ||
    kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function classDeclarations(sourceFile: ts.SourceFile): ts.ClassDeclaration[] {
  return sourceFile.statements.filter(ts.isClassDeclaration);
}

function isPrivateMember(member: ts.ClassElement): boolean {
  if (!ts.canHaveModifiers(member)) return false;
  const mods = ts.getModifiers(member);
  return Boolean(mods?.some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword));
}

function ledgerLikeName(name: string): boolean {
  return /(Map|Set|Timer|Timers|Queue|Store|Fence|Flights|Generations|Count)$/.test(name) || name.endsWith("BySession");
}

function publicReturnViolations(sourceFile: ts.SourceFile): string[] {
  const violations: string[] = [];
  for (const cls of classDeclarations(sourceFile)) {
    for (const member of cls.members) {
      if (!ts.isMethodDeclaration(member) || isPrivateMember(member) || !member.name) continue;
      const name = propertyNameText(member.name);
      if (!name) continue;
      const returnType = typeNameOf(member.type);
      if (returnType && FORBIDDEN_PUBLIC_TYPE_NAMES.has(returnType)) {
        violations.push(`${cls.name?.text ?? "?"}.${name} returns ${returnType}`);
      }
      if (member.type && ts.isTypeReferenceNode(member.type)) {
        const text = member.type.getText(sourceFile);
        if (/\bMap\s*</.test(text) || /\bSet\s*</.test(text) || /\bReplayFenceStore\b/.test(text)) {
          violations.push(`${cls.name?.text ?? "?"}.${name} return type ${text}`);
        }
      }
    }
  }
  return violations;
}

function privateLedgerViolations(sourceFile: ts.SourceFile): string[] {
  const violations: string[] = [];
  for (const cls of classDeclarations(sourceFile)) {
    for (const member of cls.members) {
      if (!ts.isPropertyDeclaration(member) || !member.name) continue;
      const name = propertyNameText(member.name);
      if (!name || !ledgerLikeName(name)) continue;
      if (!isPrivateMember(member)) {
        violations.push(`${cls.name?.text ?? "?"}.${name} is not private`);
      }
    }
  }
  return violations;
}

function scanLedgerAccess(sourceFile: ts.SourceFile): WriteHit[] {
  const hits: WriteHit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && AUTHORITY_LEDGER_NAMES.has(node.name.text)) {
      hits.push({ kind: "ledger-access", name: node.name.text, text: node.getText(sourceFile) });
    }
    if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        if (AUTHORITY_LEDGER_NAMES.has(arg.text)) {
          hits.push({ kind: "ledger-bracket", name: arg.text, text: node.getText(sourceFile) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

describe("SessionRuntime authority boundary", () => {
  const hostSource = readRuntime(HOST_FILE);
  const hostFile = parseFile(HOST_FILE, hostSource);
  const migrated = new Set<string>(MIGRATED_SESSION_FIELDS);

  it("keeps migrated scheduler/route fields off the host SessionEntry type", () => {
    const names = collectSessionEntryPropertyNames(hostFile);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => migrated.has(name))).toEqual([]);
  });

  it("does not initialize, assign, increment, destructure, or bracket-write migrated fields in the host", () => {
    expect(walkWrites(hostFile, migrated)).toEqual([]);
  });

  it("does not reach authority ledgers except through intent methods", () => {
    expect(scanLedgerAccess(hostFile)).toEqual([]);
  });

  it("keeps authority ledgers private and public methods from exposing mutable containers", () => {
    const privacy: string[] = [];
    const returns: string[] = [];
    for (const fileName of AUTHORITY_FILES) {
      const source = readRuntime(fileName);
      const parsed = parseFile(fileName, source);
      privacy.push(...privateLedgerViolations(parsed));
      returns.push(...publicReturnViolations(parsed));
    }
    expect(privacy).toEqual([]);
    expect(returns).toEqual([]);
  });

  it("fails the write walker on the bypasses QA demonstrated", () => {
    const probes = parseFile(
      "probes.ts",
      `
      const projection = this.projection;
      projection.sessions.clear();
      this.projection["sessions"].clear();
      const entry = { retryTimer: null, retryAttempt: 0, retryFromEvicted: evicted, deferredMessages: [] };
      record.retryTimer = null;
      alias["retryAttempt"] = 1;
      const { retryHeadMessage } = record;
      entry.deferredMessages.push(msg);
      entry.routeTransitionGeneration++;
      entry["activeSlotHeld"] = true;
      `,
    );
    const hits = walkWrites(probes, migrated);
    const kinds = new Set(hits.map((hit) => hit.kind));
    const names = new Set(hits.map((hit) => hit.name));
    expect(names.has("retryTimer")).toBe(true);
    expect(names.has("retryAttempt")).toBe(true);
    expect(names.has("retryFromEvicted")).toBe(true);
    expect(names.has("retryHeadMessage")).toBe(true);
    expect(names.has("deferredMessages")).toBe(true);
    expect(names.has("routeTransitionGeneration")).toBe(true);
    expect(names.has("activeSlotHeld")).toBe(true);
    expect(kinds.has("object-literal")).toBe(true);
    expect(kinds.has("assignment") || kinds.has("assignment-bracket")).toBe(true);
    expect(kinds.has("bracket-access") || kinds.has("assignment-bracket")).toBe(true);
    expect(kinds.has("destructure")).toBe(true);
    expect(kinds.has("array-mutator")).toBe(true);
    const ledgerHits = scanLedgerAccess(probes);
    expect(ledgerHits.some((hit) => hit.name === "sessions")).toBe(true);
  });
});
