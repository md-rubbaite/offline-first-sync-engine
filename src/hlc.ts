/**
 * Hybrid Logical Clock (Kulkarni et al., 2014).
 *
 * A timestamp is (wall milliseconds, counter, node id). It never goes backwards on one node, it
 * moves past every timestamp the node has seen, and it stays close to physical time, so
 * "last writer wins" means what users expect even when device clocks are a little wrong.
 *
 * Encoded form: `<wall:15 digits>:<counter:6 digits>:<node>`. Encoded timestamps sort
 * lexicographically in the same order as compareTimestamps, so they can be stored as plain
 * strings and indexed by a database.
 */

export interface Timestamp {
  readonly wall: number;
  readonly counter: number;
  readonly node: string;
}

export const MAX_COUNTER = 999_999;
const WALL_DIGITS = 15;
const COUNTER_DIGITS = 6;
const NODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export class ClockDriftError extends Error {
  constructor(
    readonly remoteWall: number,
    readonly localWall: number,
    readonly maxDriftMs: number,
  ) {
    super(`remote clock is ${remoteWall - localWall} ms ahead (limit ${maxDriftMs} ms)`);
    this.name = "ClockDriftError";
  }
}

export class CounterOverflowError extends Error {
  constructor() {
    super("HLC counter overflow: too many events in one millisecond, or the clock is stuck");
    this.name = "CounterOverflowError";
  }
}

export function assertNodeId(node: string): void {
  if (!NODE_PATTERN.test(node)) {
    throw new TypeError(`invalid node id ${JSON.stringify(node)}: use 1-64 of [A-Za-z0-9_.-]`);
  }
}

export function encodeTimestamp(ts: Timestamp): string {
  if (!Number.isSafeInteger(ts.wall) || ts.wall < 0 || ts.wall >= 10 ** WALL_DIGITS) {
    throw new RangeError(`wall time out of range: ${ts.wall}`);
  }
  if (!Number.isInteger(ts.counter) || ts.counter < 0 || ts.counter > MAX_COUNTER) {
    throw new RangeError(`counter out of range: ${ts.counter}`);
  }
  assertNodeId(ts.node);
  return `${String(ts.wall).padStart(WALL_DIGITS, "0")}:${String(ts.counter).padStart(COUNTER_DIGITS, "0")}:${ts.node}`;
}

const ENCODED = /^(\d{15}):(\d{6}):([A-Za-z0-9_.-]{1,64})$/;

export function decodeTimestamp(encoded: string): Timestamp {
  const m = ENCODED.exec(encoded);
  if (!m) throw new TypeError(`invalid timestamp ${JSON.stringify(encoded)}`);
  return { wall: Number(m[1]), counter: Number(m[2]), node: m[3] as string };
}

export function isEncodedTimestamp(value: unknown): value is string {
  return typeof value === "string" && ENCODED.test(value);
}

export function compareTimestamps(a: Timestamp, b: Timestamp): number {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node === b.node) return 0;
  return a.node < b.node ? -1 : 1;
}

export interface HlcOptions {
  /** Physical clock, milliseconds since the epoch. Injected for tests. */
  readonly now?: () => number;
  /** Reject remote timestamps further ahead of the local clock than this. Default 5 minutes. */
  readonly maxDriftMs?: number;
}

export class Hlc {
  private wall = 0;
  private counter = 0;
  private readonly clock: () => number;
  readonly maxDriftMs: number;

  constructor(
    readonly node: string,
    options: HlcOptions = {},
  ) {
    assertNodeId(node);
    this.clock = options.now ?? Date.now;
    this.maxDriftMs = options.maxDriftMs ?? 5 * 60_000;
  }

  /** The last timestamp issued or observed, for persistence across restarts. */
  get last(): Timestamp {
    return { wall: this.wall, counter: this.counter, node: this.node };
  }

  /** Restore state persisted by a previous process so the clock never goes backwards. */
  restore(last: Timestamp): void {
    if (compareTimestamps({ ...last, node: this.node }, this.last) > 0) {
      this.wall = last.wall;
      this.counter = last.counter;
    }
  }

  /** Timestamp for a local event. */
  tick(): Timestamp {
    const physical = this.clock();
    if (physical > this.wall) {
      this.wall = physical;
      this.counter = 0;
    } else {
      this.bump();
    }
    return this.last;
  }

  /**
   * Merge a timestamp received from another node. With `checkDrift`, a timestamp too far in the
   * future is rejected instead of dragging this clock forward.
   */
  receive(remote: Timestamp, checkDrift = true): Timestamp {
    const physical = this.clock();
    if (checkDrift && remote.wall - physical > this.maxDriftMs) {
      throw new ClockDriftError(remote.wall, physical, this.maxDriftMs);
    }
    const wall = Math.max(this.wall, remote.wall, physical);
    if (wall === this.wall && wall === remote.wall) {
      this.counter = Math.max(this.counter, remote.counter);
      this.bump();
    } else if (wall === this.wall) {
      this.bump();
    } else if (wall === remote.wall) {
      this.wall = wall;
      this.counter = remote.counter;
      this.bump();
    } else {
      this.wall = wall;
      this.counter = 0;
    }
    return this.last;
  }

  private bump(): void {
    if (this.counter >= MAX_COUNTER) throw new CounterOverflowError();
    this.counter += 1;
  }
}
