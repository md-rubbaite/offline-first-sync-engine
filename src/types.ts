/** JSON values a field can hold. */
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };

export type Doc = Record<string, Value>;

/**
 * One change. Field-level operations let two devices edit different fields of the same record
 * offline without either edit being lost.
 *
 * `ts` is an encoded HLC timestamp. It is unique per change (it contains the node id), so it is
 * also the operation's identity: pushing the same operation twice is harmless.
 */
export type Op =
  | {
      readonly kind: "set";
      readonly ts: string;
      readonly collection: string;
      readonly doc: string;
      readonly field: string;
      readonly value: Value;
    }
  | {
      readonly kind: "delete";
      readonly ts: string;
      readonly collection: string;
      readonly doc: string;
    };

export interface PushRequest {
  readonly clientId: string;
  readonly ops: readonly Op[];
}

export type RejectReason =
  | "invalid"
  | "too-large"
  | "clock-drift"
  | "forbidden";

export interface PushResponse {
  /** Timestamps of operations now durable on the server, including ones it already had. */
  readonly accepted: readonly string[];
  /** Operations the server will never accept. The client drops them. */
  readonly rejected: readonly { readonly ts: string; readonly reason: RejectReason }[];
}

export interface PullRequest {
  readonly clientId: string;
  /** Position in the server log the client has already applied. 0 for a new client. */
  readonly cursor: number;
  readonly limit: number;
}

export type PullResponse =
  | {
      readonly kind: "ops";
      readonly ops: readonly Op[];
      readonly cursor: number;
      readonly hasMore: boolean;
    }
  | {
      /** The client's cursor is older than the compacted log: replace local state. */
      readonly kind: "snapshot";
      readonly snapshot: ReplicaSnapshot;
      readonly cursor: number;
    };

export interface FieldEntry {
  readonly value: Value;
  readonly ts: string;
}

export interface DocEntry {
  readonly fields: Readonly<Record<string, FieldEntry>>;
  readonly deletedAt?: string;
}

/** Serializable state of a replica: collection -> doc id -> entry. */
export type ReplicaSnapshot = Readonly<Record<string, Readonly<Record<string, DocEntry>>>>;

export interface Transport {
  push(request: PushRequest): Promise<PushResponse>;
  pull(request: PullRequest): Promise<PullResponse>;
}

/** Thrown by a transport for failures worth retrying (network, timeout, 5xx). */
export class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportError";
  }
}
