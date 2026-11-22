import assert from "node:assert/strict";
import { describe, test, before } from "node:test";
import { openDatabase } from "../src/lib/db.ts";
import { SqliteStorage } from "../src/lib/store/sqlite.ts";
import { getMerchantRevenue, getMerchantSummary } from "../src/lib/queries.ts";
import { tokenUnits } from "../src/routes/merchants.ts";

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";

/** unix milliseconds for a date, used to control bucket placement */
function ms(year: number, month: number, day = 1): number {
  return Date.UTC(year, month - 1, day);
}

describe("tokenUnits", () => {
  test("whole units: 10_000_000 → '1.0000000'", () => {
    assert.equal(tokenUnits(10_000_000n), "1.0000000");
  });

  test("fractional: 12_500_000 → '1.2500000'", () => {
    assert.equal(tokenUnits(12_500_000n), "1.2500000");
  });

  test("sub-unit: 100 → '0.0000100'", () => {
    assert.equal(tokenUnits(100n), "0.0000100");
  });

  test("zero → '0.0000000'", () => {
    assert.equal(tokenUnits(0n), "0.0000000");
  });

  test("negative: -5_000_000 → '-0.5000000'", () => {
    assert.equal(tokenUnits(-5_000_000n), "-0.5000000");
  });

  test("large amount preserves exact value", () => {
    assert.equal(tokenUnits(1_000_000_000_000n), "100000.0000000");
  });
});

describe("getMerchantRevenue", () => {
  const db = openDatabase(":memory:");
  const store = new SqliteStorage(db);

  before(() => {
    // Insert a plan and mandate so the mandate table FK is satisfied
    db.prepare(
      `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
       VALUES (1, ?, 'Test', 'TOKEN', '10000000', 2592000, 1, 10)`,
    ).run(MERCHANT);
    db.prepare(
      `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, ledger)
       VALUES (1, ?, ?, 1, '10000000', 2592000, 999999999, 10)`,
    ).run(SUBSCRIBER, MERCHANT);

    // Three charges: two in Jan 2025, one in Feb 2025
    const insertCharge = db.prepare(
      `INSERT INTO charges (tx_hash, mandate_id, subscriber, merchant, amount, fee, charges_made, next_charge, ledger, created_at)
       VALUES (?, 1, ?, ?, ?, ?, 1, 999999999, 10, ?)`,
    );
    insertCharge.run("tx1", SUBSCRIBER, MERCHANT, "9000000", "1000000", ms(2025, 1, 10));
    insertCharge.run("tx2", SUBSCRIBER, MERCHANT, "9000000", "1000000", ms(2025, 1, 20));
    insertCharge.run("tx3", SUBSCRIBER, MERCHANT, "9000000", "1000000", ms(2025, 2, 5));
  });

  test("month buckets: two in Jan, one in Feb", async () => {
    const result = await getMerchantRevenue(store, MERCHANT, "month", undefined, undefined, 12);
    assert.equal(result.bucket, "month");
    assert.equal(result.buckets.length, 2);

    const jan = result.buckets.find((b) => b.bucket === "2025-01");
    assert.ok(jan, "January bucket must be present");
    assert.equal(jan.charges, 2);
    assert.equal(jan.gross, String((9_000_000n + 1_000_000n) * 2n));
    assert.equal(jan.fee, String(1_000_000n * 2n));
    assert.equal(jan.net, String(9_000_000n * 2n));

    const feb = result.buckets.find((b) => b.bucket === "2025-02");
    assert.ok(feb, "February bucket must be present");
    assert.equal(feb.charges, 1);
    assert.equal(feb.gross, "10000000");
    assert.equal(feb.fee, "1000000");
    assert.equal(feb.net, "9000000");
  });

  test("totals aggregate across all buckets", async () => {
    const result = await getMerchantRevenue(store, MERCHANT, "month", undefined, undefined, 12);
    assert.equal(result.totals.charges, 3);
    assert.equal(result.totals.gross, String(10_000_000n * 3n));
    assert.equal(result.totals.fee, String(1_000_000n * 3n));
    assert.equal(result.totals.net, String(9_000_000n * 3n));
  });

  test("from/to bounds exclude charges outside the range", async () => {
    // Only February
    const feb_start = Math.floor(ms(2025, 2, 1) / 1000);
    const feb_end = Math.floor(ms(2025, 3, 1) / 1000);
    const result = await getMerchantRevenue(store, MERCHANT, "month", feb_start, feb_end, 12);
    assert.equal(result.totals.charges, 1);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0]!.bucket, "2025-02");
  });

  test("unknown merchant returns empty buckets", async () => {
    const other = "GDLXOW3J5FEFW4UZ7XBHX6EFHL7POV7S2NG5RZ7ULYCGLJWGPUBFQO4U";
    const result = await getMerchantRevenue(store, other, "month", undefined, undefined, 12);
    assert.equal(result.buckets.length, 0);
    assert.equal(result.totals.charges, 0);
    assert.equal(result.totals.gross, "0");
  });

  test("limit restricts to the most recent N buckets", async () => {
    // Insert a third month (March) so we have Jan, Feb, Mar; limit=2 should give Feb+Mar
    db.prepare(
      `INSERT INTO charges (tx_hash, mandate_id, subscriber, merchant, amount, fee, charges_made, next_charge, ledger, created_at)
       VALUES ('tx4', 1, ?, ?, '9000000', '1000000', 1, 999999999, 10, ?)`,
    ).run(SUBSCRIBER, MERCHANT, ms(2025, 3, 1));

    const result = await getMerchantRevenue(store, MERCHANT, "month", undefined, undefined, 2);
    assert.equal(result.buckets.length, 2);
    const labels = result.buckets.map((b) => b.bucket);
    assert.ok(labels.includes("2025-02"));
    assert.ok(labels.includes("2025-03"));
    assert.ok(!labels.includes("2025-01"));
  });
});

describe("getMerchantSummary MRR/ARR", () => {
  const MERCHANT2 = "GDLXOW3J5FEFW4UZ7XBHX6EFHL7POV7S2NG5RZ7ULYCGLJWGPUBFQO4U";
  const db2 = openDatabase(":memory:");
  const store2 = new SqliteStorage(db2);

  // SECONDS_PER_MONTH = 2_592_000 (30 days)
  // SECONDS_PER_YEAR  = 31_536_000 (365 days)
  const MONTH_S = 2_592_000;
  const YEAR_S = 31_536_000;

  before(() => {
    db2.prepare(
      `INSERT INTO plans (id, merchant, name, token, amount, period, active, ledger)
       VALUES (1, ?, 'Plan', 'TOKEN', '10000000', 2592000, 1, 10)`,
    ).run(MERCHANT2);
    // Monthly mandate: amount=10_000_000, period=2_592_000 → MRR = 10_000_000
    db2.prepare(
      `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
       VALUES (1, ?, ?, 1, '10000000', 2592000, 999999999, 'Active', 10)`,
    ).run(SUBSCRIBER, MERCHANT2);
    // Weekly mandate: amount=1_000_000, period=604_800 → MRR = 1_000_000 * 2_592_000 / 604_800
    db2.prepare(
      `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
       VALUES (2, ?, ?, 1, '1000000', 604800, 999999999, 'Active', 10)`,
    ).run(SUBSCRIBER, MERCHANT2);
    // Cancelled mandate: should NOT contribute to MRR
    db2.prepare(
      `INSERT INTO mandates (id, subscriber, merchant, plan_id, amount, period, next_charge, status, ledger)
       VALUES (3, ?, ?, 1, '5000000', 2592000, 999999999, 'Cancelled', 10)`,
    ).run(SUBSCRIBER, MERCHANT2);
  });

  test("MRR sums only active mandates, normalised to 30 days", async () => {
    const summary = await getMerchantSummary(store2, MERCHANT2);
    const expectedMrr =
      10_000_000n * BigInt(MONTH_S) / BigInt(MONTH_S) +   // = 10_000_000
      1_000_000n * BigInt(MONTH_S) / BigInt(604_800);      // ≈ 4_285_714
    assert.equal(summary.mrr, expectedMrr.toString());
  });

  test("ARR sums only active mandates, normalised to 365 days", async () => {
    const summary = await getMerchantSummary(store2, MERCHANT2);
    const expectedArr =
      10_000_000n * BigInt(YEAR_S) / BigInt(MONTH_S) +
      1_000_000n * BigInt(YEAR_S) / BigInt(604_800);
    assert.equal(summary.arr, expectedArr.toString());
  });

  test("activeMandates counts only Active status rows", async () => {
    const summary = await getMerchantSummary(store2, MERCHANT2);
    assert.equal(summary.activeMandates, 2);
  });

  test("unknown merchant returns zeroed summary", async () => {
    const other = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";
    const summary = await getMerchantSummary(store2, other);
    assert.equal(summary.activeMandates, 0);
    assert.equal(summary.mrr, "0");
    assert.equal(summary.arr, "0");
    assert.equal(summary.totalCollected, "0");
  });
});
