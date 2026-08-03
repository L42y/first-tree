import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { meRoutes } from "../api/me.js";

type RegisteredRoute = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  options: unknown;
};

function routeCollector(): { app: FastifyInstance; routes: RegisteredRoute[] } {
  const routes: RegisteredRoute[] = [];
  const register =
    (method: RegisteredRoute["method"]) =>
    (...args: unknown[]) => {
      const [path, maybeOptions] = args;
      routes.push({
        method,
        path: String(path),
        options: args.length === 3 ? maybeOptions : undefined,
      });
    };
  return {
    app: {
      get: register("GET"),
      post: register("POST"),
      patch: register("PATCH"),
    } as unknown as FastifyInstance,
    routes,
  };
}

describe("BYO Context activation route protection", () => {
  it.each([
    "/me/context-activation/session-candidate/issue",
    "/me/context-activation/session-candidate/validate",
    "/me/context-activation/candidates/validate",
  ])("keeps the global actor-aware rate limiter on POST %s", async (path) => {
    const collector = routeCollector();
    await meRoutes(collector.app);
    const route = collector.routes.find((candidate) => candidate.method === "POST" && candidate.path === path);
    const config =
      route?.options && typeof route.options === "object" ? Reflect.get(route.options, "config") : undefined;

    expect(route).toBeDefined();
    expect(config).toBeDefined();
    expect(Reflect.has(config, "rateLimit")).toBe(true);
    expect(Reflect.get(config, "rateLimit")).toBeUndefined();
  });
});
