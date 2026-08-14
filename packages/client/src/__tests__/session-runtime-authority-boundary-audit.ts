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

const DETACH_METHODS = new Set([
  "slice",
  "map",
  "filter",
  "flatMap",
  "concat",
  "toSorted",
  "toReversed",
  "toSpliced",
  "splice",
]);

const SLOT_MUTABLE_FIELDS = new Set(["deferredMessages", "retryTimer", "retryHeadMessage", "retryFromEvicted"]);

const SESSION_ENTRY_TYPE_NAMES = new Set([
  "TSession",
  "SessionEntry",
  "SlotSchedulerSessionEntry",
  "RouteTeardownHostEntry",
  "SessionProjectionSessionFields",
]);

/** Newly added public methods are not implicitly trusted; these names keep accepted live observations. */
type AcceptedReturnContract = "session-iterator" | "replay-fence-writer" | "route-producer-settle";

const ACCEPTED_RETURN_CONTRACTS: Record<string, Partial<Record<string, AcceptedReturnContract>>> = {
  SessionProjectionAuthority: {
    sessionsValues: "session-iterator",
    sessionsEntries: "session-iterator",
  },
  ResetReplayAuthority: {
    createHandlerReplayFenceWriter: "replay-fence-writer",
  },
  RouteTeardownAuthority: {
    registerRouteProducer: "route-producer-settle",
  },
};

const READONLY_CONTAINER_METHODS = new Set([
  "has",
  "get",
  "keys",
  "values",
  "entries",
  "forEach",
  "includes",
  "indexOf",
  "lastIndexOf",
  "at",
  "slice",
  "map",
  "filter",
  "flatMap",
  "find",
  "findIndex",
  "some",
  "every",
  "reduce",
  "reduceRight",
  "concat",
  "join",
  "flat",
  "toSorted",
  "toReversed",
  "toSpliced",
  "toString",
  "toLocaleString",
  "valueOf",
  "with",
]);

/** Map.get / iteration values that are promises, primitives, or host SessionEntry — not live inner containers. */
const SAFE_VALUE_LEDGERS = new Set([
  "sessions",
  "admissionGenerations",
  "lastReportedStates",
  "sessionRuntimeStates",
  "currentTrigger",
  "terminatingChats",
  "retryFlights",
  "postFenceRecoveryInFlight",
]);

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

export function createOverlaidClientProgram(clientRoot: string, overlays: Record<string, string>): ts.Program {
  const configPath = ts.findConfigFile(clientRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`client tsconfig.json not found under ${clientRoot}`);
  }
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, clientRoot, { noEmit: true }, configPath);
  const options = { ...parsed.options, noEmit: true };
  const defaultHost = ts.createCompilerHost(options, true);
  const overlayByBase = new Map(Object.entries(overlays).map(([name, text]) => [basename(name), text]));
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (fileName) => overlayByBase.has(basename(fileName)) || defaultHost.fileExists(fileName),
    readFile: (fileName) => overlayByBase.get(basename(fileName)) ?? defaultHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion, onError, shouldCreate) => {
      const overlay = overlayByBase.get(basename(fileName));
      if (overlay !== undefined) {
        return ts.createSourceFile(fileName, overlay, languageVersion, true, ts.ScriptKind.TS);
      }
      return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreate);
    },
  };
  return ts.createProgram(parsed.fileNames, options, host);
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

function isPublicSurface(member: ts.ClassElement | ts.ParameterDeclaration): boolean {
  if (!ts.canHaveModifiers(member)) return true;
  const mods = ts.getModifiers(member);
  return !mods?.some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword || mod.kind === ts.SyntaxKind.ProtectedKeyword);
}

function isParameterProperty(param: ts.ParameterDeclaration): boolean {
  if (!ts.canHaveModifiers(param)) return false;
  const mods = ts.getModifiers(param);
  return Boolean(
    mods?.some(
      (mod) =>
        mod.kind === ts.SyntaxKind.PrivateKeyword ||
        mod.kind === ts.SyntaxKind.PublicKeyword ||
        mod.kind === ts.SyntaxKind.ProtectedKeyword ||
        mod.kind === ts.SyntaxKind.ReadonlyKeyword,
    ),
  );
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

function auditPublicPropertyLike(
  source: ts.SourceFile,
  className: string,
  checker: ts.TypeChecker,
  analysis: ClassProvenanceAnalysis,
  member: ts.PropertyDeclaration | ts.ParameterDeclaration,
  violations: AuditViolation[],
): void {
  if (!member.name) return;
  const name = staticName(member.name);
  if (!name) return;
  const type = checker.getTypeAtLocation(member);
  const escaped = forbiddenEscapeName(type, checker);
  if (escaped) {
    violations.push({
      kind: "public-return-forbidden-type",
      file: fileLabel(source),
      className,
      member: name,
      detail: `public property has type ${checker.typeToString(type, member, ts.TypeFormatFlags.NoTruncation)} (escape: ${escaped})`,
    });
  }
  for (const hit of analysis.publicEscapeFindings(member, name)) {
    violations.push(hit);
  }
}

function auditPublicReturns(
  source: ts.SourceFile,
  cls: ts.ClassDeclaration,
  className: string,
  checker: ts.TypeChecker,
  violations: AuditViolation[],
): void {
  const analysis = new ClassProvenanceAnalysis(source, cls, className, checker);
  const auditedNames = new Set<string>();
  for (const member of cls.members) {
    if (!member.name || ts.isPrivateIdentifier(member.name)) continue;
    if (!isPublicSurface(member)) continue;
    const name = staticName(member.name);
    if (!name) continue;

    if (ts.isPropertyDeclaration(member)) {
      auditedNames.add(name);
      auditPublicPropertyLike(source, className, checker, analysis, member, violations);
      continue;
    }

    if (!(ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member))) continue;
    const signature = checker.getSignatureFromDeclaration(member);
    if (signature) {
      const returnType = checker.getReturnTypeOfSignature(signature);
      const escaped = forbiddenEscapeName(returnType, checker);
      if (escaped) {
        violations.push({
          kind: "public-return-forbidden-type",
          file: fileLabel(source),
          className,
          member: name,
          detail: `public ${ts.isGetAccessorDeclaration(member) ? "getter" : "method"} returns ${checker.typeToString(returnType, member, ts.TypeFormatFlags.NoTruncation)} (escape: ${escaped})`,
        });
      }
    }
    for (const hit of analysis.publicEscapeFindings(member, name)) {
      violations.push(hit);
    }
  }

  for (const member of cls.members) {
    if (!ts.isConstructorDeclaration(member)) continue;
    for (const param of member.parameters) {
      if (!isParameterProperty(param) || !isPublicSurface(param) || !param.name) continue;
      const name = staticName(param.name);
      if (!name || auditedNames.has(name)) continue;
      auditedNames.add(name);
      auditPublicPropertyLike(source, className, checker, analysis, param, violations);
    }
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

type OriginTaint = {
  kind:
    | "ledger"
    | "slot-state"
    | "route-state"
    | "slot-field"
    | "nested-container"
    | "live-iterator"
    | "store"
    | "timer"
    | "quarantine-record"
    | "write-capability";
  name: string;
  via?: string;
};

type Provenance = {
  taints: OriginTaint[];
  freshContainer: boolean;
};

type FunctionOwner = ts.MethodDeclaration | ts.GetAccessorDeclaration;
type ProvenanceOwner = FunctionOwner | ts.PropertyDeclaration | ts.ParameterDeclaration;

function isPropertyLikeOwner(member: ProvenanceOwner): member is ts.PropertyDeclaration | ts.ParameterDeclaration {
  return ts.isPropertyDeclaration(member) || ts.isParameter(member);
}

type SourceLookup = { kind: "present"; expr: ts.Expression } | { kind: "missing" } | { kind: "unknown" };

const EMPTY_PROVENANCE: Provenance = { taints: [], freshContainer: false };
const FRESH_PROVENANCE: Provenance = { taints: [], freshContainer: true };

function taintKey(taint: OriginTaint): string {
  return `${taint.kind}:${taint.name}:${taint.via ?? ""}`;
}

function enclosingForOf(node: ts.Node): ts.ForOfStatement | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isForOfStatement(current)) return current;
    if (ts.isFunctionLike(current)) return undefined;
    current = current.parent;
  }
  return undefined;
}

function mergeProvenance(parts: Provenance[]): Provenance {
  const taints = new Map<string, OriginTaint>();
  let freshContainer = parts.length > 0;
  for (const part of parts) {
    for (const taint of part.taints) taints.set(taintKey(taint), taint);
    if (!part.freshContainer) freshContainer = false;
  }
  return { taints: [...taints.values()], freshContainer: freshContainer && taints.size === 0 };
}

function isPrimitiveLike(type: ts.Type): boolean {
  const flags =
    ts.TypeFlags.String |
    ts.TypeFlags.Number |
    ts.TypeFlags.Boolean |
    ts.TypeFlags.Enum |
    ts.TypeFlags.EnumLiteral |
    ts.TypeFlags.StringLiteral |
    ts.TypeFlags.NumberLiteral |
    ts.TypeFlags.BooleanLiteral |
    ts.TypeFlags.Undefined |
    ts.TypeFlags.Null |
    ts.TypeFlags.Void |
    ts.TypeFlags.Never |
    ts.TypeFlags.BigInt |
    ts.TypeFlags.BigIntLiteral |
    ts.TypeFlags.ESSymbol |
    ts.TypeFlags.UniqueESSymbol |
    ts.TypeFlags.NonPrimitive;
  if (type.flags & (flags & ~ts.TypeFlags.NonPrimitive)) return true;
  if (type.isUnion()) return type.types.every(isPrimitiveLike);
  return false;
}

function typeIncludesUndefined(type: ts.Type): boolean {
  if (type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return true;
  if (type.isUnion()) return type.types.some(typeIncludesUndefined);
  return false;
}

function typeHasName(type: ts.Type, checker: ts.TypeChecker, names: Set<string>): boolean {
  const found = new Set<string>();
  collectTypeNames(type, checker, new Set(), found);
  for (const name of names) {
    if (found.has(name)) return true;
  }
  return false;
}

function typeIsCallable(type: ts.Type): boolean {
  if (type.getCallSignatures().length > 0) return true;
  if (type.isUnion() || type.isIntersection()) return type.types.some(typeIsCallable);
  return false;
}

function containsMutableContainer(type: ts.Type, checker: ts.TypeChecker): boolean {
  const names = new Set<string>();
  collectTypeNames(type, checker, new Set(), names);
  return (
    names.has("Map") ||
    names.has("Set") ||
    names.has("WeakMap") ||
    names.has("WeakSet") ||
    names.has("Array") ||
    names.has("ReadonlyArray")
  );
}

class ClassProvenanceAnalysis {
  private readonly ledgers: ReadonlySet<string>;
  private readonly contract: Partial<Record<string, AcceptedReturnContract>>;
  private readonly methodByName = new Map<string, FunctionOwner>();
  private readonly summary = new Map<string, Provenance>();
  private readonly inFlight = new Set<string>();
  private readonly boundSummary = new Map<string, Provenance>();
  private readonly boundInFlight = new Set<string>();
  private readonly paramTaintStack: Array<Map<ts.Symbol, Provenance>> = [];

  constructor(
    private readonly source: ts.SourceFile,
    private readonly cls: ts.ClassDeclaration,
    private readonly className: string,
    private readonly checker: ts.TypeChecker,
  ) {
    this.ledgers = new Set(
      EXPECTED_LEDGERS[className as (typeof AUTHORITY_CLASS_NAMES)[number]] ?? Object.values(EXPECTED_LEDGERS).flat(),
    );
    this.contract = ACCEPTED_RETURN_CONTRACTS[className] ?? {};
    for (const member of cls.members) {
      if ((ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) && member.name) {
        const name = staticName(member.name);
        if (name) this.methodByName.set(name, member);
      }
    }
  }

  publicEscapeFindings(member: ProvenanceOwner, methodName: string): AuditViolation[] {
    const provenance = this.summarizeMember(member, methodName);
    const findings: AuditViolation[] = [];
    if (this.isUnanalyzedCallableProperty(member, methodName)) {
      findings.push({
        kind: "ledger-write-capability-escape",
        file: fileLabel(this.source),
        className: this.className,
        member: methodName,
        detail: "public callable property has no analyzed initializer or constructor assignment",
      });
    }
    const contract = this.contract[methodName];
    const allowedIterator = contract === "session-iterator";
    for (const taint of provenance.taints) {
      if (allowedIterator && taint.kind === "live-iterator" && taint.name === "sessions") continue;
      if (
        contract === "replay-fence-writer" &&
        (taint.kind === "store" || (taint.kind === "write-capability" && taint.name === "replayFence"))
      ) {
        continue;
      }
      if (
        contract === "route-producer-settle" &&
        taint.kind === "write-capability" &&
        taint.name === "routeProducers"
      ) {
        continue;
      }
      if (taint.kind === "write-capability") {
        findings.push({
          kind: "ledger-write-capability-escape",
          file: fileLabel(this.source),
          className: this.className,
          member: methodName,
          detail: `public ${isPropertyLikeOwner(member) ? "property" : "method"} returns a callable that can mutate private ${taint.name}`,
        });
        continue;
      }
      findings.push({
        kind: "ledger-identity-escape",
        file: fileLabel(this.source),
        className: this.className,
        member: methodName,
        detail: `public ${isPropertyLikeOwner(member) ? "property" : "method"} returns private ${taint.kind} ${taint.name}`,
      });
    }
    const signature = isPropertyLikeOwner(member) ? undefined : this.checker.getSignatureFromDeclaration(member);
    const returnType = signature ? this.checker.getReturnTypeOfSignature(signature) : undefined;
    if (
      returnType &&
      containsMutableContainer(returnType, this.checker) &&
      !provenance.freshContainer &&
      provenance.taints.length === 0
    ) {
      const allowedWriter = this.contract[methodName] === "replay-fence-writer";
      if (!allowedIterator && !allowedWriter) {
        findings.push({
          kind: "unproven-container-return",
          file: fileLabel(this.source),
          className: this.className,
          member: methodName,
          detail: `public method returns a mutable container without proving a detached copy (${this.checker.typeToString(returnType)})`,
        });
      }
    }
    return findings;
  }

  private summarizeMember(member: ProvenanceOwner, methodName: string): Provenance {
    const cached = this.summary.get(methodName);
    if (cached) return cached;
    if (this.inFlight.has(methodName)) return EMPTY_PROVENANCE;
    this.inFlight.add(methodName);
    let provenance: Provenance;
    if (isPropertyLikeOwner(member)) {
      const parts: Provenance[] = [];
      if (member.initializer) parts.push(this.exprProvenance(member.initializer, member));
      for (const assigned of this.constructorAssignedValues(methodName)) {
        parts.push(this.exprProvenance(assigned, member));
      }
      provenance = parts.length > 0 ? mergeProvenance(parts) : FRESH_PROVENANCE;
    } else {
      const returns = this.returnExpressions(member);
      provenance =
        returns.length === 0
          ? FRESH_PROVENANCE
          : mergeProvenance(returns.map((expr) => this.exprProvenance(expr, member)));
    }
    this.inFlight.delete(methodName);
    this.summary.set(methodName, provenance);
    return provenance;
  }

  private isUnanalyzedCallableProperty(member: ProvenanceOwner, methodName: string): boolean {
    if (!isPropertyLikeOwner(member) || member.initializer) return false;
    if (!typeIsCallable(this.checker.getTypeAtLocation(member))) return false;
    return this.constructorAssignedValues(methodName).length === 0;
  }

  private constructorAssignedValues(propertyName: string): ts.Expression[] {
    const out: ts.Expression[] = [];
    for (const member of this.cls.members) {
      if (!ts.isConstructorDeclaration(member) || !member.body) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isBinaryExpression(node) && ASSIGNMENT_KINDS.has(node.operatorToken.kind)) {
          if (this.assignsThisProperty(node.left, propertyName)) out.push(node.right);
        }
        ts.forEachChild(node, visit);
      };
      visit(member.body);
    }
    return out;
  }

  private assignsThisProperty(left: ts.Expression, propertyName: string): boolean {
    const current = unwrap(left);
    if (
      ts.isPropertyAccessExpression(current) &&
      this.isThisReceiver(current.expression) &&
      current.name.text === propertyName
    ) {
      return true;
    }
    if (ts.isElementAccessExpression(current) && this.isThisReceiver(current.expression)) {
      const key = resolveConstString(current.argumentExpression, this.checker);
      return key.kind === "literal" && key.value === propertyName;
    }
    return false;
  }

  private summarizeBoundMember(
    member: FunctionOwner,
    methodName: string,
    args: readonly ts.Expression[] | undefined,
    caller: ProvenanceOwner,
  ): Provenance {
    const bindings = this.bindCallParameters(member, args, caller);
    if (bindings.size === 0) return this.summarizeMember(member, methodName);
    const key = `${methodName}#${this.bindingsKey(bindings)}`;
    const cached = this.boundSummary.get(key);
    if (cached) return cached;
    if (this.boundInFlight.has(key)) return mergeProvenance([...bindings.values()]);
    this.boundInFlight.add(key);
    this.paramTaintStack.push(bindings);
    try {
      const returns = this.returnExpressions(member);
      const provenance =
        returns.length === 0
          ? FRESH_PROVENANCE
          : mergeProvenance(returns.map((expr) => this.exprProvenance(expr, member)));
      this.boundSummary.set(key, provenance);
      return provenance;
    } finally {
      this.paramTaintStack.pop();
      this.boundInFlight.delete(key);
    }
  }

  private bindCallParameters(
    callee: FunctionOwner,
    args: readonly ts.Expression[] | undefined,
    caller: ProvenanceOwner,
  ): Map<ts.Symbol, Provenance> {
    const map = new Map<ts.Symbol, Provenance>();
    const actual = args ?? [];
    for (let index = 0; index < callee.parameters.length; index++) {
      const param = callee.parameters[index];
      if (!param) continue;
      if (param.dotDotDotToken) {
        const rest = actual.slice(index);
        const provenance =
          rest.length === 0 ? FRESH_PROVENANCE : mergeProvenance(rest.map((arg) => this.exprProvenance(arg, caller)));
        this.bindBindingName(param.name, provenance, map, callee, undefined, caller);
        break;
      }
      const explicit = actual[index];
      // JS evaluates a default when the actual is missing or undefined, not
      // merely when the argument node is absent.
      if (explicit && (!param.initializer || !this.expressionMayBeUndefined(explicit))) {
        this.bindBindingName(param.name, this.exprProvenance(explicit, caller), map, callee, explicit, caller);
        continue;
      }
      if (explicit) {
        this.bindBindingName(param.name, this.exprProvenance(explicit, caller), map, callee, explicit, caller);
      }
      if (!param.initializer) continue;
      this.paramTaintStack.push(map);
      try {
        this.bindBindingName(
          param.name,
          this.exprProvenance(param.initializer, callee),
          map,
          callee,
          param.initializer,
          callee,
        );
      } finally {
        this.paramTaintStack.pop();
      }
    }
    return map;
  }

  private expressionMayBeUndefined(expr: ts.Expression): boolean {
    const current = unwrap(expr);
    if (current.kind === ts.SyntaxKind.UndefinedKeyword) return true;
    if (ts.isIdentifier(current) && current.text === "undefined") return true;
    if (ts.isVoidExpression(current)) return true;
    return typeIncludesUndefined(this.checker.getTypeAtLocation(expr));
  }

  private bindBindingName(
    name: ts.BindingName,
    provenance: Provenance,
    map: Map<ts.Symbol, Provenance>,
    initOwner: ProvenanceOwner,
    source: ts.Expression | undefined,
    sourceOwner: ProvenanceOwner,
  ): void {
    if (ts.isIdentifier(name)) {
      const symbol = this.checker.getSymbolAtLocation(name);
      if (!symbol) return;
      const prev = map.get(symbol);
      map.set(symbol, prev ? mergeProvenance([prev, provenance]) : provenance);
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      this.bindArrayPattern(name, provenance, map, initOwner, source, sourceOwner);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      this.bindObjectPattern(name, provenance, map, initOwner, source, sourceOwner);
    }
  }

  private bindObjectPattern(
    pattern: ts.ObjectBindingPattern,
    provenance: Provenance,
    map: Map<ts.Symbol, Provenance>,
    initOwner: ProvenanceOwner,
    source: ts.Expression | undefined,
    sourceOwner: ProvenanceOwner,
  ): void {
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      if (element.dotDotDotToken) {
        this.bindBindingName(element.name, provenance, map, initOwner, source, sourceOwner);
        continue;
      }
      const propName = staticName(element.propertyName ?? element.name);
      const lookup = this.objectSourceProperty(source, propName);
      const elementProv = this.bindingElementProvenance(provenance, element, lookup, map, initOwner, sourceOwner);
      const nestedSource =
        lookup.kind === "present" ? lookup.expr : lookup.kind === "missing" ? element.initializer : undefined;
      this.bindBindingName(element.name, elementProv, map, initOwner, nestedSource, sourceOwner);
    }
  }

  private bindArrayPattern(
    pattern: ts.ArrayBindingPattern,
    provenance: Provenance,
    map: Map<ts.Symbol, Provenance>,
    initOwner: ProvenanceOwner,
    source: ts.Expression | undefined,
    sourceOwner: ProvenanceOwner,
  ): void {
    let index = 0;
    for (const element of pattern.elements) {
      if (ts.isOmittedExpression(element)) {
        index++;
        continue;
      }
      if (!ts.isBindingElement(element)) continue;
      if (element.dotDotDotToken) {
        this.bindBindingName(element.name, provenance, map, initOwner, source, sourceOwner);
        continue;
      }
      const lookup = this.arraySourceElement(source, index);
      const elementProv = this.bindingElementProvenance(provenance, element, lookup, map, initOwner, sourceOwner);
      const nestedSource =
        lookup.kind === "present" ? lookup.expr : lookup.kind === "missing" ? element.initializer : undefined;
      this.bindBindingName(element.name, elementProv, map, initOwner, nestedSource, sourceOwner);
      index++;
    }
  }

  private bindingElementProvenance(
    container: Provenance,
    element: ts.BindingElement,
    lookup: SourceLookup,
    map: Map<ts.Symbol, Provenance>,
    initOwner: ProvenanceOwner,
    sourceOwner: ProvenanceOwner,
  ): Provenance {
    const parts: Provenance[] = [];
    if (lookup.kind === "present") {
      parts.push(this.exprProvenance(lookup.expr, sourceOwner));
      if (element.initializer && this.expressionMayBeUndefined(lookup.expr)) {
        parts.push(this.evalBindingInitializer(element.initializer, map, initOwner));
      }
    } else if (lookup.kind === "missing") {
      if (element.initializer) parts.push(this.evalBindingInitializer(element.initializer, map, initOwner));
      else parts.push(container);
    } else {
      parts.push(container);
      if (element.initializer) parts.push(this.evalBindingInitializer(element.initializer, map, initOwner));
    }
    return parts.length === 0 ? FRESH_PROVENANCE : mergeProvenance(parts);
  }

  private evalBindingInitializer(
    initializer: ts.Expression,
    map: Map<ts.Symbol, Provenance>,
    owner: ProvenanceOwner,
  ): Provenance {
    this.paramTaintStack.push(map);
    try {
      return this.exprProvenance(initializer, owner);
    } finally {
      this.paramTaintStack.pop();
    }
  }

  private objectSourceProperty(source: ts.Expression | undefined, name: string | undefined): SourceLookup {
    if (!name) return { kind: "unknown" };
    if (!source) return { kind: "missing" };
    const obj = unwrap(source);
    if (obj.kind === ts.SyntaxKind.UndefinedKeyword || ts.isVoidExpression(obj)) return { kind: "missing" };
    if (!ts.isObjectLiteralExpression(obj)) return { kind: "unknown" };
    if (obj.properties.some((prop) => ts.isSpreadAssignment(prop))) return { kind: "unknown" };
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop) && staticName(prop.name) === name) {
        return { kind: "present", expr: prop.initializer };
      }
      if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === name) {
        return { kind: "present", expr: prop.name };
      }
    }
    return { kind: "missing" };
  }

  private arraySourceElement(source: ts.Expression | undefined, index: number): SourceLookup {
    if (!source) return { kind: "missing" };
    const arr = unwrap(source);
    if (arr.kind === ts.SyntaxKind.UndefinedKeyword || ts.isVoidExpression(arr)) return { kind: "missing" };
    if (!ts.isArrayLiteralExpression(arr)) return { kind: "unknown" };
    if (arr.elements.some((element) => ts.isSpreadElement(element))) return { kind: "unknown" };
    const element = arr.elements[index];
    if (!element || ts.isOmittedExpression(element)) return { kind: "missing" };
    return { kind: "present", expr: element };
  }

  private bindingsKey(bindings: Map<ts.Symbol, Provenance>): string {
    const parts: string[] = [];
    for (const [symbol, provenance] of bindings) {
      const taints = provenance.taints
        .map((taint) => taintKey(taint))
        .sort()
        .join(",");
      parts.push(`${symbol.getName()}:${taints}:${provenance.freshContainer ? "1" : "0"}`);
    }
    return parts.join("|");
  }

  private returnExpressions(member: FunctionOwner): ts.Expression[] {
    const out: ts.Expression[] = [];
    if (!member.body || !ts.isBlock(member.body)) return out;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && node !== member) return;
      if (ts.isReturnStatement(node) && node.expression) out.push(node.expression);
      if (ts.isYieldExpression(node) && node.expression) out.push(node.expression);
      ts.forEachChild(node, visit);
    };
    visit(member.body);
    return out;
  }

  private exprProvenance(node: ts.Node, owner: ProvenanceOwner): Provenance {
    const current = unwrap(node);
    if (
      ts.isStringLiteral(current) ||
      ts.isNumericLiteral(current) ||
      current.kind === ts.SyntaxKind.TrueKeyword ||
      current.kind === ts.SyntaxKind.FalseKeyword ||
      current.kind === ts.SyntaxKind.NullKeyword ||
      current.kind === ts.SyntaxKind.UndefinedKeyword
    ) {
      return FRESH_PROVENANCE;
    }
    if (ts.isAwaitExpression(current)) return this.exprProvenance(current.expression, owner);
    if (ts.isConditionalExpression(current)) {
      return mergeProvenance([
        this.exprProvenance(current.whenTrue, owner),
        this.exprProvenance(current.whenFalse, owner),
      ]);
    }
    if (ts.isBinaryExpression(current)) {
      const op = current.operatorToken.kind;
      if (
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return mergeProvenance([this.exprProvenance(current.left, owner), this.exprProvenance(current.right, owner)]);
      }
      if (op === ts.SyntaxKind.CommaToken) return this.exprProvenance(current.right, owner);
      if (ASSIGNMENT_KINDS.has(op)) return this.exprProvenance(current.right, owner);
      return FRESH_PROVENANCE;
    }
    if (ts.isArrayLiteralExpression(current)) {
      const taints: OriginTaint[] = [];
      for (const element of current.elements) {
        if (ts.isSpreadElement(element)) {
          taints.push(
            ...this.detachIterableIdentity(this.exprProvenance(element.expression, owner), element.expression),
          );
        } else {
          taints.push(...this.exprProvenance(element, owner).taints);
        }
      }
      return { taints: uniqueTaints(taints), freshContainer: taints.length === 0 };
    }
    if (ts.isObjectLiteralExpression(current)) {
      const taints: OriginTaint[] = [];
      for (const prop of current.properties) {
        if (ts.isSpreadAssignment(prop)) {
          taints.push(...this.exprProvenance(prop.expression, owner).taints);
        } else if (ts.isPropertyAssignment(prop)) {
          taints.push(...this.exprProvenance(prop.initializer, owner).taints);
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          taints.push(...this.exprProvenance(prop.name, owner).taints);
        } else if (
          ts.isMethodDeclaration(prop) ||
          ts.isGetAccessorDeclaration(prop) ||
          ts.isSetAccessorDeclaration(prop)
        ) {
          taints.push(...this.callableProvenance(prop, owner).taints);
        }
      }
      return { taints: uniqueTaints(taints), freshContainer: taints.length === 0 };
    }
    if (ts.isNewExpression(current)) return this.newExpressionProvenance(current, owner);
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      return this.callableProvenance(current, owner);
    }
    if (ts.isCallExpression(current)) return this.callProvenance(current, owner);
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      return this.memberProvenance(current, owner);
    }
    if (ts.isIdentifier(current)) return this.identifierProvenance(current, owner);
    if (current.kind === ts.SyntaxKind.ThisKeyword) return EMPTY_PROVENANCE;
    if (ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) return FRESH_PROVENANCE;
    if (ts.isTypeOfExpression(current) || ts.isVoidExpression(current)) return FRESH_PROVENANCE;
    if (ts.isAsExpression(current) || ts.isNonNullExpression(current) || ts.isSatisfiesExpression(current)) {
      return this.exprProvenance(current.expression, owner);
    }
    return EMPTY_PROVENANCE;
  }

  private callProvenance(call: ts.CallExpression, owner: ProvenanceOwner): Provenance {
    const callee = unwrap(call.expression);
    if (ts.isIdentifier(callee) && callee.text === "Array" && call.arguments.length > 0) {
      /* Array(n) */
      return FRESH_PROVENANCE;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (ts.isIdentifier(callee.expression) && callee.expression.text === "Array" && method === "from") {
        const arg = call.arguments[0];
        const inner = arg ? this.exprProvenance(arg, owner) : FRESH_PROVENANCE;
        const taints = arg ? this.detachIterableIdentity(inner, arg) : [];
        return { taints, freshContainer: true };
      }
      if (ts.isIdentifier(callee.expression) && callee.expression.text === "Object" && method === "freeze") {
        const arg = call.arguments[0];
        return arg ? this.exprProvenance(arg, owner) : EMPTY_PROVENANCE;
      }
      if (
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Promise" &&
        (method === "resolve" || method === "reject")
      ) {
        const arg = call.arguments[0];
        return arg ? this.exprProvenance(arg, owner) : FRESH_PROVENANCE;
      }
      if (method === "bind" && ts.isPropertyAccessExpression(callee.expression)) {
        const bound = this.capabilityFromReceiver(callee.expression.name.text, callee.expression.expression, owner);
        if (bound) return bound;
      }
      if (this.isArrayLikeReceiver(callee.expression)) {
        if (DETACH_METHODS.has(method)) {
          return this.arrayDetachProvenance(callee.expression, method, call, owner);
        }
        // Unknown non-primitive standard calls on a tainted array fail closed
        // as element selection (at/pop/shift/find/…) unless already proven detached.
        return this.arrayElementSelectionProvenance(callee.expression, call, owner);
      }
      if (DETACH_METHODS.has(method)) {
        return this.arrayDetachProvenance(callee.expression, method, call, owner);
      }
      if (method === "get" || method === "values" || method === "entries" || method === "keys") {
        return this.containerMethodProvenance(callee.expression, method, owner);
      }
      if (this.isThisReceiver(callee.expression)) {
        const target = this.methodByName.get(method);
        if (target) return this.summarizeBoundMember(target, method, call.arguments, owner);
      }
    }
    const argTaints: OriginTaint[] = [];
    for (const arg of call.arguments) {
      const unwrapped = unwrap(arg);
      if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) continue;
      argTaints.push(...this.exprProvenance(arg, owner).taints);
    }
    if (isPrimitiveLike(this.checker.getTypeAtLocation(call))) return FRESH_PROVENANCE;
    if (argTaints.length > 0) return { taints: uniqueTaints(argTaints), freshContainer: false };
    return EMPTY_PROVENANCE;
  }

  private blockReturnProvenance(block: ts.Block, owner: ProvenanceOwner): Provenance {
    const returns: Provenance[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) && node !== owner) return;
      if (ts.isReturnStatement(node) && node.expression) returns.push(this.exprProvenance(node.expression, owner));
      ts.forEachChild(node, visit);
    };
    visit(block);
    return returns.length === 0 ? FRESH_PROVENANCE : mergeProvenance(returns);
  }

  private containerMethodProvenance(receiver: ts.Expression, method: string, owner: ProvenanceOwner): Provenance {
    const recv = this.exprProvenance(receiver, owner);
    const ledger = recv.taints.find((taint) => taint.kind === "ledger");
    if (!ledger) return recv;
    if (method === "get") {
      if (SAFE_VALUE_LEDGERS.has(ledger.name)) return FRESH_PROVENANCE;
      if (ledger.name === "slotBySession")
        return { taints: [{ kind: "slot-state", name: ledger.name }], freshContainer: false };
      if (ledger.name === "routeBySession")
        return { taints: [{ kind: "route-state", name: ledger.name }], freshContainer: false };
      if (ledger.name === "quarantinedSessions") {
        return { taints: [{ kind: "quarantine-record", name: ledger.name }], freshContainer: false };
      }
      if (ledger.name === "handlerShutdowns") {
        return { taints: [{ kind: "nested-container", name: ledger.name }], freshContainer: false };
      }
      if (
        ledger.name === "replayFenceRetryTimers" ||
        ledger.name === "postFenceRecoveryTimers" ||
        ledger.name === "idleTimer"
      ) {
        return { taints: [{ kind: "timer", name: ledger.name }], freshContainer: false };
      }
      return { taints: [{ kind: "nested-container", name: ledger.name }], freshContainer: false };
    }
    if (method === "values" || method === "entries" || method === "keys") {
      return { taints: [{ kind: "live-iterator", name: ledger.name, via: method }], freshContainer: false };
    }
    return recv;
  }

  private arrayDetachProvenance(
    recvExpr: ts.Expression,
    method: string,
    call: ts.CallExpression,
    owner: ProvenanceOwner,
  ): Provenance {
    const receiver = this.exprProvenance(recvExpr, owner);
    if (method === "map" || method === "flatMap") {
      const element: Provenance = {
        taints: receiver.taints.filter(
          (taint) =>
            taint.kind === "nested-container" ||
            taint.kind === "slot-state" ||
            taint.kind === "route-state" ||
            taint.kind === "quarantine-record" ||
            taint.kind === "store",
        ),
        freshContainer: false,
      };
      const callbackTaints: OriginTaint[] = [];
      for (const arg of call.arguments) {
        if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
          callbackTaints.push(...this.functionCallbackProvenance(arg, element, owner).taints);
        }
      }
      return { taints: uniqueTaints(callbackTaints), freshContainer: true };
    }
    const nested = receiver.taints.filter(
      (taint) => taint.kind !== "ledger" && taint.kind !== "slot-field" && taint.kind !== "live-iterator",
    );
    return { taints: uniqueTaints(nested), freshContainer: true };
  }

  private isArrayLikeReceiver(expr: ts.Expression): boolean {
    return typeHasName(this.checker.getTypeAtLocation(expr), this.checker, new Set(["Array", "ReadonlyArray"]));
  }

  private arrayElementSelectionProvenance(
    recvExpr: ts.Expression,
    resultNode: ts.Node,
    owner: ProvenanceOwner,
  ): Provenance {
    if (isPrimitiveLike(this.checker.getTypeAtLocation(resultNode))) return FRESH_PROVENANCE;
    const recv = this.exprProvenance(recvExpr, owner);
    if (recv.taints.length > 0) return { taints: recv.taints, freshContainer: false };
    return FRESH_PROVENANCE;
  }

  private memberProvenance(
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    owner: ProvenanceOwner,
  ): Provenance {
    let name: string | undefined;
    if (ts.isPropertyAccessExpression(node)) {
      name = node.name.text;
    } else {
      const key = resolveConstString(node.argumentExpression, this.checker);
      if (key.kind === "literal") name = key.value;
    }
    const recvExpr = node.expression;
    const type = this.checker.getTypeAtLocation(node);
    if (isPrimitiveLike(type)) return FRESH_PROVENANCE;
    if (name && this.isThisReceiver(recvExpr) && this.ledgers.has(name)) {
      return this.thisLedgerProvenance(name, node);
    }
    if (name && this.isThisReceiver(recvExpr)) {
      const target = this.methodByName.get(name);
      if (target && ts.isGetAccessorDeclaration(target)) return this.summarizeMember(target, name);
    }
    const recv = this.exprProvenance(recvExpr, owner);
    if (!name) {
      if (ts.isElementAccessExpression(node) && this.isThisReceiver(recvExpr)) {
        const key = resolveConstString(node.argumentExpression, this.checker);
        if (key.kind !== "literal") {
          return { taints: [...recv.taints, { kind: "ledger", name: "<dynamic>" }], freshContainer: false };
        }
      }
      if (this.isArrayLikeReceiver(recvExpr)) {
        return this.arrayElementSelectionProvenance(recvExpr, node, owner);
      }
      if (recv.taints.some((taint) => taint.kind === "ledger")) {
        return this.containerMethodProvenance(recvExpr, "get", owner);
      }
      return recv;
    }
    if (recv.taints.some((taint) => taint.kind === "slot-state") && SLOT_MUTABLE_FIELDS.has(name)) {
      return { taints: [{ kind: "slot-field", name }], freshContainer: false };
    }
    if (recv.taints.some((taint) => taint.kind === "route-state") && name !== "generation" && name !== "injectReady") {
      if (name === "transition") return FRESH_PROVENANCE;
      return { taints: [{ kind: "route-state", name: "routeBySession" }], freshContainer: false };
    }
    if (recv.taints.some((taint) => taint.kind === "quarantine-record") && name === "handler") return FRESH_PROVENANCE;
    if (
      recv.taints.some((taint) => taint.kind === "nested-container" && taint.name === "handlerShutdowns") &&
      (name === "raw" || name === "observed")
    ) {
      return FRESH_PROVENANCE;
    }
    if (recv.taints.some((taint) => taint.kind === "store") && name !== "replayFence" && name !== "registry") {
      return FRESH_PROVENANCE;
    }
    const nestedField = recv.taints.find((taint) => taint.kind === "slot-field" && taint.name === name);
    if (nestedField) return { taints: [nestedField], freshContainer: false };
    if (recv.taints.length > 0 && SLOT_MUTABLE_FIELDS.has(name)) {
      return { taints: [{ kind: "slot-field", name }], freshContainer: false };
    }
    return {
      taints: recv.taints.filter((taint) => taint.kind !== "slot-state" && taint.kind !== "route-state"),
      freshContainer: false,
    };
  }

  private thisLedgerProvenance(name: string, node: ts.Node): Provenance {
    const type = this.checker.getTypeAtLocation(node);
    if (isPrimitiveLike(type)) return FRESH_PROVENANCE;
    if (typeHasName(type, this.checker, new Set(["ReplayFenceStore", "SessionRegistry"]))) {
      return { taints: [{ kind: "store", name }], freshContainer: false };
    }
    if (typeHasName(type, this.checker, new Set(["Timeout"]))) {
      return { taints: [{ kind: "timer", name }], freshContainer: false };
    }
    return { taints: [{ kind: "ledger", name }], freshContainer: false };
  }

  private identifierProvenance(id: ts.Identifier, owner: ProvenanceOwner): Provenance {
    if (id.text === "undefined" || id.text === "NaN" || id.text === "Infinity") return FRESH_PROVENANCE;
    const symbol = this.checker.getSymbolAtLocation(id);
    if (!symbol) return EMPTY_PROVENANCE;
    for (let index = this.paramTaintStack.length - 1; index >= 0; index--) {
      const bound = this.paramTaintStack[index]?.get(symbol);
      if (!bound) continue;
      if (isPrimitiveLike(this.checker.getTypeAtLocation(id))) return FRESH_PROVENANCE;
      return bound;
    }
    const parts: Provenance[] = [];
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        parts.push(this.exprProvenance(declaration.initializer, owner));
      }
      if (ts.isVariableDeclaration(declaration) && !declaration.initializer) {
        const forOf = enclosingForOf(declaration);
        if (forOf) parts.push(this.forOfNameProvenance(declaration.name, forOf, owner));
      }
      if (ts.isBindingElement(declaration)) {
        const forOf = enclosingForOf(declaration);
        if (forOf) {
          parts.push(this.forOfBindingProvenance(declaration, forOf, owner));
        } else {
          const property = staticName(declaration.propertyName ?? declaration.name);
          const target = declaration.parent.parent;
          if (property && ts.isVariableDeclaration(target) && target.initializer) {
            const recv = this.exprProvenance(target.initializer, owner);
            if (
              SLOT_MUTABLE_FIELDS.has(property) &&
              recv.taints.some((taint) => taint.kind === "slot-state" || taint.kind === "slot-field")
            ) {
              parts.push({ taints: [{ kind: "slot-field", name: property }], freshContainer: false });
            } else {
              parts.push(recv);
            }
          }
        }
      }
      if (ts.isParameter(declaration) && this.paramTaintStack.length === 0) parts.push(EMPTY_PROVENANCE);
    }
    if (ts.isMethodDeclaration(owner) || ts.isGetAccessorDeclaration(owner)) {
      if (!owner.body) return mergeProvenance(parts);
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node) && node !== owner) return;
        if (
          ts.isBinaryExpression(node) &&
          ASSIGNMENT_KINDS.has(node.operatorToken.kind) &&
          ts.isIdentifier(unwrap(node.left))
        ) {
          const left = unwrap(node.left) as ts.Identifier;
          if (this.checker.getSymbolAtLocation(left) === symbol) {
            parts.push(this.exprProvenance(node.right, owner));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(owner.body);
    }
    if (parts.length === 0) return EMPTY_PROVENANCE;
    const merged = mergeProvenance(parts);
    if (
      typeHasName(this.checker.getTypeAtLocation(id), this.checker, SESSION_ENTRY_TYPE_NAMES) &&
      !this.ledgers.has(id.text)
    ) {
      return FRESH_PROVENANCE;
    }
    if (isPrimitiveLike(this.checker.getTypeAtLocation(id))) return FRESH_PROVENANCE;
    return merged;
  }

  private detachIterableIdentity(spread: Provenance, expr: ts.Expression): OriginTaint[] {
    const out: OriginTaint[] = [];
    for (const taint of spread.taints) {
      if (taint.kind === "ledger") {
        if (this.iterationYieldsLiveInner(taint.name, expr)) {
          out.push({ kind: "nested-container", name: taint.name });
        }
        continue;
      }
      if (taint.kind === "slot-field") continue;
      if (taint.kind === "live-iterator") {
        if (taint.via === "keys") continue;
        if (SAFE_VALUE_LEDGERS.has(taint.name)) continue;
        out.push({ kind: "nested-container", name: taint.name });
        continue;
      }
      if (taint.kind === "nested-container") continue;
      out.push(taint);
    }
    return uniqueTaints(out);
  }

  private iterationYieldsLiveInner(name: string, expr: ts.Expression): boolean {
    if (SAFE_VALUE_LEDGERS.has(name)) return false;
    const names = new Set<string>();
    collectTypeNames(this.checker.getTypeAtLocation(expr), this.checker, new Set(), names);
    if (names.has("Array") || names.has("Set") || names.has("ReadonlyArray")) return false;
    return names.has("Map") || names.has("WeakMap");
  }

  private functionCallbackProvenance(
    fn: ts.ArrowFunction | ts.FunctionExpression,
    element: Provenance,
    owner: ProvenanceOwner,
  ): Provenance {
    const map = new Map<ts.Symbol, Provenance>();
    for (const param of fn.parameters) this.bindCallbackName(param.name, element, map);
    this.paramTaintStack.push(map);
    try {
      if (ts.isBlock(fn.body)) return this.blockReturnProvenance(fn.body, owner);
      return this.exprProvenance(fn.body, owner);
    } finally {
      this.paramTaintStack.pop();
    }
  }

  private bindCallbackName(name: ts.BindingName, element: Provenance, map: Map<ts.Symbol, Provenance>): void {
    if (ts.isIdentifier(name)) {
      const symbol = this.checker.getSymbolAtLocation(name);
      if (symbol) map.set(symbol, element);
      return;
    }
    if (ts.isArrayBindingPattern(name)) {
      for (const [index, el] of name.elements.entries()) {
        if (!ts.isBindingElement(el)) continue;
        const inner =
          index === 0 && element.taints.some((taint) => taint.kind === "nested-container") ? FRESH_PROVENANCE : element;
        this.bindCallbackName(el.name, inner, map);
      }
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) this.bindCallbackName(el.name, element, map);
      }
    }
  }

  private forOfNameProvenance(name: ts.BindingName, forOf: ts.ForOfStatement, owner: ProvenanceOwner): Provenance {
    const element = this.iteratedElementProvenance(forOf.expression, owner);
    if (ts.isIdentifier(name)) {
      if (isPrimitiveLike(this.checker.getTypeAtLocation(name))) return FRESH_PROVENANCE;
      return element;
    }
    return element;
  }

  private forOfBindingProvenance(
    declaration: ts.BindingElement,
    forOf: ts.ForOfStatement,
    owner: ProvenanceOwner,
  ): Provenance {
    const element = this.iteratedElementProvenance(forOf.expression, owner);
    const pattern = declaration.parent;
    if (ts.isArrayBindingPattern(pattern)) {
      const index = pattern.elements.indexOf(declaration);
      if (index === 0 && element.taints.some((taint) => taint.kind === "nested-container")) {
        return FRESH_PROVENANCE;
      }
    }
    if (isPrimitiveLike(this.checker.getTypeAtLocation(declaration.name))) return FRESH_PROVENANCE;
    return element;
  }

  private iteratedElementProvenance(expr: ts.Expression, owner: ProvenanceOwner): Provenance {
    const inner = this.exprProvenance(expr, owner);
    const taints = this.detachIterableIdentity(inner, expr);
    return { taints, freshContainer: taints.length === 0 };
  }

  private isThisReceiver(node: ts.Expression): boolean {
    const current = followInitializer(node, this.checker, new Set());
    return current.kind === ts.SyntaxKind.ThisKeyword;
  }

  private newExpressionProvenance(expr: ts.NewExpression, owner: ProvenanceOwner): Provenance {
    const ctor = unwrap(expr.expression);
    const name = ts.isIdentifier(ctor) ? ctor.text : "";
    // Named constructors only: Promise/Error executors stay internal; Set/Map/Array detach identity.
    if (name === "Promise" || name === "Error") return FRESH_PROVENANCE;
    if (name === "Set" || name === "Map" || name === "Array" || name === "WeakSet") {
      const arg = expr.arguments?.[0];
      if (!arg || ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return FRESH_PROVENANCE;
      return { taints: this.detachIterableIdentity(this.exprProvenance(arg, owner), arg), freshContainer: true };
    }
    const argTaints: OriginTaint[] = [];
    for (const arg of expr.arguments ?? []) {
      argTaints.push(...this.exprProvenance(arg, owner).taints);
    }
    if (argTaints.length > 0) return { taints: uniqueTaints(argTaints), freshContainer: false };
    return FRESH_PROVENANCE;
  }

  private callableProvenance(
    fn:
      | ts.ArrowFunction
      | ts.FunctionExpression
      | ts.MethodDeclaration
      | ts.GetAccessorDeclaration
      | ts.SetAccessorDeclaration,
    owner: ProvenanceOwner,
  ): Provenance {
    const parts: Provenance[] = [];
    if (!fn.body) return FRESH_PROVENANCE;
    const visit = (node: ts.Node): void => {
      if (ts.isReturnStatement(node) && node.expression) parts.push(this.exprProvenance(node.expression, owner));
      if (ts.isYieldExpression(node) && node.expression) parts.push(this.exprProvenance(node.expression, owner));
      const write = this.mutationAt(node, owner);
      if (write) parts.push(write);
      ts.forEachChild(node, visit);
    };
    if (ts.isBlock(fn.body)) visit(fn.body);
    else {
      parts.push(this.exprProvenance(fn.body, owner));
      const write = this.mutationAt(unwrap(fn.body), owner);
      if (write) parts.push(write);
    }
    return parts.length === 0 ? FRESH_PROVENANCE : mergeProvenance(parts);
  }

  private mutationAt(node: ts.Node, owner: ProvenanceOwner): Provenance | undefined {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        return this.capabilityFromReceiver(callee.name.text, callee.expression, owner);
      }
    }
    if (ts.isBinaryExpression(node) && ASSIGNMENT_KINDS.has(node.operatorToken.kind)) {
      return this.capabilityFromAssigned(node.left, owner);
    }
    if (ts.isDeleteExpression(node)) return this.capabilityFromAssigned(node.expression, owner);
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      return this.capabilityFromAssigned(node.operand, owner);
    }
    return undefined;
  }

  private capabilityFromAssigned(target: ts.Expression, owner: ProvenanceOwner): Provenance | undefined {
    const found = this.exprProvenance(target, owner).taints.filter(
      (taint) =>
        taint.kind === "ledger" ||
        taint.kind === "slot-field" ||
        taint.kind === "nested-container" ||
        taint.kind === "slot-state" ||
        taint.kind === "route-state" ||
        taint.kind === "store" ||
        taint.kind === "timer",
    );
    if (found.length === 0) return undefined;
    return {
      taints: uniqueTaints(found.map((taint) => ({ kind: "write-capability" as const, name: taint.name }))),
      freshContainer: false,
    };
  }

  private capabilityFromReceiver(
    method: string,
    receiver: ts.Expression,
    owner: ProvenanceOwner,
  ): Provenance | undefined {
    const recv = this.exprProvenance(receiver, owner);
    const storage = recv.taints.filter(
      (taint) =>
        taint.kind === "ledger" ||
        taint.kind === "slot-field" ||
        taint.kind === "nested-container" ||
        taint.kind === "slot-state" ||
        taint.kind === "route-state" ||
        taint.kind === "store" ||
        taint.kind === "timer",
    );
    if (storage.length === 0) return undefined;
    if (CONTAINER_MUTATORS.has(method)) {
      return {
        taints: uniqueTaints(storage.map((taint) => ({ kind: "write-capability" as const, name: taint.name }))),
        freshContainer: false,
      };
    }
    const storeLike = storage.filter((taint) => taint.kind === "store" || taint.kind === "timer");
    if (storeLike.length > 0 && !READONLY_CONTAINER_METHODS.has(method)) {
      return {
        taints: uniqueTaints(storeLike.map((taint) => ({ kind: "write-capability" as const, name: taint.name }))),
        freshContainer: false,
      };
    }
    return undefined;
  }
}

function uniqueTaints(taints: OriginTaint[]): OriginTaint[] {
  const map = new Map<string, OriginTaint>();
  for (const taint of taints) map.set(taintKey(taint), taint);
  return [...map.values()];
}
