// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Hero } from "../hero.js";

describe("Landing hero", () => {
  it("offers OpenTag without changing the existing signup destination", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Hero />
      </MemoryRouter>,
    );

    expect(html).toContain('href="/opentag"');
    expect(html).toContain("Start with OpenTag");
    expect(html).toContain("OpenTag brings one AI agent into your Feishu team");
    expect(html).toContain('href="/login"');
    expect(html).toContain("Get Started");
  });
});
