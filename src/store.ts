import jsonpatch from "fast-json-patch";
import type { Operation } from "fast-json-patch";
import {
  VERSION_KEY,
  isReservedKey,
  readLocalVersion,
  type ContextState,
  type JsonValue,
} from "./types.js";

const { applyPatch, compare, deepClone, escapePathComponent } = jsonpatch;

/**
 * Structured JSON shared state.
 * Mutations go through setKey / applyOps; `_version` is managed by sync layer.
 */
export class ContextStore {
  private state: ContextState = Object.create(null) as ContextState;

  get(key: string): JsonValue | undefined {
    return this.state[key];
  }

  getVersion(): number {
    return readLocalVersion(this.state);
  }

  setVersion(version: number): void {
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`Invalid _version: ${version}`);
    }
    this.state[VERSION_KEY] = version;
  }

  /**
   * Set a top-level key. Returns the RFC 6902 patch vs the previous snapshot,
   * or an empty array if nothing changed.
   */
  setKey(key: string, value: JsonValue): Operation[] {
    if (isReservedKey(key)) {
      throw new Error(`Reserved context key is not allowed: ${key}`);
    }
    if (key === VERSION_KEY) {
      throw new Error(
        `Key "${VERSION_KEY}" is system-managed; use the conflict protocol`,
      );
    }
    const before = this.snapshot();
    this.state[key] = deepClone(value) as JsonValue;
    return compare(before, this.snapshot());
  }

  /**
   * Apply an RFC 6902 patch in place (validated, prototype mods banned).
   * Returns the same ops for convenience (broadcast / audit).
   */
  applyOps(ops: Operation[]): Operation[] {
    applyPatch(this.state, deepClone(ops) as Operation[], true, true, true);
    return ops;
  }

  /** Deep-cloned plain snapshot suitable for compare() / Markdown. */
  snapshot(): ContextState {
    return deepClone(this.state) as ContextState;
  }

  /** Replace entire document (used when rehydrating from Markdown Active State). */
  replaceAll(next: ContextState): void {
    const clean = Object.create(null) as ContextState;
    for (const [key, value] of Object.entries(next)) {
      if (isReservedKey(key)) continue;
      clean[key] = deepClone(value) as JsonValue;
    }
    this.state = clean;
  }

  /** Build a JSON Pointer for a top-level key. */
  static pointerForKey(key: string): string {
    return `/${escapePathComponent(key)}`;
  }
}
