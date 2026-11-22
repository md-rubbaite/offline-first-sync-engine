import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeTimestamp } from "../src/hlc.js";
import { SyncServer } from "../src/server.js";
import type { Op } from "../src/types.js";

const ts = (wall: number, node = "phone", counter = 0) => encodeTimestamp({ wall, counter, node });
const op = (t: string, value: unknown = "v", field = "f"): Op => ({ kind: "set", ts: t, collection: "notes", doc: "n1", field, value } as Op);

test("a retried push is accepted again without a second log entry", async () => {
  const s = new SyncServer({ now: () => 10 });
  const ops = [op(ts(1)), op(ts(2), "w", "g")];
  assert.deepEqual((await s.push({ clientId: "phone", ops })).accepted, [ts(1), ts(2)]);
  assert.deepEqual((await s.push({ clientId: "phone", ops })).accepted, [ts(1), ts(2)]);
  assert.equal(s.logLength, 2);
});

test("the same timestamp with different content is rejected, so replicas cannot diverge", async () => {
  const s = new SyncServer({ now: () => 10 });
  await s.push({ clientId: "phone", ops: [op(ts(1), "first")] });
  const r = await s.push({ clientId: "phone", ops: [op(ts(1), "second")] });
  assert.deepEqual(r.rejected, [{ ts: ts(1), reason: "invalid" }]);
  assert.equal(s.replica.get("notes", "n1")?.["f"], "first");
});

test("a client cannot stamp operations with another client's id", async () => {
  const s = new SyncServer({ now: () => 10 });
  const r = await s.push({ clientId: "phone", ops: [op(ts(1, "laptop"))] });
  assert.deepEqual(r.rejected, [{ ts: ts(1, "laptop"), reason: "forbidden" }]);
});

test("operations from a clock far in the future are rejected", async () => {
  const s = new SyncServer({ now: () => 1_000, maxDriftMs: 60_000 });
  const r = await s.push({ clientId: "phone", ops: [op(ts(10_000_000))] });
  assert.deepEqual(r.rejected, [{ ts: ts(10_000_000), reason: "clock-drift" }]);
});

test("malformed, oversized and unauthorized operations are rejected individually", async () => {
  const s = new SyncServer({
    now: () => 10,
    maxOpBytes: 300,
    authorize: (_client, o) => o.collection !== "admin",
  });
  const ok = op(ts(1));
  const r = await s.push({
    clientId: "phone",
    ops: [
      ok,
      { ...ok, ts: ts(2), field: "__proto__" } as Op,
      { ...ok, ts: ts(3), extra: 1 } as unknown as Op,
      op(ts(4), "x".repeat(400)),
      { ...ok, ts: ts(5), collection: "admin" } as Op,
      { kind: "set", ts: ts(6), collection: "notes", doc: "n1", field: "f", value: Number.NaN } as Op,
    ],
  });
  assert.deepEqual(r.accepted, [ts(1)]);
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    ["invalid", "invalid", "too-large", "forbidden", "invalid"],
  );
});

test("pull pages through the log with a cursor", async () => {
  const s = new SyncServer({ now: () => 100 });
  await s.push({ clientId: "phone", ops: Array.from({ length: 5 }, (_, i) => op(ts(i + 1), i, `f${i}`)) });
  const p1 = await s.pull({ clientId: "x", cursor: 0, limit: 2 });
  assert.ok(p1.kind === "ops");
  assert.equal(p1.ops.length, 2);
  assert.equal(p1.hasMore, true);
  const p2 = await s.pull({ clientId: "x", cursor: p1.cursor, limit: 10 });
  assert.ok(p2.kind === "ops");
  assert.deepEqual(p2.ops.map((o) => o.ts), [ts(3), ts(4), ts(5)]);
  assert.equal(p2.hasMore, false);
  const p3 = await s.pull({ clientId: "x", cursor: p2.cursor, limit: 10 });
  assert.ok(p3.kind === "ops");
  assert.equal(p3.ops.length, 0);
  await assert.rejects(s.pull({ clientId: "x", cursor: 99, limit: 1 }), RangeError);
});

test("after compaction an old cursor gets a snapshot, a recent one gets the log", async () => {
  const s = new SyncServer({ now: () => 100 });
  await s.push({ clientId: "phone", ops: [op(ts(1), "a"), op(ts(2), "b", "g"), op(ts(3), "c", "h")] });
  s.compact(2);
  assert.equal(s.logLength, 1);
  const old = await s.pull({ clientId: "x", cursor: 0, limit: 10 });
  assert.ok(old.kind === "snapshot");
  assert.equal(old.cursor, 2);
  const recent = await s.pull({ clientId: "x", cursor: 2, limit: 10 });
  assert.ok(recent.kind === "ops");
  assert.deepEqual(recent.ops.map((o) => o.ts), [ts(3)]);
});
