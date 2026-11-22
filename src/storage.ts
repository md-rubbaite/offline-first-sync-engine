import type { Op, ReplicaSnapshot } from "./types.js";

/** What a client must keep across restarts. Saved as one unit so a crash never splits it. */
export interface ClientState {
  readonly version: 1;
  readonly cursor: number;
  readonly confirmed: ReplicaSnapshot;
  readonly outbox: readonly Op[];
  /** Last HLC timestamp issued or seen, encoded. */
  readonly clock: string | null;
}

/**
 * Durable storage for one client. Implementations must make save() atomic: after a crash, load()
 * returns either the previous state or the new one, never a mix. In a browser, one IndexedDB
 * transaction per save() satisfies this; on SQLite, one transaction.
 */
export interface Storage {
  load(): Promise<ClientState | undefined>;
  save(state: ClientState): Promise<void>;
}

/** In-memory storage. Deep-copies on both sides so callers cannot mutate saved state. */
export class MemoryStorage implements Storage {
  private state: ClientState | undefined;
  saves = 0;

  async load(): Promise<ClientState | undefined> {
    return this.state === undefined ? undefined : structuredClone(this.state);
  }

  async save(state: ClientState): Promise<void> {
    this.state = structuredClone(state);
    this.saves += 1;
  }
}
