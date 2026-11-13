import { MAX_PROVIDER_RESET_SECONDS, safeInteger } from "../config/provider-policy";

// Parser resource/freshness bounds, never replacement cooldowns. Out-of-range
// evidence is rejected rather than clamped to these values.
export const MAX_SIGNAL_DELAY_SECONDS = MAX_PROVIDER_RESET_SECONDS;
export const MAX_CLOCK_SKEW_SECONDS = 300;
export const MAX_OBSERVATION_AGE_SECONDS = 300;
export type Deadline = { state: "known"; until: number; basis: "delta_seconds" | "http_date" | "duration" | "policy_utc_day" } |
  { state: "missing" | "invalid" | "clock_uncertain" };
export const timestamp = (v: unknown): v is number => safeInteger(v) && v <= 253402300799; // Last second of year 9999.
export function unsignedInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 16 || !/^\d+$/.test(value)) return;
  const n = Number(value); return safeInteger(n) ? n : undefined;
}
export function parseResetDuration(value: unknown, receivedAt: number): Deadline {
  if (value === undefined) return { state: "missing" };
  if (!timestamp(receivedAt) || typeof value !== "string" || value.length > 64) return { state: "invalid" };
  const m = /^(?:(\d{1,9})h)?(?:(\d{1,9})m)?(?:(\d{1,9})(?:\.(\d{1,9}))?s)?$/.exec(value);
  if (!m || (!m[1] && !m[2] && !m[3])) return { state: "invalid" };
  const seconds = BigInt(m[1] ?? 0) * 3600n + BigInt(m[2] ?? 0) * 60n + BigInt(m[3] ?? 0) +
    (m[4] && /[1-9]/.test(m[4]) ? 1n : 0n);
  if (seconds > BigInt(MAX_SIGNAL_DELAY_SECONDS)) return { state: "invalid" };
  const until = receivedAt + Number(seconds);
  return timestamp(until) ? { state: "known", until, basis: "duration" } : { state: "invalid" };
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const longDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// RFC 9110 IMF-fixdate and the two obsolete recipient formats. Date.parse alone
// accepts invalid calendar dates, non-HTTP strings and surprising timezones.
export function parseHttpDate(value: unknown, referenceTime: number): number | undefined {
  if (typeof value !== "string" || value.length > 64 || !timestamp(referenceTime)) return;
  let day: string, month: string, year: number, hour: string, minute: string, second: string, weekday: number, obsoleteYear = false;
  let m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (m) { weekday = weekdays.indexOf(m[1]!); [day, month] = [m[2]!, m[3]!]; year = Number(m[4]); [hour, minute, second] = [m[5]!, m[6]!, m[7]!]; }
  else if ((m = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value))) {
    weekday = longDays.indexOf(m[1]!); [day, month] = [m[2]!, m[3]!];
    const currentYear = new Date(referenceTime * 1000).getUTCFullYear();
    year = currentYear + 50 - ((currentYear + 50 - Number(m[4])) % 100); obsoleteYear = true;
    [hour, minute, second] = [m[5]!, m[6]!, m[7]!];
  } else if ((m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) (\d{2}| \d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value))) {
    weekday = weekdays.indexOf(m[1]!); [month, day] = [m[2]!, m[3]!]; year = Number(m[7]); [hour, minute, second] = [m[4]!, m[5]!, m[6]!];
  } else return;
  const monthIndex = months.indexOf(month), d = Number(day), h = Number(hour), min = Number(minute), s = Number(second);
  if (obsoleteYear) {
    const fiftyYears = new Date(referenceTime * 1000); fiftyYears.setUTCFullYear(fiftyYears.getUTCFullYear() + 50);
    if (Date.UTC(year, monthIndex, d, h, min, s) > fiftyYears.getTime()) year -= 100;
  }
  if (year < 1970 || monthIndex < 0 || d < 1 || d > 31 || h > 23 || min > 59 || s > 59) return;
  const date = new Date(Date.UTC(year, monthIndex, d, h, min, s));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== d || date.getUTCDay() !== weekday) return;
  const seconds = date.getTime() / 1000; return timestamp(seconds) ? seconds : undefined;
}

export function parseRetryAfter(value: unknown, receivedAt: number, serverDate?: unknown): Deadline {
  if (value === undefined) return { state: "missing" };
  if (!timestamp(receivedAt) || typeof value !== "string" || value.length > 128) return { state: "invalid" };
  const delta = unsignedInteger(value);
  if (delta !== undefined) {
    const until = receivedAt + delta;
    return delta <= MAX_SIGNAL_DELAY_SECONDS && timestamp(until) ? { state: "known", until, basis: "delta_seconds" } : { state: "invalid" };
  }
  const absolute = parseHttpDate(value, receivedAt);
  if (absolute === undefined) return { state: "invalid" };
  let until = absolute;
  if (serverDate !== undefined) {
    const server = parseHttpDate(serverDate, receivedAt);
    if (server === undefined || Math.abs(server - receivedAt) > MAX_CLOCK_SKEW_SECONDS) return { state: "clock_uncertain" };
    // Never shorten an absolute instruction when the provider clock is ahead;
    // preserve its relative wait when it is behind. No guessed skew padding.
    until = Math.max(absolute, receivedAt + (absolute - server));
  }
  return timestamp(until) && until - receivedAt <= MAX_SIGNAL_DELAY_SECONDS ?
    { state: "known", until, basis: "http_date" } : { state: "invalid" };
}
