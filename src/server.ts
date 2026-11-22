import { decodeTimestamp } from "./hlc.js";
import { Replica } from "./replica.js";
import type { Op, PullRequest, PullResponse, PushRequest, PushResponse, RejectReason } from "./types.js";
import { isValidName, isValidOp } from "./validate.js";

export interface SyncServerOptions {
  /** Physical clock, for the drift check. */
  readonly now?: () => number;
  /** Reject operations stamped further than this into the future. Default 5 minutes. */
  readonly maxDriftMs?: number;
  /** Largest serialized operation accepted, in bytes. Default 64 KiB. */
  readonly maxOpBytes?: number;
  /** Most operations accepted in one push and returned in one pull. Default 500. */
  readonly maxBatch?: number;
  /** Authorization hook: may this client write this operation? Default: allow. */
  readonly authorize?: (clientId: string, op: Op) => boolean;
}

/**
 * Reference sync server. It keeps an append-only log of accepted operations, numbered from 1, and
 * the merged replica. Clients pull the log from their cursor.
 *
 * Production mapping (see docs/postgres-schema.sql): the log is a table with a sequence primary key
 * and a unique key on `ts`; push is one transaction; pull is `WHERE seq > $cursor ORDER BY seq LIMIT n`.
 */
export class SyncServer {
  private readonly log: { seq: number; op: Op }[] = [];
  private readonly byTs = new Map<string, string>();
  private readonly state = new Replica();
  private nextSeq = 1;
  /** Log entries with seq <= horizon were compacted away. */
  private horizon = 0;
  private horizonSnapshot = new Replica().snapshot();
  private readonly now: () => number;
  private readonly maxDriftMs: number;
  private readonly maxOpBytes: number;
  readonly maxBatch: number;
  private readonly authorize: (clientId: string, op: Op) => boolean;

  constructor(options: SyncServerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxDriftMs = options.maxDriftMs ?? 5 * 60_000;
    this.maxOpBytes = options.maxOpBytes ?? 64 * 1024;
    this.maxBatch = options.maxBatch ?? 500;
    this.authorize = options.authorize ?? (() => true);
  }

  async push(request: PushRequest): Promise<PushResponse> {
    if (!isValidName(request.clientId)) throw new TypeError("invalid clientId");
    if (!Array.isArray(request.ops) || request.ops.length > this.maxBatch) {
      throw new RangeError(`push at most ${this.maxBatch} operations`);
    }
    const accepted: string[] = [];
    const rejected: { ts: string; reason: RejectReason }[] = [];
    for (const op of request.ops as unknown[]) {
      const reason = this.check(request.clientId, op);
      const ts = typeof (op as { ts?: unknown })?.ts === "string" ? (op as { ts: string }).ts : "";
      if (reason !== undefined) {
        rejected.push({ ts, reason });
        continue;
      }
      const valid = op as Op;
      const key = canonical(valid);
      const known = this.byTs.get(valid.ts);
      if (known === undefined) {
        this.byTs.set(valid.ts, key);
        this.log.push({ seq: this.nextSeq++, op: structuredClone(valid) });
        this.state.apply(valid);
        accepted.push(valid.ts);
      } else if (known === key) {
        accepted.push(valid.ts); // retry of an operation we already have
      } else {
        rejected.push({ ts: valid.ts, reason: "invalid" }); // same identity, different content
      }
    }
    return { accepted, rejected };
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    if (!Number.isSafeInteger(request.cursor) || request.cursor < 0 || request.cursor >= this.nextSeq) {
      throw new RangeError("invalid cursor");
    }
    if (request.cursor < this.horizon) {
      return { kind: "snapshot", snapshot: this.horizonSnapshot, cursor: this.horizon };
    }
    const limit = Math.max(1, Math.min(request.limit, this.maxBatch));
    const start = this.indexAfter(request.cursor);
    const page = this.log.slice(start, start + limit);
    const cursor = page.length > 0 ? (page[page.length - 1] as { seq: number }).seq : request.cursor;
    return {
      kind: "ops",
      ops: page.map((e) => structuredClone(e.op)),
      cursor,
      hasMore: start + limit < this.log.length,
    };
  }

  /**
   * Drop log entries up to and including `seq`, keeping a snapshot of the state at that point.
   * Clients whose cursor is older receive the snapshot and then the rest of the log.
   */
  compact(seq: number): void {
    if (seq <= this.horizon) return;
    const upTo = Math.min(seq, this.nextSeq - 1);
    const atHorizon = Replica.fromSnapshot(this.horizonSnapshot);
    const end = this.indexAfter(upTo);
    for (const e of this.log.slice(0, end)) atHorizon.apply(e.op);
    this.log.splice(0, end);
    this.horizon = upTo;
    this.horizonSnapshot = atHorizon.snapshot();
  }

  /** Latest sequence number. */
  get head(): number {
    return this.nextSeq - 1;
  }

  get logLength(): number {
    return this.log.length;
  }

  /** Merged state, for tests and admin tools. */
  get replica(): Replica {
    return this.state.clone();
  }

  private check(clientId: string, op: unknown): RejectReason | undefined {
    if (!isValidOp(op)) return "invalid";
    if (JSON.stringify(op).length > this.maxOpBytes) return "too-large";
    const ts = decodeTimestamp(op.ts);
    if (ts.node !== clientId) return "forbidden"; // a client may only stamp its own operations
    if (ts.wall - this.now() > this.maxDriftMs) return "clock-drift";
    if (!this.authorize(clientId, op)) return "forbidden";
    return undefined;
  }

  private indexAfter(seq: number): number {
    // log is sorted by seq; binary search for the first entry with seq > cursor
    let lo = 0;
    let hi = this.log.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.log[mid] as { seq: number }).seq <= seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

function canonical(op: Op): string {
  return op.kind === "delete"
    ? JSON.stringify([op.kind, op.ts, op.collection, op.doc])
    : JSON.stringify([op.kind, op.ts, op.collection, op.doc, op.field, sortKeys(op.value)]);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
