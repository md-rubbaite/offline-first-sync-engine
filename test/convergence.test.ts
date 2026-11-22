import assert from "node:assert/strict";
import { test } from "node:test";
import { SyncClient } from "../src/client.js";
import { SyncServer } from "../src/server.js";
import { MemoryStorage } from "../src/storage.js";
import { FaultyTransport, LocalTransport, seededRandom } from "../src/testing.js";
import { TransportError, type Value } from "../src/types.js";

/**
 * Randomized end-to-end check of the core promise: whatever the network does, once every device
 * syncs on a working network, all devices and the server show exactly the same data and no write
 * that the server accepted is lost or duplicated.
 */
const SEEDS = Number(process.env["SYNC_SEEDS"] ?? 40);

for (let seed = 1; seed <= SEEDS; seed++) {
  test(`devices converge under lost, duplicated and refused messages (seed ${seed})`, async () => {
    const rnd = seededRandom(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const base = { now: 1_700_000_000_000 };
    const server = new SyncServer({ now: () => base.now, maxBatch: 50 });
    const devices: { client: SyncClient; transport: FaultyTransport; skew: number; storage: MemoryStorage }[] = [];
    for (const id of ["phone", "laptop", "tablet"]) {
      const skew = Math.floor((rnd() - 0.5) * 20_000); // device clocks up to ±10 s wrong
      const transport = new FaultyTransport(new LocalTransport(server), {}, seededRandom(seed * 31 + id.length));
      const storage = new MemoryStorage();
      const client = await SyncClient.open({
        clientId: id,
        transport,
        storage,
        now: () => base.now + skew,
        batchSize: 7,
        retry: { retries: 2, sleep: async () => {}, random: rnd },
      });
      devices.push({ client, transport, skew, storage });
    }

    const docs = ["a", "b", "c", "d"];
    const fields = ["title", "done", "tags", "owner"];
    const values: Value[] = ["x", "y", 1, 2, true, false, null, ["p", "q"], { k: "v" }];

    for (let step = 0; step < 150; step++) {
      base.now += Math.floor(rnd() * 400);
      const d = pick(devices);
      const roll = rnd();
      if (roll < 0.45) {
        await d.client.set(pick(["tasks", "notes"]), pick(docs), { [pick(fields)]: pick(values) });
      } else if (roll < 0.52) {
        await d.client.delete(pick(["tasks", "notes"]), pick(docs));
      } else if (roll < 0.85) {
        d.transport.faults = {
          dropRequest: rnd() * 0.3,
          dropResponse: rnd() * 0.3,
          duplicate: rnd() * 0.3,
          offline: rnd() < 0.15,
        };
        try {
          await d.client.sync();
        } catch (err) {
          if (!(err instanceof TransportError)) throw err;
        }
      } else if (roll < 0.9) {
        // the app restarts: reopen from storage
        const reopened = await SyncClient.open({
          clientId: d.client.clientId,
          transport: d.transport,
          storage: d.storage,
          now: () => base.now + d.skew,
          batchSize: 7,
          retry: { retries: 2, sleep: async () => {}, random: rnd },
        });
        assert.deepEqual(reopened.snapshotView(), d.client.snapshotView(), "restart restores the same view");
        d.client = reopened;
      } else if (roll < 0.93) {
        server.compact(Math.floor(server.head * rnd()));
      }
    }

    for (const d of devices) d.transport.faults = {};
    for (let round = 0; round < 2; round++) for (const d of devices) await d.client.sync();

    const truth = server.replica.view();
    for (const d of devices) {
      assert.equal(d.client.pending, 0, `${d.client.clientId} has nothing left to push`);
      assert.deepEqual(d.client.snapshotView(), truth, `${d.client.clientId} matches the server`);
    }
    const seen = new Set<string>();
    for (let cursor = server.head - server.logLength; ; ) {
      const page = await server.pull({ clientId: "audit", cursor, limit: 50 });
      assert.ok(page.kind === "ops");
      for (const op of page.ops) {
        assert.ok(!seen.has(op.ts), "no operation is stored twice");
        seen.add(op.ts);
      }
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    assert.equal(seen.size, server.logLength, "the audit read the whole log");
  });
}
