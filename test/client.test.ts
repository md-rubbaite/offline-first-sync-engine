import assert from "node:assert/strict";
import { test } from "node:test";
import { SyncClient } from "../src/client.js";
import { SyncServer } from "../src/server.js";
import { MemoryStorage } from "../src/storage.js";
import { FaultyTransport, LocalTransport, seededRandom } from "../src/testing.js";
import { TransportError } from "../src/types.js";

const noSleep = { sleep: async () => {}, retries: 8 };

async function device(clientId: string, server: SyncServer, clock: { now: number }, storage = new MemoryStorage()) {
  const transport = new FaultyTransport(new LocalTransport(server), {}, seededRandom(clientId.length * 7919));
  const client = await SyncClient.open({ clientId, transport, storage, now: () => clock.now, retry: noSleep });
  return { client, transport, storage };
}

test("offline edits to different fields of one record both survive", async () => {
  const clock = { now: 1_000 };
  const server = new SyncServer({ now: () => clock.now });
  const phone = await device("phone", server, clock);
  const laptop = await device("laptop", server, clock);

  await phone.client.set("tasks", "t1", { title: "Ship release", done: false });
  await phone.client.sync();
  await laptop.client.sync();

  phone.transport.faults = { offline: true };
  laptop.transport.faults = { offline: true };
  clock.now += 1_000;
  await phone.client.set("tasks", "t1", { done: true });
  await laptop.client.set("tasks", "t1", { title: "Ship release 2.0" });
  assert.equal(phone.client.pending, 1);
  await assert.rejects(phone.client.sync(), TransportError);
  assert.deepEqual(phone.client.get("tasks", "t1"), { done: true, title: "Ship release" }, "local view works offline");

  phone.transport.faults = {};
  laptop.transport.faults = {};
  await phone.client.sync();
  await laptop.client.sync();
  await phone.client.sync();
  const expected = { done: true, title: "Ship release 2.0" };
  assert.deepEqual(phone.client.get("tasks", "t1"), expected);
  assert.deepEqual(laptop.client.get("tasks", "t1"), expected);
  assert.equal(phone.client.pending, 0);
});

test("a lost acknowledgement does not create duplicates", async () => {
  const clock = { now: 1_000 };
  const server = new SyncServer({ now: () => clock.now });
  const phone = await device("phone", server, clock);
  await phone.client.set("notes", "n1", { body: "hello" });
  phone.transport.faults = { dropResponse: 1 };
  await assert.rejects(phone.client.sync(), TransportError);
  assert.equal(server.logLength, 1, "the server stored it once despite every retry");
  assert.equal(phone.client.pending, 1, "the client still thinks it is pending");
  phone.transport.faults = {};
  const result = await phone.client.sync();
  assert.equal(result.pushed, 1);
  assert.equal(server.logLength, 1);
  assert.equal(phone.client.pending, 0);
});

test("state, outbox and clock survive a restart", async () => {
  const clock = { now: 5_000 };
  const server = new SyncServer({ now: () => clock.now });
  const storage = new MemoryStorage();
  const first = await device("tablet", server, clock, storage);
  await first.client.set("notes", "n1", { body: "draft" });
  await first.client.sync();
  first.transport.faults = { offline: true };
  await first.client.set("notes", "n1", { body: "draft 2" });

  clock.now = 1_000; // the device clock went backwards while the app was closed
  const second = await device("tablet", server, clock, storage);
  assert.equal(second.client.pending, 1);
  assert.deepEqual(second.client.get("notes", "n1"), { body: "draft 2" });
  await second.client.set("notes", "n1", { body: "draft 3" });
  await second.client.sync();
  assert.equal(server.replica.get("notes", "n1")?.["body"], "draft 3", "the newest edit wins despite the clock");
});

test("an operation the server rejects disappears from the local view", async () => {
  const clock = { now: 1_000 };
  const server = new SyncServer({ now: () => clock.now, authorize: (_c, op) => op.collection !== "readonly" });
  const phone = await device("phone", server, clock);
  await phone.client.set("readonly", "r1", { x: 1 });
  await phone.client.set("notes", "n1", { x: 2 });
  assert.deepEqual(phone.client.get("readonly", "r1"), { x: 1 });
  const result = await phone.client.sync();
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]?.reason, "forbidden");
  assert.equal(phone.client.get("readonly", "r1"), undefined);
  assert.deepEqual(phone.client.get("notes", "n1"), { x: 2 });
  assert.equal(phone.client.pending, 0);
});

test("a client behind the compaction horizon resyncs from a snapshot and keeps its pending edits", async () => {
  const clock = { now: 1_000 };
  const server = new SyncServer({ now: () => clock.now });
  const writer = await device("writer", server, clock);
  const late = await device("late", server, clock);
  await late.client.set("notes", "mine", { text: "offline draft" });
  late.transport.faults = { offline: true };
  for (let i = 0; i < 5; i++) await writer.client.set("notes", `n${i}`, { i });
  await writer.client.sync();
  server.compact(server.head);
  late.transport.faults = {};
  const result = await late.client.sync();
  assert.equal(result.resynced, true);
  assert.equal(late.client.list("notes").length, 6);
  assert.deepEqual(late.client.snapshotView(), server.replica.view());
});

test("concurrent sync calls share one run", async () => {
  const clock = { now: 1_000 };
  const server = new SyncServer({ now: () => clock.now });
  const phone = await device("phone", server, clock);
  await phone.client.set("notes", "n1", { a: 1 });
  const [a, b] = await Promise.all([phone.client.sync(), phone.client.sync()]);
  assert.equal(a, b);
  assert.equal(server.logLength, 1);
});

test("invalid writes are refused before they reach the outbox", async () => {
  const clock = { now: 1_000 };
  const server = new SyncServer({ now: () => clock.now });
  const { client } = await device("phone", server, clock);
  await assert.rejects(client.set("notes", "n1", JSON.parse('{"__proto__": 1}')), TypeError);
  await assert.rejects(client.set("bad name", "n1", { a: 1 }), TypeError);
  await assert.rejects(client.set("notes", "n1", { a: Number.POSITIVE_INFINITY }), TypeError);
  await assert.rejects(client.set("notes", "n1", {}), TypeError);
  assert.equal(client.pending, 0);
});
