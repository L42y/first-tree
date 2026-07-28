import { describe, expect, it } from "vitest";
import { confirmTeamRepositoriesSchema } from "../schemas/resource.js";

describe("confirmTeamRepositoriesSchema", () => {
  it("accepts canonical optimistic keys and exact repository inputs", () => {
    expect(
      confirmTeamRepositoriesSchema.parse({
        expectedActiveRepositoryKeys: ["github.com/acme/api"],
        repositories: [{ name: "App", url: "https://github.com/acme/app.git" }],
      }),
    ).toMatchObject({
      expectedActiveRepositoryKeys: ["github.com/acme/api"],
    });
  });

  it("rejects duplicate canonical repositories and non-canonical expected keys", () => {
    expect(() =>
      confirmTeamRepositoriesSchema.parse({
        expectedActiveRepositoryKeys: ["GitHub.com/Acme/API"],
        repositories: [
          { name: "App", url: "https://github.com/acme/app.git" },
          { name: "Same", url: "git@github.com:ACME/APP.git" },
        ],
      }),
    ).toThrow();
  });
});
