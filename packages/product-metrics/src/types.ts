export const DAILY_RETENTION_DAYS = [1, 2, 3, 4, 5, 6, 7, 14, 30] as const;
export const WEEKLY_RETENTION_WEEKS = [1, 2, 3, 4] as const;

export type VisitorIdentityBridge = "available" | "unavailable";
export type VisitorDataStatus = "available" | "unavailable";

export type ClientReadyMode = "connected" | "observed_connected" | "skipped" | "inferred_completed";
export type AgentReadyMode = "created" | "skipped" | "inferred_completed";

/**
 * One global-user journey. The extraction SQL chooses one internally
 * consistent membership path per global user instead of mixing milestones
 * across organizations.
 */
export type UserJourneyFact = {
  userId: string;
  accountAuthenticatedAt: string | null;
  clientReadyAt: string | null;
  clientReadyMode: ClientReadyMode | null;
  agentReadyAt: string | null;
  agentReadyMode: AgentReadyMode | null;
  bootstrapReceivedAt: string | null;
  firstUserMessageAt: string | null;
};

/**
 * Organic, user-authored messages at exact timestamp grain. Multiple messages
 * with one timestamp may be aggregated in `messageCount`. Trusted
 * server-authored messages persisted in a member's voice must already be
 * excluded.
 */
export type ActivityFact = {
  userId: string;
  occurredAt: string;
  messageCount: number;
};

/**
 * One anonymous Web visit. `isFirstVisit` must come from a durable first-visit
 * event, not from the first row in a truncated export.
 *
 * `userId` is optional because most visitors never authenticate. It may be
 * populated only by an explicit, privacy-reviewed first-party identity bridge.
 */
export type VisitorVisitFact = {
  visitorId: string;
  visitedAt: string;
  isFirstVisit: boolean;
  userId: string | null;
};

export type ProductMetricInput = {
  version: 1;
  asOf: string;
  timeZone: string;
  visitorData: VisitorDataStatus;
  visitorIdentityBridge: VisitorIdentityBridge;
  journeys: UserJourneyFact[];
  activity: ActivityFact[];
  visits: VisitorVisitFact[];
};

export type DateWindow = {
  startDate: string;
  endDateExclusive: string;
};

export type FunnelStageName =
  | "visitor"
  | "account_authenticated"
  | "client_ready_or_skipped"
  | "agent_ready_or_skipped"
  | "bootstrap_received"
  | "formal_registered";

export type FunnelStage = {
  stage: FunnelStageName;
  users: number;
  lostFromPrevious: number;
  conversionFromPrevious: number | null;
  conversionFromFirstStage: number | null;
};

export type FunnelResult = {
  status: "available" | "unavailable";
  reason: string | null;
  window: DateWindow;
  allUniqueVisitors: number | null;
  acquisitionVisitors: number | null;
  stages: FunnelStage[];
  rightCensored: boolean;
};

export type SignedInFunnelResult = {
  window: DateWindow;
  stages: FunnelStage[];
  rightCensored: boolean;
};

export type DepthBuckets = {
  one: number;
  two: number;
  threeToNine: number;
  tenPlus: number;
};

export type DepthStats = {
  activeUsers: number;
  messages: number;
  mean: number | null;
  median: number | null;
  p90: number | null;
  buckets: DepthBuckets;
};

export type ActivitySegment = "new" | "retained";

export type SegmentedDepth = {
  period: string;
  segment: ActivitySegment;
  stats: DepthStats;
};

export type DailyDau = {
  date: string;
  newUsers: number;
  retainedUsers: number;
  totalUsers: number;
};

export type RetentionPoint = {
  horizon: number;
  eligibleUsers: number;
  retainedUsers: number;
  rate: number | null;
};

export type CohortRetentionPoint = {
  horizon: number;
  mature: boolean;
  retainedUsers: number | null;
  rate: number | null;
};

export type DailyRetentionCohort = {
  cohortDate: string;
  registeredUsers: number;
  points: CohortRetentionPoint[];
};

export type WeeklyRetentionCohort = {
  cohortWeek: string;
  registeredUsers: number;
  points: CohortRetentionPoint[];
};

export type DataQuality = {
  missingAccountStage: number;
  missingClientStage: number;
  missingAgentStage: number;
  missingBootstrapStage: number;
  missingFirstUserMessageStage: number;
  invalidStageOrder: number;
  activityRowsBeforeRegistration: number;
  duplicateVisitorUserLinks: number;
  warnings: string[];
};

export type MetricContract = {
  version: 1;
  userGrain: "global_user";
  formalRegistration: "ordered_account_client_agent_bootstrap_then_organic_message";
  visitorFunnelCohort: "first_visit";
  activitySignal: "organic_user_message";
  dailyRetention: "exact_local_calendar_day";
  weeklyRetention: "any_day_in_iso_monday_sunday_week";
  completePeriodsOnly: true;
};

export type ProductMetricReport = {
  version: 1;
  metricContract: MetricContract;
  asOf: string;
  timeZone: string;
  lastCompleteDate: string;
  windows: {
    yesterday: DateWindow;
    last7Days: DateWindow;
  };
  visitorFunnels: {
    yesterday: FunnelResult;
    last7Days: FunnelResult;
  };
  signedInFunnels: {
    yesterday: SignedInFunnelResult;
    last7Days: SignedInFunnelResult;
  };
  dau: DailyDau[];
  dailyDepth: SegmentedDepth[];
  weeklyDepth: SegmentedDepth[];
  dailyRetention: {
    aggregate: RetentionPoint[];
    cohorts: DailyRetentionCohort[];
  };
  weeklyRetention: {
    aggregate: RetentionPoint[];
    cohorts: WeeklyRetentionCohort[];
  };
  dataQuality: DataQuality;
};
