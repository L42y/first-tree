const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const EXPLICIT_INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)$/iu;

function instantMatch(value: string, label: string): RegExpExecArray {
  const match = EXPLICIT_INSTANT_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${label} must be a complete ISO-8601 timestamp with an explicit UTC offset`);
  }
  return match;
}

function normalizedInstant(value: string, match: RegExpExecArray): string {
  const offset = match[6] ?? "";
  const normalizedOffset = /^[+-]\d{2}$/u.test(offset) ? `${offset}:00` : offset;
  const withoutOffset = value.slice(0, value.length - offset.length).replace(" ", "T");
  return `${withoutOffset}${normalizedOffset}`;
}

function validateInstantComponents(match: RegExpExecArray, label: string): void {
  const date = match[1] ?? "";
  assertDateString(date, `${label} date`);

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] === undefined ? 0 : Number(match[4]);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`${label} must contain a valid clock time`);
  }

  const offset = match[6] ?? "";
  if (offset.toUpperCase() === "Z") return;
  const offsetDigits = /^([+-])(\d{2})(?::?(\d{2}))?$/u.exec(offset);
  if (!offsetDigits) {
    throw new Error(`${label} must contain a valid UTC offset`);
  }
  const offsetHour = Number(offsetDigits[2]);
  const offsetMinute = Number(offsetDigits[3] ?? "0");
  if (offsetMinute > 59 || offsetHour > 14 || (offsetHour === 14 && offsetMinute !== 0)) {
    throw new Error(`${label} must contain a valid UTC offset`);
  }
}

export function parseInstant(value: string, label: string): Date {
  const match = instantMatch(value, label);
  validateInstantComponents(match, label);
  const parsed = new Date(normalizedInstant(value, match));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  }
  return parsed;
}

export function instantEpochNanoseconds(value: string, label: string): bigint {
  const match = instantMatch(value, label);
  const parsed = parseInstant(value, label);
  const fraction = match[5] ?? "";
  const nanoseconds = fraction.padEnd(9, "0").slice(0, 9);
  const subMillisecondNanoseconds = nanoseconds.slice(3) || "0";
  return BigInt(parsed.getTime()) * 1_000_000n + BigInt(subMillisecondNanoseconds);
}

export function compareInstants(left: string, right: string): number {
  const leftValue = instantEpochNanoseconds(left, "left instant");
  const rightValue = instantEpochNanoseconds(right, "right instant");
  if (leftValue < rightValue) return -1;
  if (leftValue > rightValue) return 1;
  return 0;
}

export function assertDateString(value: string, label: string): void {
  if (!DATE_PATTERN.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a real calendar date`);
  }
}

export function localDate(instant: string | Date, timeZone: string): string {
  const date = typeof instant === "string" ? parseInstant(instant, "instant") : instant;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (!year || !month || !day) {
    throw new Error(`Unable to format date in time zone ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}

export function addDays(date: string, amount: number): string {
  assertDateString(date, "date");
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

export function compareDates(left: string, right: string): number {
  assertDateString(left, "left date");
  assertDateString(right, "right date");
  return left.localeCompare(right);
}

export function dateInWindow(date: string, startDate: string, endDateExclusive: string): boolean {
  return compareDates(date, startDate) >= 0 && compareDates(date, endDateExclusive) < 0;
}

export function isoWeekStart(date: string): string {
  assertDateString(date, "date");
  const value = new Date(`${date}T00:00:00.000Z`);
  const day = value.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  return addDays(date, -daysSinceMonday);
}

export function reportWindows(
  asOf: string,
  timeZone: string,
): {
  currentDate: string;
  lastCompleteDate: string;
  currentWeekStart: string;
  yesterday: { startDate: string; endDateExclusive: string };
  last7Days: { startDate: string; endDateExclusive: string };
} {
  const currentDate = localDate(parseInstant(asOf, "asOf"), timeZone);
  const lastCompleteDate = addDays(currentDate, -1);
  return {
    currentDate,
    lastCompleteDate,
    currentWeekStart: isoWeekStart(currentDate),
    yesterday: {
      startDate: lastCompleteDate,
      endDateExclusive: currentDate,
    },
    last7Days: {
      startDate: addDays(currentDate, -7),
      endDateExclusive: currentDate,
    },
  };
}
