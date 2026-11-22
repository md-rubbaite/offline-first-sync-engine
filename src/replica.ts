import type { Doc, DocEntry, FieldEntry, Op, ReplicaSnapshot, Value } from "./types.js";

/**
 * A state-based CRDT: every field is a last-writer-wins register ordered by HLC timestamp, and a
 * delete records a tombstone timestamp on the document.
 *
 * - A field write wins if its timestamp is newer than the field's current one.
 * - A delete hides every field written before it.
 * - A field written after the delete (by timestamp) is visible again, so a document deleted on one
 *   device and edited later on another reappears with the newer edits only.
 *
 * apply() is commutative, associative and idempotent, so replicas that have seen the same set of
 * operations hold the same state, in any order and with any duplicates.
 */
export class Replica {
  private readonly collections = new Map<string, Map<string, MutableDoc>>();

  /** Apply one operation. Returns true if visible or stored state changed. */
  apply(op: Op): boolean {
    const doc = this.docEntry(op.collection, op.doc);
    if (op.kind === "delete") {
      if (doc.deletedAt !== undefined && doc.deletedAt >= op.ts) return false;
      doc.deletedAt = op.ts;
      return true;
    }
    const current = doc.fields.get(op.field);
    if (current !== undefined && current.ts >= op.ts) return false;
    doc.fields.set(op.field, { value: structuredClone(op.value), ts: op.ts });
    return true;
  }

  applyAll(ops: Iterable<Op>): number {
    let changed = 0;
    for (const op of ops) if (this.apply(op)) changed += 1;
    return changed;
  }

  /** Visible fields of a document, or undefined if it does not exist or is deleted. */
  get(collection: string, id: string): Doc | undefined {
    const doc = this.collections.get(collection)?.get(id);
    if (doc === undefined) return undefined;
    const visible: [string, Value][] = [];
    for (const [field, entry] of doc.fields) {
      if (doc.deletedAt === undefined || entry.ts > doc.deletedAt) visible.push([field, structuredClone(entry.value)]);
    }
    if (visible.length === 0) return undefined;
    visible.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(visible);
  }

  /** Visible documents of a collection, sorted by id. */
  list(collection: string): { id: string; doc: Doc }[] {
    const docs = this.collections.get(collection);
    if (docs === undefined) return [];
    const out: { id: string; doc: Doc }[] = [];
    for (const id of [...docs.keys()].sort()) {
      const doc = this.get(collection, id);
      if (doc !== undefined) out.push({ id, doc });
    }
    return out;
  }

  collectionNames(): string[] {
    return [...this.collections.keys()].sort();
  }

  /** Everything visible, for comparing replicas in tests and debugging. */
  view(): Record<string, Record<string, Doc>> {
    const out: Record<string, Record<string, Doc>> = {};
    for (const name of this.collectionNames()) {
      const docs = this.list(name);
      if (docs.length > 0) out[name] = Object.fromEntries(docs.map(({ id, doc }) => [id, doc]));
    }
    return out;
  }

  snapshot(): ReplicaSnapshot {
    const out: Record<string, Record<string, DocEntry>> = {};
    for (const [name, docs] of this.collections) {
      const c: Record<string, DocEntry> = {};
      for (const [id, doc] of docs) {
        const fields: Record<string, FieldEntry> = {};
        for (const [f, e] of doc.fields) fields[f] = { value: structuredClone(e.value), ts: e.ts };
        c[id] = doc.deletedAt === undefined ? { fields } : { fields, deletedAt: doc.deletedAt };
      }
      out[name] = c;
    }
    return out;
  }

  static fromSnapshot(snapshot: ReplicaSnapshot): Replica {
    const r = new Replica();
    for (const [name, docs] of Object.entries(snapshot)) {
      for (const [id, entry] of Object.entries(docs)) {
        const doc = r.docEntry(name, id);
        for (const [f, e] of Object.entries(entry.fields)) doc.fields.set(f, { value: structuredClone(e.value), ts: e.ts });
        if (entry.deletedAt !== undefined) doc.deletedAt = entry.deletedAt;
      }
    }
    return r;
  }

  clone(): Replica {
    return Replica.fromSnapshot(this.snapshot());
  }

  private docEntry(collection: string, id: string): MutableDoc {
    let docs = this.collections.get(collection);
    if (docs === undefined) {
      docs = new Map();
      this.collections.set(collection, docs);
    }
    let doc = docs.get(id);
    if (doc === undefined) {
      doc = { fields: new Map() };
      docs.set(id, doc);
    }
    return doc;
  }
}

interface MutableDoc {
  fields: Map<string, FieldEntry>;
  deletedAt?: string;
}
