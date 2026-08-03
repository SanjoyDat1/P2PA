/**
 * Deterministic JSON.
 *
 * Two things depend on every implementation producing byte-identical output for
 * the same value: the content tiebreak that keeps replicas from disagreeing when
 * stamps collide, and the signature over an operation. `JSON.stringify` orders
 * object keys by insertion, so it cannot serve either — a value that round-trips
 * through a different language, or merely through a different key order, would
 * hash differently and verify as forged.
 *
 * The rules are the whole contract, and they are restated normatively in
 * SPEC.md so a second implementation can reproduce them:
 * - object keys sorted by UTF-16 code unit, ascending
 * - no insignificant whitespace
 * - strings escaped as `JSON.stringify` escapes them
 * - numbers as `JSON.stringify` renders them (integers exactly; P2PA does not
 *   sign non-integer numbers, see `SPEC.md` §Signatures)
 */
import type { JsonValue } from "./types.js";

/** Canonical serialization of any JSON value. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`)
    .join(",");
  return `{${body}}`;
}
