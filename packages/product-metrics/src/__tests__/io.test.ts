import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadActivityCsv, loadJourneyCsv, loadVisitCsv } from "../io.js";

type CsvLoader = (filePath: string) => Promise<unknown[]>;

async function withCsv(content: string, assertion: (filePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "first-tree-product-metrics-"));
  const filePath = join(directory, "input.csv");
  try {
    await writeFile(filePath, content, "utf8");
    await assertion(filePath);
  } finally {
    await rm(directory, { recursive: true });
  }
}

const loaderCases: Array<{ name: string; loader: CsvLoader; headers: string[] }> = [
  {
    name: "journey",
    loader: loadJourneyCsv,
    headers: [
      "user_id",
      "account_authenticated_at",
      "client_ready_at",
      "client_ready_mode",
      "agent_ready_at",
      "agent_ready_mode",
      "bootstrap_received_at",
      "first_user_message_at",
    ],
  },
  {
    name: "activity",
    loader: loadActivityCsv,
    headers: ["user_id", "occurred_at", "message_count"],
  },
  {
    name: "visit",
    loader: loadVisitCsv,
    headers: ["visitor_id", "visited_at", "is_first_visit", "user_id"],
  },
];

describe.each(loaderCases)("$name CSV schema validation", ({ name, loader, headers }) => {
  it("rejects an empty export", async () => {
    await withCsv("", async (filePath) => {
      await expect(loader(filePath)).rejects.toThrow(`${name} CSV is empty`);
    });
  });

  it("rejects an unrelated header-only export", async () => {
    await withCsv("wrong_header\n", async (filePath) => {
      await expect(loader(filePath)).rejects.toThrow("missing required header");
    });
  });

  it("rejects a zero-row export with a missing column", async () => {
    await withCsv(`${headers.slice(0, -1).join(",")}\n`, async (filePath) => {
      await expect(loader(filePath)).rejects.toThrow(headers[headers.length - 1] ?? "missing required header");
    });
  });

  it("accepts a schema-correct header-only export as an empty data set", async () => {
    await withCsv(`${headers.join(",")}\n`, async (filePath) => {
      await expect(loader(filePath)).resolves.toEqual([]);
    });
  });
});
