/**
 * Symbol- and type-aware ownership audit for the Client Runtime authority split.
 *
 * Syntax-only SourceFile walks, identifier-suffix regexes, and shallow TypeNode
 * name checks are not sufficient: compile-valid aliases, computed keys, and
 * type-alias return types can hide live ledger custody. This module always
 * builds findings from a TypeScript Program + TypeChecker.
 */
import { basename, join } from "node:path";
import ts from "typescript";

export const HOST_FILE = "session-runtime.ts";

export const AUTHORITY_FILES = [
  "route-teardown-authority.ts",
  "reset-replay-authority.ts",
  "slot-scheduler-authority.ts",
  "session-projection-authority.ts",
] as const;

export const AUTHORITY_CLASS_NAMES = [
  "RouteTeardownAuthority",
  "ResetReplayAuthority",
  "SlotSchedulerAuthority",
  "SessionProjectionAuthority",
] as const;

export const MIGRATED_SESSION_FIELDS = [
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

/** Original old→new authority map. Explicit contract; name heuristics must not replace this. */
export const EXPECTED_LEDGERS: Record<(typeof AUTHORITY_CLASS_NAMES)[number], readonly string[]> = {
  RouteTeardownAuthority: [
    "pendingTeardowns",
    "quarantinedSessions",
    "routeProducers",
    "retiredHandlers",
    "handlerShutdowns",
    "routeBySession",
  ],
  ResetReplayAuthority: [
    "terminatingChats",
    "terminatePersistFailures",
    "awaitingResetFenceRelease",
    "resetGenerations",
    "postResetFenceRecoveryScheduled",
    "replayFence",
    "replayFenceUnavailable",
    "provenSettledFences",
    "replayFenceRetryTimers",
    "postFenceRecoveryDebt",
    "postFenceRecoveryTimers",
    "postFenceRecoveryInFlight",
  ],
  SlotSchedulerAuthority: [
    "retryFlights",
    "admissionGenerations",
    "pendingQueue",
    "activeCount",
    "idleTimer",
    "slotBySession",
  ],
  SessionProjectionAuthority: [
    "sessions",
    "evictedMappings",
    "currentTrigger",
    "registry",
    "lastReportedStates",
    "sessionRuntimeStates",
    "runtimeProofRecoveryChats",
    "lastReportedRuntimeState",
    "lastTreeResolveAttemptAt",
    "runtimeReaffirmTimer",
  ],
};

const AUTHORITY_CLASS_NAME_SET = new Set<string>(AUTHORITY_CLASS_NAMES);
const MIGRATED_FIELD_SET = new Set<string>(MIGRATED_SESSION_FIELDS);
const ALL_LEDGER_NAMES = new Set<string>(Object.values(EXPECTED_LEDGERS).flat());

const ARRAY_MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "copyWithin", "fill"]);

const CONTAINER_MUTATORS = new Set([...ARRAY_MUTATORS, "clear", "set", "delete", "add"]);

const FORBIDDEN_ESCAPE_NAMES = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ReadonlyMap",
  "ReadonlySet",
  "ReplayFenceStore",
  "SlotState",
  "RouteState",
  "SessionRegistry",
  "QuarantinedSession",
  "Timeout",
]);

const MUTABLE_STORAGE_NAMES = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array"]);

const ASSIGNMENT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

export type AuditViolation = {
  kind: string;
  file: string;
  className?: string;
  member?: string;
  detail: string;
};

export type AuditOptions = {
  hostFileNames?: readonly string[];
  requireCompleteInventory?: boolean;
};

export function formatViolation(violation: AuditViolation): string {
  const loc = [violation.file, violation.className, violation.member].filter(Boolean).join("/");
  return `${violation.kind}: ${loc} — ${violation.detail}`;
}

export function createClientBoundaryProgram(clientRoot: string): ts.Program {
  const configPath = ts.findConfigFile(clientRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`client tsconfig.json not found under ${clientRoot}`);
  }
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, clientRoot, { noEmit: true }, configPath);
  return ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
}

export function createInMemoryProgram(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts"],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
  };
  const defaultHost = ts.createCompilerHost(options, true);
  const readVirtual = (fileName: string): string | undefined => files[basename(fileName)] ?? files[fileName];
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (fileName) => readVirtual(fileName) !== undefined || defaultHost.fileExists(fileName),
    readFile: (fileName) => readVirtual(fileName) ?? defaultHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
      const text = readVirtual(fileName);
      if (text !== undefined) {
        return ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
      }
      return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreate);
    },
    writeFile: () => undefined,
  };
  return ts.createProgram({
    rootNames: Object.keys(files).map((name) => join(defaultHost.getCurrentDirectory(), basename(name))),
    options,
    host,
  });
}

export function fixtureDiagnostics(program: ts.Program, virtualFiles: Record<string, string>): string[] {
  const names = new Set(Object.keys(virtualFiles).map((name) => basename(name)));
  return ts.getPreEmitDiagnostics(program).flatMap((diagnostic) => {
    const file = diagnostic.file;
    if (!file || !names.has(basename(file.fileName))) return [];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    const loc = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return [`${basename(file.fileName)}:${loc.line + 1}:${loc.character + 1} ${message}`];
  });
}

export function auditAuthorityBoundary(program: ts.Program, options: AuditOptions = {}): AuditViolation[] {
  const checker = program.getTypeChecker();
  const requireCompleteInventory = options.requireCompleteInventory ?? true;
  const hostNames = new Set((options.hostFileNames ?? [HOST_FILE]).map((name) => basename(name)));
  const violations: AuditViolation[] = [];

  const authorityClasses = new Map<string, { source: ts.SourceFile; cls: ts.ClassDeclaration }>();
  let hostSource: ts.SourceFile | undefined;

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    if (hostNames.has(basename(source.fileName))) hostSource = source;
    for (const stmt of source.statements) {
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
      if (AUTHORITY_CLASS_NAME_SET.has(stmt.name.text)) {
        authorityClasses.set(stmt.name.text, { source, cls: stmt });
      }
    }
  }

  if (requireCompleteInventory) {
    if (!hostSource) {
      violations.push({
        kind: "host-missing",
        file: HOST_FILE,
        detail: "SessionRuntime host source is not in the Program",
      });
    }
    for (const className of AUTHORITY_CLASS_NAMES) {
      if (!authorityClasses.has(className)) {
        violations.push({
          kind: "authority-class-missing",
          file: `${className}.ts`,
          className,
          detail: "expected authority class is not in the Program",
        });
      }
    }
  }

  for (const className of AUTHORITY_CLASS_NAMES) {
    const found = authorityClasses.get(className);
    if (!found) continue;
    auditLedgers(found.source, found.cls, className, checker, requireCompleteInventory, violations);
    auditPublicReturns(found.source, found.cls, className, checker, violations);
  }

  if (hostSource) {
    auditHostSessionEntry(hostSource, checker, violations);
    auditHostWrites(hostSource, checker, violations);
    auditHostLedgerAccess(hostSource, checker, violations);
  }

  return violations;
}

function fileLabel(source: ts.SourceFile): string {
  return basename(source.fileName);
}

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (current.kind === ts.SyntaxKind.TypeAssertionExpression) {
      current = (current as ts.TypeAssertion).expression;
      continue;
    }
    break;
  }
  return current;
}

function staticName(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  const current = unwrap(node);
  if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) return current.text;
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current) || ts.isNumericLiteral(current)) {
    return current.text;
  }
  if (ts.isComputedPropertyName(current)) return staticName(current.expression);
  return undefined;
}

function isPrivateMember(member: ts.ClassElement | ts.ParameterDeclaration): boolean {
  if (
    (ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) &&
    member.name &&
    ts.isPrivateIdentifier(member.name)
  ) {
    return true;
  }
  if (!ts.canHaveModifiers(member)) return false;
  return Boolean(ts.getModifiers(member)?.some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword));
}

function isPublicSurface(member: ts.ClassElement): boolean {
  if (!ts.canHaveModifiers(member)) return true;
  const mods = ts.getModifiers(member);
  return !mods?.some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword || mod.kind === ts.SyntaxKind.ProtectedKeyword);
}

function classInstanceProperties(
  cls: ts.ClassDeclaration,
): Array<{ name: string; node: ts.ClassElement | ts.ParameterDeclaration }> {
  const properties: Array<{ name: string; node: ts.ClassElement | ts.ParameterDeclaration }> = [];
  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member) && member.name) {
      const name = staticName(member.name);
      if (name) properties.push({ name, node: member });
    }
    if (ts.isConstructorDeclaration(member)) {
      for (const param of member.parameters) {
        if (!param.name || !ts.canHaveModifiers(param)) continue;
        const mods = ts.getModifiers(param);
        if (
          !mods?.some(
            (mod) =>
              mod.kind === ts.SyntaxKind.PrivateKeyword ||
              mod.kind === ts.SyntaxKind.PublicKeyword ||
              mod.kind === ts.SyntaxKind.ProtectedKeyword ||
              mod.kind === ts.SyntaxKind.ReadonlyKeyword,
          )
        ) {
          continue;
        }
        const name = staticName(param.name);
        if (name) properties.push({ name, node: param });
      }
    }
  }
  return properties;
}

function auditLedgers(
  source: ts.SourceFile,
  cls: ts.ClassDeclaration,
  className: (typeof AUTHORITY_CLASS_NAMES)[number],
  checker: ts.TypeChecker,
  requireCompleteInventory: boolean,
  violations: AuditViolation[],
): void {
  const properties = new Map(classInstanceProperties(cls).map((entry) => [entry.name, entry]));
  const expected = EXPECTED_LEDGERS[className];
  for (const name of expected) {
    const found = properties.get(name);
    if (!found) {
      if (requireCompleteInventory) {
        violations.push({
          kind: "ledger-missing",
          file: fileLabel(source),
          className,
          member: name,
          detail: "expected ledger is missing from the owning class",
        });
      }
      continue;
    }
    if (!isPrivateMember(found.node)) {
      violations.push({
        kind: "ledger-not-private",
        file: fileLabel(source),
        className,
        member: name,
        detail: "inventory ledger must be a private class member",
      });
    }
  }

  for (const [name, found] of properties) {
    if (expected.includes(name) || isPrivateMember(found.node)) continue;
    const type = checker.getTypeAtLocation(found.node);
    if (isMutableStorageType(type)) {
      violations.push({
        kind: "unexpected-public-storage",
        file: fileLabel(source),
        className,
        member: name,
        detail: `public member has mutable storage type ${checker.typeToString(type)}`,
      });
    }
  }
}

function auditPublicReturns(
  source: ts.SourceFile,
  cls: ts.ClassDeclaration,
  className: string,
  checker: ts.TypeChecker,
  violations: AuditViolation[],
): void {
  for (const member of cls.members) {
    if (
      !(ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) ||
      !member.name ||
      ts.isPrivateIdentifier(member.name)
    ) {
      continue;
    }
    if (!isPublicSurface(member)) continue;
    const name = staticName(member.name);
    if (!name) continue;
    const signature = checker.getSignatureFromDeclaration(member);
    if (!signature) continue;
    const returnType = checker.getReturnTypeOfSignature(signature);
    const escaped = forbiddenEscapeName(returnType, checker);
    if (!escaped) continue;
    violations.push({
      kind: "public-return-forbidden-type",
      file: fileLabel(source),
      className,
      member: name,
      detail: `public ${ts.isGetAccessorDeclaration(member) ? "getter" : "method"} returns ${checker.typeToString(returnType, member, ts.TypeFormatFlags.NoTruncation)} (escape: ${escaped})`,
    });
  }
}

function auditHostSessionEntry(source: ts.SourceFile, checker: ts.TypeChecker, violations: AuditViolation[]): void {
  const alias = source.statements.find(
    (stmt): stmt is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(stmt) && stmt.name.text === "SessionEntry",
  );
  if (!alias) {
    violations.push({
      kind: "session-entry-missing",
      file: fileLabel(source),
      member: "SessionEntry",
      detail: "host SessionEntry type alias is missing",
    });
    return;
  }
  const type = checker.getTypeAtLocation(alias.name);
  for (const symbol of type.getProperties()) {
    if (!MIGRATED_FIELD_SET.has(symbol.getName())) continue;
    violations.push({
      kind: "session-entry-migrated-field",
      file: fileLabel(source),
      className: "SessionRuntime",
      member: symbol.getName(),
      detail: "migrated scheduler/route field remains on host SessionEntry",
    });
  }
}

function isInsideAuthorityClass(node: ts.Node): boolean {
  const { className } = enclosingClassAndMember(node);
  return Boolean(className && AUTHORITY_CLASS_NAME_SET.has(className));
}

function auditHostWrites(source: ts.SourceFile, checker: ts.TypeChecker, violations: AuditViolation[]): void {
  const visit = (node: ts.Node): void => {
    if (isInsideAuthorityClass(node)) return;
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (
          ts.isPropertyAssignment(property) ||
          ts.isShorthandPropertyAssignment(property) ||
          ts.isMethodDeclaration(property)
        ) {
          const name = staticName(property.name);
          if (name && MIGRATED_FIELD_SET.has(name)) {
            pushHostWrite(violations, source, node, "object-literal", name, property);
          }
        }
      }
    }

    if (ts.isBinaryExpression(node) && ASSIGNMENT_KINDS.has(node.operatorToken.kind)) {
      const field = resolveMigratedField(node.left, checker);
      if (field) {
        const kind = node.operatorToken.kind === ts.SyntaxKind.EqualsToken ? "assignment" : "compound-assignment";
        pushHostWrite(violations, source, node, kind, field, node);
      }
    }

    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const field = resolveMigratedField(node.operand, checker);
      if (field) pushHostWrite(violations, source, node, "increment", field, node);
    }

    if (ts.isDeleteExpression(node)) {
      const field = resolveMigratedField(node.expression, checker);
      if (field) pushHostWrite(violations, source, node, "delete", field, node);
    }

    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      collectBindingWrites(node.name, source, violations);
    }
    if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
      collectBindingWrites(node.name, source, violations);
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (ARRAY_MUTATORS.has(method)) {
        const receiver = node.expression.expression;
        const field = resolveMigratedField(receiver, checker);
        if (field) {
          const kind = ts.isIdentifier(unwrap(receiver)) ? "aliased-array-mutator" : "array-mutator";
          pushHostWrite(violations, source, node, kind, field, node);
        }
      }
      if (
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Object" &&
        method === "assign"
      ) {
        const target = node.arguments[0];
        if (target) {
          const field = resolveMigratedField(target, checker);
          if (field) {
            pushHostWrite(violations, source, node, "object-assign", field, node);
          } else if (typeMentionsSessionEntry(checker.getTypeAtLocation(target), checker)) {
            pushHostWrite(violations, source, node, "object-assign", "SessionEntry", node);
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
}

function auditHostLedgerAccess(source: ts.SourceFile, checker: ts.TypeChecker, violations: AuditViolation[]): void {
  const visit = (node: ts.Node): void => {
    if (isInsideAuthorityClass(node)) return;
    if (ts.isPropertyAccessExpression(node) && ALL_LEDGER_NAMES.has(node.name.text)) {
      if (authorityReceiverName(node.expression, checker)) {
        pushHostWrite(violations, source, node, "host-ledger-access", node.name.text, node);
      }
    }

    if (ts.isElementAccessExpression(node)) {
      const receiverName = authorityReceiverName(node.expression, checker);
      if (receiverName) {
        const key = resolveConstString(node.argumentExpression, checker);
        if (key.kind === "literal" && ALL_LEDGER_NAMES.has(key.value)) {
          pushHostWrite(violations, source, node, "computed-ledger-access", key.value, node);
        } else if (key.kind !== "literal") {
          pushHostWrite(violations, source, node, "unresolved-dynamic-bracket", receiverName, node);
        }
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      CONTAINER_MUTATORS.has(node.expression.name.text)
    ) {
      const receiver = node.expression.expression;
      const ledger = resolveLedgerAccess(receiver, checker);
      if (ledger) {
        const viaComputed = elementAccessIsComputed(receiver);
        const kind = viaComputed ? "computed-ledger-mutation" : "host-ledger-mutation";
        pushHostWrite(violations, source, node, kind, ledger, node);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
}

function collectBindingWrites(
  pattern: ts.ObjectBindingPattern,
  source: ts.SourceFile,
  violations: AuditViolation[],
): void {
  for (const element of pattern.elements) {
    const name = staticName(element.propertyName ?? element.name);
    if (name && MIGRATED_FIELD_SET.has(name)) {
      pushHostWrite(violations, source, element, "destructure", name, element);
    }
    if (ts.isObjectBindingPattern(element.name)) collectBindingWrites(element.name, source, violations);
  }
}

function pushHostWrite(
  violations: AuditViolation[],
  source: ts.SourceFile,
  node: ts.Node,
  kind: string,
  member: string,
  reported: ts.Node,
): void {
  const { className, member: enclosing } = enclosingClassAndMember(node);
  violations.push({
    kind,
    file: fileLabel(source),
    className,
    member: member || enclosing,
    detail: `${enclosing ?? "<module>"}: ${reported.getText(source).replace(/\s+/g, " ").slice(0, 180)}`,
  });
}

function enclosingClassAndMember(node: ts.Node): { className?: string; member?: string } {
  let className: string | undefined;
  let member: string | undefined;
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      !member &&
      (ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current))
    ) {
      member = current.name ? staticName(current.name) : undefined;
    }
    if (!member && ts.isConstructorDeclaration(current)) member = "constructor";
    if (ts.isClassDeclaration(current) && current.name) className = current.name.text;
    current = current.parent;
  }
  return { className, member };
}

function resolveConstString(
  node: ts.Expression | undefined,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): { kind: "literal"; value: string } | { kind: "dynamic" } {
  if (!node) return { kind: "dynamic" };
  const current = unwrap(node);
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return { kind: "literal", value: current.text };
  }
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || seen.has(symbol)) return { kind: "dynamic" };
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return resolveConstString(declaration.initializer, checker, seen);
      }
      if (ts.isBindingElement(declaration)) {
        const name = staticName(declaration.propertyName ?? declaration.name);
        if (name) return { kind: "literal", value: name };
      }
    }
    const type = checker.getTypeAtLocation(current);
    if (type.isStringLiteral()) return { kind: "literal", value: type.value };
    return { kind: "dynamic" };
  }
  return { kind: "dynamic" };
}

function followInitializer(node: ts.Node, checker: ts.TypeChecker, seen: Set<ts.Symbol>): ts.Node {
  let current = unwrap(node);
  while (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || seen.has(symbol)) break;
    seen.add(symbol);
    let next: ts.Node | undefined;
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        next = unwrap(declaration.initializer);
        break;
      }
    }
    if (!next) break;
    current = next;
  }
  return current;
}

function memberName(node: ts.Node): string | undefined {
  const current = unwrap(node);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current)) {
    const key = current.argumentExpression;
    if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) return key.text;
  }
  return undefined;
}

function resolveMigratedField(node: ts.Node, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): string | undefined {
  const current = unwrap(node);
  const direct = memberName(current);
  if (direct && MIGRATED_FIELD_SET.has(direct)) return direct;

  if (ts.isElementAccessExpression(current)) {
    const key = resolveConstString(current.argumentExpression, checker);
    if (key.kind === "literal" && MIGRATED_FIELD_SET.has(key.value)) return key.value;
  }

  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const resolved = resolveMigratedField(declaration.initializer, checker, seen);
        if (resolved) return resolved;
      }
      if (ts.isBindingElement(declaration)) {
        const property = staticName(declaration.propertyName ?? declaration.name);
        if (property && MIGRATED_FIELD_SET.has(property)) return property;
      }
    }
  }
  return undefined;
}

function resolveLedgerAccess(node: ts.Node, checker: ts.TypeChecker, seen = new Set<ts.Symbol>()): string | undefined {
  const current = followInitializer(node, checker, seen);
  if (ts.isPropertyAccessExpression(current) && ALL_LEDGER_NAMES.has(current.name.text)) {
    if (authorityReceiverName(current.expression, checker)) return current.name.text;
  }
  if (ts.isElementAccessExpression(current)) {
    if (!authorityReceiverName(current.expression, checker)) return undefined;
    const key = resolveConstString(current.argumentExpression, checker);
    if (key.kind === "literal" && ALL_LEDGER_NAMES.has(key.value)) return key.value;
  }
  if (ts.isIdentifier(unwrap(node))) {
    const symbol = checker.getSymbolAtLocation(unwrap(node));
    if (!symbol || seen.has(symbol)) return undefined;
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const resolved = resolveLedgerAccess(declaration.initializer, checker, new Set(seen));
        if (resolved) return resolved;
      }
    }
  }
  return undefined;
}

function elementAccessIsComputed(node: ts.Node): boolean {
  const current = unwrap(node);
  if (ts.isIdentifier(current)) {
    // Alias of a computed access: inspect initializer via parent walk in resolveLedgerAccess.
    return true;
  }
  if (!ts.isElementAccessExpression(current)) return false;
  const arg = unwrap(current.argumentExpression);
  return !ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg);
}

function authorityReceiverName(node: ts.Node, checker: ts.TypeChecker): string | undefined {
  const current = followInitializer(node, checker, new Set());
  const type = checker.getTypeAtLocation(current);
  return authorityNameFromType(type);
}

function authorityNameFromType(type: ts.Type): string | undefined {
  if (type.isUnion() || type.isIntersection()) {
    for (const part of type.types) {
      const name = authorityNameFromType(part);
      if (name) return name;
    }
    return undefined;
  }
  const names = [type.symbol?.getName(), type.aliasSymbol?.getName()].filter((name): name is string => Boolean(name));
  return names.find((name) => AUTHORITY_CLASS_NAME_SET.has(name));
}

function typeMentionsSessionEntry(type: ts.Type, checker: ts.TypeChecker): boolean {
  const names = new Set<string>();
  collectTypeNames(type, checker, new Set(), names);
  return names.has("SessionEntry");
}

function isMutableStorageType(type: ts.Type): boolean {
  const names = new Set<string>();
  collectImmediateTypeNames(type, names);
  for (const name of names) {
    if (MUTABLE_STORAGE_NAMES.has(name)) return true;
  }
  return false;
}

function collectImmediateTypeNames(type: ts.Type, out: Set<string>): void {
  if (type.isUnion() || type.isIntersection()) {
    for (const part of type.types) {
      if (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) continue;
      collectImmediateTypeNames(part, out);
    }
    return;
  }
  if (type.aliasSymbol) out.add(type.aliasSymbol.getName());
  const symbol = type.getSymbol();
  if (symbol) out.add(symbol.getName());
}

function forbiddenEscapeName(type: ts.Type, checker: ts.TypeChecker): string | undefined {
  const names = new Set<string>();
  collectTypeNames(type, checker, new Set(), names);
  for (const name of names) {
    if (FORBIDDEN_ESCAPE_NAMES.has(name)) return name;
  }
  return undefined;
}

function collectTypeNames(type: ts.Type, checker: ts.TypeChecker, seen: Set<ts.Type>, out: Set<string>): void {
  if (seen.has(type)) return;
  seen.add(type);

  if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void | ts.TypeFlags.Never)) return;

  if (type.isUnion() || type.isIntersection()) {
    for (const part of type.types) collectTypeNames(part, checker, seen, out);
    return;
  }

  if (type.aliasSymbol) {
    out.add(type.aliasSymbol.getName());
    for (const declaration of type.aliasSymbol.getDeclarations() ?? []) {
      if (ts.isTypeAliasDeclaration(declaration) && declaration.type) {
        collectTypeNames(checker.getTypeFromTypeNode(declaration.type), checker, seen, out);
      }
    }
    for (const arg of type.aliasTypeArguments ?? []) {
      collectTypeNames(arg, checker, seen, out);
    }
  }

  const symbol = type.getSymbol();
  if (symbol) out.add(symbol.getName());

  const typeArgs = getTypeArguments(type, checker);
  for (const arg of typeArgs) collectTypeNames(arg, checker, seen, out);
}

function getTypeArguments(type: ts.Type, checker: ts.TypeChecker): readonly ts.Type[] {
  const aliasArgs = type.aliasTypeArguments;
  if (aliasArgs?.length) return aliasArgs;
  try {
    const args = checker.getTypeArguments(type as ts.TypeReference);
    if (args?.length) return args;
  } catch {
    // Non-type-references throw or return empty; ignore.
  }
  return [];
}
