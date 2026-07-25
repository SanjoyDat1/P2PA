import { CrdtDoc, type CrdtOp, type MergeResult } from "./crdt.js";
import { HybridClock, nodeIdFromPublicKey, type Hlc } from "./hlc.js";
import {
  CrdtOpArraySchema,
  LEGACY_VERSION_KEY,
  isReservedKey,
  type ContextState,
  type JsonValue,
} from "./types.js";

/**
 * Shared state, backed by a per-key CRDT.
 *
 * There is no document-wide version any more. Each key carries its own stamp,
 * which is what allows two agents to write at the same time without either of
 * them having to win the whole document.
 */
export class ContextStore {
  private readonly doc: CrdtDoc;

  /**
   * @param nodeId Stable id for this replica — pass the node's public key.
   *   Defaults to a random id, which is only appropriate for throwaway
   *   instances such as tests: two replicas sharing an id cannot break ties.
   */
  constructor(nodeId?: string, now: () => number = Date.now) {
    const id = nodeId
      ? nodeIdFromPublicKey(nodeId)
      : `anon${Math.random().toString(16).slice(2, 14)}`;
    this.doc = new CrdtDoc(new HybridClock(id, now));
  }

  get nodeId(): string {
    return this.doc.nodeId;
  }

  get(key: string): JsonValue | undefined {
    return this.doc.get(key);
  }

  /** Stamp currently on a key, for status output. */
  stampFor(key: string): Hlc | undefined {
    return this.doc.stampFor(key);
  }

  /** Digest of the materialized document; equal digests mean equal state. */
  stateHash(): string {
    return this.doc.stateHash();
  }

  /** Set a top-level key. Returns the op to broadcast. */
  setKey(key: string, value: JsonValue): CrdtOp {
    this.assertWritable(key);
    return this.doc.setValue(key, value);
  }

  /** Tombstone a top-level key. Returns the op to broadcast. */
  deleteKey(key: string): CrdtOp {
    this.assertWritable(key);
    return this.doc.deleteValue(key);
  }

  /** Add one element to a set-valued key. Concurrent adds all survive. */
  addToSet(key: string, value: JsonValue): CrdtOp {
    this.assertWritable(key);
    return this.doc.addToSet(key, value);
  }

  /** Remove every copy of `value` from a set-valued key. */
  removeFromSet(key: string, value: JsonValue): CrdtOp | null {
    this.assertWritable(key);
    return this.doc.removeFromSet(key, value);
  }

  /** Merge inbound ops from a peer. Never replaces the document wholesale. */
  merge(ops: CrdtOp[], now: number = Date.now()): MergeResult[] {
    return this.doc.mergeAll(ops, now);
  }

  /** Plain-JSON view for agents, Markdown persistence, and hashing. */
  snapshot(): ContextState {
    return this.doc.materialize();
  }

  /** Every entry, for the handshake snapshot and for persistence. */
  export(): CrdtOp[] {
    return this.doc.export();
  }

  /**
   * Replace all entries when rehydrating from disk.
   *
   * The file is validated like wire input: it is not necessarily the file this
   * process wrote, and an unvalidated `__proto__` key or bogus `kind` from a
   * hand-edited document would flow straight into the materialized document.
   */
  load(ops: CrdtOp[], now: number = Date.now()): { loaded: number; skipped: number } {
    const parsed = CrdtOpArraySchema.safeParse(ops);
    if (!parsed.success) {
      // Salvage what is well-formed rather than discarding the whole document.
      const clean = ops.filter(
        (op) => CrdtOpArraySchema.safeParse([op]).success,
      );
      this.doc.load(clean, now);
      return { loaded: clean.length, skipped: ops.length - clean.length };
    }
    this.doc.load(parsed.data, now);
    return { loaded: parsed.data.length, skipped: 0 };
  }

  /**
   * Seed from a plain document with no stamps, as written by the retired
   * counter protocol. Each key is stamped locally on the way in.
   */
  hydrateLegacy(state: ContextState): number {
    let seeded = 0;
    for (const [key, value] of Object.entries(state)) {
      if (isReservedKey(key) || key === LEGACY_VERSION_KEY) continue;
      this.doc.setValue(key, value);
      seeded += 1;
    }
    return seeded;
  }

  private assertWritable(key: string): void {
    if (isReservedKey(key)) {
      throw new Error(`Reserved context key is not allowed: ${key}`);
    }
    if (key === LEGACY_VERSION_KEY) {
      throw new Error(
        `Key "${LEGACY_VERSION_KEY}" belonged to the retired counter protocol`,
      );
    }
  }
}
