import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_SIGNAL_DELAY_SECONDS, parseHttpDate, parseResetDuration, parseRetryAfter, unsignedInteger } from "../src/providers/response-time";
import { NOW } from "./provider-response-fixture";

for (const [raw, seconds] of [["7.66s", 8], ["2m59.56s", 180], ["1h2m3s", 3723], ["0s", 0], ["0.000000001s", 1],
  ["59.000s", 59], ["24h", 86400], ["10m", 600], ["168h", MAX_SIGNAL_DELAY_SECONDS]] as const) {
  test(`reset duration ${raw} rounds upward to ${seconds} seconds`, () => assert.deepEqual(parseResetDuration(raw, NOW), { state: "known", until: NOW + seconds, basis: "duration" }));
}
for (const raw of ["", "7.66", "-1s", "1e3s", "1ms", "1d", "1s2m", "1m1m", "1.5m", "1sPRIVATE", "NaNs", "Infinitys", "1.1234567890s", "999999999h", "169h", " 1s", "1s ", "1\ns", null, 60]) {
  test(`rejects malformed reset duration ${JSON.stringify(raw)}`, () => assert.equal(parseResetDuration(raw, NOW).state, "invalid"));
}
test("missing timing fields remain missing", () => {
  assert.deepEqual(parseRetryAfter(undefined, NOW), { state: "missing" }); assert.deepEqual(parseResetDuration(undefined, NOW), { state: "missing" });
});
for (const raw of ["0", "2", "0002", String(MAX_SIGNAL_DELAY_SECONDS)]) test(`Retry-After accepts delta seconds ${raw}`, () =>
  assert.deepEqual(parseRetryAfter(raw, NOW), { state: "known", until: NOW + Number(raw), basis: "delta_seconds" }));
for (const raw of ["-1", "+1", "1.5", "1e3", "Infinity", "NaN", "604801", "9007199254740992", "2s", "2, 3", "", " ", "2026-11-07", "tomorrow", "2\r\nX: secret", null, 2]) {
  test(`Retry-After rejects ${JSON.stringify(raw)}`, () => assert.equal(parseRetryAfter(raw, NOW).state, "invalid"));
}
test("all three HTTP date formats represent the same UTC timestamp", () => {
  for (const date of ["Sat, 07 Nov 2026 00:00:12 GMT", "Saturday, 07-Nov-26 00:00:12 GMT", "Sat Nov  7 00:00:12 2026"]) {
    assert.equal(parseHttpDate(date, NOW), NOW + 12);
    assert.deepEqual(parseRetryAfter(date, NOW), { state: "known", until: NOW + 12, basis: "http_date" });
  }
});
test("HTTP obsolete year rollover follows the fifty-year rule", () => assert.equal(parseHttpDate("Sunday, 06-Nov-94 08:49:37 GMT", NOW), Date.UTC(1994, 10, 6, 8, 49, 37) / 1000));
test("HTTP obsolete years handle exact dates at the fifty-year boundary", () => {
  assert.equal(parseHttpDate("Monday, 08-Nov-76 00:00:00 GMT", NOW), Date.UTC(1976, 10, 8) / 1000);
  assert.equal(parseHttpDate("Wednesday, 01-Jan-20 00:00:00 GMT", 0), Date.UTC(2020, 0, 1) / 1000);
});
for (const date of ["Fri, 07 Nov 2026 00:00:12 GMT", "Sat, 31 Feb 2026 00:00:12 GMT", "Sat, 07 Nov 2026 24:00:00 GMT", "Sat, 07 Nov 2026 00:00:60 GMT",
  "Sat, 07 Nov 2026 00:00:12 PST", "Sat, 7 Nov 2026 00:00:12 GMT", "Sat, 07 Nov 2026 00:00:12 GMT, Sat, 07 Nov 2026 00:00:13 GMT", "0"]) {
  test(`rejects invalid HTTP date ${date}`, () => assert.equal(parseHttpDate(date, NOW), undefined));
}
test("clock skew never shortens provider wait or adds guessed padding", () => {
  const date = (t: number) => new Date(t * 1000).toUTCString();
  assert.deepEqual(parseRetryAfter(date(NOW - 10), NOW, date(NOW - 20)), { state: "known", until: NOW + 10, basis: "http_date" });
  assert.deepEqual(parseRetryAfter(date(NOW + 30), NOW, date(NOW + 20)), { state: "known", until: NOW + 30, basis: "http_date" });
  assert.equal(parseRetryAfter(date(NOW + 30), NOW, date(NOW + 301)).state, "clock_uncertain");
  assert.equal(parseRetryAfter(date(NOW + 30), NOW, "invalid").state, "clock_uncertain");
  assert.equal(parseRetryAfter("12", NOW, "invalid").state, "known");
});
test("past HTTP dates stay expired, never become a fresh cooldown", () => {
  const r = parseRetryAfter(new Date((NOW - 20) * 1000).toUTCString(), NOW);
  assert.deepEqual(r, { state: "known", until: NOW - 20, basis: "http_date" });
});
test("safe integer, calendar and time addition bounds reject overflow", () => {
  assert.equal(unsignedInteger("9007199254740991"), Number.MAX_SAFE_INTEGER); assert.equal(unsignedInteger("9007199254740992"), undefined);
  for (const now of [NaN, Infinity, -1, NOW + 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal(parseRetryAfter("2", now).state, "invalid"); assert.equal(parseResetDuration("2s", now).state, "invalid");
  }
  assert.equal(parseRetryAfter("2", 253402300799).state, "invalid"); assert.equal(parseResetDuration("2s", 253402300799).state, "invalid");
});
