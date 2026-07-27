import {
  addDays,
  compareDates,
  compareInstants,
  dateInWindow,
  instantEpochNanoseconds,
  isoWeekStart,
  localDate,
  parseInstant,
  reportWindows,
} from "./dates.js";
import {
  type ActivitySegment,
  type CohortRetentionPoint,
  DAILY_RETENTION_DAYS,
  type DailyDau,
  type DailyRetentionCohort,
  type DataQuality,
  type DateWindow,
  type DepthStats,
  type FunnelResult,
  type FunnelStage,
  type FunnelStageName,
  type ProductMetricInput,
  type ProductMetricReport,
  type RetentionPoint,
  type SegmentedDepth,
  type SignedInFunnelResult,
  type UserJourneyFact,
  type VisitorVisitFact,
  WEEKLY_RETENTION_WEEKS,
  type WeeklyRetentionCohort,
} from "./types.js";

type JourneyReach = {
  account: boolean;
  client: boolean;
  agent: boolean;
  bootstrap: boolean;
  registered: boolean;
  registrationAt: string | null;
  invalidOrder: boolean;
};

type VisitorSummary = {
  visitorId: string;
  firstVisitAt: string | null;
  visits: string[];
  userId: string | null;
};

type RegisteredActivity = {
  registrationAtByUser: Map<string, string>;
  registrationDateByUser: Map<string, string>;
  messagesByUserDate: Map<string, number>;
  activeDatesByUser: Map<string, Set<string>>;
  rowsBeforeRegistration: number;
};

const VISITOR_FUNNEL_STAGES: FunnelStageName[] = [
  "visitor",
  "account_authenticated",
  "client_ready_or_skipped",
  "agent_ready_or_skipped",
  "bootstrap_received",
  "formal_registered",
];

const SIGNED_IN_FUNNEL_STAGES: FunnelStageName[] = [
  "account_authenticated",
  "client_ready_or_skipped",
  "agent_ready_or_skipped",
  "bootstrap_received",
  "formal_registered",
];

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function buildStages(names: FunnelStageName[], counts: number[]): FunnelStage[] {
  const first = counts[0] ?? 0;
  return names.map((stage, index) => {
    const users = counts[index] ?? 0;
    const previous = index === 0 ? users : (counts[index - 1] ?? 0);
    return {
      stage,
      users,
      lostFromPrevious: index === 0 ? 0 : previous - users,
      conversionFromPrevious: index === 0 ? null : rate(users, previous),
      conversionFromFirstStage: rate(users, first),
    };
  });
}

function pairedStage(
  timestamp: string | null,
  mode: string | null,
  timestampLabel: string,
  modeLabel: string,
): bigint | null {
  if ((timestamp === null) !== (mode === null)) {
    throw new Error(`${timestampLabel} and ${modeLabel} must both be null or both be set`);
  }
  return timestamp === null ? null : instantEpochNanoseconds(timestamp, timestampLabel);
}

/**
 * Formal registration is the first user-authored reply after every required
 * stage. Receiving the member-voice bootstrap by itself never registers a user.
 */
export function deriveJourneyReach(journey: UserJourneyFact, asOf: string): JourneyReach {
  const asOfValue = instantEpochNanoseconds(asOf, "asOf");
  const accountValue =
    journey.accountAuthenticatedAt === null
      ? null
      : instantEpochNanoseconds(journey.accountAuthenticatedAt, "accountAuthenticatedAt");
  const clientValue = pairedStage(journey.clientReadyAt, journey.clientReadyMode, "clientReadyAt", "clientReadyMode");
  const agentValue = pairedStage(journey.agentReadyAt, journey.agentReadyMode, "agentReadyAt", "agentReadyMode");
  const bootstrapValue =
    journey.bootstrapReceivedAt === null
      ? null
      : instantEpochNanoseconds(journey.bootstrapReceivedAt, "bootstrapReceivedAt");
  const messageValue =
    journey.firstUserMessageAt === null
      ? null
      : instantEpochNanoseconds(journey.firstUserMessageAt, "firstUserMessageAt");

  const account = accountValue !== null && accountValue <= asOfValue;
  const client = account && clientValue !== null && clientValue >= accountValue && clientValue <= asOfValue;
  const agent = client && agentValue !== null && agentValue >= clientValue && agentValue <= asOfValue;
  const bootstrap = agent && bootstrapValue !== null && bootstrapValue >= agentValue && bootstrapValue <= asOfValue;
  const registered = bootstrap && messageValue !== null && messageValue > bootstrapValue && messageValue <= asOfValue;

  const present = [accountValue, clientValue, agentValue, bootstrapValue, messageValue].filter(
    (value): value is bigint => value !== null,
  );
  const invalidOrder = present.some((value, index) => index > 0 && value < (present[index - 1] ?? value));

  return {
    account,
    client,
    agent,
    bootstrap,
    registered,
    registrationAt: registered ? journey.firstUserMessageAt : null,
    invalidOrder,
  };
}

function journeyMap(journeys: UserJourneyFact[]): Map<string, UserJourneyFact> {
  const result = new Map<string, UserJourneyFact>();
  for (const journey of journeys) {
    if (!journey.userId) throw new Error("journey.userId must not be empty");
    if (result.has(journey.userId)) {
      throw new Error(`Duplicate global-user journey: ${journey.userId}`);
    }
    result.set(journey.userId, journey);
  }
  return result;
}

function signedInFunnel(
  journeys: UserJourneyFact[],
  reaches: Map<string, JourneyReach>,
  window: DateWindow,
  timeZone: string,
): SignedInFunnelResult {
  const cohort = journeys.filter((journey) => {
    if (journey.accountAuthenticatedAt === null) return false;
    return dateInWindow(localDate(journey.accountAuthenticatedAt, timeZone), window.startDate, window.endDateExclusive);
  });
  const counts = [
    cohort.filter((journey) => reaches.get(journey.userId)?.account).length,
    cohort.filter((journey) => reaches.get(journey.userId)?.client).length,
    cohort.filter((journey) => reaches.get(journey.userId)?.agent).length,
    cohort.filter((journey) => reaches.get(journey.userId)?.bootstrap).length,
    cohort.filter((journey) => reaches.get(journey.userId)?.registered).length,
  ];
  return {
    window,
    stages: buildStages(SIGNED_IN_FUNNEL_STAGES, counts),
    rightCensored: true,
  };
}

function summarizeVisitors(visits: VisitorVisitFact[]): Map<string, VisitorSummary> {
  const summaries = new Map<string, VisitorSummary>();
  for (const visit of visits) {
    if (!visit.visitorId) throw new Error("visit.visitorId must not be empty");
    parseInstant(visit.visitedAt, "visitedAt");
    const current = summaries.get(visit.visitorId) ?? {
      visitorId: visit.visitorId,
      firstVisitAt: null,
      visits: [],
      userId: null,
    };
    current.visits.push(visit.visitedAt);
    if (
      visit.isFirstVisit &&
      (current.firstVisitAt === null || compareInstants(visit.visitedAt, current.firstVisitAt) < 0)
    ) {
      current.firstVisitAt = visit.visitedAt;
    }
    if (visit.userId !== null) {
      if (current.userId !== null && current.userId !== visit.userId) {
        throw new Error(`Visitor ${visit.visitorId} maps to more than one global user`);
      }
      current.userId = visit.userId;
    }
    summaries.set(visit.visitorId, current);
  }
  return summaries;
}

function visitorFunnel(
  input: ProductMetricInput,
  reaches: Map<string, JourneyReach>,
  journeys: Map<string, UserJourneyFact>,
  summaries: Map<string, VisitorSummary>,
  window: DateWindow,
): { result: FunnelResult; duplicateVisitorUserLinks: number } {
  const allVisitors = [...summaries.values()].filter((visitor) =>
    visitor.visits.some((visitedAt) =>
      dateInWindow(localDate(visitedAt, input.timeZone), window.startDate, window.endDateExclusive),
    ),
  );
  const acquisition = [...summaries.values()].filter(
    (visitor) =>
      visitor.firstVisitAt !== null &&
      dateInWindow(localDate(visitor.firstVisitAt, input.timeZone), window.startDate, window.endDateExclusive),
  );

  if (input.visitorData === "unavailable") {
    return {
      result: {
        status: "unavailable",
        reason: "No visitor visit export was supplied, so traffic totals and visitor conversion are unavailable.",
        window,
        allUniqueVisitors: null,
        acquisitionVisitors: null,
        stages: [],
        rightCensored: true,
      },
      duplicateVisitorUserLinks: 0,
    };
  }

  if (input.visitorIdentityBridge === "unavailable") {
    return {
      result: {
        status: "unavailable",
        reason:
          "Anonymous visitor IDs are not linked to global user IDs; downstream totals cannot be presented as one cohort funnel.",
        window,
        allUniqueVisitors: allVisitors.length,
        acquisitionVisitors: acquisition.length,
        stages: [],
        rightCensored: true,
      },
      duplicateVisitorUserLinks: 0,
    };
  }

  const canonicalVisitorByUser = new Map<string, string>();
  const acquisitionVisitorIds = new Set(acquisition.map((visitor) => visitor.visitorId));
  let duplicateVisitorUserLinks = 0;
  for (const visitor of [...summaries.values()]
    .filter((candidate) => candidate.firstVisitAt !== null)
    .sort((left, right) => {
      const byTime = compareInstants(left.firstVisitAt ?? "", right.firstVisitAt ?? "");
      return byTime === 0 ? left.visitorId.localeCompare(right.visitorId) : byTime;
    })) {
    if (visitor.userId === null) continue;
    if (canonicalVisitorByUser.has(visitor.userId)) {
      if (acquisitionVisitorIds.has(visitor.visitorId)) duplicateVisitorUserLinks += 1;
      continue;
    }
    canonicalVisitorByUser.set(visitor.userId, visitor.visitorId);
  }

  const stageCounts: [number, number, number, number, number, number] = [acquisition.length, 0, 0, 0, 0, 0];
  for (const visitor of acquisition) {
    const userId = visitor.userId;
    if (userId === null || canonicalVisitorByUser.get(userId) !== visitor.visitorId || visitor.firstVisitAt === null) {
      continue;
    }
    const journey = journeys.get(userId);
    const reach = reaches.get(userId);
    if (!journey || !reach || journey.accountAuthenticatedAt === null) continue;
    if (compareInstants(journey.accountAuthenticatedAt, visitor.firstVisitAt) < 0) {
      continue;
    }
    if (reach.account) stageCounts[1] += 1;
    if (reach.client) stageCounts[2] += 1;
    if (reach.agent) stageCounts[3] += 1;
    if (reach.bootstrap) stageCounts[4] += 1;
    if (reach.registered) stageCounts[5] += 1;
  }

  return {
    result: {
      status: "available",
      reason: null,
      window,
      allUniqueVisitors: allVisitors.length,
      acquisitionVisitors: acquisition.length,
      stages: buildStages(VISITOR_FUNNEL_STAGES, stageCounts),
      rightCensored: true,
    },
    duplicateVisitorUserLinks,
  };
}

function registeredActivity(
  input: ProductMetricInput,
  reaches: Map<string, JourneyReach>,
  lastCompleteDate: string,
): RegisteredActivity {
  const registrationAtByUser = new Map<string, string>();
  const registrationDateByUser = new Map<string, string>();
  for (const [userId, reach] of reaches) {
    if (!reach.registrationAt) continue;
    registrationAtByUser.set(userId, reach.registrationAt);
    registrationDateByUser.set(userId, localDate(reach.registrationAt, input.timeZone));
  }

  const messagesByUserDate = new Map<string, number>();
  const activeDatesByUser = new Map<string, Set<string>>();
  let rowsBeforeRegistration = 0;

  for (const activity of input.activity) {
    if (!activity.userId) throw new Error("activity.userId must not be empty");
    parseInstant(activity.occurredAt, "occurredAt");
    if (!Number.isSafeInteger(activity.messageCount) || activity.messageCount <= 0) {
      throw new Error("activity.messageCount must be a positive integer");
    }
    const registrationAt = registrationAtByUser.get(activity.userId);
    if (!registrationAt || compareInstants(activity.occurredAt, registrationAt) < 0) {
      rowsBeforeRegistration += 1;
      continue;
    }
    const activityDate = localDate(activity.occurredAt, input.timeZone);
    if (compareDates(activityDate, lastCompleteDate) > 0) continue;
    const key = `${activity.userId}\u0000${activityDate}`;
    messagesByUserDate.set(key, (messagesByUserDate.get(key) ?? 0) + activity.messageCount);
    const dates = activeDatesByUser.get(activity.userId) ?? new Set<string>();
    dates.add(activityDate);
    activeDatesByUser.set(activity.userId, dates);
  }

  return {
    registrationAtByUser,
    registrationDateByUser,
    messagesByUserDate,
    activeDatesByUser,
    rowsBeforeRegistration,
  };
}

function emptyDepth(): DepthStats {
  return {
    activeUsers: 0,
    messages: 0,
    mean: null,
    median: null,
    p90: null,
    buckets: { one: 0, two: 0, threeToNine: 0, tenPlus: 0 },
  };
}

export function depthStats(messageCounts: number[]): DepthStats {
  if (messageCounts.length === 0) return emptyDepth();
  const values = [...messageCounts].sort((left, right) => left - right);
  const messages = values.reduce((sum, value) => sum + value, 0);
  const midpoint = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0 ? ((values[midpoint - 1] ?? 0) + (values[midpoint] ?? 0)) / 2 : (values[midpoint] ?? null);
  const p90Index = Math.max(0, Math.ceil(values.length * 0.9) - 1);
  return {
    activeUsers: values.length,
    messages,
    mean: messages / values.length,
    median,
    p90: values[p90Index] ?? null,
    buckets: {
      one: values.filter((value) => value === 1).length,
      two: values.filter((value) => value === 2).length,
      threeToNine: values.filter((value) => value >= 3 && value <= 9).length,
      tenPlus: values.filter((value) => value >= 10).length,
    },
  };
}

function dailyOutputs(activity: RegisteredActivity, window: DateWindow): { dau: DailyDau[]; depth: SegmentedDepth[] } {
  const dau: DailyDau[] = [];
  const depth: SegmentedDepth[] = [];

  for (let date = window.startDate; compareDates(date, window.endDateExclusive) < 0; date = addDays(date, 1)) {
    const counts: Record<ActivitySegment, number[]> = { new: [], retained: [] };
    for (const [key, messageCount] of activity.messagesByUserDate) {
      const separator = key.indexOf("\u0000");
      const userId = key.slice(0, separator);
      const activityDate = key.slice(separator + 1);
      if (activityDate !== date) continue;
      const registrationDate = activity.registrationDateByUser.get(userId);
      if (!registrationDate) continue;
      counts[registrationDate === date ? "new" : "retained"].push(messageCount);
    }
    dau.push({
      date,
      newUsers: counts.new.length,
      retainedUsers: counts.retained.length,
      totalUsers: counts.new.length + counts.retained.length,
    });
    depth.push(
      { period: date, segment: "new", stats: depthStats(counts.new) },
      { period: date, segment: "retained", stats: depthStats(counts.retained) },
    );
  }
  return { dau, depth };
}

function weeklyDepth(activity: RegisteredActivity, currentWeekStart: string): SegmentedDepth[] {
  const firstWeek = addDays(currentWeekStart, -28);
  const weeklyUserMessages = new Map<string, number>();
  for (const [key, messageCount] of activity.messagesByUserDate) {
    const separator = key.indexOf("\u0000");
    const userId = key.slice(0, separator);
    const activityDate = key.slice(separator + 1);
    const week = isoWeekStart(activityDate);
    if (compareDates(week, firstWeek) < 0 || compareDates(week, currentWeekStart) >= 0) continue;
    const weeklyKey = `${userId}\u0000${week}`;
    weeklyUserMessages.set(weeklyKey, (weeklyUserMessages.get(weeklyKey) ?? 0) + messageCount);
  }

  const output: SegmentedDepth[] = [];
  for (let week = firstWeek; compareDates(week, currentWeekStart) < 0; week = addDays(week, 7)) {
    const counts: Record<ActivitySegment, number[]> = { new: [], retained: [] };
    for (const [key, messageCount] of weeklyUserMessages) {
      const separator = key.indexOf("\u0000");
      const userId = key.slice(0, separator);
      const activityWeek = key.slice(separator + 1);
      if (activityWeek !== week) continue;
      const registrationDate = activity.registrationDateByUser.get(userId);
      if (!registrationDate) continue;
      counts[isoWeekStart(registrationDate) === week ? "new" : "retained"].push(messageCount);
    }
    output.push(
      { period: week, segment: "new", stats: depthStats(counts.new) },
      { period: week, segment: "retained", stats: depthStats(counts.retained) },
    );
  }
  return output;
}

function dailyRetention(
  activity: RegisteredActivity,
  lastCompleteDate: string,
): { aggregate: RetentionPoint[]; cohorts: DailyRetentionCohort[] } {
  const usersByCohort = new Map<string, string[]>();
  for (const [userId, cohortDate] of activity.registrationDateByUser) {
    if (compareDates(cohortDate, lastCompleteDate) > 0) continue;
    const users = usersByCohort.get(cohortDate) ?? [];
    users.push(userId);
    usersByCohort.set(cohortDate, users);
  }

  const cohorts: DailyRetentionCohort[] = [...usersByCohort.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cohortDate, users]) => ({
      cohortDate,
      registeredUsers: users.length,
      points: DAILY_RETENTION_DAYS.map((horizon): CohortRetentionPoint => {
        const targetDate = addDays(cohortDate, horizon);
        const mature = compareDates(targetDate, lastCompleteDate) <= 0;
        if (!mature) return { horizon, mature: false, retainedUsers: null, rate: null };
        const retainedUsers = users.filter((userId) => activity.activeDatesByUser.get(userId)?.has(targetDate)).length;
        return {
          horizon,
          mature: true,
          retainedUsers,
          rate: rate(retainedUsers, users.length),
        };
      }),
    }));

  const aggregate = DAILY_RETENTION_DAYS.map((horizon): RetentionPoint => {
    let eligibleUsers = 0;
    let retainedUsers = 0;
    for (const cohort of cohorts) {
      const point = cohort.points.find((candidate) => candidate.horizon === horizon);
      if (!point?.mature || point.retainedUsers === null) continue;
      eligibleUsers += cohort.registeredUsers;
      retainedUsers += point.retainedUsers;
    }
    return { horizon, eligibleUsers, retainedUsers, rate: rate(retainedUsers, eligibleUsers) };
  });
  return { aggregate, cohorts };
}

function weeklyRetention(
  activity: RegisteredActivity,
  currentWeekStart: string,
): { aggregate: RetentionPoint[]; cohorts: WeeklyRetentionCohort[] } {
  const usersByCohort = new Map<string, string[]>();
  for (const [userId, registrationDate] of activity.registrationDateByUser) {
    const cohortWeek = isoWeekStart(registrationDate);
    if (compareDates(cohortWeek, currentWeekStart) >= 0) continue;
    const users = usersByCohort.get(cohortWeek) ?? [];
    users.push(userId);
    usersByCohort.set(cohortWeek, users);
  }

  const cohorts: WeeklyRetentionCohort[] = [...usersByCohort.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cohortWeek, users]) => ({
      cohortWeek,
      registeredUsers: users.length,
      points: WEEKLY_RETENTION_WEEKS.map((horizon): CohortRetentionPoint => {
        const targetWeek = addDays(cohortWeek, horizon * 7);
        const mature = compareDates(addDays(targetWeek, 7), currentWeekStart) <= 0;
        if (!mature) return { horizon, mature: false, retainedUsers: null, rate: null };
        const retainedUsers = users.filter((userId) =>
          [...(activity.activeDatesByUser.get(userId) ?? [])].some((date) => isoWeekStart(date) === targetWeek),
        ).length;
        return {
          horizon,
          mature: true,
          retainedUsers,
          rate: rate(retainedUsers, users.length),
        };
      }),
    }));

  const aggregate = WEEKLY_RETENTION_WEEKS.map((horizon): RetentionPoint => {
    let eligibleUsers = 0;
    let retainedUsers = 0;
    for (const cohort of cohorts) {
      const point = cohort.points.find((candidate) => candidate.horizon === horizon);
      if (!point?.mature || point.retainedUsers === null) continue;
      eligibleUsers += cohort.registeredUsers;
      retainedUsers += point.retainedUsers;
    }
    return { horizon, eligibleUsers, retainedUsers, rate: rate(retainedUsers, eligibleUsers) };
  });
  return { aggregate, cohorts };
}

function dataQuality(
  input: ProductMetricInput,
  reaches: Map<string, JourneyReach>,
  activity: RegisteredActivity,
  duplicateVisitorUserLinks: number,
): DataQuality {
  const inferredClient = input.journeys.filter((journey) => journey.clientReadyMode === "inferred_completed").length;
  const observedClient = input.journeys.filter((journey) => journey.clientReadyMode === "observed_connected").length;
  const inferredAgent = input.journeys.filter((journey) => journey.agentReadyMode === "inferred_completed").length;
  const warnings: string[] = [];
  if (input.visitorData === "unavailable") {
    warnings.push(
      "Visitor visit data is unavailable; traffic totals and visitor-to-registration conversion are intentionally withheld.",
    );
  } else if (input.visitorIdentityBridge === "unavailable") {
    warnings.push(
      "Visitor-to-user identity bridge is unavailable; visitor funnels are intentionally withheld instead of joining unrelated aggregate totals.",
    );
  }
  if (inferredClient > 0) {
    warnings.push(
      `${inferredClient} user journeys infer client readiness from onboarding completion because clients.connected_at is mutable.`,
    );
  }
  if (observedClient > 0) {
    warnings.push(
      `${observedClient} user journeys prove client readiness from a mutable connection observation; their first-connect time is not exact.`,
    );
  }
  if (inferredAgent > 0) {
    warnings.push(`${inferredAgent} user journeys infer agent readiness from onboarding completion.`);
  }
  if (activity.rowsBeforeRegistration > 0) {
    warnings.push(
      `${activity.rowsBeforeRegistration} activity rows preceded formal registration or belonged to users who never formally registered and were excluded.`,
    );
  }
  if (duplicateVisitorUserLinks > 0) {
    warnings.push(
      `${duplicateVisitorUserLinks} extra acquisition visitor IDs mapped to users already linked by an earlier visitor and were not double-counted downstream.`,
    );
  }

  return {
    missingAccountStage: input.journeys.filter((journey) => journey.accountAuthenticatedAt === null).length,
    missingClientStage: input.journeys.filter((journey) => journey.clientReadyAt === null).length,
    missingAgentStage: input.journeys.filter((journey) => journey.agentReadyAt === null).length,
    missingBootstrapStage: input.journeys.filter((journey) => journey.bootstrapReceivedAt === null).length,
    missingFirstUserMessageStage: input.journeys.filter((journey) => journey.firstUserMessageAt === null).length,
    invalidStageOrder: [...reaches.values()].filter((reach) => reach.invalidOrder).length,
    activityRowsBeforeRegistration: activity.rowsBeforeRegistration,
    duplicateVisitorUserLinks,
    warnings,
  };
}

export function generateProductMetricReport(input: ProductMetricInput): ProductMetricReport {
  if (input.version !== 1) throw new Error("Unsupported product metric input version");
  parseInstant(input.asOf, "asOf");
  // Validates the IANA time-zone name before any metrics are computed.
  localDate(input.asOf, input.timeZone);

  const journeys = journeyMap(input.journeys);
  const reaches = new Map<string, JourneyReach>(
    input.journeys.map((journey) => [journey.userId, deriveJourneyReach(journey, input.asOf)]),
  );
  const windows = reportWindows(input.asOf, input.timeZone);
  const visitorSummaries = summarizeVisitors(input.visits);
  const yesterdayVisitor = visitorFunnel(input, reaches, journeys, visitorSummaries, windows.yesterday);
  const last7Visitor = visitorFunnel(input, reaches, journeys, visitorSummaries, windows.last7Days);
  const activity = registeredActivity(input, reaches, windows.lastCompleteDate);
  const daily = dailyOutputs(activity, windows.last7Days);
  const dailyRetentionResult = dailyRetention(activity, windows.lastCompleteDate);
  const weeklyRetentionResult = weeklyRetention(activity, windows.currentWeekStart);
  const duplicateVisitorUserLinks = Math.max(
    yesterdayVisitor.duplicateVisitorUserLinks,
    last7Visitor.duplicateVisitorUserLinks,
  );

  return {
    version: 1,
    metricContract: {
      version: 1,
      userGrain: "global_user",
      formalRegistration: "ordered_account_client_agent_bootstrap_then_organic_message",
      visitorFunnelCohort: "first_visit",
      activitySignal: "organic_user_message",
      dailyRetention: "exact_local_calendar_day",
      weeklyRetention: "any_day_in_iso_monday_sunday_week",
      completePeriodsOnly: true,
    },
    asOf: input.asOf,
    timeZone: input.timeZone,
    lastCompleteDate: windows.lastCompleteDate,
    windows: {
      yesterday: windows.yesterday,
      last7Days: windows.last7Days,
    },
    visitorFunnels: {
      yesterday: yesterdayVisitor.result,
      last7Days: last7Visitor.result,
    },
    signedInFunnels: {
      yesterday: signedInFunnel(input.journeys, reaches, windows.yesterday, input.timeZone),
      last7Days: signedInFunnel(input.journeys, reaches, windows.last7Days, input.timeZone),
    },
    dau: daily.dau,
    dailyDepth: daily.depth,
    weeklyDepth: weeklyDepth(activity, windows.currentWeekStart),
    dailyRetention: dailyRetentionResult,
    weeklyRetention: weeklyRetentionResult,
    dataQuality: dataQuality(input, reaches, activity, duplicateVisitorUserLinks),
  };
}
