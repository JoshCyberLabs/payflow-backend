import assert from "node:assert/strict";
import { test, describe } from "node:test";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import type { IndexerStatus } from "../src/indexer.ts";
import type { SyncResponse } from "../src/routes/types.ts";

const config = {
  STELLAR_NETWORK: "testnet",
  PLAN_REGISTRY_ID: "C".repeat(56),
  VAULT_ID: "C".repeat(56),
  SUBSCRIPTION_ID: "C".repeat(56),
  CORS_ORIGIN: "*",
  PORT: 0,
} as unknown as Config;

function indexerStatus(overrides: Partial<IndexerStatus> = {}): IndexerStatus {
  return {
    cursor: 1_000,
    latest: 1_120,
    lastRunAt: Date.now(),
    lastError: null,
    mismatchedEvents: 0,
    reconciliations: 0,
    corrections: 0,
    ...overrides,
  } as IndexerStatus;
}

async function startApp(
  status?: IndexerStatus,
): Promise<{ base: string; stop: () => void }> {
  const db = openDatabase(":memory:");
  const app = createApp(db, config, status);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => {
      server.close();
      db.close();
    },
  };
}

describe("GET /sync", () => {
  test("returns indexer and chain ledger with lag when indexer is attached", async () => {
    const app = await startApp(indexerStatus({ cursor: 1_000, latest: 1_120 }));
    try {
      const res = await fetch(`${app.base}/sync`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as SyncResponse;
      assert.equal(body.indexer_ledger, 1_000);
      assert.equal(body.chain_ledger, 1_120);
      assert.equal(body.lag, 120);
      assert.equal(body.in_sync, true); // 120 ≤ MAX_LAG (120)
    } finally {
      app.stop();
    }
  });

  test("in_sync is false when lag exceeds 120", async () => {
    const app = await startApp(indexerStatus({ cursor: 900, latest: 1_200 }));
    try {
      const res = await fetch(`${app.base}/sync`);
      const body = (await res.json()) as SyncResponse;
      assert.equal(body.lag, 300);
      assert.equal(body.in_sync, false);
    } finally {
      app.stop();
    }
  });

  test("chain_ledger and lag are null when no indexer is attached", async () => {
    const app = await startApp(undefined);
    try {
      const res = await fetch(`${app.base}/sync`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as SyncResponse;
      assert.equal(body.indexer_ledger, 0);
      assert.equal(body.chain_ledger, null);
      assert.equal(body.lag, null);
      assert.equal(body.in_sync, false);
    } finally {
      app.stop();
    }
  });

  test("indexer_ledger is 0 before the first pass even when indexer exists", async () => {
    const app = await startApp(indexerStatus({ cursor: 0, latest: 0 }));
    try {
      const res = await fetch(`${app.base}/sync`);
      const body = (await res.json()) as SyncResponse;
      assert.equal(body.indexer_ledger, 0);
      assert.equal(body.chain_ledger, null); // latest 0 → no chain ledger yet
      assert.equal(body.lag, null);
      assert.equal(body.in_sync, false);
    } finally {
      app.stop();
    }
  });

  test("response includes Cache-Control: no-store", async () => {
    const app = await startApp(indexerStatus());
    try {
      const res = await fetch(`${app.base}/sync`);
      assert.ok(
        (res.headers.get("cache-control") ?? "").includes("no-store"),
        "sync must not be cached",
      );
    } finally {
      app.stop();
    }
  });
});
