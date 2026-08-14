import { describe, expect, it } from "vitest";
import { safeFeishuErrorContext } from "../services/integrations/feishu/safe-error.js";

describe("Feishu error logging", () => {
  it("keeps raw transport credential fields out of the serialized log context", () => {
    const error = Object.assign(new Error('Request failed with Bearer tenant-secret and "app_secret":"bot-secret"'), {
      code: "transport_error",
      config: {
        headers: { Authorization: "Bearer tenant-secret" },
        data: { app_secret: "bot-secret" },
      },
      cause: { request: { headers: { Authorization: "Bearer nested-secret" } } },
    });

    const output = JSON.stringify(safeFeishuErrorContext(error));

    expect(output).toContain("transport_error");
    expect(output).not.toMatch(/tenant-secret|bot-secret|nested-secret/);
    expect(output).toContain("[REDACTED]");
  });
});
