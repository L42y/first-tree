// @vitest-environment happy-dom

import type { MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { NO_TEAM_ENTRY_PATH, RequireAuth } from "../require-auth.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: {
    isAuthenticated: false,
    meLoaded: false,
    user: null,
    memberships: [] as MeMembership[],
    currentMembership: null as MeMembership | null,
    hasNoTeam: false,
    organizationId: null,
    memberId: null,
    role: null,
    agentId: null,
    teamDisplayName: null,
    orgHasOtherMembers: false,
    onboardingStep: null,
    onboardingDismissedAt: null,
    onboardingCompletedAt: null,
    dismissOnboarding: async () => undefined,
    restoreOnboarding: async () => undefined,
    markOnboardingCompleted: async () => undefined,
    applyOnboardingKickoffStamp: () => undefined,
    login: async () => undefined,
    adoptTokens: async () => undefined,
    selectOrganization: async () => undefined,
    refreshMe: async () => undefined,
    logout: () => undefined,
  },
}));

vi.mock("../auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));

vi.mock("../../pages/landing/index.js", () => ({
  LandingPage: () => <div>Landing content</div>,
}));

function renderRoute(path: string): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route index element={<div>Dashboard</div>} />
            <Route path="/settings" element={<div>Settings</div>} />
            <Route path="/settings/account" element={<div>Account settings</div>} />
            <Route path="/quickstart" element={<div>Quickstart</div>} />
          </Route>
          <Route path="/login" element={<div>Login</div>} />
          <Route path="/templates" element={<div>Template library</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/**
 * `renderToStaticMarkup` does not follow `<Navigate>` — a redirect renders as
 * an empty string. Mount for real when the DESTINATION is what is under test.
 */
function renderRouteInDom(path: string): string {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient();
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route element={<RequireAuth />}>
              <Route index element={<div>Dashboard</div>} />
              <Route path="/settings" element={<div>Settings</div>} />
              <Route path="/settings/account" element={<div>Account settings</div>} />
              <Route path="/quickstart" element={<div>Quickstart</div>} />
            </Route>
            <Route path="/login" element={<div>Login</div>} />
            <Route path={NO_TEAM_ENTRY_PATH} element={<div>Template library</div>} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  const html = container.innerHTML;
  act(() => root.unmount());
  container.remove();
  return html;
}

describe("RequireAuth", () => {
  it("renders public landing on unauthenticated root", () => {
    authMock.value = { ...authMock.value, isAuthenticated: false, meLoaded: false };
    expect(renderRoute("/")).toContain("landing-marketing");
  });

  it("redirects unauthenticated deep links to login", () => {
    authMock.value = { ...authMock.value, isAuthenticated: false, meLoaded: false };
    expect(renderRoute("/settings")).toBe("");
  });

  it("blocks authenticated routes until /me is loaded, then renders children", () => {
    authMock.value = { ...authMock.value, isAuthenticated: true, meLoaded: false };
    expect(renderRoute("/settings")).not.toContain("Settings");

    authMock.value = { ...authMock.value, isAuthenticated: true, meLoaded: true };
    expect(renderRoute("/settings")).toContain("Settings");
  });

  // Everything behind this guard is org-scoped, and the first org-scoped query
  // to mount throws without a selected org. A Team-less user goes to the
  // Team-less entry instead.
  it("sends an authenticated user with no Team to the Team-less entry", () => {
    authMock.value = { ...authMock.value, isAuthenticated: true, meLoaded: true, hasNoTeam: true };
    expect(renderRouteInDom("/settings")).toContain("Template library");
    expect(renderRouteInDom("/settings")).not.toContain("Settings");
    // Including the workspace root, which would otherwise mount the dashboard.
    expect(renderRouteInDom("/")).toContain("Template library");
    expect(renderRouteInDom("/")).not.toContain("Dashboard");
  });

  it("keeps user-scoped Quickstart and account routes reachable without a Team", () => {
    authMock.value = { ...authMock.value, isAuthenticated: true, meLoaded: true, hasNoTeam: true };

    expect(renderRouteInDom("/quickstart?campaign=production-scan")).toContain("Quickstart");
    expect(renderRouteInDom("/settings/account")).toContain("Account settings");
  });

  it("keeps a member with Teams in the workspace even while /me has not proven authority", () => {
    // `hasNoTeam` is false whenever /me is not authoritative, so a transport
    // failure that leaves `memberships` empty never ejects a real member.
    authMock.value = { ...authMock.value, isAuthenticated: true, meLoaded: true, hasNoTeam: false };
    expect(renderRouteInDom("/settings")).toContain("Settings");
  });

  it("names an entry destination that is not itself behind this guard", () => {
    // A destination inside the guard would redirect to itself forever.
    expect(NO_TEAM_ENTRY_PATH).toBe("/templates");
  });
});
