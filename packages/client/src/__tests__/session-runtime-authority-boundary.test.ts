import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditAuthorityBoundary,
  createClientBoundaryProgram,
  createInMemoryProgram,
  fixtureDiagnostics,
  formatViolation,
  HOST_FILE,
} from "./session-runtime-authority-boundary-audit.js";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, "..", "..");

const FIXTURE_AUDIT = { requireCompleteInventory: false as const, hostFileNames: ["host.ts"] };

function auditFixture(files: Record<string, string>) {
  const program = createInMemoryProgram(files);
  return {
    diagnostics: fixtureDiagnostics(program, files),
    violations: auditAuthorityBoundary(program, FIXTURE_AUDIT),
  };
}

function kinds(violations: ReturnType<typeof auditAuthorityBoundary>): string[] {
  return violations.map(formatViolation);
}

describe("SessionRuntime authority boundary", () => {
  describe("production Client program", () => {
    const program = createClientBoundaryProgram(clientRoot);
    const violations = auditAuthorityBoundary(program, { requireCompleteInventory: true });

    it("builds a type-aware Program from Client tsconfig.json and reports no ownership escapes", () => {
      expect(program.getTypeChecker(), "TypeChecker must exist").toBeTruthy();
      expect(violations, violations.length ? kinds(violations).join("\n") : "clean").toEqual([]);
    });

    it("keeps the host source in the Program so SessionEntry is checker-resolved", () => {
      const host = program.getSourceFiles().find((file) => file.fileName.endsWith(`/${HOST_FILE}`));
      expect(host).toBeTruthy();
    });
  });

  describe("compile-valid negative fixtures", () => {
    it("catches removing private from RouteTeardownAuthority.quarantinedSessions", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          export class RouteTeardownAuthority {
            quarantinedSessions = new Map<string, { handler: object }>();
            private routeBySession = new WeakMap<object, { generation: number }>();
          }
          export class SessionRuntime {
            constructor(private routes: RouteTeardownAuthority) {}
            note(entry: SessionEntry): string {
              return entry.chatId;
            }
          }
        `,
      };
      const { diagnostics, violations } = auditFixture(files);
      expect(diagnostics, diagnostics.join("\n")).toEqual([]);
      expect(
        violations.some(
          (hit) =>
            hit.kind === "ledger-not-private" &&
            hit.className === "RouteTeardownAuthority" &&
            hit.member === "quarantinedSessions",
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
    });

    it("catches a public method returning live RouteState through a type alias union", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          type RouteState = { generation: number; injectReady: boolean };
          type RouteStateAlias = RouteState;
          type Box<T> = T;
          export class RouteTeardownAuthority {
            private routeBySession = new WeakMap<object, RouteState>();
            inspectLive(entry: object): Box<RouteStateAlias> | undefined {
              return this.routeBySession.get(entry);
            }
          }
          export class SessionRuntime {
            constructor(private routes: RouteTeardownAuthority) {}
            note(entry: SessionEntry): string {
              return entry.chatId;
            }
          }
        `,
      };
      const { diagnostics, violations } = auditFixture(files);
      expect(diagnostics, diagnostics.join("\n")).toEqual([]);
      expect(
        violations.some(
          (hit) =>
            hit.kind === "public-return-forbidden-type" &&
            hit.className === "RouteTeardownAuthority" &&
            hit.member === "inspectLive" &&
            /RouteState/.test(hit.detail),
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
    });

    it("catches queue.push after aliasing deferredMessages under a different variable name", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          export class SessionRuntime {
            enqueue(entry: SessionEntry, message: { id: string }): void {
              const queue = (entry as SessionEntry & { deferredMessages: Array<{ id: string }> }).deferredMessages;
              queue.push(message);
            }
          }
        `,
      };
      const { diagnostics, violations } = auditFixture(files);
      expect(diagnostics, diagnostics.join("\n")).toEqual([]);
      expect(
        violations.some((hit) => hit.kind === "aliased-array-mutator" && hit.member === "deferredMessages"),
        kinds(violations).join("\n"),
      ).toBe(true);
    });

    it("catches computed-key mutation of projection.sessions after a Record cast", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          export class SessionProjectionAuthority {
            private sessions = new Map<string, { chatId: string }>();
            getSession(chatId: string): { chatId: string } | undefined {
              return this.sessions.get(chatId);
            }
          }
          export class SessionRuntime {
            constructor(private projection: SessionProjectionAuthority) {}
            wipe(): void {
              const ledgerName = "sessions";
              (this.projection as unknown as Record<string, Map<string, unknown> | undefined>)[ledgerName]?.clear();
            }
            note(entry: SessionEntry): string {
              return entry.chatId;
            }
          }
        `,
      };
      const { diagnostics, violations } = auditFixture(files);
      expect(diagnostics, diagnostics.join("\n")).toEqual([]);
      expect(
        violations.some((hit) => hit.kind === "computed-ledger-mutation" && hit.member === "sessions"),
        kinds(violations).join("\n"),
      ).toBe(true);
    });
  });

  describe("clean fixture", () => {
    it("passes a miniature unique-ownership Program with no violations", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          type RouteState = { generation: number };
          export class RouteTeardownAuthority {
            private quarantinedSessions = new Map<string, object>();
            private routeBySession = new WeakMap<object, RouteState>();
            attach(entry: object): void {
              this.routeBySession.set(entry, { generation: 0 });
            }
            hasQuarantine(chatId: string): boolean {
              return this.quarantinedSessions.has(chatId);
            }
          }
          export class SessionProjectionAuthority {
            private sessions = new Map<string, { chatId: string }>();
            getSession(chatId: string): { chatId: string } | undefined {
              return this.sessions.get(chatId);
            }
          }
          export class SessionRuntime {
            constructor(
              private routes: RouteTeardownAuthority,
              private projection: SessionProjectionAuthority,
            ) {}
            start(entry: SessionEntry): void {
              this.routes.attach(entry);
            }
            lookup(chatId: string): { chatId: string } | undefined {
              return this.projection.getSession(chatId);
            }
          }
        `,
      };
      const { diagnostics, violations } = auditFixture(files);
      expect(diagnostics, diagnostics.join("\n")).toEqual([]);
      expect(violations, kinds(violations).join("\n")).toEqual([]);
    });
  });
});
