import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  FirstTreeHubSDK: vi.fn(),
  SdkError: class SdkError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
  })),
  getAgentContextTreeConfig: vi.fn(),
  setAgentContextTreeConfig: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  agentConfigSchema: {},
  clientConfigSchema: {},
  defaultConfigDir: vi.fn(),
  defaultDataDir: vi.fn(),
  loadAgents: vi.fn(),
  resolveConfigReadonly: vi.fn(),
}));

const bootstrapMocks = vi.hoisted(() => ({
  AuthRefreshFailedError: class AuthRefreshFailedError extends Error {},
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));

vi.mock("@first-tree/client", () => clientMocks);
vi.mock("@first-tree/shared/config", () => configMocks);
vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../cli/output.js", () => outputMocks);

describe("org context-tree local agent resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.FIRST_TREE_AGENT_ID;
    configMocks.defaultConfigDir.mockReturnValue("/tmp/first-tree-config");
    configMocks.defaultDataDir.mockReturnValue("/tmp/first-tree-data");
    configMocks.resolveConfigReadonly.mockReturnValue({});
    bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("token");
    bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
    clientMocks.getAgentContextTreeConfig.mockResolvedValue({
      bindingState: "bound",
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
      provider: "github",
    });
    clientMocks.setAgentContextTreeConfig.mockImplementation(async (input: { repo: string; branch?: string }) => ({
      repo: input.repo,
      branch: input.branch ?? "main",
    }));
    clientMocks.FirstTreeHubSDK.mockImplementation((config: { agentId?: string }) => ({
      agentId: config.agentId,
      getAgentContextTreeConfig: clientMocks.getAgentContextTreeConfig,
      setAgentContextTreeConfig: clientMocks.setAgentContextTreeConfig,
    }));
  });

  async function parse(options: string[] = []): Promise<void> {
    const { registerOrgContextTreeCommand } = await import("../commands/org/context-tree.js");
    const program = new Command();
    registerOrgContextTreeCommand(program);
    await program.parseAsync(["node", "first-tree", "context-tree", ...options]);
  }

  async function parseSet(options: string[] = []): Promise<void> {
    const { registerOrgContextTreeCommand } = await import("../commands/org/context-tree.js");
    const program = new Command();
    registerOrgContextTreeCommand(program);
    await program.parseAsync([
      "node",
      "first-tree",
      "context-tree",
      "set",
      "git@github.com:acme/context-tree.git",
      ...options,
    ]);
  }

  it("creates its logger after command preAction config is applied", async () => {
    const events: string[] = [];
    configMocks.loadAgents.mockReturnValue(new Map([["writer", { agentId: "agent-writer" }]]));
    clientMocks.createLogger.mockImplementationOnce(() => {
      events.push("logger");
      return { debug: vi.fn(), warn: vi.fn() };
    });

    const { registerOrgContextTreeCommand } = await import("../commands/org/context-tree.js");
    expect(clientMocks.createLogger).not.toHaveBeenCalled();

    const program = new Command();
    program.hook("preAction", () => {
      events.push("preAction");
    });
    registerOrgContextTreeCommand(program);
    await program.parseAsync(["node", "first-tree", "context-tree"]);

    expect(events).toEqual(["preAction", "logger"]);
    expect(clientMocks.createLogger).toHaveBeenCalledWith("context-tree-binding");
  });

  it("uses an explicit local agent name before environment or singleton selection", async () => {
    process.env.FIRST_TREE_AGENT_ID = "agent-env";
    configMocks.loadAgents.mockReturnValue(
      new Map([
        ["writer", { agentId: "agent-writer" }],
        ["runner", { agentId: "agent-env" }],
      ]),
    );

    await parse(["--agent", "writer"]);

    expect(clientMocks.FirstTreeHubSDK).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-writer" }));
    expect(outputMocks.success).toHaveBeenCalledWith({
      status: "bound",
      repo: "https://github.com/acme/context-tree.git",
      branch: "main",
    });
  });

  it("uses FIRST_TREE_AGENT_ID when no explicit name is supplied", async () => {
    process.env.FIRST_TREE_AGENT_ID = "agent-runner";
    configMocks.loadAgents.mockReturnValue(
      new Map([
        ["writer", { agentId: "agent-writer" }],
        ["runner", { agentId: "agent-runner" }],
      ]),
    );

    await parse();

    expect(clientMocks.FirstTreeHubSDK).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-runner" }));
  });

  it("uses the only local agent when no environment selection exists", async () => {
    configMocks.loadAgents.mockReturnValue(new Map([["writer", { agentId: "agent-writer" }]]));

    await parse();

    expect(clientMocks.FirstTreeHubSDK).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-writer" }));
  });

  it.each([
    ["unbound", { bindingState: "unbound", repo: null, branch: "main", provider: null }],
    ["invalid", { bindingState: "invalid", repo: null, branch: null, provider: null }],
  ] as const)("preserves explicit %s agent binding state", async (status, response) => {
    configMocks.loadAgents.mockReturnValue(new Map([["writer", { agentId: "agent-writer" }]]));
    clientMocks.getAgentContextTreeConfig.mockResolvedValueOnce(response);

    await parse();

    expect(outputMocks.success).toHaveBeenCalledWith({
      status,
      repo: null,
      branch: status === "unbound" ? "main" : null,
    });
  });

  it("fails closed on a legacy read response while keeping set responses backward-compatible", async () => {
    configMocks.loadAgents.mockReturnValue(new Map([["writer", { agentId: "agent-writer" }]]));
    clientMocks.getAgentContextTreeConfig.mockResolvedValueOnce({ repo: null, branch: null });

    await expect(parse()).rejects.toMatchObject({ code: "CONTEXT_TREE_UNREADABLE", exitCode: 1 });

    await expect(parseSet()).resolves.toBeUndefined();
    expect(outputMocks.success).toHaveBeenLastCalledWith({
      status: "bound",
      repo: "git@github.com:acme/context-tree.git",
      branch: "main",
    });
  });

  it("uses the explicit agent for set before an environment-selected agent", async () => {
    process.env.FIRST_TREE_AGENT_ID = "agent-env";
    configMocks.loadAgents.mockReturnValue(
      new Map([
        ["writer", { agentId: "agent-writer" }],
        ["runner", { agentId: "agent-env" }],
      ]),
    );

    await parseSet(["--agent", "writer"]);

    expect(clientMocks.FirstTreeHubSDK).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-writer" }));
    expect(clientMocks.setAgentContextTreeConfig).toHaveBeenCalledWith({
      repo: "git@github.com:acme/context-tree.git",
    });
    expect(clientMocks.getAgentContextTreeConfig).not.toHaveBeenCalled();
  });

  it("uses the environment or unique local agent for set when no explicit name is supplied", async () => {
    process.env.FIRST_TREE_AGENT_ID = "agent-runner";
    configMocks.loadAgents.mockReturnValue(
      new Map([
        ["writer", { agentId: "agent-writer" }],
        ["runner", { agentId: "agent-runner" }],
      ]),
    );
    await parseSet();
    expect(clientMocks.FirstTreeHubSDK).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "agent-runner" }));

    delete process.env.FIRST_TREE_AGENT_ID;
    configMocks.loadAgents.mockReturnValue(new Map([["writer", { agentId: "agent-writer" }]]));
    await parseSet();
    expect(clientMocks.FirstTreeHubSDK).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "agent-writer" }));
  });

  it("rejects an explicitly empty set agent instead of falling through to environment selection", async () => {
    process.env.FIRST_TREE_AGENT_ID = "agent-writer";
    configMocks.loadAgents.mockReturnValue(new Map([["writer", { agentId: "agent-writer" }]]));

    await expect(parseSet(["--agent", ""])).rejects.toMatchObject({ code: "UNKNOWN_AGENT", exitCode: 2 });

    expect(clientMocks.FirstTreeHubSDK).not.toHaveBeenCalled();
    expect(bootstrapMocks.ensureFreshAccessToken).not.toHaveBeenCalled();
    expect(outputMocks.fail).toHaveBeenCalledWith("UNKNOWN_AGENT", expect.any(String), 2);
  });

  it.each([
    ["missing", new Map(), undefined, "MISSING_AGENT"],
    [
      "ambiguous",
      new Map([
        ["writer", { agentId: "agent-writer" }],
        ["runner", { agentId: "agent-runner" }],
      ]),
      undefined,
      "AMBIGUOUS_AGENT",
    ],
    [
      "environment mismatch",
      new Map([["writer", { agentId: "agent-writer" }]]),
      "agent-missing",
      "ENV_AGENT_NOT_LOCAL",
    ],
    ["unknown explicit", new Map([["writer", { agentId: "agent-writer" }]]), undefined, "UNKNOWN_AGENT"],
  ] as const)("fails %s before creating an SDK or making a request", async (_label, agents, envAgentId, code) => {
    configMocks.loadAgents.mockReturnValue(agents);
    if (envAgentId) process.env.FIRST_TREE_AGENT_ID = envAgentId;
    const args = code === "UNKNOWN_AGENT" ? ["--agent", "missing"] : [];

    await expect(parse(args)).rejects.toMatchObject({ code, exitCode: 2 });

    expect(clientMocks.FirstTreeHubSDK).not.toHaveBeenCalled();
    expect(bootstrapMocks.ensureFreshAccessToken).not.toHaveBeenCalled();
    expect(outputMocks.fail).toHaveBeenCalledWith(code, expect.any(String), 2);
  });

  it.each([
    ["missing", new Map(), undefined, "MISSING_AGENT"],
    [
      "ambiguous",
      new Map([
        ["writer", { agentId: "agent-writer" }],
        ["runner", { agentId: "agent-runner" }],
      ]),
      undefined,
      "AMBIGUOUS_AGENT",
    ],
    [
      "environment mismatch",
      new Map([["writer", { agentId: "agent-writer" }]]),
      "agent-missing",
      "ENV_AGENT_NOT_LOCAL",
    ],
    ["unknown explicit", new Map([["writer", { agentId: "agent-writer" }]]), undefined, "UNKNOWN_AGENT"],
  ] as const)("set fails %s selection before constructing an SDK", async (_label, agents, envAgentId, code) => {
    configMocks.loadAgents.mockReturnValue(agents);
    if (envAgentId) process.env.FIRST_TREE_AGENT_ID = envAgentId;
    const args = code === "UNKNOWN_AGENT" ? ["--agent", "missing"] : [];

    await expect(parseSet(args)).rejects.toMatchObject({ code, exitCode: 2 });

    expect(clientMocks.FirstTreeHubSDK).not.toHaveBeenCalled();
    expect(bootstrapMocks.ensureFreshAccessToken).not.toHaveBeenCalled();
    expect(outputMocks.fail).toHaveBeenCalledWith(code, expect.any(String), 2);
  });
});
