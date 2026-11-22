import { isEncodedTimestamp } from "./hlc.js";
import type { Op, Value } from "./types.js";

const NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const RESERVED_FIELDS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 32;

export function isValidName(name: unknown): name is string {
  return typeof name === "string" && NAME.test(name);
}

export function isValidField(field: unknown): field is string {
  return isValidName(field) && !RESERVED_FIELDS.has(field);
}

export function isJsonValue(value: unknown, depth = 0): value is Value {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isJsonValue(v, depth + 1));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.entries(value).every(([k, v]) => !RESERVED_FIELDS.has(k) && isJsonValue(v, depth + 1));
  }
  return false;
}

/** Structural check for an operation received from an untrusted peer. */
export function isValidOp(op: unknown): op is Op {
  if (typeof op !== "object" || op === null) return false;
  const o = op as Record<string, unknown>;
  if (!isEncodedTimestamp(o["ts"]) || !isValidName(o["collection"]) || !isValidName(o["doc"])) return false;
  if (o["kind"] === "delete") return Object.keys(o).length === 4;
  if (o["kind"] === "set") {
    return Object.keys(o).length === 6 && isValidField(o["field"]) && "value" in o && isJsonValue(o["value"]);
  }
  return false;
}
