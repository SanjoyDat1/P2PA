/**
 * Hybrid Logical Clocks.
 *
 * A single shared counter cannot say whether two writes overlapped, only which
 * one the receiver saw first. An HLC pairs wall-clock time with a per-tick
 * counter and the id of the node that stamped it, which gives every write a
 * total order that all peers compute identically without talking to each other.
 * That is what lets concurrent writes merge instead of collide.
 *
 * The wall component is deliberately bounded (`MAX_CLOCK_SKEW_MS`). Timestamps
 * arrive from peers, so an unbounded one is an attack: a single entry stamped
 * near `Number.MAX_SAFE_INTEGER` would pin the receiver's clock at the ceiling
 * and every subsequent local write would fail to advance past it.
 */

/** How far ahead of local time a peer's clock may be before it is refused. */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** Ceiling on the intra-millisecond counter, so it cannot be used to saturate. */
export const MAX_HLC_COUNTER = 1_000_000;

/** Node ids are truncated public keys — 64 bits is ample to break ties. */
export const NODE_ID_LENGTH = 16;

/**
 * A stamped point in causal time.
 * Short field names: one of these rides along with every key in every snapshot.
 */
export interface Hlc {
  /** Wall clock, ms since epoch. */
  w: number;
  /** Counter distinguishing writes within the same millisecond. */
  c: number;
  /** Node id of whoever stamped it — also the final tiebreak. */
  n: string;
}

/** Derive a stable, compact node id from a public key. */
export function nodeIdFromPublicKey(publicKeyHex: string): string {
  return publicKeyHex.toLowerCase().slice(0, NODE_ID_LENGTH);
}

/**
 * Total order over stamps: wall, then counter, then node id.
 *
 * The node-id tiebreak is what makes "last write wins" deterministic — without
 * it two peers stamping the same millisecond would each keep their own value
 * and never converge.
 */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.w !== b.w) return a.w < b.w ? -1 : 1;
  if (a.c !== b.c) return a.c < b.c ? -1 : 1;
  if (a.n === b.n) return 0;
  return a.n < b.n ? -1 : 1;
}

/**
 * Break a stamp tie using content.
 *
 * Stamps are not authenticated end to end, so a peer can replay another node's
 * exact `(w, c, n)` carrying a different value. Comparing equal there would
 * leave each replica holding whichever copy it saw first, forever. Ordering the
 * content itself keeps the decision total and identical everywhere.
 */
export function breakTie(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** True when `candidate` should replace `current` under last-write-wins. */
export function hlcWins(candidate: Hlc, current: Hlc): boolean {
  return compareHlc(candidate, current) > 0;
}

/**
 * Reject stamps that are malformed or too far in the future.
 *
 * Applied to everything inbound before it can influence the local clock.
 */
export function isAcceptableHlc(value: Hlc, now: number): boolean {
  if (!Number.isSafeInteger(value.w) || value.w < 0) return false;
  if (value.w > now + MAX_CLOCK_SKEW_MS) return false;
  if (!Number.isSafeInteger(value.c) || value.c < 0) return false;
  if (value.c >= MAX_HLC_COUNTER) return false;
  return (
    typeof value.n === "string" &&
    value.n.length > 0 &&
    value.n.length <= NODE_ID_LENGTH
  );
}

export function formatHlc(value: Hlc): string {
  return `${new Date(value.w).toISOString()}#${value.c}@${value.n}`;
}

/**
 * The local clock. One per node.
 *
 * `tick()` stamps a local write; `observe()` folds in a stamp seen from a peer
 * so that a later local write sorts after everything this node has already
 * seen. `observe()` refuses out-of-bounds input rather than adopting it.
 */
export class HybridClock {
  private wall = 0;
  private counter = 0;

  constructor(
    private readonly nodeId: string,
    private readonly now: () => number = Date.now,
  ) {}

  get id(): string {
    return this.nodeId;
  }

  /** Stamp a local event. Strictly greater than every stamp seen so far. */
  tick(): Hlc {
    const physical = this.now();
    const ceiling = physical + MAX_CLOCK_SKEW_MS;
    if (physical > this.wall) {
      this.wall = physical;
      this.counter = 0;
    } else {
      this.counter += 1;
      if (this.counter >= MAX_HLC_COUNTER) {
        // Only reachable if the physical clock is frozen or a peer pushed us to
        // the ceiling. Roll into the next millisecond, but never past what other
        // replicas will accept — a stamp beyond the ceiling is refused by every
        // peer, which would silently drop this node out of sync.
        this.wall = Math.min(this.wall + 1, ceiling);
        this.counter = 0;
      }
    }
    return { w: this.wall, c: this.counter, n: this.nodeId };
  }

  /**
   * Fold a peer's stamp into the local clock.
   * Returns false (and changes nothing) when the stamp is out of bounds.
   */
  observe(remote: Hlc): boolean {
    const physical = this.now();
    if (!isAcceptableHlc(remote, physical)) return false;

    // Never let a peer push the local clock past what peers will accept back:
    // a wall beyond the ceiling would make every subsequent local write
    // unacceptable everywhere else, silently cutting this node out of sync.
    const ceiling = physical + MAX_CLOCK_SKEW_MS;
    const highest = Math.min(Math.max(physical, this.wall, remote.w), ceiling);
    if (highest === this.wall && highest === remote.w) {
      this.counter = Math.max(this.counter, remote.c) + 1;
    } else if (highest === this.wall) {
      this.counter += 1;
    } else if (highest === remote.w) {
      this.counter = remote.c + 1;
    } else {
      this.counter = 0;
    }
    // Leave headroom below the counter ceiling, so the next local tick cannot
    // be forced to roll the wall over.
    this.counter = Math.min(this.counter, MAX_HLC_COUNTER - 1);
    this.wall = highest;
    return true;
  }

  /** Current stamp without advancing — for status output. */
  peek(): Hlc {
    return { w: this.wall, c: this.counter, n: this.nodeId };
  }
}
