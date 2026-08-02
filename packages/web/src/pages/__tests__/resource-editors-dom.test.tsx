// @vitest-environment happy-dom

import type { ResourceRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: { role: "admin" as "admin" | "member", organizationId: "org-1" as string | null, meLoaded: true },
}));

const resourceMocks = vi.hoisted(() => ({
  listTeamResources: vi.fn(),
  createTeamResource: vi.fn(),
  updateResource: vi.fn(),
  retireResource: vi.fn(),
  previewOrgResourceImpact: vi.fn(),
  previewResourceImpact: vi.fn(),
}));
const attachmentMocks = vi.hoisted(() => ({
  uploadAttachment: vi.fn(),
}));

vi.mock("../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../api/resources.js", () => resourceMocks);
vi.mock("../../api/attachments.js", () => attachmentMocks);

const NOW = "2026-06-03T00:00:00.000Z";

function row(over: Partial<ResourceRow> & Pick<ResourceRow, "id" | "type" | "name" | "payload">): ResourceRow {
  return {
    organizationId: "org-1",
    scope: "team",
    ownerAgentId: null,
    repoCanonicalKey: null,
    defaultEnabled: "available",
    originTemplateId: null,
    status: "active",
    createdBy: "u",
    updatedBy: "u",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
    bundleAttachmentId: over.bundleAttachmentId ?? null,
  };
}

const GITHUB_MCP = row({
  id: "mcp-1",
  type: "mcp",
  name: "github",
  defaultEnabled: "recommended",
  payload: { name: "github", transport: "http", url: "https://mcp.example.com/github" },
});

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * Poll for a button by text, flushing between attempts. Radix Popover / Dialog
 * render their contents through a portal on an async tick, so a single flush()
 * after the trigger click can race the option appearing (flaky under slower
 * CI timing). Wait until it's there instead of assuming one tick is enough.
 */
async function waitForButton(text: string): Promise<HTMLButtonElement> {
  for (let i = 0; i < 50; i++) {
    const found = byText(text);
    if (found) return found;
    await flush();
  }
  throw new Error(`waitForButton: "${text}" never appeared`);
}

/**
 * Close any open overlay (Radix Dialog / our Popover both dismiss on Escape).
 * Call before unmounting a test that left a dialog open, so the overlay's
 * cleanup runs while mounted instead of racing unmount and leaking body
 * attributes (pointer-events / scroll-lock) into the next test.
 */
async function pressEscape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await flush();
}

/** Wait until a button is present AND enabled, then click it. */
async function clickWhenEnabled(text: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const found = byText(text);
    if (found && !found.disabled) {
      await click(found);
      return;
    }
    await flush();
  }
  throw new Error(`clickWhenEnabled: "${text}" never became enabled`);
}

async function render(): Promise<{ root: Root }> {
  // Mount the shared sections component with every type: the machinery under
  // test is type-agnostic, and the page-level split (repo in the shared
  // Integrations code-access area, the rest on Settings → Resources) is
  // covered by the page smoke tests.
  const { ResourceTypeSections } = await import("../settings/resource-sections.js");
  const { RESOURCE_TYPES } = await import("../settings/resource-editors.js");
  const { ToastProvider } = await import("../../components/ui/toast.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={createClient()}>
        <ToastProvider>
          <ResourceTypeSections types={RESOURCE_TYPES} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return { root };
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("click: element not found");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setInputValue(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  });
  await flush();
}

function byText(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}
function byAria(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label);
}
function input(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`input #${id} not found`);
  return el;
}
async function selectOption(triggerId: string, label: string): Promise<void> {
  await click(document.getElementById(triggerId));
  const opt = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === label);
  await click(opt);
}
function lastByPlaceholder(placeholder: string): HTMLInputElement {
  const els = [...document.body.querySelectorAll(`input[placeholder="${placeholder}"]`)];
  const el = els[els.length - 1];
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input[placeholder=${placeholder}]`);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  // Radix Dialog (+ react-remove-scroll) sets attributes/styles on <body>/<html>
  // while open — pointer-events, aria-hidden, inert, data-scroll-locked. In
  // happy-dom these can survive a root.unmount(), so a dialog test would poison
  // the next test's portal rendering (e.g. the Add-resource popover never
  // mounting). Scrub them so every test starts from a clean document.
  for (const el of [document.body, document.documentElement]) {
    el.removeAttribute("style");
    el.removeAttribute("aria-hidden");
    el.removeAttribute("inert");
    el.removeAttribute("data-scroll-locked");
    el.removeAttribute("data-aria-hidden");
  }
  authMock.value = { role: "admin", organizationId: "org-1", meLoaded: true };
  resourceMocks.listTeamResources.mockResolvedValue([GITHUB_MCP]);
  resourceMocks.createTeamResource.mockResolvedValue(
    row({ id: "new", type: "repo", name: "x", payload: { url: "x" } }),
  );
  resourceMocks.updateResource.mockResolvedValue(GITHUB_MCP);
  resourceMocks.retireResource.mockResolvedValue({ affectedAgentCount: 0, promptOverflowAgentCount: 0, agents: [] });
  resourceMocks.previewOrgResourceImpact.mockResolvedValue({
    affectedAgentCount: 0,
    promptOverflowAgentCount: 0,
    agents: [],
  });
  resourceMocks.previewResourceImpact.mockResolvedValue({
    affectedAgentCount: 0,
    promptOverflowAgentCount: 0,
    agents: [],
  });
  attachmentMocks.uploadAttachment.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000301",
    mimeType: "application/zip",
    filename: "skill.zip",
    sizeBytes: 100,
    uploadedBy: "human-1",
    createdAt: NOW,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resource editors", () => {
  it("creates a repo from the URL, deriving the name (no name field)", async () => {
    const { root } = await render();
    // Section-local entry: each section's "+" icon (aria "Add <Type>") opens that type's editor.
    await click(byAria("Add Repo"));

    // No Name field — the display name is derived from the URL.
    expect(document.getElementById("repo-name")).toBeNull();
    const url = document.getElementById("repo-url");
    expect(url).toBeTruthy();
    if (!(url instanceof HTMLInputElement)) throw new Error("inputs");
    await setInputValue(url, "git@github.com:acme/web.git");

    await click(byText("Create"));

    expect(resourceMocks.createTeamResource).toHaveBeenCalledTimes(1);
    // Assert on the first arg only — react-query passes its own context as a
    // trailing arg to mutationFn. Name is derived (owner/repo); the scp-like URL
    // is already valid so it is saved unchanged.
    expect(resourceMocks.createTeamResource.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ type: "repo", name: "acme/web", payload: { url: "git@github.com:acme/web.git" } }),
    );
    await act(async () => root.unmount());
  });

  it("normalizes a scheme-less repo URL and derives the name on create", async () => {
    const { root } = await render();
    await click(byAria("Add Repo"));
    const url = document.getElementById("repo-url");
    if (!(url instanceof HTMLInputElement)) throw new Error("inputs");
    await setInputValue(url, "github.com/acme/web");

    await click(byText("Create"));

    expect(resourceMocks.createTeamResource.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ type: "repo", name: "acme/web", payload: { url: "https://github.com/acme/web" } }),
    );
    await act(async () => root.unmount());
  });

  it("opens an existing mcp resource prefilled for edit and saves via updateResource", async () => {
    const { root } = await render();
    await click(byAria("Edit github"));

    // Prefilled from the existing resource (assert exact value by field id —
    // not a URL substring scan, which CodeQL flags).
    expect(input("mcp-url").value).toBe("https://mcp.example.com/github");
    // Edit mode → the primary action is "Save", not "Create".
    expect(byText("Save")).toBeTruthy();
    expect(byText("Create")).toBeUndefined();

    await click(byText("Save"));
    expect(resourceMocks.updateResource).toHaveBeenCalledTimes(1);
    expect(resourceMocks.updateResource.mock.calls[0]?.[0]).toBe("mcp-1");
    // The edit round-trips the resource's payload unchanged (no transport/name drop).
    expect(resourceMocks.updateResource.mock.calls[0]?.[1]?.payload).toEqual({
      name: "github",
      transport: "http",
      url: "https://mcp.example.com/github",
    });
    expect(resourceMocks.createTeamResource).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("edits an mcp whose display name differs from its server id (no-op safe)", async () => {
    // Migrated/API resource: outer name "Team tools" vs payload.name "team-tools".
    resourceMocks.listTeamResources.mockResolvedValue([
      row({
        id: "mcp-2",
        type: "mcp",
        name: "Team tools",
        payload: { name: "team-tools", transport: "stdio", command: "npx" },
      }),
    ]);
    const { root } = await render();
    await click(byAria("Edit Team tools"));

    // Server-id field prefills from payload.name (valid), not the display name.
    expect(input("mcp-name").value).toBe("team-tools");
    await click(byText("Save")); // no-op save must not be blocked

    expect(resourceMocks.updateResource).toHaveBeenCalledTimes(1);
    const [id, body] = resourceMocks.updateResource.mock.calls[0] ?? [];
    expect(id).toBe("mcp-2");
    expect(body?.name).toBe("Team tools"); // display name preserved
    expect(body?.payload).toEqual({ name: "team-tools", transport: "stdio", command: "npx" });
    await act(async () => root.unmount());
  });

  it("creates a stdio mcp with command + args", async () => {
    const { root } = await render();
    await click(byAria("Add MCP"));
    await setInputValue(input("mcp-name"), "github");
    await setInputValue(input("mcp-command"), "npx");
    await click(byText("Add")); // add an args row
    await setInputValue(lastByPlaceholder("--flag"), "-y");
    await click(byText("Create"));

    expect(resourceMocks.createTeamResource.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: "mcp",
        payload: { name: "github", transport: "stdio", command: "npx", args: ["-y"] },
      }),
    );
    await act(async () => root.unmount());
  });

  it("creates an http mcp with url and no headers key (no-secret schema)", async () => {
    const { root } = await render();
    await click(byAria("Add MCP"));
    await selectOption("mcp-transport", "http");
    await setInputValue(input("mcp-name"), "remote");
    await setInputValue(input("mcp-url"), "https://x.example.com/sse");
    await click(byText("Create"));

    const payload = resourceMocks.createTeamResource.mock.calls[0]?.[0]?.payload;
    expect(payload).toEqual({ name: "remote", transport: "http", url: "https://x.example.com/sse" });
    expect("headers" in payload).toBe(false);
    await act(async () => root.unmount());
  });

  it("uploads pasted SKILL.md as a bundle and creates a bundle-backed skill", async () => {
    const { root } = await render();
    await click(byAria("Add Skill"));
    const body = document.getElementById("skill-markdown");
    if (!(body instanceof HTMLTextAreaElement)) throw new Error("skill-markdown");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        body,
        "---\nname: rel\ndescription: Release helper\n---\n\nhello world",
      );
      body.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    expect(document.getElementById("skill-name")).toBeNull();
    expect(document.body.textContent).toContain("Skill source");
    expect(document.body.textContent).not.toContain("Metadata");
    await click(byText("Create"));
    await flush();

    expect(attachmentMocks.uploadAttachment).toHaveBeenCalledWith(expect.any(Blob), "skill.zip");
    expect(resourceMocks.createTeamResource.mock.calls[0]?.[0]).toEqual({
      type: "skill",
      defaultEnabled: "available",
      bundleAttachmentId: "00000000-0000-4000-8000-000000000301",
    });
    await act(async () => root.unmount());
  });

  it("keeps an existing Skill bundle on edit and preserves metadata in the replacement draft", async () => {
    const bundleAttachmentId = "00000000-0000-4000-8000-000000000302";
    resourceMocks.listTeamResources.mockResolvedValue([
      row({
        id: "skill-1",
        type: "skill",
        name: "release",
        bundleAttachmentId,
        payload: {
          name: "release",
          namespace: "team",
          description: "Release helper",
          body: "Ship carefully.",
          metadata: { owner: "platform", strict: true },
        },
      }),
    ]);
    const { root } = await render();
    await click(byAria("Edit release"));
    await click(byText("Replace bundle"));
    const markdown = document.getElementById("skill-markdown");
    if (!(markdown instanceof HTMLTextAreaElement)) throw new Error("skill-markdown");
    expect(markdown.value).toContain('namespace: "team"');
    expect(markdown.value).toContain('metadata: {"owner":"platform","strict":true}');

    await click(byText("Keep current bundle"));
    await click(byText("Save"));
    expect(attachmentMocks.uploadAttachment).not.toHaveBeenCalled();
    expect(resourceMocks.updateResource).toHaveBeenCalledWith("skill-1", {
      defaultEnabled: "available",
      bundleAttachmentId,
    });
    await act(async () => root.unmount());
  });

  it("blocks an invalid mcp server name client-side (no API call)", async () => {
    const { root } = await render();
    await click(byAria("Add MCP"));
    await setInputValue(input("mcp-name"), "my server"); // space → invalid server id
    await setInputValue(input("mcp-command"), "npx");
    await click(byText("Create"));

    // Validation blocks the call and surfaces a message; nothing is sent.
    expect(resourceMocks.createTeamResource).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Name must be");
    await act(async () => root.unmount());
  });

  it("hides add / edit / retire affordances for members but keeps preview", async () => {
    authMock.value = { role: "member", organizationId: "org-1", meLoaded: true };
    const { root } = await render();
    // No per-section add button (e.g. the MCP section's "+" / "Add MCP") for members.
    expect(byAria("Add MCP")).toBeUndefined();
    expect(byAria("Edit github")).toBeUndefined();
    expect(byAria("Retire github")).toBeUndefined();
    // Read-only preview is available to every member.
    expect(byAria("Preview github")).toBeTruthy();
    await act(async () => root.unmount());
  });

  it("requires a confirm step before retiring (cancel does not retire)", async () => {
    const { root } = await render();
    // Trash no longer retires on one click — it opens a confirm dialog.
    await click(byAria("Retire github"));
    expect(resourceMocks.retireResource).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Retire "github"?');

    // Cancel backs out without retiring.
    await click(byText("Cancel"));
    expect(resourceMocks.retireResource).not.toHaveBeenCalled();

    // Re-open and confirm → retire fires once with the resource id. The confirm
    // re-disables briefly while the impact re-fetches, so wait for it to enable.
    await click(byAria("Retire github"));
    await clickWhenEnabled("Retire");
    expect(resourceMocks.retireResource).toHaveBeenCalledTimes(1);
    expect(resourceMocks.retireResource.mock.calls[0]?.[0]).toBe("mcp-1");
    await act(async () => root.unmount());
  });

  it("re-checks impact on every open — never confirms against a cached stale count", async () => {
    // A fresh controllable promise per call lets us prove the second open
    // re-fetches (gcTime: 0) instead of reusing the first open's cached count.
    const resolvers: Array<(v: { affectedAgentCount: number; promptOverflowAgentCount: number; agents: [] }) => void> =
      [];
    resourceMocks.previewResourceImpact.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { root } = await render();

    // Open #1: pending → disabled; resolve → enabled.
    await click(byAria("Retire github"));
    expect(byText("Retire")?.disabled).toBe(true);
    await act(async () => {
      resolvers[0]?.({ affectedAgentCount: 1, promptOverflowAgentCount: 0, agents: [] });
    });
    await flush();
    expect(byText("Retire")?.disabled).toBe(false);
    await click(byText("Cancel"));

    // Reopen: must re-fetch and re-disable (not reuse the cached count), so a
    // background refetch can't leave a stale-but-clickable confirm.
    await click(byAria("Retire github"));
    expect(resourceMocks.previewResourceImpact).toHaveBeenCalledTimes(2);
    expect(byText("Retire")?.disabled).toBe(true);
    await act(async () => {
      resolvers[1]?.({ affectedAgentCount: 1, promptOverflowAgentCount: 0, agents: [] });
    });
    await flush();
    expect(byText("Retire")?.disabled).toBe(false);
    await pressEscape();
    await act(async () => root.unmount());
  });

  it("disables the confirm button until the impact check resolves", async () => {
    // Hold the impact check open so we can observe the pending state.
    let resolveImpact: (v: { affectedAgentCount: number; promptOverflowAgentCount: number; agents: [] }) => void =
      () => {};
    resourceMocks.previewResourceImpact.mockReturnValue(
      new Promise((r) => {
        resolveImpact = r;
      }),
    );
    const { root } = await render();
    await click(byAria("Retire github"));
    // While "Checking impact…", the confirm is disabled — can't retire blind.
    expect(byText("Retire")?.disabled).toBe(true);
    expect(resourceMocks.retireResource).not.toHaveBeenCalled();

    // Once the count is in, the button enables.
    await act(async () => {
      resolveImpact({ affectedAgentCount: 2, promptOverflowAgentCount: 0, agents: [] });
    });
    await flush();
    expect(byText("Retire")?.disabled).toBe(false);
    await pressEscape();
    await act(async () => root.unmount());
  });

  it("opens a read-only preview from the eye icon", async () => {
    resourceMocks.listTeamResources.mockResolvedValue([
      row({
        id: "prompt-1",
        type: "prompt",
        name: "house style",
        payload: { body: "# Voice\nWrite plainly.", description: "Tone guide" },
      }),
    ]);
    const { root } = await render();
    await click(byAria("Preview house style"));
    // Read-only detail shows the full body content, not a one-line summary.
    expect(document.body.textContent).toContain("Write plainly.");
    // No edit controls inside the preview.
    expect(document.getElementById("prompt-body")).toBeNull();
    await pressEscape();
    await act(async () => root.unmount());
  });

  it("warns on prompt overflow before saving, then saves on confirm", async () => {
    resourceMocks.previewOrgResourceImpact.mockResolvedValue({
      affectedAgentCount: 3,
      promptOverflowAgentCount: 2,
      agents: [],
    });
    // Render the prompt editor directly rather than driving the Add-resource
    // Popover. The assertion target is the overflow save flow, not menu
    // navigation (already covered by the create tests above) — and opening a
    // portal-anchored Popover after the Dialog-heavy tests in this file is a
    // CI-only teardown-leak hazard. Mounting the editor sidesteps it entirely.
    const { ResourceEditor } = await import("../settings/resource-editors.js");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={createClient()}>
          <ResourceEditor state={{ mode: "create", type: "prompt" }} onClose={() => {}} />
        </QueryClientProvider>,
      );
    });
    await flush();

    const body = document.getElementById("prompt-body");
    if (!(body instanceof HTMLTextAreaElement)) throw new Error("prompt-body");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(body, "long body");
      body.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });

    // First click runs the silent overflow check → warns, does NOT save yet.
    await click(byText("Create"));
    // The check is async (impact preview) — wait for the warning to surface.
    await waitForButton("Save anyway");
    expect(resourceMocks.createTeamResource).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("exceed the prompt budget for 2 agents");

    // Second click ("Save anyway") commits.
    await click(await waitForButton("Save anyway"));
    expect(resourceMocks.createTeamResource).toHaveBeenCalledTimes(1);
    await pressEscape();
    await act(async () => root.unmount());
  });

  it("renders app-owned English copy for the Skill file picker, not the locale-dependent native input", async () => {
    const { root } = await render();
    await click(byAria("Add Skill"));
    await selectOption("skill-input-mode", "Upload ZIP or SKILL.md");

    // The native input stays mounted (it owns accept + the change event) but is
    // hidden; its browser-localized button text must never be what the user sees.
    const fileInput = input("skill-file");
    expect(fileInput.type).toBe("file");
    expect(fileInput.className).toContain("hidden");
    expect(fileInput.getAttribute("accept")).toBe(".zip,.md,application/zip,text/markdown,text/plain");

    // App-owned English trigger + empty state, not type=submit.
    const choose = byText("Choose file");
    expect(choose).toBeTruthy();
    expect(choose?.type).toBe("button");
    expect(document.body.textContent).toContain("No file selected");
    expect(document.body.textContent).not.toContain("未选择任何文件");

    // The hidden input's accessible value is gone with it, so the trigger must
    // be tied to the status text (aria-describedby) and that text must be a
    // live status that announces the selection after the dialog closes.
    const status = document.getElementById("skill-file-status");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.textContent?.trim()).toBe("No file selected");
    expect(choose?.getAttribute("aria-describedby")).toBe("skill-file-status");

    // The button opens the hidden input's picker.
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    await click(choose);
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();

    // After a selection, the chosen file name is rendered by the app.
    const file = new File(["---\nname: rel\n---"], "SKILL.md", { type: "text/markdown" });
    await act(async () => {
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).toContain("SKILL.md");
    expect(document.body.textContent).not.toContain("No file selected");
    // The live status itself carries the selection (not just visible text).
    expect(document.getElementById("skill-file-status")?.textContent?.trim()).toBe("SKILL.md");
    await pressEscape();
    await act(async () => root.unmount());
  });

  it("renders app-owned English copy for the Skill folder picker and reports the selection count", async () => {
    const { root } = await render();
    await click(byAria("Add Skill"));
    await selectOption("skill-input-mode", "Choose Skill folder");

    const folderInput = input("skill-folder");
    expect(folderInput.type).toBe("file");
    expect(folderInput.className).toContain("hidden");
    expect(folderInput.multiple).toBe(true);
    expect(folderInput.getAttribute("webkitdirectory")).not.toBeNull();

    const choose = byText("Choose folder");
    expect(choose).toBeTruthy();
    expect(choose?.type).toBe("button");
    expect(document.body.textContent).toContain("No folder selected");

    const folderStatus = document.getElementById("skill-folder-status");
    expect(folderStatus?.getAttribute("role")).toBe("status");
    expect(folderStatus?.textContent?.trim()).toBe("No folder selected");
    expect(choose?.getAttribute("aria-describedby")).toBe("skill-folder-status");

    // The button opens the hidden input's picker (same contract as file mode).
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    await click(choose);
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();

    await act(async () => {
      Object.defineProperty(folderInput, "files", {
        value: [new File(["a"], "SKILL.md"), new File(["b"], "helper.sh")],
        configurable: true,
      });
      folderInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).toContain("2 files selected");
    expect(document.body.textContent).not.toContain("No folder selected");
    expect(document.getElementById("skill-folder-status")?.textContent?.trim()).toBe("2 files selected");
    await pressEscape();
    await act(async () => root.unmount());
  });
});
