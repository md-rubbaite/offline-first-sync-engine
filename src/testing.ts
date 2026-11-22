import type { SyncServer } from "./server.js";
import { TransportError, type PullRequest, type PullResponse, type PushRequest, type PushResponse, type Transport } from "./types.js";

/** Calls a SyncServer in process, through a JSON round trip like a real network would. */
export class LocalTransport implements Transport {
  constructor(private readonly server: SyncServer) {}

  async push(request: PushRequest): Promise<PushResponse> {
    return roundTrip(await this.server.push(roundTrip(request)));
  }

  async pull(request: PullRequest): Promise<PullResponse> {
    return roundTrip(await this.server.pull(roundTrip(request)));
  }
}

export interface Faults {
  /** Probability the request never reaches the server. */
  dropRequest?: number;
  /** Probability the server handles the request but the response is lost. */
  dropResponse?: number;
  /** Probability the request is delivered twice (a retrying proxy, a double tap). */
  duplicate?: number;
  /** When true, every call fails as if the device were offline. */
  offline?: boolean;
}

/** A transport that loses, duplicates and refuses messages, for testing sync logic. */
export class FaultyTransport implements Transport {
  readonly stats = { calls: 0, droppedRequests: 0, droppedResponses: 0, duplicated: 0, offline: 0 };

  constructor(
    private readonly inner: Transport,
    public faults: Faults,
    private readonly random: () => number,
  ) {}

  push(request: PushRequest): Promise<PushResponse> {
    return this.call(() => this.inner.push(request));
  }

  pull(request: PullRequest): Promise<PullResponse> {
    return this.call(() => this.inner.pull(request));
  }

  private async call<T>(send: () => Promise<T>): Promise<T> {
    this.stats.calls += 1;
    if (this.faults.offline === true) {
      this.stats.offline += 1;
      throw new TransportError("offline");
    }
    if (this.random() < (this.faults.dropRequest ?? 0)) {
      this.stats.droppedRequests += 1;
      throw new TransportError("request lost");
    }
    if (this.random() < (this.faults.duplicate ?? 0)) {
      this.stats.duplicated += 1;
      await send();
    }
    const response = await send();
    if (this.random() < (this.faults.dropResponse ?? 0)) {
      this.stats.droppedResponses += 1;
      throw new TransportError("response lost");
    }
    return response;
  }
}

/** Small deterministic PRNG (mulberry32) for reproducible fault schedules. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
