import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeTimestamp } from "../src/hlc.js";
import { Replica } from "../src/replica.js";
import type { Op, Value } from "../src/types.js";

const ts = (wall: number, node = "a", counter = 0) => encodeTimestamp({ wall, counter, node });
const set = (t: string, field: string, value: Value, doc = "d1"): Op => ({ kind: "set", ts: t, collection: "c", doc, field, value });
const del = (t: string, doc = "d1"): Op => ({ kind: "delete", ts: t, collection: "c", doc });

test("newer write wins per field; edits to different fields both survive", () => {
  const r = new Replica();
  r.apply(set(ts(1, "a"), "title", "Buy milk"));
  r.apply(set(ts(2, "b"), "done", true)); // other device, other field
  r.apply(set(ts(3, "a"), "title", "Buy oat milk"));
  r.apply(set(ts(2, "b"), "title", "stale")); // older than ts 3
  assert.deepEqual(r.get("c", "d1"), { done: true, title: "Buy oat milk" });
});

test("equal walls are ordered by counter, then node id", () => {
  const r = new Replica();
  r.apply(set(ts(5, "a", 1), "x", "a1"));
  r.apply(set(ts(5, "b", 0), "x", "b0"));
  assert.equal(r.get("c", "d1")?.["x"], "a1");
  r.apply(set(ts(5, "b", 1), "x", "b1"));
  assert.equal(r.get("c", "d1")?.["x"], "b1");
});

test("delete hides earlier fields; a later edit resurrects only newer fields", () => {
  const r = new Replica();
  r.apply(set(ts(1), "title", "x"));
  r.apply(set(ts(2), "notes", "y"));
  r.apply(del(ts(3, "b")));
  assert.equal(r.get("c", "d1"), undefined);
  assert.deepEqual(r.list("c"), []);
  r.apply(set(ts(4, "c"), "title", "edited offline after the delete"));
  assert.deepEqual(r.get("c", "d1"), { title: "edited offline after the delete" });
});

test("apply is idempotent and order-independent", () => {
  const ops = [
    set(ts(1, "a"), "a", 1),
    set(ts(2, "b"), "a", 2),
    del(ts(3, "c")),
    set(ts(4, "a"), "b", { nested: [1, 2] }),
    set(ts(2, "c"), "b", "older"),
    del(ts(1, "b"), "d2"),
    set(ts(2, "a"), "z", null, "d2"),
    del(ts(2, "a")), // an older, concurrent delete of d1
    set(ts(5, "b"), "a", "after both deletes"),
  ];
  const reference = new Replica();
  reference.applyAll(ops);
  for (let i = 0; i < 50; i++) {
    const shuffled = [...ops, ...ops].sort(() => Math.random() - 0.5);
    const r = new Replica();
    r.applyAll(shuffled);
    assert.deepEqual(r.snapshot(), reference.snapshot());
  }
  assert.equal(reference.apply(ops[0] as Op), false, "re-applying changes nothing");
});

test("snapshot round-trips, and returned values cannot mutate the replica", () => {
  const r = new Replica();
  r.apply(set(ts(1), "tags", ["a"]));
  const doc = r.get("c", "d1");
  (doc?.["tags"] as string[]).push("mutated");
  assert.deepEqual(r.get("c", "d1"), { tags: ["a"] });
  assert.deepEqual(Replica.fromSnapshot(JSON.parse(JSON.stringify(r.snapshot()))).view(), r.view());
});
