/**
 * Peer activity, as something an agent can wait on.
 *
 * Every tool up to now is pull-only: an agent learns a peer did something only
 * if it happens to call `pull_context` or `read_context_history`, which an LLM
 * does not do unprompted. So in practice one agent talks and the other never
 * hears it — the difference between a shared file and a multiplayer session.
 *
 * This is a bounded log of things peers did, plus the ability to block until
 * the next one arrives. Everything here is sized: the buffer, the number of
 * waiters, the wait itself, and the text carried per event. Peers supply the
 * input, so an unbounded queue or an unbounded waiter list is a remote
 * memory-exhaustion primitive rather than a convenience.
 */

/** Events retained for agents that were not waiting when one arrived. */
export const MAX_EVENTS = 200;

/** Concurrent waiters. One agent needs one; more than this is a leak or an attack. */
export const MAX_WAITERS = 32;

/** Longest an agent may block. */
export const MAX_WAIT_MS = 120_000;

export const DEFAULT_WAIT_MS = 30_000;

/** Message text carried inline. The full text is always in the audit trail. */
export const MAX_EVENT_TEXT = 2_000;

export type PeerEventKind =
  | "state"
  | "message"
  | "claim"
  | "release"
  | "presence";

export interface PeerEvent {
  /** Monotonic cursor. Pass the highest seen back as `since` to avoid gaps. */
  seq: number;
  kind: PeerEventKind;
  at: string;
  /** Fingerprint of the peer that caused it, or null when locally generated. */
  peer: string | null;
  /** Context keys touched, for `state`. */
  keys?: string[];
  /** Task and holder, for `claim` / `release`. */
  taskId?: string;
  holder?: string;
  /** Message body, truncated. */
  text?: string;
  /**
   * Sender's public key, for `message`.
   *
   * Needed to answer: `reply_to_peer` addresses the response back to exactly the
   * peer that asked, and a fingerprint is too short to route on.
   */
  from?: string;
  /** Correlation id, so a reply can be tied to its question. */
  corr?: string;
  /** Whether the peer expects an answer. */
  intent?: "tell" | "ask" | "reply";
  /** Role and status, for `presence`. */
  role?: string;
  status?: string;
}

export type EventListener = (event: PeerEvent) => void;

interface Waiter {
  since: number;
  resolve: (events: PeerEvent[]) => void;
  timer: NodeJS.Timeout;
}

export class EventBus {
  private readonly events: PeerEvent[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly listeners = new Set<EventListener>();
  private nextSeq = 1;

  /** Cursor of the most recent event. */
  get latestSeq(): number {
    return this.nextSeq - 1;
  }

  /** Cursor of the oldest event still retained, or 0 when the buffer is empty. */
  get oldestSeq(): number {
    return this.events[0]?.seq ?? 0;
  }

  /**
   * Events dropped between `seq` and what is still retained.
   *
   * A peer can bury something an agent cares about under a flood of cheap
   * writes. Silently returning only the flood would let that pass unnoticed, so
   * callers are told how much they lost and can fall back to the audit trail.
   */
  missedSince(seq: number): number {
    const oldest = this.oldestSeq;
    if (oldest === 0 || seq >= oldest - 1) return 0;
    return oldest - 1 - seq;
  }

  get waiterCount(): number {
    return this.waiters.size;
  }

  get size(): number {
    return this.events.length;
  }

  /**
   * Record something a peer did and release anyone waiting.
   *
   * Listeners are for out-of-band push (MCP notifications); a throwing listener
   * must not take down the sync path that called us.
   */
  emit(input: Omit<PeerEvent, "seq" | "at">): PeerEvent {
    const event: PeerEvent = {
      ...input,
      seq: this.nextSeq,
      at: new Date().toISOString(),
      ...(input.text !== undefined
        ? { text: input.text.slice(0, MAX_EVENT_TEXT) }
        : {}),
      ...(input.keys !== undefined ? { keys: input.keys.slice(0, 50) } : {}),
    };
    this.nextSeq += 1;

    this.events.push(event);
    while (this.events.length > MAX_EVENTS) this.events.shift();

    for (const waiter of [...this.waiters]) {
      if (event.seq > waiter.since) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(this.since(waiter.since));
      }
    }

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A push channel failing is not a reason to drop the event.
      }
    }
    return event;
  }

  /** Events after `seq`. Callers that fell behind still see everything retained. */
  since(seq: number): PeerEvent[] {
    return this.events.filter((event) => event.seq > seq);
  }

  recent(limit = 20): PeerEvent[] {
    return this.events.slice(-Math.max(1, limit));
  }

  /**
   * Resolve as soon as an event newer than `since` exists.
   *
   * Returns immediately when one already has — otherwise an agent that acts
   * between two calls would block through an event it had already been told
   * about. Resolves empty on timeout rather than rejecting: "nothing happened"
   * is an ordinary answer, not an error.
   */
  wait(
    since: number,
    timeoutMs: number,
    signal?: { aborted: boolean; addEventListener: (t: string, f: () => void) => void },
  ): Promise<PeerEvent[]> {
    // A cursor past anything we have issued is meaningless — almost always one
    // carried over from before a restart, since the buffer is in-memory and
    // `nextSeq` begins again at 1. Treat it as "I do not know where I am" and
    // replay what is retained, rather than blocking until the counter catches up.
    const from = since > this.latestSeq ? this.oldestSeq - 1 : since;

    const pending = this.since(from);
    if (pending.length > 0) return Promise.resolve(pending);
    if (signal?.aborted === true) return Promise.resolve([]);

    if (this.waiters.size >= MAX_WAITERS) {
      return Promise.resolve([]);
    }

    const bounded = Math.min(Math.max(timeoutMs, 0), MAX_WAIT_MS);
    return new Promise((resolve) => {
      const settle = (events: PeerEvent[]): void => {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        resolve(events);
      };
      const waiter: Waiter = {
        since: from,
        resolve,
        timer: setTimeout(() => settle([]), bounded),
      };
      // Do not hold the process open purely to keep a poll alive.
      waiter.timer.unref?.();
      this.waiters.add(waiter);

      // A client that gives up on the call must not leave its waiter parked:
      // enough abandoned waiters reach the cap, and `wait` then returns
      // instantly forever, quietly turning the long-poll back into polling.
      signal?.addEventListener("abort", () => settle([]));
    });
  }

  /** Subscribe to pushes. Returns an unsubscribe function. */
  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Release every waiter, e.g. during shutdown. */
  close(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve([]);
    }
    this.waiters.clear();
    this.listeners.clear();
  }
}
