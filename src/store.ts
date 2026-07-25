import { CrdtDoc, type CrdtOp, type MergeResult } from "./crdt.js";
import {
  claimKeyFor,
  describeClaim,
  isClaimKey,
  holderOf,
  isAcceptableTtl,
  isHeld,
  isSafelyLapsed,
  isValidTaskId,
  taskIdFromKey,
  type ClaimEntry,
  type ClaimView,
} from "./claim.js";
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
  private readonly now: () => number;

  constructor(nodeId?: string, now: () => number = Date.now) {
    const id = nodeId
      ? nodeIdFromPublicKey(nodeId)
      : `anon${Math.random().toString(16).slice(2, 14)}`;
    // Held so lease expiry reads the same clock that stamps writes. Mixing an
    // injected stamp clock with real wall time made lease decisions incoherent.
    this.now = now;
    this.doc = new CrdtDoc(new HybridClock(id, now));
  }

  /** Current time on this replica's clock, for callers deriving lease views. */
  nowMs(): number {
    return this.now();
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

  // ---- leases -------------------------------------------------------------

  /** Current lease on a task, expired ones included. */
  claim(taskId: string): ClaimEntry | undefined {
    return this.doc.claimEntry(claimKeyFor(taskId));
  }

  /** Node id holding a task right now, or null when it is free. */
  holder(taskId: string, now: number = this.now()): string | null {
    const entry = this.claim(taskId);
    return entry ? holderOf(entry, now) : null;
  }

  /** True when this replica is the current holder. */
  holdsClaim(taskId: string, now: number = this.now()): boolean {
    return this.holder(taskId, now) === this.nodeId;
  }

  /**
   * Take a lease on a task.
   *
   * Refuses only when somebody else currently holds it. Re-claiming a task this
   * replica already holds is how a lease is renewed: it takes the next
   * generation, which outranks the lease it extends.
   */
  takeClaim(
    taskId: string,
    ttlMs: number,
    note?: string,
    now: number = this.now(),
  ): { ok: true; op: CrdtOp } | { ok: false; holder: string } {
    if (!isValidTaskId(taskId)) {
      throw new Error(`Malformed task id: ${taskId}`);
    }
    if (!isAcceptableTtl(ttlMs)) {
      throw new Error(`Lease duration out of range: ${ttlMs}ms`);
    }
    const key = claimKeyFor(taskId);
    const current = this.doc.claimEntry(key);
    if (current && current.hlc.n !== this.nodeId && !isSafelyLapsed(current, now)) {
      // Grace on top of expiry: clocks disagree, and without it a node running
      // fast decides a live lease has lapsed and duplicates the work.
      return { ok: false, holder: current.hlc.n };
    }
    const op = this.doc.takeClaim(key, ttlMs, note);
    if (!op) return { ok: false, holder: current?.hlc.n ?? "another node" };
    return { ok: true, op };
  }

  /** Give up a lease this replica holds. */
  releaseClaim(
    taskId: string,
    now: number = this.now(),
  ): { ok: true; op: CrdtOp } | { ok: false; reason: string } {
    if (!isValidTaskId(taskId)) return { ok: false, reason: "malformed task id" };
    const key = claimKeyFor(taskId);
    const current = this.doc.claimEntry(key);
    if (!current) return { ok: false, reason: "no lease on that task" };
    if (!isHeld(current, now)) return { ok: false, reason: "lease already ended" };
    if (current.hlc.n !== this.nodeId) {
      return { ok: false, reason: `held by ${current.hlc.n}` };
    }
    const op = this.doc.releaseClaim(key);
    if (!op) return { ok: false, reason: "no lease on that task" };
    return { ok: true, op };
  }

  /**
   * Digest over the lease table.
   *
   * `stateHash` deliberately ignores leases, so two replicas disagreeing about
   * who holds a task would otherwise look identical to `sync_health`.
   */
  claimsHash(): string {
    return this.doc.claimsHash();
  }

  /** Every lease on record, newest-relevant first. */
  listClaims(now: number = this.now()): ClaimView[] {
    return this.doc
      .claimEntries()
      .map(({ key, entry }) => {
        const taskId = taskIdFromKey(key);
        return taskId === null ? null : describeClaim(taskId, entry, now);
      })
      .filter((view): view is ClaimView => view !== null)
      .sort((a, b) => Number(b.held) - Number(a.held) || (a.taskId < b.taskId ? -1 : 1));
  }

  /** Merge inbound ops from a peer. Never replaces the document wholesale. */
  merge(ops: CrdtOp[], now: number = this.now()): MergeResult[] {
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
  load(ops: CrdtOp[], now: number = this.now()): { loaded: number; skipped: number } {
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
      if (isClaimKey(key)) continue;
      this.doc.setValue(key, value);
      seeded += 1;
    }
    return seeded;
  }

  private assertWritable(key: string): void {
    if (isReservedKey(key)) {
      throw new Error(`Reserved context key is not allowed: ${key}`);
    }
    if (isClaimKey(key)) {
      throw new Error(
        `Key "${key}" belongs to the lease namespace; use claim/release instead`,
      );
    }
    if (key === LEGACY_VERSION_KEY) {
      throw new Error(
        `Key "${LEGACY_VERSION_KEY}" belonged to the retired counter protocol`,
      );
    }
  }
}
