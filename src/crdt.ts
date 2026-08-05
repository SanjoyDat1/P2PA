/**
 * The replicated document.
 *
 * Every top-level key is its own CRDT register carrying its own HLC stamp, so
 * two agents writing different keys never contend: each key merges on its own
 * timeline and both peers arrive at the same document without exchanging a
 * single round of agreement. Where they do write the same key, the HLC total
 * order picks the winner identically on both sides — deterministic rather than
 * queued for a human or an LLM to arbitrate.
 *
 * Two register types are supported:
 * - `lww` — last-write-wins scalar/object, with a tombstone so a delete cannot
 *   be silently resurrected by a stale replica.
 * - `orset` — add-wins set, so concurrent appends to a list union instead of
 *   one overwriting the other.
 *
 * Every bound in here (`MAX_CRDT_KEYS`, `MAX_SET_ELEMENTS`,
 * `MAX_SET_TOMBSTONES`) exists because entries arrive from peers: an unbounded
 * document or tombstone set is a remote memory-exhaustion primitive.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import { isSigned, stripSignature, verifyOp, type OpSigner } from "./signing.js";
import {
  breakTie,
  compareHlc,
  isAcceptableHlc,
  type Hlc,
  type HybridClock,
} from "./hlc.js";
import {
  claimWins,
  isAcceptableClaimStamp,
  isAcceptableGen,
  isAcceptableTtl,
  isClaimKey,
  isCollectable,
  nextGeneration,
  type ClaimEntry,
} from "./claim.js";
import {
  canonicalTask,
  isAcceptableTaskEntry,
  isTaskCollectable,
  isTaskKey,
  mergeTasks,
  type TaskDraft,
  type TaskEntry,
} from "./task.js";
import type { ContextState, JsonValue } from "./types.js";

/** Maximum distinct keys in one document. */
export const MAX_CRDT_KEYS = 10_000;
/**
 * Maximum concurrent leases.
 *
 * Separate from the state budget so a flood of leases cannot crowd out the
 * shared context — and bounded, because leases were previously exempt entirely.
 */
export const MAX_CLAIM_KEYS = 1_000;
/**
 * Maximum tasks on the backlog.
 *
 * Its own budget, like leases, so a flood of tasks cannot crowd out the shared
 * context. 500 because a backlog is a human-scale queue — past a few hundred
 * open items the board is no longer legible to the human it exists for — and
 * because 500 entries at `MAX_VALUE_BYTES` is 32 MiB, an order of magnitude
 * under what the state budget already tolerates.
 */
export const MAX_TASK_KEYS = 500;
/** Maximum live elements in one set. */
export const MAX_SET_ELEMENTS = 5_000;
/** Maximum retained remove-tags in one set. */
export const MAX_SET_TOMBSTONES = 10_000;
/** Maximum serialized bytes for a single key's value. */
export const MAX_VALUE_BYTES = 64 * 1024;
/**
 * How long a tombstone is retained before collection.
 *
 * Must comfortably exceed the accepted clock skew so a delete cannot be
 * outlived by an in-flight write that predates it.
 */
export const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Signature metadata carried by every entry kind.
 *
 * Stored with the entry rather than on the envelope so it survives relay: an op
 * authored by C stays verifiable after B passes it to A. See `signing.ts`.
 */
export interface SignatureFields {
  /** Author's ed25519 public key, lowercase hex. Absent on unsigned entries. */
  by?: string;
  /** Base64 signature over the canonical op encoding. */
  sig?: string;
}

export interface LwwEntry extends SignatureFields {
  kind: "lww";
  hlc: Hlc;
  /** Omitted when `deleted` is true. */
  value?: JsonValue;
  deleted?: boolean;
}

export interface OrSetEntry extends SignatureFields {
  kind: "orset";
  hlc: Hlc;
  /**
   * Highest lww stamp this key has carried.
   * Set ops at or below it belong to a superseded lineage and are discarded, so
   * a key that flips between kinds converges regardless of delivery order.
   */
  floor?: Hlc;
  /** Unique tag → element. Concurrent adds get distinct tags and both survive. */
  adds: Record<string, JsonValue>;
  /** Tags that have been removed. Add-wins: a re-add gets a fresh tag. */
  removes: string[];
}

export type CrdtEntry = LwwEntry | OrSetEntry | ClaimEntry | TaskEntry;

/** One key's state, as it travels on the wire and in snapshots. */
export interface CrdtOp {
  key: string;
  entry: CrdtEntry;
}

export type MergeStatus = "applied" | "ignored" | "contended" | "rejected";

export interface MergeResult {
  key: string;
  status: MergeStatus;
  /** Set when an existing value written by a different node was replaced. */
  previousNode?: string;
  /** Set when status is "rejected". */
  reason?: string;
}

function isOrSet(entry: CrdtEntry): entry is OrSetEntry {
  return entry.kind === "orset";
}

function isClaim(entry: CrdtEntry): entry is ClaimEntry {
  return entry.kind === "claim";
}

function isTask(entry: CrdtEntry): entry is TaskEntry {
  return entry.kind === "task";
}

/**
 * Does `candidate` replace `current`?
 *
 * Stamp order decides it. When the stamps are byte-identical — which only
 * happens when someone replays another node's stamp with different content —
 * the canonical form of the entry breaks the tie, so every replica makes the
 * same call instead of keeping whichever arrived first.
 */
function entryWins(candidate: CrdtEntry, current: CrdtEntry): boolean {
  const byStamp = compareHlc(candidate.hlc, current.hlc);
  if (byStamp !== 0) return byStamp > 0;
  const byContent = breakTie(canonicalEntry(candidate), canonicalEntry(current));
  if (byContent !== 0) return byContent > 0;
  // Same stamp, same content: keep whichever copy carries a signature. A v3 peer
  // drops the signature fields when it relays, so one logical write can arrive
  // both signed and bare; retaining the verifiable copy is strictly more
  // information and is the same decision on every replica. `canonicalEntry`
  // deliberately excludes `by`/`sig`, so this is the only place they matter.
  return isSigned(candidate) && !isSigned(current);
}

/** Highest lww stamp either side has seen for this key. Monotone, so it converges. */
function highestFloor(a: CrdtEntry, b: CrdtEntry): Hlc | undefined {
  // A lease or a task stamp is not evidence that a key was ever an `lww`
  // register, so neither contributes a floor.
  const left = isOrSet(a) ? a.floor : isClaim(a) || isTask(a) ? undefined : a.hlc;
  const right = isOrSet(b) ? b.floor : isClaim(b) || isTask(b) ? undefined : b.hlc;
  if (!left) return right;
  if (!right) return left;
  return compareHlc(left, right) >= 0 ? left : right;
}

/**
 * Record that a key was an lww register as recently as `stamp`.
 *
 * Raising the floor edits the entry, so the author's signature no longer covers
 * it and has to go: relaying a signature over content that has since changed
 * would have every peer reject the op as a forgery and stall convergence on that
 * key. The floor is derived state — any replica recomputes it from the ops it has
 * seen — so losing verifiability here costs nothing.
 */
function raiseFloor(entry: CrdtEntry, stamp: Hlc): CrdtEntry {
  if (!isOrSet(entry)) return entry;
  if (entry.floor && compareHlc(entry.floor, stamp) >= 0) return entry;
  return { ...stripSignature(entry), floor: stamp } as OrSetEntry;
}

/**
 * Union two tag maps, resolving a collision by content rather than by which
 * side happened to be spread last.
 *
 * Tags are predictable and relayed verbatim, so a peer can reuse another node's
 * tag; spread order then silently replaced that element on one replica only.
 */
function mergeAdds(
  current: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): Record<string, JsonValue> {
  // Prototype-free, because tags come from peers. On a plain object the tag
  // `__proto__` makes `tag in out` true via the inherited accessor, so a genuine
  // element was compared against `Object.prototype` and silently dropped — and
  // assigning to it rewrote the object's prototype instead of adding an element.
  // Whether that happened depended on how the map was built (`JSON.parse` creates
  // an own `__proto__`, a spread does not), so two replicas could disagree.
  // Reserved tags are also refused at the schema boundary; this is the second layer.
  const out: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [tag, value] of Object.entries(current)) out[tag] = value;
  for (const [tag, value] of Object.entries(incoming)) {
    if (!Object.hasOwn(out, tag)) {
      out[tag] = value;
      continue;
    }
    const mine = canonicalJson(out[tag] as JsonValue);
    const theirs = canonicalJson(value);
    if (breakTie(theirs, mine) > 0) out[tag] = value;
  }
  return out;
}

function canonicalEntry(entry: CrdtEntry): string {
  if (isClaim(entry)) {
    return `claim:${entry.gen}:${entry.ttl}:${entry.released === true ? "r" : "a"}`;
  }
  // Unreachable in practice — namespace isolation keeps other kinds off `@task/`
  // keys and the task branch in `mergeOp` runs before `entryWins` is ever
  // reached — but leaving a kind out of a function that claims to be a total
  // ordering is exactly how the mixed-kind data loss in §5.5 became possible.
  if (isTask(entry)) {
    return `task:${entry.status}:${entry.attempts}:${canonicalTask(entry)}`;
  }
  return isOrSet(entry)
    ? `orset:${canonicalJson(entry.adds as JsonValue)}:${[...entry.removes].sort().join(",")}`
    : `lww:${entry.deleted === true ? "-" : canonicalJson((entry.value ?? null) as JsonValue)}`;
}

export class CrdtDoc {
  private readonly entries = new Map<string, CrdtEntry>();
  private tagCounter = 0;

  /**
   * @param signer Signs every entry this replica mints, so the copy kept locally
   *   and the copy broadcast are byte-identical. Signing only the outbound copy
   *   would leave this node relaying its own writes unsigned inside snapshots,
   *   which is exactly the case signatures exist to cover. Omitted in tests and
   *   on builds without an identity, where entries stay unsigned.
   */
  constructor(
    private readonly clock: HybridClock,
    private readonly signer?: OpSigner,
  ) {}

  /**
   * Attach this node's signature to a freshly minted op.
   *
   * A merged OR-set is deliberately left unsigned by `mergeOp`: its contents come
   * from several authors, so no single signature can speak for it. Delta ops are
   * signed, which is what makes set *membership* verifiable even though a merged
   * set is not attributable to one node. See SPEC.md §Signatures.
   */
  private signed(op: CrdtOp): CrdtOp {
    if (!this.signer) return op;
    try {
      return this.signer.signOp(op);
    } catch (err) {
      // Never fail a local write because signing failed — an unsigned entry is
      // still correct, merely unverifiable by a third party downstream.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[p2pa:crdt] could not sign ${op.key}: ${message}`);
      return op;
    }
  }

  get nodeId(): string {
    return this.clock.id;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Leases on record, which have their own budget. */
  private claimKeyCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (isClaim(entry)) count += 1;
    }
    return count;
  }

  /** Tasks on record, which have their own budget. */
  private taskKeyCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (isTask(entry)) count += 1;
    }
    return count;
  }

  /** Keys that currently hold a value — tombstones do not consume the budget. */
  private liveKeyCount(): number {
    let live = 0;
    for (const entry of this.entries.values()) {
      if (isClaim(entry) || isTask(entry)) continue;
      if (!isOrSet(entry) && entry.deleted === true) continue;
      live += 1;
    }
    return live;
  }

  /**
   * Drop tombstones older than the retention horizon.
   *
   * Without this a deleted key holds its slot forever, so a document that has
   * churned through its key budget stays permanently full even when it
   * materializes to nothing.
   */
  private collectTombstones(now: number): void {
    for (const [key, entry] of this.entries) {
      if (isClaim(entry)) {
        // An expired lease is kept a while so a late op cannot reinstate it,
        // then dropped so finished tasks do not accumulate forever.
        if (isCollectable(entry, now)) this.entries.delete(key);
        continue;
      }
      if (isTask(entry)) {
        // Only a settled task is collectable. An `open` one is the work queue,
        // and dropping it loses the job rather than the record of one.
        if (isTaskCollectable(entry, now)) this.entries.delete(key);
        continue;
      }
      if (isOrSet(entry) || entry.deleted !== true) continue;
      if (now - entry.hlc.w > TOMBSTONE_TTL_MS) this.entries.delete(key);
    }
  }

  /** Fresh, globally unique tag for one set element. */
  private mintTag(stamp: Hlc): string {
    this.tagCounter += 1;
    return `${stamp.n}.${stamp.w.toString(36)}.${stamp.c.toString(36)}.${this.tagCounter.toString(36)}`;
  }

  // ---- local writes -------------------------------------------------------

  /** Write a key locally. Returns the op to broadcast. */
  setValue(key: string, value: JsonValue): CrdtOp {
    if (!this.entries.has(key)) {
      this.collectTombstones(Date.now());
      if (this.liveKeyCount() >= MAX_CRDT_KEYS) {
        throw new Error(`document is at its ${MAX_CRDT_KEYS}-key limit`);
      }
    }
    const op = this.signed({
      key,
      entry: { kind: "lww", hlc: this.clock.tick(), value } satisfies LwwEntry,
    });
    this.entries.set(key, op.entry);
    return op;
  }

  /** Tombstone a key locally. Returns the op to broadcast. */
  deleteValue(key: string): CrdtOp {
    const op = this.signed({
      key,
      entry: {
        kind: "lww",
        hlc: this.clock.tick(),
        deleted: true,
      } satisfies LwwEntry,
    });
    this.entries.set(key, op.entry);
    return op;
  }

  /** Add one element to a set-valued key. Concurrent adds all survive. */
  addToSet(key: string, value: JsonValue): CrdtOp {
    const existing = this.entries.get(key);
    if (!existing) {
      this.collectTombstones(Date.now());
      if (this.liveKeyCount() >= MAX_CRDT_KEYS) {
        throw new Error(`document is at its ${MAX_CRDT_KEYS}-key limit`);
      }
    }
    const stamp = this.clock.tick();
    const base: OrSetEntry =
      existing && isOrSet(existing)
        ? existing
        : { kind: "orset", hlc: stamp, adds: {}, removes: [] };

    const removedTags = new Set(base.removes);
    const liveElements = Object.keys(base.adds).filter(
      (tag) => !removedTags.has(tag),
    ).length;
    if (liveElements >= MAX_SET_ELEMENTS) {
      throw new Error(`set "${key}" is at its ${MAX_SET_ELEMENTS}-element limit`);
    }

    const tag = this.mintTag(stamp);
    // The stored entry and the broadcast delta are different values, so each is
    // signed over its own content — a signature covering one would not verify
    // against the other.
    const full = this.signed({
      key,
      entry: {
        kind: "orset",
        hlc: stamp,
        adds: { ...base.adds, [tag]: value },
        removes: [...base.removes],
        ...(base.floor ? { floor: base.floor } : {}),
      } satisfies OrSetEntry,
    });
    this.entries.set(key, full.entry);
    // Broadcast only the delta; merge is a union so peers converge either way.
    return this.signed({
      key,
      entry: {
        kind: "orset",
        hlc: stamp,
        adds: { [tag]: value },
        removes: [],
      } satisfies OrSetEntry,
    });
  }

  /** Remove every current copy of `value` from a set-valued key. */
  removeFromSet(key: string, value: JsonValue): CrdtOp | null {
    const existing = this.entries.get(key);
    if (!existing || !isOrSet(existing)) return null;

    const target = canonicalJson(value);
    const doomed = Object.keys(existing.adds).filter(
      (tag) => canonicalJson(existing.adds[tag] as JsonValue) === target,
    );
    if (doomed.length === 0) return null;

    const stamp = this.clock.tick();
    const full = this.signed({
      key,
      entry: {
        kind: "orset",
        hlc: stamp,
        adds: { ...existing.adds },
        removes: [...new Set([...existing.removes, ...doomed])],
        ...(existing.floor ? { floor: existing.floor } : {}),
      } satisfies OrSetEntry,
    });
    this.entries.set(key, full.entry);
    return this.signed({
      key,
      entry: {
        kind: "orset",
        hlc: stamp,
        adds: {},
        removes: doomed,
      } satisfies OrSetEntry,
    });
  }

  /** Read the lease on a task key, if any. */
  claimEntry(key: string): ClaimEntry | undefined {
    const entry = this.entries.get(key);
    return entry && isClaim(entry) ? entry : undefined;
  }

  /** Every lease on record, expired ones included. */
  claimEntries(): Array<{ key: string; entry: ClaimEntry }> {
    const out: Array<{ key: string; entry: ClaimEntry }> = [];
    for (const [key, entry] of this.entries) {
      if (isClaim(entry)) out.push({ key, entry: structuredClone(entry) });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * Take the next generation of a lease.
   *
   * Callers check availability first; this only mints the op. Taking `gen + 1`
   * unconditionally is what makes a stale op from the previous generation
   * harmless whenever it turns up.
   */
  takeClaim(key: string, ttl: number, note?: string): CrdtOp | null {
    const current = this.claimEntry(key);
    const entry: ClaimEntry = {
      kind: "claim",
      hlc: this.clock.tick(),
      gen: nextGeneration(current),
      ttl,
      ...(note !== undefined ? { note } : {}),
    };
    // Refuse to record a lease the merge rule would discard: storing one would
    // tell this node's agent it holds work every peer says it does not.
    if (current && !claimWins(entry, current)) return null;
    const op = this.signed({ key, entry });
    this.entries.set(key, op.entry);
    return op;
  }

  /** End the current generation of a lease. Absorbing, so it cannot be undone. */
  releaseClaim(key: string): CrdtOp | null {
    const current = this.claimEntry(key);
    if (!current) return null;
    // Carries the claim's own stamp, not a fresh one: that is what makes a
    // release beat exactly the claim it ends, and what makes forging one
    // require the holder's node id.
    const entry: ClaimEntry = {
      kind: "claim",
      hlc: { ...current.hlc },
      gen: current.gen,
      ttl: current.ttl,
      released: true,
      ...(current.note !== undefined ? { note: current.note } : {}),
    };
    const op = this.signed({ key, entry });
    this.entries.set(key, op.entry);
    return op;
  }

  /** Read the task at a key, if any. */
  taskEntry(key: string): TaskEntry | undefined {
    const entry = this.entries.get(key);
    return entry && isTask(entry) ? entry : undefined;
  }

  /** Every task on record, settled ones included. */
  taskEntries(): Array<{ key: string; entry: TaskEntry }> {
    const out: Array<{ key: string; entry: TaskEntry }> = [];
    for (const [key, entry] of this.entries) {
      if (isTask(entry)) out.push({ key, entry: structuredClone(entry) });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /**
   * Write a task locally.
   *
   * The draft is merged with what is already on record rather than replacing it,
   * so a local write can never regress a field it did not mean to touch — a
   * completion written from a stale read cannot lower an `attempts` a peer has
   * already raised, or drop a dependency a peer added while we were deciding.
   * `clock.tick()` is strictly greater than every stamp this replica has
   * observed, so the fresh entry always wins the descriptor and the merged
   * result always carries this node's stamp, which is what lets `signed()`
   * sign it.
   *
   * Returns `null` when the merge rule would discard the write — the same guard
   * `takeClaim` makes, and for the same reason: reporting a change every peer
   * says did not happen is worse than reporting failure.
   */
  writeTask(key: string, draft: TaskDraft, now: number = Date.now()): CrdtOp | null {
    const current = this.taskEntry(key);
    if (!this.entries.has(key)) {
      // Collected against the caller's clock rather than wall time, because
      // retention here is measured against the same stamps this replica writes:
      // a store driven by an injected clock would otherwise decide a task it
      // stamped seconds ago had been settled for a week.
      this.collectTombstones(now);
      if (this.taskKeyCount() >= MAX_TASK_KEYS) {
        throw new Error(
          `backlog is at its ${MAX_TASK_KEYS}-task limit; complete_task or ` +
            `fail_task on finished work frees a slot`,
        );
      }
    }
    const fresh: TaskEntry = { kind: "task", hlc: this.clock.tick(), ...draft };
    const merged = current ? mergeTasks(current, fresh) : fresh;
    if (current && canonicalTask(merged) === canonicalTask(current)) return null;
    const op = this.signed({ key, entry: merged });
    this.entries.set(key, op.entry);
    return op;
  }

  // ---- merge --------------------------------------------------------------

  /**
   * Merge one inbound op.
   *
   * Nothing here trusts the sender beyond its own key: an op can only move the
   * key it names, and only if its stamp beats what is already there. There is
   * no path by which a peer replaces the whole document.
   */
  mergeOp(op: CrdtOp, now: number): MergeResult {
    const { key, entry } = op;

    // Every free check runs before the signature. Verification is ~80µs of
    // blocking Ed25519 work, so an op that fails a comparison must never be
    // allowed to buy that work first.
    if (!isAcceptableHlc(entry.hlc, now)) {
      return { key, status: "rejected", reason: "stamp out of bounds" };
    }
    if (isClaimKey(key) !== isClaim(entry)) {
      return {
        key,
        status: "rejected",
        reason: isClaim(entry)
          ? "lease entry outside the lease namespace"
          : "state entry inside the lease namespace",
      };
    }
    if (
      isClaim(entry) &&
      (!isAcceptableTtl(entry.ttl) ||
        !isAcceptableGen(entry.gen) ||
        !isAcceptableClaimStamp(entry, now))
    ) {
      return { key, status: "rejected", reason: "lease bounds exceeded" };
    }
    if (isTaskKey(key) !== isTask(entry)) {
      return {
        key,
        status: "rejected",
        reason: isTask(entry)
          ? "task entry outside the task namespace"
          : "state entry inside the task namespace",
      };
    }
    if (isTask(entry) && !isAcceptableTaskEntry(entry, now)) {
      return { key, status: "rejected", reason: "task bounds exceeded" };
    }
    if (JSON.stringify(entry).length > MAX_VALUE_BYTES) {
      return { key, status: "rejected", reason: "entry exceeds value size limit" };
    }
    // A signature that does not verify is an active forgery attempt, not a peer
    // on an older build — those simply arrive unsigned. Checked before the local
    // clock observes the stamp, so a forged op cannot drag our clock forward on
    // its way to being refused.
    const signature = verifyOp(op);
    if (signature.status === "invalid") {
      return { key, status: "rejected", reason: `bad signature: ${signature.reason}` };
    }
    if (!this.entries.has(key)) {
      this.collectTombstones(now);
      if (isClaim(entry)) {
        if (this.claimKeyCount() >= MAX_CLAIM_KEYS) {
          return { key, status: "rejected", reason: "lease limit reached" };
        }
      } else if (isTask(entry)) {
        if (this.taskKeyCount() >= MAX_TASK_KEYS) {
          return { key, status: "rejected", reason: "task limit reached" };
        }
      } else if (this.liveKeyCount() >= MAX_CRDT_KEYS) {
        return { key, status: "rejected", reason: "document key limit reached" };
      }
    }

    this.clock.observe(entry.hlc);
    const current = this.entries.get(key);

    // Leases resolve first-come-wins within a generation, so they cannot share
    // the last-write-wins path used by state.
    if (isClaim(entry)) {
      if (current && isClaim(current)) {
        if (!claimWins(entry, current)) return { key, status: "ignored" };
        const previous = current.hlc.n;
        this.entries.set(key, entry);
        return previous !== entry.hlc.n
          ? { key, status: "contended", previousNode: previous }
          : { key, status: "applied" };
      }
      this.entries.set(key, entry);
      return { key, status: "applied" };
    }

    // A backlog entry is expected to be written by several nodes — that is what
    // a shared backlog means — so it merges field by field rather than picking a
    // winner, and it is never reported as "contended". Surfacing every peer
    // completion as a concurrent update would fill the human's Concurrent
    // Updates section with ordinary traffic and teach the agent to ignore it.
    if (isTask(entry)) {
      if (current && isTask(current)) {
        const merged = mergeTasks(current, entry);
        if (canonicalTask(merged) === canonicalTask(current)) {
          return { key, status: "ignored" };
        }
        this.entries.set(key, merged);
        return { key, status: "applied" };
      }
      this.entries.set(key, entry);
      return { key, status: "applied" };
    }

    if (!current) {
      this.entries.set(key, isOrSet(entry) ? this.boundSet(entry) : entry);
      return { key, status: "applied" };
    }

    // Mixed kinds on one key: settle which kind wins by stamp first, otherwise
    // the outcome depends on which op happened to arrive first.
    if (isOrSet(entry) !== isOrSet(current)) {
      if (!entryWins(entry, current)) {
        // The loser is discarded. Storing it here — which this did when a stale
        // `orset` lost to a live `lww` — silently replaced the register's value
        // with the set, reported the merge as "ignored" so nothing reached the
        // audit trail, and left the two replicas permanently divergent, since
        // feeding the same two ops in the other order kept the register. One
        // stale op from any allowlisted peer was enough to erase a key.
        //
        // Only the surviving `orset` takes a floor, and only when the loser is an
        // `lww`: that is real evidence the key was a register at that stamp, and
        // recording it keeps later stale set ops out. In the reverse case the
        // winning `lww`'s own stamp already serves as the floor via
        // `highestFloor`, so there is nothing to store.
        if (isOrSet(current) && !isOrSet(entry)) {
          this.entries.set(key, raiseFloor(current, entry.hlc));
        }
        return { key, status: "ignored" };
      }
      const replacement = isOrSet(entry)
        ? this.boundSet(raiseFloor(entry, current.hlc) as OrSetEntry)
        : entry;
      this.entries.set(key, replacement);
      return current.hlc.n !== entry.hlc.n
        ? { key, status: "contended", previousNode: current.hlc.n }
        : { key, status: "applied" };
    }

    // Sets union regardless of order, so a stale set op still contributes.
    if (isOrSet(entry) && isOrSet(current)) {
      // An op stamped at or below the highest lww this key has seen belongs to
      // a lineage the register already moved past; unioning it back in is what
      // made three-op lww/orset sequences depend on arrival order.
      const floor = highestFloor(current, entry);
      if (floor && compareHlc(entry.hlc, floor) <= 0) {
        return { key, status: "ignored" };
      }

      const merged = this.boundSet({
        kind: "orset",
        hlc: compareHlc(entry.hlc, current.hlc) > 0 ? entry.hlc : current.hlc,
        ...(floor ? { floor } : {}),
        adds: mergeAdds(current.adds, entry.adds),
        removes: [...new Set([...current.removes, ...entry.removes])].sort(),
      });
      const changed =
        Object.keys(merged.adds).length !== Object.keys(current.adds).length ||
        merged.removes.length !== current.removes.length;
      this.entries.set(key, merged);
      return { key, status: changed ? "applied" : "ignored" };
    }

    if (!entryWins(entry, current)) {
      return { key, status: "ignored" };
    }

    const stored = isOrSet(entry) ? this.boundSet(entry) : entry;
    if (stored === null) {
      return { key, status: "rejected", reason: "set limit reached" };
    }
    this.entries.set(key, stored);

    // Same key, last touched by someone else: both replicas agree on the
    // winner, but the losing write is worth surfacing to the agent.
    if (current.hlc.n !== entry.hlc.n) {
      return { key, status: "contended", previousNode: current.hlc.n };
    }
    return { key, status: "applied" };
  }

  mergeAll(ops: CrdtOp[], now: number): MergeResult[] {
    return ops.map((op) => this.mergeOp(op, now));
  }

  /**
   * Bring a set within its bounds deterministically.
   *
   * Refusing an over-cap merge is not commutative — whichever op arrived first
   * would survive, so two replicas fed the same ops in different orders keep
   * different elements forever. Truncating by sorted tag is a pure function of
   * the merged content, so every replica discards exactly the same entries and
   * they stay in agreement even at the limit.
   */
  private boundSet(entry: OrSetEntry): OrSetEntry {
    const removed = new Set(entry.removes);
    const liveTags = Object.keys(entry.adds).filter((tag) => !removed.has(tag));

    let adds = entry.adds;
    if (liveTags.length > MAX_SET_ELEMENTS) {
      const keep = new Set(liveTags.sort().slice(0, MAX_SET_ELEMENTS));
      adds = Object.create(null) as Record<string, JsonValue>;
      for (const tag of Object.keys(entry.adds).sort()) {
        // Retain tombstoned tags: dropping one resurrects its element.
        if (keep.has(tag) || removed.has(tag)) {
          adds[tag] = entry.adds[tag] as JsonValue;
        }
      }
    }

    let removes = entry.removes;
    if (removes.length > MAX_SET_TOMBSTONES) {
      removes = [...removes].sort().slice(0, MAX_SET_TOMBSTONES);
    }
    // Truncation rewrites the content, so any signature on it is no longer valid
    // — drop it rather than relay bytes that will not verify.
    if (adds !== entry.adds || removes !== entry.removes) {
      return { ...stripSignature(entry), adds, removes } as OrSetEntry;
    }
    return { ...entry, adds, removes };
  }

  // ---- reads --------------------------------------------------------------

  /** Plain-JSON view of the document, with tombstones and tags stripped. */
  materialize(): ContextState {
    const out = Object.create(null) as ContextState;
    for (const [key, entry] of [...this.entries.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (isOrSet(entry)) {
        const removed = new Set(entry.removes);
        const tags = Object.keys(entry.adds)
          .filter((tag) => !removed.has(tag))
          .sort();
        out[key] = tags.map((tag) => entry.adds[tag] as JsonValue);
        continue;
      }
      // Leases and tasks each have their own tools and their own digest, and
      // leaking `@task/…` keys here would put peer-authored titles into a
      // surface with no provenance framing.
      if (isClaim(entry) || isTask(entry)) continue;
      if (entry.deleted === true) continue;
      out[key] = entry.value as JsonValue;
    }
    return out;
  }

  get(key: string): JsonValue | undefined {
    const entry = this.entries.get(key);
    if (!entry || isClaim(entry) || isTask(entry)) return undefined;
    if (isOrSet(entry)) {
      const removed = new Set(entry.removes);
      return Object.keys(entry.adds)
        .filter((tag) => !removed.has(tag))
        .sort()
        .map((tag) => entry.adds[tag] as JsonValue);
    }
    return entry.deleted === true ? undefined : (entry.value as JsonValue);
  }

  /** Stamp on a key, for status output and contention reporting. */
  stampFor(key: string): Hlc | undefined {
    return this.entries.get(key)?.hlc;
  }

  /** Every entry, for the handshake snapshot and for persistence. */
  export(): CrdtOp[] {
    return [...this.entries.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => ({ key, entry: structuredClone(entry) }));
  }

  /** Replace all entries, e.g. when rehydrating from disk. */
  load(ops: CrdtOp[], now: number): void {
    this.entries.clear();
    // State first, then the backlog, then leases: all three sort ahead of
    // ordinary keys, so a key-ordered truncation would drop the user's actual
    // context to keep them. Tasks outrank leases in what survives an over-budget
    // document because a lease is transient and re-derivable by expiry, while a
    // task is the work itself.
    const ordered = [
      ...ops.filter((op) => !isClaim(op.entry) && !isTask(op.entry)),
      ...ops.filter((op) => isTask(op.entry)),
      ...ops.filter((op) => isClaim(op.entry)),
    ];
    for (const op of ordered) {
      if (!isAcceptableHlc(op.entry.hlc, now)) continue;
      // The replica file is treated as untrusted input, so a signature edited
      // into it by hand must not be re-relayed to peers as authentic.
      if (verifyOp(op).status === "invalid") continue;
      if (isClaim(op.entry)) {
        if (this.claimKeyCount() >= MAX_CLAIM_KEYS) continue;
      } else if (isTask(op.entry)) {
        if (this.taskKeyCount() >= MAX_TASK_KEYS) continue;
      } else if (this.liveKeyCount() >= MAX_CRDT_KEYS) {
        continue;
      }
      this.clock.observe(op.entry.hlc);
      this.entries.set(op.key, structuredClone(op.entry));
    }
  }

  /**
   * Content hash of the materialized document.
   * Two peers that agree produce the same digest, so divergence is detectable
   * rather than silent.
   */
  /** Digest over leases, which `stateHash` deliberately excludes. */
  claimsHash(): string {
    const rows = this.claimEntries().map(
      ({ key, entry }) =>
        `${key}|${entry.gen}|${entry.hlc.w}|${entry.hlc.c}|${entry.hlc.n}|${entry.ttl}|${entry.released === true ? 1 : 0}`,
    );
    return createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16);
  }

  /**
   * Digest over the backlog, which `stateHash` also excludes.
   *
   * Empty when there are no tasks, rather than the hash of an empty string: a
   * peer that predates this namespace sends no `tasks` digest at all, and the
   * two have to compare equal or every reconnect in a mixed swarm re-ships the
   * whole document to prove nothing changed.
   */
  tasksHash(): string {
    const entries = this.taskEntries();
    if (entries.length === 0) return "";
    const rows = entries.map(
      ({ key, entry }) =>
        `${key}|${entry.status}|${entry.attempts}|${entry.priority}|` +
        `${entry.hlc.w}|${entry.hlc.c}|${entry.hlc.n}`,
    );
    return createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16);
  }

  stateHash(): string {
    return createHash("sha256")
      .update(canonicalJson(this.materialize() as unknown as JsonValue))
      .digest("hex")
      .slice(0, 16);
  }
}
