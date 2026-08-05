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
import type { OpSigner } from "./signing.js";
import {
  agentKeyFor,
  describeCard,
  isAgentKey,
  nodeIdFromAgentKey,
  parseCard,
  type AgentCard,
  type AgentView,
} from "./presence.js";
import {
  DEFAULT_TASK_PRIORITY,
  describeTask,
  isTaskKey,
  isTerminal,
  canonicalTokens,
  slugTaskId,
  taskIdFromTaskKey,
  taskKeyFor,
  type TaskDraft,
  type TaskEntry,
  type TaskView,
} from "./task.js";
import {
  CrdtOpArraySchema,
  LEGACY_VERSION_KEY,
  isReservedKey,
  type ContextState,
  type JsonValue,
} from "./types.js";

/**
 * Would every peer accept this operation?
 *
 * Handed to the CRDT's local task writer so a rejected entry is never stored,
 * not merely never sent. `export()` feeds the handshake snapshot, and a snapshot
 * is validated as one array with no per-op tolerance — so a single entry that
 * fails this check would make the whole replica undeliverable to every peer for
 * as long as the process runs, and an `open` task is never collected.
 */
function isWireValid(op: CrdtOp): boolean {
  return CrdtOpArraySchema.safeParse([op]).success;
}

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

  /**
   * @param signer Signs entries this replica authors, so its writes stay
   *   verifiable after another peer relays them. Omitted leaves entries unsigned,
   *   which is still correct — just not independently attributable.
   */
  constructor(
    nodeId?: string,
    now: () => number = Date.now,
    signer?: OpSigner,
  ) {
    const id = nodeId
      ? nodeIdFromPublicKey(nodeId)
      : `anon${Math.random().toString(16).slice(2, 14)}`;
    // Held so lease expiry reads the same clock that stamps writes. Mixing an
    // injected stamp clock with real wall time made lease decisions incoherent.
    this.now = now;
    this.doc = new CrdtDoc(new HybridClock(id, now), signer);
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

  // ---- backlog ------------------------------------------------------------

  /** The task on record under an id, settled ones included. */
  task(taskId: string): TaskEntry | undefined {
    return this.doc.taskEntry(taskKeyFor(taskId));
  }

  /** Every task on record, keyed by id. */
  taskEntries(): Array<{ taskId: string; entry: TaskEntry }> {
    const out: Array<{ taskId: string; entry: TaskEntry }> = [];
    for (const { key, entry } of this.doc.taskEntries()) {
      const taskId = taskIdFromTaskKey(key);
      if (taskId !== null) out.push({ taskId, entry });
    }
    return out;
  }

  /**
   * Digest over the backlog.
   *
   * Separate from `stateHash` and `claimsHash` for the same reason those are
   * separate from each other: two replicas that disagree about what work exists
   * would otherwise look identical to `sync_health`.
   */
  tasksHash(): string {
    return this.doc.tasksHash();
  }

  /**
   * Put a task on the backlog.
   *
   * Create is not an overwrite path. A duplicate id is refused rather than
   * merged, because the caller asking to create a task it has already created is
   * a caller that has lost track of what it did — silently rewriting the
   * descriptor of somebody's in-flight work is the worse answer.
   */
  createTask(input: {
    title: string;
    detail?: string;
    needs?: string[];
    deps?: string[];
    priority?: number;
    taskId?: string;
    suffix: string;
    now?: number;
  }): { ok: true; taskId: string; op: CrdtOp } | { ok: false; error: string } {
    const taskId = input.taskId ?? slugTaskId(input.title, input.suffix);
    if (!isValidTaskId(taskId)) {
      return { ok: false, error: `Malformed task id: ${taskId}` };
    }
    // Dependencies are task ids too, and they are the easier one to get wrong:
    // an agent asked for "what must finish first" will happily answer in prose.
    // An op carrying one fails the wire schema, and because a snapshot is
    // validated as a whole array it takes every other entry down with it.
    const malformed = (input.deps ?? []).find((dep) => !isValidTaskId(dep));
    if (malformed !== undefined) {
      return {
        ok: false,
        error:
          `Malformed dependency id: "${malformed}". Dependencies are task ids ` +
          `from list_tasks, not descriptions of the work.`,
      };
    }
    if (this.task(taskId) !== undefined) {
      return {
        ok: false,
        error:
          `A task with id "${taskId}" already exists. Omit task_id to have one ` +
          `minted, or call list_tasks to see what is on the board.`,
      };
    }
    const draft: TaskDraft = {
      title: input.title,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      // Deduplicated and sorted here, where the caller's intent is still a set:
      // the wire schema accepts only that encoding, so an agent passing the same
      // capability twice would otherwise mint an op no peer can read.
      ...(input.needs !== undefined ? { needs: canonicalTokens(input.needs) } : {}),
      ...(input.deps !== undefined ? { deps: canonicalTokens(input.deps) } : {}),
      priority: input.priority ?? DEFAULT_TASK_PRIORITY,
      status: "open",
      attempts: 0,
      createdBy: this.nodeId,
      createdAt: input.now ?? this.now(),
    };
    let op: CrdtOp | null;
    try {
      op = this.doc.writeTask(taskKeyFor(taskId), draft, this.now(), isWireValid);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // Either the merge rule discarded the write — which nothing can currently
    // produce against an entry we just established does not exist — or the
    // entry failed the wire schema, in which case refusing is the whole point.
    if (!op) {
      return {
        ok: false,
        error: `Could not record task "${taskId}": the entry failed validation`,
      };
    }
    return { ok: true, taskId, op };
  }

  /** Change a task that already exists. Returns null when nothing moved. */
  putTask(taskId: string, draft: TaskDraft): CrdtOp | null {
    if (!isValidTaskId(taskId)) throw new Error(`Malformed task id: ${taskId}`);
    return this.doc.writeTask(taskKeyFor(taskId), draft, this.now(), isWireValid);
  }

  /**
   * The board: every task joined with its lease and with the roster.
   *
   * The join happens on read and only on read. A task never records who is
   * working on it — `holder` here comes from `@claim/<id>`, and `holderLive`
   * from `@agent/<holder>`.
   */
  listTasks(now: number = this.now()): TaskView[] {
    const tasks = this.taskEntries();
    const byId = new Map(tasks.map(({ taskId, entry }) => [taskId, entry]));
    const agents = new Map(
      this.listAgents(now).map((agent) => [
        agent.nodeId,
        { role: agent.role, live: agent.live },
      ]),
    );
    const capabilities = new Set(this.ownCard()?.capabilities ?? []);
    return tasks
      .map(({ taskId, entry }) =>
        describeTask(taskId, entry, this.claim(taskId), byId, now, {
          selfNodeId: this.nodeId,
          capabilities,
          agents,
        }),
      )
      .sort(
        (a, b) =>
          Number(isTerminal(a.status)) - Number(isTerminal(b.status)) ||
          b.priority - a.priority ||
          (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
      );
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

  // ---- presence -----------------------------------------------------------

  /**
   * Publish this node's presence card.
   *
   * The key is derived from this replica's own node id rather than taken as an
   * argument, so there is no call shape that writes somebody else's card.
   */
  announce(card: AgentCard): CrdtOp {
    return this.doc.setValue(
      agentKeyFor(this.nodeId),
      card as unknown as JsonValue,
    );
  }

  /** This node's own card, if it has announced. */
  ownCard(): AgentCard | null {
    return parseCard(this.doc.get(agentKeyFor(this.nodeId)));
  }

  /**
   * The roster.
   *
   * Cards whose key and stamp disagree are skipped rather than reported: they
   * cannot arrive over the wire (validation refuses them) but a hand-edited
   * replica file could carry one, and a roster is the wrong place to surface it.
   */
  listAgents(now: number = this.now()): AgentView[] {
    // Latest wall time each node has stamped anywhere in the document. A node
    // that is writing state or taking leases is proving it is alive without
    // having to also remember a heartbeat.
    const lastActivity = new Map<string, number>();
    for (const op of this.doc.export()) {
      const { n, w } = op.entry.hlc;
      const seen = lastActivity.get(n);
      if (seen === undefined || w > seen) lastActivity.set(n, w);
    }

    const out: AgentView[] = [];
    for (const [key, value] of Object.entries(this.doc.materialize())) {
      const nodeId = nodeIdFromAgentKey(key);
      if (nodeId === null) continue;
      const stamp = this.doc.stampFor(key);
      if (!stamp || stamp.n !== nodeId) continue;
      const card = parseCard(value);
      if (!card) continue;
      out.push(
        describeCard(nodeId, card, now, this.nodeId, lastActivity.get(nodeId)),
      );
    }
    return out.sort(
      (a, b) => Number(b.live) - Number(a.live) || (a.nodeId < b.nodeId ? -1 : 1),
    );
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
      if (isClaimKey(key) || isTaskKey(key)) continue;
      // Re-stamping somebody else's card under this node's id would forge it.
      if (isAgentKey(key)) continue;
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
    if (isTaskKey(key)) {
      throw new Error(
        `Key "${key}" belongs to the task namespace; use create_task / complete_task instead`,
      );
    }
    if (isAgentKey(key)) {
      throw new Error(
        `Key "${key}" belongs to the agent-presence namespace; use announce instead`,
      );
    }
    if (key === LEGACY_VERSION_KEY) {
      throw new Error(
        `Key "${LEGACY_VERSION_KEY}" belonged to the retired counter protocol`,
      );
    }
  }
}
