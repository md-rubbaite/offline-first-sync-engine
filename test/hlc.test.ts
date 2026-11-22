import assert from "node:assert/strict";
import { test } from "node:test";
import { ClockDriftError, CounterOverflowError, Hlc, MAX_COUNTER, compareTimestamps, decodeTimestamp, encodeTimestamp } from "../src/hlc.js";

test("tick follows the physical clock and is strictly increasing", () => {
  let now = 1_000;
  const h = new Hlc("a", { now: () => now });
  const t1 = h.tick();
  assert.deepEqual(t1, { wall: 1_000, counter: 0, node: "a" });
  const t2 = h.tick(); // same millisecond
  assert.equal(compareTimestamps(t1, t2), -1);
  now = 2_000;
  assert.deepEqual(h.tick(), { wall: 2_000, counter: 0, node: "a" });
});

test("a clock that jumps backwards never produces an older timestamp", () => {
  let now = 10_000;
  const h = new Hlc("a", { now: () => now });
  const before = h.tick();
  now = 5_000; // NTP correction, manual change, VM restore
  const after = h.tick();
  assert.equal(compareTimestamps(before, after), -1);
  assert.equal(after.wall, 10_000);
});

test("receive moves past a remote timestamp so later local writes win", () => {
  const h = new Hlc("a", { now: () => 1_000 });
  const remote = { wall: 1_500, counter: 7, node: "b" };
  const merged = h.receive(remote);
  assert.deepEqual(merged, { wall: 1_500, counter: 8, node: "a" });
  assert.equal(compareTimestamps(remote, h.tick()), -1);
});

test("receive with equal walls takes the larger counter", () => {
  const h = new Hlc("a", { now: () => 1_000 });
  h.tick(); // (1000, 0)
  h.tick(); // (1000, 1)
  assert.deepEqual(h.receive({ wall: 1_000, counter: 5, node: "b" }), { wall: 1_000, counter: 6, node: "a" });
});

test("receive rejects timestamps too far in the future", () => {
  const h = new Hlc("a", { now: () => 0, maxDriftMs: 1_000 });
  assert.throws(() => h.receive({ wall: 5_000, counter: 0, node: "b" }), ClockDriftError);
  assert.equal(h.last.wall, 0, "the clock did not move");
  assert.doesNotThrow(() => h.receive({ wall: 5_000, counter: 0, node: "b" }, false));
});

test("counter overflow is reported instead of wrapping", () => {
  const h = new Hlc("a", { now: () => 1 });
  h.restore({ wall: 1, counter: MAX_COUNTER, node: "a" });
  assert.throws(() => h.tick(), CounterOverflowError);
});

test("restore never moves the clock backwards", () => {
  const h = new Hlc("a", { now: () => 0 });
  h.restore({ wall: 500, counter: 3, node: "a" });
  h.restore({ wall: 100, counter: 0, node: "a" });
  assert.deepEqual(h.last, { wall: 500, counter: 3, node: "a" });
  assert.deepEqual(h.tick(), { wall: 500, counter: 4, node: "a" });
});

test("encoded timestamps sort like compareTimestamps", () => {
  const samples = [
    { wall: 9, counter: 0, node: "b" },
    { wall: 10, counter: 0, node: "a" },
    { wall: 10, counter: 0, node: "ab" },
    { wall: 10, counter: 2, node: "a" },
    { wall: 10, counter: 10, node: "a" },
    { wall: 1_700_000_000_000, counter: 0, node: "z" },
  ];
  const byObject = [...samples].sort(compareTimestamps).map(encodeTimestamp);
  const byString = samples.map(encodeTimestamp).sort();
  assert.deepEqual(byString, byObject);
  for (const s of samples) assert.deepEqual(decodeTimestamp(encodeTimestamp(s)), s);
});

test("invalid node ids and encodings are rejected", () => {
  assert.throws(() => new Hlc("has space"), TypeError);
  assert.throws(() => new Hlc(""), TypeError);
  assert.throws(() => decodeTimestamp("1:2:a"), TypeError);
  assert.throws(() => encodeTimestamp({ wall: -1, counter: 0, node: "a" }), RangeError);
});
