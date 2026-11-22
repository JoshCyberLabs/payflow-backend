import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  BUCKET_SQL,
  bucketLabel,
  bucketStart,
  churnBucketSize,
} from "../src/lib/churn.ts";
import type { ChurnBucketSize } from "../src/routes/types.ts";

/**
 * The bucket rule is written twice — once in TypeScript and once as a SQL
 * expression — so the aggregation can happen inside SQLite. These tests are
 * what keeps the two copies honest: if they ever disagree, a mandate would
 * be filed under a different bucket in the report than the one its label
 * names.
 */
describe("churn buckets", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (at INTEGER)");
  const insert = db.prepare("INSERT INTO t VALUES (?)");

  function sqlStart(size: ChurnBucketSize, at: number): number {
    insert.run(at);
    // The interpolated fragment is the vetted static expression under test,
    // never request data; the instant is a bound parameter.
    // eslint-disable-next-line no-restricted-syntax
    const row = db.prepare(`SELECT ${BUCKET_SQL[size]} AS b FROM t`).get() as { b: number };
    db.prepare("DELETE FROM t").run();
    return row.b;
  }

  test("the SQL and TypeScript bucket rules agree", () => {
    // Walk a wide range of instants, including a leap day and the epoch
    // itself, and check every size at each one.
    for (let t = Date.UTC(2019, 0, 1); t < Date.UTC(2027, 0, 1); t += 7 * 86_400_000 + 3_661) {
      const at = Math.floor(t / 1000);
      for (const size of ["day", "week", "month"] as const) {
        const js = Math.floor(bucketStart(size, at).getTime() / 1000);
        assert.equal(
          sqlStart(size, at),
          js,
          `${size} bucket disagrees at ${new Date(at * 1000).toISOString()}`,
        );
      }
    }
  });

  test("a month bucket starts on the first of the month", () => {
    const late = Math.floor(Date.UTC(2025, 0, 31, 23, 59, 59) / 1000);
    const early = Math.floor(Date.UTC(2025, 1, 1, 0, 0, 0) / 1000);
    assert.equal(bucketLabel("month", bucketStart("month", late)), "2025-01");
    assert.equal(bucketLabel("month", bucketStart("month", early)), "2025-02");
  });

  test("a day bucket starts at UTC midnight", () => {
    const late = Math.floor(Date.UTC(2025, 0, 31, 23, 59, 59) / 1000);
    const early = Math.floor(Date.UTC(2025, 1, 1, 0, 0, 0) / 1000);
    assert.equal(bucketLabel("day", bucketStart("day", late)), "2025-01-31");
    assert.equal(bucketLabel("day", bucketStart("day", early)), "2025-02-01");
  });

  test("a week bucket starts on Monday", () => {
    // 2025-01-27 is a Monday; 2025-02-02 is the Sunday that closes it.
    const monday = Math.floor(Date.UTC(2025, 0, 27) / 1000);
    const sunday = Math.floor(Date.UTC(2025, 1, 2) / 1000);
    const nextMonday = Math.floor(Date.UTC(2025, 1, 3) / 1000);
    assert.equal(bucketLabel("week", bucketStart("week", monday)), "2025-01-27");
    assert.equal(bucketLabel("week", bucketStart("week", sunday)), "2025-01-27");
    assert.equal(bucketLabel("week", bucketStart("week", nextMonday)), "2025-02-03");
  });

  test("the bucket parameter falls back to month", () => {
    assert.equal(churnBucketSize("day"), "day");
    assert.equal(churnBucketSize("week"), "week");
    assert.equal(churnBucketSize("month"), "month");
    assert.equal(churnBucketSize("year"), "month");
    assert.equal(churnBucketSize(undefined), "month");
    assert.equal(churnBucketSize(["day", "week"]), "day");
  });
});

import { nextBucketStart, bucketLabelAt } from "../src/lib/churn.ts";

describe("nextBucketStart", () => {
  test("day: advances exactly 24 hours", () => {
    const start = new Date(Date.UTC(2025, 2, 14)); // 2025-03-14
    const next = nextBucketStart("day", start);
    assert.equal(next.toISOString(), "2025-03-15T00:00:00.000Z");
  });

  test("week: advances exactly 7 days", () => {
    const monday = new Date(Date.UTC(2025, 0, 27)); // 2025-01-27
    const next = nextBucketStart("week", monday);
    assert.equal(next.toISOString(), "2025-02-03T00:00:00.000Z");
  });

  test("month: advances to the first of the next month", () => {
    const jan = new Date(Date.UTC(2025, 0, 1));
    assert.equal(nextBucketStart("month", jan).toISOString(), "2025-02-01T00:00:00.000Z");
  });

  test("month: advances across a year boundary", () => {
    const dec = new Date(Date.UTC(2024, 11, 1));
    assert.equal(nextBucketStart("month", dec).toISOString(), "2025-01-01T00:00:00.000Z");
  });

  test("month: February to March works across leap year", () => {
    const feb = new Date(Date.UTC(2024, 1, 1)); // Feb 2024 (leap year)
    assert.equal(nextBucketStart("month", feb).toISOString(), "2024-03-01T00:00:00.000Z");
  });

  test("chaining nextBucketStart gives increasing dates for all sizes", () => {
    for (const size of ["day", "week", "month"] as const) {
      let cursor = bucketStart(size, Math.floor(Date.UTC(2025, 0, 1) / 1000));
      for (let i = 0; i < 5; i += 1) {
        const next = nextBucketStart(size, cursor);
        assert.ok(next.getTime() > cursor.getTime(), `${size}: next must be strictly after cursor`);
        cursor = next;
      }
    }
  });
});

describe("bucketLabelAt", () => {
  test("matches bucketLabel(bucketStart(...))", () => {
    const instants = [
      Date.UTC(2025, 0, 1),
      Date.UTC(2025, 0, 27),  // Monday
      Date.UTC(2025, 5, 15),  // mid-month
      Date.UTC(2024, 11, 31), // last day of year
    ];
    for (const t of instants) {
      const at = Math.floor(t / 1000);
      for (const size of ["day", "week", "month"] as const) {
        assert.equal(
          bucketLabelAt(size, at),
          bucketLabel(size, bucketStart(size, at)),
          `${size} at ${new Date(t).toISOString()}`,
        );
      }
    }
  });

  test("day label is the ISO date of midnight UTC", () => {
    const at = Math.floor(Date.UTC(2025, 2, 14, 13, 45, 0) / 1000); // mid-day
    assert.equal(bucketLabelAt("day", at), "2025-03-14");
  });

  test("week label is the Monday of the containing week", () => {
    // 2025-03-13 is a Thursday; the week started 2025-03-10 (Monday).
    const at = Math.floor(Date.UTC(2025, 2, 13) / 1000);
    assert.equal(bucketLabelAt("week", at), "2025-03-10");
  });

  test("month label is YYYY-MM", () => {
    const at = Math.floor(Date.UTC(2025, 2, 31, 23, 59, 59) / 1000);
    assert.equal(bucketLabelAt("month", at), "2025-03");
  });
});
