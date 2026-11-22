import { TransportError } from "./types.js";

export interface RetryOptions {
  /** Attempts after the first one. Default 5. */
  readonly retries?: number;
  /** First backoff in milliseconds. Default 200. */
  readonly baseMs?: number;
  /** Cap for one backoff. Default 30 seconds. */
  readonly maxMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Random number in [0, 1), for jitter. */
  readonly random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying TransportError with exponential backoff and full jitter. Other errors are
 * bugs or permanent failures and are thrown at once.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 5;
  const base = options.baseMs ?? 200;
  const max = options.maxMs ?? 30_000;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof TransportError) || attempt >= retries) throw err;
      const ceiling = Math.min(max, base * 2 ** attempt);
      await sleep(Math.floor(random() * ceiling));
    }
  }
}
