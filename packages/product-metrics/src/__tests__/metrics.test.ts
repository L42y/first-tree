import { describe, expect, it } from "vitest";
import { depthStats, generateProductMetricReport } from "../metrics.js";
import type { ActivityFact, ProductMetricInput, UserJourneyFact, VisitorVisitFact } from "../types.js";

function journey(userId: string, registrationDate: string): UserJourneyFact {
  return {
    userId,
    accountAuthenticatedAt: `${registrationDate}T08:00:00.000Z`,
    clientReadyAt: `${registrationDate}T08:01:00.000Z`,
    clientReadyMode: "connected",
    agentReadyAt: `${registrationDate}T08:02:00.000Z`,
    agentReadyMode: "created",
    bootstrapReceivedAt: `${registrationDate}T08:03:00.000Z`,
    firstUserMessageAt: `${registrationDate}T08:04:00.000Z`,
  };
}

function input(overrides: Partial<ProductMetricInput> = {}): ProductMetricInput {
  return {
    version: 1,
    asOf: "2026-02-12T12:00:00.000Z",
    timeZone: "UTC",
    visitorData: "unavailable",
    visitorIdentityBridge: "unavailable",
    journeys: [],
    activity: [],
    visits: [],
    ...overrides,
  };
}

describe("formal registration", () => {
  it("does not register a bootstrap-only user", () => {
    const bootstrapOnly = journey("bootstrap-only", "2026-02-10");
    bootstrapOnly.firstUserMessageAt = null;

    const report = generateProductMetricReport(input({ journeys: [bootstrapOnly] }));

    expect(report.signedInFunnels.yesterday.stages.at(-1)?.users).toBe(0);
    expect(report.dau.at(-1)).toEqual({
      date: "2026-02-11",
      newUsers: 0,
      retainedUsers: 0,
      totalUsers: 0,
    });
  });

  it("accepts legitimate client and agent skips followed by a real message", () => {
    const skipped = journey("skip", "2026-02-11");
    skipped.clientReadyMode = "skipped";
    skipped.agentReadyMode = "skipped";

    const report = generateProductMetricReport(
      input({
        journeys: [skipped],
        activity: [{ userId: "skip", occurredAt: "2026-02-11T08:04:00.000Z", messageCount: 1 }],
      }),
    );

    expect(report.signedInFunnels.yesterday.stages.map((stage) => stage.users)).toEqual([1, 1, 1, 1, 1]);
    expect(report.dau.at(-1)).toMatchObject({ newUsers: 1, retainedUsers: 0, totalUsers: 1 });
  });

  it("excludes same-day organic messages that precede formal registration", () => {
    const sameMillisecond = journey("same-day", "2026-02-11");
    sameMillisecond.firstUserMessageAt = "2026-02-11T08:04:00.000900Z";
    const report = generateProductMetricReport(
      input({
        journeys: [sameMillisecond],
        activity: [
          { userId: "same-day", occurredAt: "2026-02-11T08:04:00.000100Z", messageCount: 50 },
          { userId: "same-day", occurredAt: "2026-02-11T08:04:00.000900Z", messageCount: 1 },
        ],
      }),
    );

    expect(report.dailyDepth.at(-2)?.stats.messages).toBe(1);
    expect(report.dataQuality.activityRowsBeforeRegistration).toBe(1);
  });
});

describe("activity and interaction depth", () => {
  const journeys = [journey("new", "2026-02-11"), journey("retained", "2026-02-01")];
  const activity: ActivityFact[] = [
    { userId: "new", occurredAt: "2026-02-11T09:00:00.000Z", messageCount: 2 },
    { userId: "retained", occurredAt: "2026-02-11T09:00:00.000Z", messageCount: 10 },
  ];

  it("splits DAU and daily depth into new and retained users", () => {
    const report = generateProductMetricReport(input({ journeys, activity }));

    expect(report.dau.at(-1)).toEqual({
      date: "2026-02-11",
      newUsers: 1,
      retainedUsers: 1,
      totalUsers: 2,
    });
    expect(report.dailyDepth.slice(-2)).toEqual([
      {
        period: "2026-02-11",
        segment: "new",
        stats: {
          activeUsers: 1,
          messages: 2,
          mean: 2,
          median: 2,
          p90: 2,
          buckets: { one: 0, two: 1, threeToNine: 0, tenPlus: 0 },
        },
      },
      {
        period: "2026-02-11",
        segment: "retained",
        stats: {
          activeUsers: 1,
          messages: 10,
          mean: 10,
          median: 10,
          p90: 10,
          buckets: { one: 0, two: 0, threeToNine: 0, tenPlus: 1 },
        },
      },
    ]);
  });

  it("computes deterministic median, nearest-rank p90, and buckets", () => {
    expect(depthStats([1, 2, 3, 9, 10, 20])).toEqual({
      activeUsers: 6,
      messages: 45,
      mean: 7.5,
      median: 6,
      p90: 20,
      buckets: { one: 1, two: 1, threeToNine: 2, tenPlus: 2 },
    });
  });
});

describe("retention", () => {
  it("uses exact target days and excludes immature daily cohorts", () => {
    const journeys = [journey("d1-return", "2026-02-10"), journey("no-return", "2026-02-10")];
    const activity: ActivityFact[] = [
      { userId: "d1-return", occurredAt: "2026-02-10T09:00:00.000Z", messageCount: 1 },
      { userId: "d1-return", occurredAt: "2026-02-11T09:00:00.000Z", messageCount: 1 },
      { userId: "no-return", occurredAt: "2026-02-10T09:00:00.000Z", messageCount: 1 },
    ];

    const report = generateProductMetricReport(input({ journeys, activity }));
    const cohort = report.dailyRetention.cohorts.find((candidate) => candidate.cohortDate === "2026-02-10");

    expect(cohort?.points.find((point) => point.horizon === 1)).toEqual({
      horizon: 1,
      mature: true,
      retainedUsers: 1,
      rate: 0.5,
    });
    expect(cohort?.points.find((point) => point.horizon === 2)).toEqual({
      horizon: 2,
      mature: false,
      retainedUsers: null,
      rate: null,
    });
  });

  it("counts any active day in a complete target ISO week", () => {
    const journeys = [journey("weekly-return", "2026-01-26"), journey("weekly-no-return", "2026-01-27")];
    const activity: ActivityFact[] = [
      { userId: "weekly-return", occurredAt: "2026-01-26T09:00:00.000Z", messageCount: 1 },
      { userId: "weekly-return", occurredAt: "2026-02-05T09:00:00.000Z", messageCount: 1 },
      { userId: "weekly-no-return", occurredAt: "2026-01-27T09:00:00.000Z", messageCount: 1 },
    ];

    const report = generateProductMetricReport(input({ journeys, activity }));
    const cohort = report.weeklyRetention.cohorts.find((candidate) => candidate.cohortWeek === "2026-01-26");

    expect(cohort?.points.find((point) => point.horizon === 1)).toEqual({
      horizon: 1,
      mature: true,
      retainedUsers: 1,
      rate: 0.5,
    });
    expect(cohort?.points.find((point) => point.horizon === 2)?.mature).toBe(false);
  });
});

describe("visitor funnel", () => {
  const visits: VisitorVisitFact[] = [
    {
      visitorId: "visitor-early",
      visitedAt: "2026-02-11T07:00:00.000Z",
      isFirstVisit: true,
      userId: "registered",
    },
    {
      visitorId: "visitor-duplicate",
      visitedAt: "2026-02-11T07:30:00.000Z",
      isFirstVisit: true,
      userId: "registered",
    },
    {
      visitorId: "visitor-anonymous",
      visitedAt: "2026-02-11T09:00:00.000Z",
      isFirstVisit: true,
      userId: null,
    },
  ];

  it("withholds downstream conversion without an identity bridge", () => {
    const report = generateProductMetricReport(input({ visitorData: "available", visits }));

    expect(report.visitorFunnels.yesterday).toMatchObject({
      status: "unavailable",
      allUniqueVisitors: 3,
      acquisitionVisitors: 3,
      stages: [],
    });
  });

  it("deduplicates downstream global users while retaining visitor denominator", () => {
    const report = generateProductMetricReport(
      input({
        visitorIdentityBridge: "available",
        visitorData: "available",
        journeys: [journey("registered", "2026-02-11")],
        visits,
      }),
    );

    expect(report.visitorFunnels.yesterday.stages.map((stage) => stage.users)).toEqual([3, 1, 1, 1, 1, 1]);
    expect(report.dataQuality.duplicateVisitorUserLinks).toBe(1);
  });

  it("does not misreport a missing visitor export as zero traffic", () => {
    const report = generateProductMetricReport(input());

    expect(report.visitorFunnels.yesterday).toMatchObject({
      status: "unavailable",
      allUniqueVisitors: null,
      acquisitionVisitors: null,
    });
  });
});
