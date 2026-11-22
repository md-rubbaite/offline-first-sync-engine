import { Hlc, decodeTimestamp, encodeTimestamp } from "./hlc.js";
import { Replica } from "./replica.js";
import { withRetry, type RetryOptions } from "./retry.js";
import type { ClientState, Storage } from "./storage.js";
import type { Doc, Op, PushResponse, RejectReason, Transport, Value } from "./types.js";
import { isJsonValue, isValidField, isValidName } from "./validate.js";

export interface SyncClientOptions {
  /** Stable, unique id of this device or installation. It is part of every timestamp. */
  readonly clientId: string;
  readonly transport: Transport;
  readonly storage: Storage;
  readonly now?: () => number;
  /** Operations per push and per pull page. Default 100. */
  readonly batchSize?: number;
  readonly retry?: RetryOptions;
}

export interface SyncResult {
  readonly pushed: number;
  readonly rejected: readonly { readonly op: Op; readonly reason: RejectReason }[];
  readonly pulled: number;
  readonly resynced: boolean;
}

/**
 * An offline-first client. Writes apply locally at once and wait in a durable outbox; sync() pushes
 * the outbox and pulls everything new from the server.
 *
 * The visible state is the server-confirmed state with the pending operations applied on top. So an
 * operation the server rejects simply disappears on the next sync, and nothing has to be rolled
 * back by hand.
 */
export class SyncClient {
  private readonly hlc: Hlc;
  private confirmed = new Replica();
  private view = new Replica();
  private outbox: Op[] = [];
  private cursor = 0;
  private syncing: Promise<SyncResult> | undefined;
  private loaded = false;
  private readonly batchSize: number;

  private constructor(private readonly options: SyncClientOptions) {
    this.hlc = new Hlc(options.clientId, options.now === undefined ? {} : { now: options.now });
    this.batchSize = options.batchSize ?? 100;
  }

  /** Create a client and restore any state saved by a previous run. */
  static async open(options: SyncClientOptions): Promise<SyncClient> {
    const client = new SyncClient(options);
    const saved = await options.storage.load();
    if (saved !== undefined) {
      if (saved.version !== 1) throw new Error(`unsupported client state version ${String(saved.version)}`);
      client.cursor = saved.cursor;
      client.confirmed = Replica.fromSnapshot(saved.confirmed);
      client.outbox = [...saved.outbox];
      if (saved.clock !== null) client.hlc.restore(decodeTimestamp(saved.clock));
      client.rebuildView();
    }
    client.loaded = true;
    return client;
  }

  get clientId(): string {
    return this.options.clientId;
  }

  /** Operations written locally and not yet acknowledged by the server. */
  get pending(): number {
    return this.outbox.length;
  }

  get serverCursor(): number {
    return this.cursor;
  }

  get(collection: string, id: string): Doc | undefined {
    return this.view.get(collection, id);
  }

  list(collection: string): { id: string; doc: Doc }[] {
    return this.view.list(collection);
  }

  /** Everything visible on this device. */
  snapshotView(): Record<string, Record<string, Doc>> {
    return this.view.view();
  }

  /** Set one or more fields of a document. Each field becomes its own operation. */
  async set(collection: string, id: string, fields: Record<string, Value>): Promise<Op[]> {
    this.assertOpen();
    assertName("collection", collection);
    assertName("document id", id);
    const entries = Object.entries(fields);
    if (entries.length === 0) throw new TypeError("no fields to set");
    for (const [field, value] of entries) {
      if (!isValidField(field)) throw new TypeError(`invalid field name ${JSON.stringify(field)}`);
      if (!isJsonValue(value)) throw new TypeError(`field ${field} is not a JSON value`);
    }
    const ops: Op[] = entries.map(([field, value]) => ({
      kind: "set",
      ts: encodeTimestamp(this.hlc.tick()),
      collection,
      doc: id,
      field,
      value: structuredClone(value),
    }));
    return this.record(ops);
  }

  async delete(collection: string, id: string): Promise<Op[]> {
    this.assertOpen();
    assertName("collection", collection);
    assertName("document id", id);
    return this.record([{ kind: "delete", ts: encodeTimestamp(this.hlc.tick()), collection, doc: id }]);
  }

  /**
   * Push pending operations, then pull until up to date. Concurrent calls share one run.
   * Throws TransportError if the network stays down after the retries; local state is intact and
   * the next sync() continues where this one stopped.
   */
  sync(): Promise<SyncResult> {
    this.assertOpen();
    this.syncing ??= this.runSync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async runSync(): Promise<SyncResult> {
    let pushed = 0;
    const rejected: { op: Op; reason: RejectReason }[] = [];
    // Push a stable prefix of the outbox. Writes made during the sync stay queued for the next run.
    const toPush = [...this.outbox];
    for (let i = 0; i < toPush.length; i += this.batchSize) {
      const batch = toPush.slice(i, i + this.batchSize);
      const response: PushResponse = await withRetry(
        () => this.options.transport.push({ clientId: this.clientId, ops: batch }),
        this.options.retry,
      );
      const done = new Set<string>(response.accepted);
      for (const r of response.rejected) {
        const op = batch.find((o) => o.ts === r.ts);
        if (op !== undefined) {
          rejected.push({ op, reason: r.reason });
          done.add(r.ts);
        }
      }
      pushed += response.accepted.length;
      this.outbox = this.outbox.filter((o) => !done.has(o.ts));
      // Acknowledged operations are part of the server state, so fold them into `confirmed` now;
      // otherwise they would vanish from the view until the pull below brings them back.
      for (const op of batch) if (response.accepted.includes(op.ts)) this.confirmed.apply(op);
      this.rebuildView();
      await this.persist();
    }

    let pulled = 0;
    let resynced = false;
    for (;;) {
      const page = await withRetry(
        () => this.options.transport.pull({ clientId: this.clientId, cursor: this.cursor, limit: this.batchSize }),
        this.options.retry,
      );
      if (page.kind === "snapshot") {
        this.confirmed = Replica.fromSnapshot(page.snapshot);
        this.cursor = page.cursor;
        resynced = true;
        this.rebuildView();
        await this.persist();
        continue;
      }
      for (const op of page.ops) {
        this.hlc.receive(decodeTimestamp(op.ts), false);
        this.confirmed.apply(op);
      }
      pulled += page.ops.length;
      this.cursor = page.cursor;
      this.rebuildView();
      await this.persist();
      if (!page.hasMore) break;
    }
    return { pushed, rejected, pulled, resynced };
  }

  private async record(ops: Op[]): Promise<Op[]> {
    this.outbox.push(...ops);
    this.view.applyAll(ops);
    await this.persist();
    return ops;
  }

  private rebuildView(): void {
    const view = this.confirmed.clone();
    view.applyAll(this.outbox);
    this.view = view;
  }

  private persist(): Promise<void> {
    const state: ClientState = {
      version: 1,
      cursor: this.cursor,
      confirmed: this.confirmed.snapshot(),
      outbox: this.outbox,
      clock: this.hlc.last.wall === 0 ? null : encodeTimestamp(this.hlc.last),
    };
    return this.options.storage.save(state);
  }

  private assertOpen(): void {
    if (!this.loaded) throw new Error("use SyncClient.open()");
  }
}

function assertName(what: string, name: string): void {
  if (!isValidName(name)) throw new TypeError(`invalid ${what} ${JSON.stringify(name)}`);
}
