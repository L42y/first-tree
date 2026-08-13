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
    it("catches a public method returning live RouteState through a non-transparent wrapper", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          type RouteState = { generation: number; injectReady: boolean };
          type Box<T> = { value: T };
          export class RouteTeardownAuthority {
            private routeBySession = new WeakMap<object, RouteState>();
            inspectLive(entry: object): Box<RouteState> | undefined {
              const state = this.routeBySession.get(entry);
              return state ? { value: state } : undefined;
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
            (hit.kind === "public-return-forbidden-type" || hit.kind === "ledger-identity-escape") &&
            hit.className === "RouteTeardownAuthority" &&
            hit.member === "inspectLive",
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
    });
  });

  describe("compile-valid provenance fixtures", () => {
    it("catches raw pendingQueue returned as unknown[] even when the host pops it", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          export class SlotSchedulerAuthority {
            private pendingQueue: Array<{ chatId: string }> = [];
            qaLeakPendingQueue(): unknown[] {
              return this.pendingQueue;
            }
          }
          export class SessionRuntime {
            constructor(private slotScheduler: SlotSchedulerAuthority) {}
            qaMutateLeakedPendingQueue(): void {
              this.slotScheduler.qaLeakPendingQueue().pop();
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
        violations.some(
          (hit) =>
            hit.kind === "ledger-identity-escape" &&
            hit.className === "SlotSchedulerAuthority" &&
            hit.member === "qaLeakPendingQueue" &&
            /pendingQueue/.test(hit.detail),
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
    });

    it("catches the same raw pendingQueue return with no host consumer", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          export class SlotSchedulerAuthority {
            private pendingQueue: Array<{ chatId: string }> = [];
            qaLeakPendingQueue(): unknown[] {
              return this.pendingQueue;
            }
          }
          export class SessionRuntime {
            constructor(private scheduler: SlotSchedulerAuthority) {}
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
            hit.kind === "ledger-identity-escape" &&
            hit.className === "SlotSchedulerAuthority" &&
            hit.member === "qaLeakPendingQueue" &&
            /pendingQueue/.test(hit.detail),
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
    });

    it("catches a ledger alias, cast, and conditional return", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          export class SlotSchedulerAuthority {
            private pendingQueue: Array<{ chatId: string }> = [];
            leak(flag: boolean): unknown[] | null {
              const queued = this.pendingQueue as unknown as unknown[];
              return flag ? queued : null;
            }
          }
          export class SessionRuntime {
            constructor(private scheduler: SlotSchedulerAuthority) {}
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
          (hit) => hit.kind === "ledger-identity-escape" && hit.member === "leak" && /pendingQueue/.test(hit.detail),
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
    });

    it("catches nested object and tuple wrappers around the live queue", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          export class SlotSchedulerAuthority {
            private pendingQueue: Array<{ chatId: string }> = [];
            boxed(): { value: unknown[] } {
              const queue = this.pendingQueue;
              return { value: queue };
            }
            tupled(): [unknown[]] {
              return [this.pendingQueue];
            }
          }
          export class SessionRuntime {
            constructor(private scheduler: SlotSchedulerAuthority) {}
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
          (hit) => hit.kind === "ledger-identity-escape" && hit.member === "boxed" && /pendingQueue/.test(hit.detail),
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
      expect(
        violations.some(
          (hit) => hit.kind === "ledger-identity-escape" && hit.member === "tupled" && /pendingQueue/.test(hit.detail),
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
    });

    it("catches Promise.resolve and async forwarding of the live queue", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          export class SlotSchedulerAuthority {
            private pendingQueue: Array<{ chatId: string }> = [];
            promised(): Promise<unknown[]> {
              return Promise.resolve(this.pendingQueue);
            }
            async forwarded(): Promise<unknown[]> {
              return this.pendingQueue;
            }
          }
          export class SessionRuntime {
            constructor(private scheduler: SlotSchedulerAuthority) {}
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
            hit.kind === "ledger-identity-escape" && hit.member === "promised" && /pendingQueue/.test(hit.detail),
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
      expect(
        violations.some(
          (hit) =>
            hit.kind === "ledger-identity-escape" && hit.member === "forwarded" && /pendingQueue/.test(hit.detail),
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
    });

    it("catches a public forwarder of a private helper that returns the ledger", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          export class SlotSchedulerAuthority {
            private pendingQueue: Array<{ chatId: string }> = [];
            private leak(): unknown[] {
              return this.pendingQueue;
            }
            private get leaked(): unknown[] {
              return this.leak();
            }
            expose(): unknown[] {
              return this.leaked;
            }
          }
          export class SessionRuntime {
            constructor(private scheduler: SlotSchedulerAuthority) {}
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
          (hit) => hit.kind === "ledger-identity-escape" && hit.member === "expose" && /pendingQueue/.test(hit.detail),
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
    });

    it("catches Object.freeze of the raw ledger identity", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          export class SlotSchedulerAuthority {
            private pendingQueue: Array<{ chatId: string }> = [];
            frozen(): readonly unknown[] {
              return Object.freeze(this.pendingQueue);
            }
          }
          export class SessionRuntime {
            constructor(private scheduler: SlotSchedulerAuthority) {}
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
          (hit) => hit.kind === "ledger-identity-escape" && hit.member === "frozen" && /pendingQueue/.test(hit.detail),
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
    });

    it("catches peekSlot deferredMessages erased to unknown[]", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          type SlotState = { deferredMessages: Array<{ id: string }> };
          export class SlotSchedulerAuthority {
            private slotBySession = new WeakMap<object, SlotState>();
            private peekSlot(entry: object): SlotState | undefined {
              return this.slotBySession.get(entry);
            }
            leakDeferred(entry: object): unknown[] | undefined {
              return this.peekSlot(entry)?.deferredMessages as unknown[] | undefined;
            }
          }
          export class SessionRuntime {
            constructor(private scheduler: SlotSchedulerAuthority) {}
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
            hit.kind === "ledger-identity-escape" &&
            hit.member === "leakDeferred" &&
            /deferredMessages/.test(hit.detail),
        ),
        kinds(violations).join("\n"),
      ).toBe(true);
    });

    it("passes spread, Array.from, slice, nested copies, and a fresh accumulator", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          type SlotState = { deferredMessages: Array<{ id: string }> };
          export class SlotSchedulerAuthority {
            private pendingQueue: Array<{ chatId: string }> = [];
            private slotBySession = new WeakMap<object, SlotState>();
            private peekSlot(entry: object): SlotState | undefined {
              return this.slotBySession.get(entry);
            }
            spreadCopy(): Array<{ chatId: string }> {
              return [...this.pendingQueue];
            }
            fromCopy(): Array<{ chatId: string }> {
              return Array.from(this.pendingQueue);
            }
            sliceCopy(): Array<{ chatId: string }> {
              return this.pendingQueue.slice();
            }
            nestedCopy(entry: object): Array<{ id: string }> {
              const state = this.peekSlot(entry);
              return state ? [...state.deferredMessages] : [];
            }
            accumulator(): string[] {
              const out: string[] = [];
              for (const item of this.pendingQueue) out.push(item.chatId);
              return out;
            }
          }
          export class SessionProjectionAuthority {
            private sessions = new Map<string, SessionEntry>();
            getSession(chatId: string): SessionEntry | undefined {
              return this.sessions.get(chatId);
            }
            snapshot(): Array<{ chatId: string }> {
              return [...this.sessions.entries()].map(([chatId]) => ({ chatId }));
            }
          }
          export class SessionRuntime {
            constructor(
              private scheduler: SlotSchedulerAuthority,
              private projection: SessionProjectionAuthority,
            ) {}
            note(entry: SessionEntry): string {
              return entry.chatId;
            }
          }
        `,
      };
      const { diagnostics, violations } = auditFixture(files);
      expect(diagnostics, diagnostics.join("\n")).toEqual([]);
      expect(violations, kinds(violations).join("\n")).toEqual([]);
    });

    it("passes observation iterators, frozen capability objects, and frozen snapshots", () => {
      const files = {
        "host.ts": `
          type SessionEntry = { chatId: string };
          type ReplayFenceWriter = { fence: (id: string) => void; clear: (id: string) => void };
          export class SessionProjectionAuthority {
            private sessions = new Map<string, SessionEntry>();
            sessionsValues(): IterableIterator<SessionEntry> {
              return this.sessions.values();
            }
            sessionsEntries(): IterableIterator<[string, SessionEntry]> {
              return this.sessions.entries();
            }
            activate(entry: SessionEntry): { chatId: string } {
              return Object.freeze({ chatId: entry.chatId });
            }
          }
          export class ResetReplayAuthority {
            private replayFence: { fence: (id: string) => void; clear: (id: string) => void } | null = null;
            createHandlerReplayFenceWriter(): ReplayFenceWriter | null {
              if (!this.replayFence) return null;
              const store = this.replayFence;
              return Object.freeze({
                fence: (id: string) => {
                  store.fence(id);
                },
                clear: (id: string) => {
                  store.clear(id);
                },
              });
            }
          }
          export class SessionRuntime {
            constructor(
              private projection: SessionProjectionAuthority,
              private reset: ResetReplayAuthority,
            ) {}
            note(entry: SessionEntry): string {
              return entry.chatId;
            }
          }
        `,
      };
      const { diagnostics, violations } = auditFixture(files);
      expect(diagnostics, diagnostics.join("\n")).toEqual([]);
      expect(violations, kinds(violations).join("\n")).toEqual([]);
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
