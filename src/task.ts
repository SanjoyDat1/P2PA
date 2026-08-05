/**
 * The backlog.
 *
 * P2PA can already say who is here (`@agent/`) and stop two agents doing the
 * same job (`@claim/`). It cannot say what should be done next, and that gap is
 * load-bearing: a lease is a lock over a task id, and a task id up to now refers
 * to nothing. Two agents describing the same work differently — `refactor-auth`
 * and `auth-refactor` — each take a lease and both do the job. The exclusion a
 * lease provides is conditional on a shared vocabulary that nothing in the
 * system supplies, which is why every swarm has so far needed a human to hand
 * out ids and collect results.
 *
 * A task is that vocabulary made into an object: one register at `@task/<id>`
 * carrying what the work is, what it needs, what it waits on, and — once
 * somebody finishes — what came out of it.
 *
 * ## What a task deliberately does not record
 *
 * Who is working on it. That is the lease's job and it stays the lease's job.
 * `@task/<id>` and `@claim/<id>` share an id and are joined when read, never
 * merged: a `holder` field here would be a second answer to a question
 * `@claim/` already answers, and the two would disagree the first time a holder
 * crashed — the task saying "held by B" forever while the lease said "free".
 * Nothing in this file changes lease semantics; generation ordering,
 * first-come-first-served within a generation and the expiry grace remain the
 * only exclusion mechanism in P2PA.
 *
 * ## How two copies of a task merge
 *
 * A task is written by several nodes — created by one, completed by another,
 * retried by a third — so it cannot be a last-write-wins register: a stale
 * `open` arriving after a completion would reopen finished work. Each field
 * carries its own join instead, and the entry is the product of them:
 *
 * - `status` takes the higher rank of `open < cancelled < failed < done`.
 *   Monotone, so a completion cannot be undone by a late op, and the three
 *   terminals are totally ordered so two nodes settling a task at the same
 *   instant still land on the same answer. `done` outranks the others because it
 *   is the only terminal carrying a result, and losing a real completion to a
 *   concurrent cancel strands everything that was waiting on it.
 * - `attempts` takes the maximum, so a retry count never goes backwards.
 * - `deps` and `needs` take the union, so no requirement is lost to a
 *   concurrent write.
 * - `title`, `detail`, `priority`, `createdBy`, `createdAt`, `result` and
 *   `lastError` move together as one **descriptor**, taken whole from the entry
 *   with the greater `(stamp, content)`. Merging them field by field would pair
 *   a title from one write with a priority from another and produce a task
 *   neither author wrote.
 *
 * `result` and `lastError` ride in that group rather than joining on their own,
 * and the reason is not tidiness. A field that resolves by last-write-wins needs
 * a stamp of its own, and a task entry carries exactly one stamp. Joining
 * `result` by `(entry stamp, content)` while the entry's stamp is decided by the
 * descriptor is not associative: merge a completion stamped 100 with a bare
 * descriptor write stamped 200 and the surviving result is now *labelled* 200,
 * so a third copy carrying a result stamped 150 loses — while the other
 * association order lets it win, and the two replicas never agree again. Adding
 * a second stamp to the wire format would fix that and cost every implementation
 * a field; carrying the outcome with the descriptor costs one honest limitation
 * instead, stated below.
 *
 * Each of those is a maximum over a total order or a set union, so each is
 * commutative, associative and idempotent; a product of join-semilattices is a
 * join-semilattice, so the whole merge is one. Every replica reaches the same
 * task from the same ops in any delivery order, and re-delivering a completion
 * changes nothing.
 *
 * A union that overflows its bound is truncated to the first N by sort order,
 * never refused. Refusal is not commutative (SPEC §10.2); min-N truncation is,
 * because anything dropped already had N smaller elements that survive into
 * every later union and would have displaced it anyway.
 *
 * ## What this does and does not guarantee
 *
 * Once two nodes have exchanged ops they agree on every field of every task.
 * They do not agree on whether the work was done twice: two partitioned nodes
 * can each lease and complete the same open task, and on reconnect the later
 * result simply wins. The backlog inherits the lease's limit exactly — it
 * narrows duplicate work to the propagation delay, and is not a scheduler with a
 * quorum.
 *
 * Because the outcome travels with the descriptor, a completion can also lose
 * its `result` to a *concurrent* descriptor write carrying a higher stamp — a
 * second node creating the same task id at the same moment. `status` is joined
 * separately and monotone, so the task still reads `done` on every replica; only
 * the payload is lost, and only in the case where two nodes minted the same id
 * independently. That is the price of one stamp per entry, and it is stated here
 * rather than discovered later.
 *
 * `deps` is not a guarantee that work happens in order either. It is a guarantee
 * that `next_task` will not hand out a task whose dependencies are unfinished.
 * `claim_task` still takes a lease on any id, so an agent that ignores the
 * backlog is not prevented from doing anything. And because `deps` unions and
 * can never shrink, a dependency that ends `failed` or `cancelled` blocks its
 * dependents permanently — surfaced as `blockedBy` on every view rather than
 * left as a task that mysteriously never comes up.
 *
 * ## Trust
 *
 * This is the first namespace in P2PA that is not owner-bound. A presence card
 * is only valid in the slot its author stamped; a lease can only be released by
 * its holder. A task deliberately has neither rule: any allowlisted peer may
 * create, complete, requeue or cancel any task, because that is what a shared
 * backlog is — a peer that could not finish work it did not create could not be
 * delegated to. `createdBy` is therefore an attribution a peer chooses, not one
 * the protocol enforces; the verifiable author of a given write is the signature
 * on the op. Merge is monotone, so the destructive direction is one-way: a peer
 * can end a task, not silently reopen one. See SPEC §12.2.
 */
import { canonicalJson } from "./canonical.js";
import { breakTie, compareHlc, type Hlc } from "./hlc.js";
import { isSigned, stripSignature } from "./signing.js";
import {
  expiresAt,
  holderOf,
  isValidTaskId,
  type ClaimEntry,
} from "./claim.js";
import type { SignatureFields } from "./crdt.js";
import type { JsonValue } from "./types.js";

/** Tasks live under this prefix and it holds nothing else. */
export const TASK_KEY_PREFIX = "@task/";

/**
 * Bounds on a task.
 *
 * Every one of these is a defence against a peer rather than a tuning knob: a
 * task arrives on the wire like any other entry, and every field on it —
 * including the ones a human reads — is chosen by whoever sent it.
 */

/** One line in a table a human reads, and in every task event. */
export const MAX_TASK_TITLE = 200;

/** The brief. Long enough for a real handover, short enough to sit in a board. */
export const MAX_TASK_DETAIL = 4_000;

/**
 * Serialized size of a result.
 *
 * A result is a handover, not a payload channel: 500 tasks at this ceiling is
 * 8 MiB of backlog riding every handshake snapshot. Anything larger belongs in
 * `push_context`, which is bounded separately and is not replayed per task.
 */
export const MAX_TASK_RESULT_BYTES = 16 * 1024;

/** Why the last attempt failed. Matches `ClaimEntry.note`. */
export const MAX_TASK_ERROR = 500;

/** Capability tokens one task may demand. */
export const MAX_TASK_NEEDS = 8;

/** Dependencies one task may wait on. Bounded because the union never shrinks. */
export const MAX_TASK_DEPS = 32;

export const MIN_TASK_PRIORITY = 0;
export const MAX_TASK_PRIORITY = 9;
export const DEFAULT_TASK_PRIORITY = 5;

/** Attempts before a task is dead-lettered instead of requeued. */
export const TASK_MAX_ATTEMPTS = 3;

/**
 * Highest `attempts` accepted from a peer.
 *
 * Bounded rather than unbounded because the join is a maximum: an absurd value
 * is sticky, and an unbounded integer field is free payload space. A peer can
 * still dead-letter a task by sending `attempts` past `TASK_MAX_ATTEMPTS` — a
 * nuisance any allowlisted peer can cause a dozen other ways, and one that
 * cannot reopen or steal work.
 */
export const MAX_ACCEPTED_TASK_ATTEMPTS = 1_000;

/**
 * How long a settled task is kept before collection.
 *
 * Matches `TOMBSTONE_TTL_MS` for the same reason it was chosen there: retention
 * must comfortably exceed the accepted clock skew (24 h), or a completed task
 * collected early is resurrected as `open` by an in-flight op that predates the
 * completion and an agent redoes the work. A peer offline for longer than seven
 * days can still resurrect a finished task; that is the limitation tombstones
 * already have, and it is stated rather than hidden.
 */
export const TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Characters of the slug kept before the uniqueness suffix. */
export const MAX_TASK_SLUG = 48;

/**
 * Terminal statuses absorb; `open` is the only non-terminal.
 *
 * The three terminals are totally ordered so two nodes settling the same task at
 * the same instant still land on the same answer.
 */
export const TASK_STATUS = ["open", "done", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

export interface TaskEntry extends SignatureFields {
  kind: "task";
  /** Stamp of the write that last set the descriptor. `hlc.n` is that writer — NOT the holder. */
  hlc: Hlc;
  /** One line, shown in the backlog table and carried on every task event. */
  title: string;
  /** The brief the doer acts on. */
  detail?: string;
  /** Capability tokens, matched against `AgentCard.capabilities`. */
  needs?: string[];
  /** Task ids that must reach `done` before this is offered. */
  deps?: string[];
  /** 0…9, higher first. */
  priority: number;
  status: TaskStatus;
  /** Set by the completer. The handover channel this protocol did not have. */
  result?: JsonValue;
  /** Why the last attempt failed. */
  lastError?: string;
  attempts: number;
  /** Node id the creator claimed. Advisory — see the trust note above. */
  createdBy: string;
  /** Epoch ms the task was created. FIFO order within a priority band. */
  createdAt: number;
}

/** Everything a local write chooses. The stamp and signature are not its to pick. */
export type TaskDraft = Omit<TaskEntry, "kind" | "hlc" | "by" | "sig">;

export function taskKeyFor(taskId: string): string {
  return `${TASK_KEY_PREFIX}${taskId}`;
}

export function taskIdFromTaskKey(key: string): string | null {
  if (!key.startsWith(TASK_KEY_PREFIX)) return null;
  return key.slice(TASK_KEY_PREFIX.length);
}

export function isTaskKey(key: string): boolean {
  return key.startsWith(TASK_KEY_PREFIX);
}

/**
 * Rank of a status in the join.
 *
 * `done` > `failed` > `cancelled` > `open`. `done` outranks because it is the
 * only terminal carrying a result, and losing a real completion to a concurrent
 * cancel strands every task waiting on it and causes the work to be redone.
 * `failed` outranks `cancelled` because the more information-bearing terminal
 * should survive: hiding a failure behind a concurrent cancel loses the only
 * record that the work was attempted and did not work.
 */
export function statusRank(status: TaskStatus): number {
  switch (status) {
    case "open":
      return 0;
    case "cancelled":
      return 1;
    case "failed":
      return 2;
    case "done":
      return 3;
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return status !== "open";
}

/** Canonical form of a task's replicated content, excluding signature metadata. */
export function canonicalTask(entry: TaskEntry): string {
  return canonicalJson(stripSignature(entry) as unknown as JsonValue);
}

/**
 * Canonical form of the descriptor group.
 *
 * Only used to break a tie between two entries carrying the same stamp, which
 * happens when a peer replays another node's stamp with different content.
 * Without it each replica would keep whichever copy it saw first.
 */
export function canonicalDescriptor(entry: TaskEntry): string {
  const group: Record<string, JsonValue> = {
    title: entry.title,
    priority: entry.priority,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt,
  };
  if (entry.detail !== undefined) group["detail"] = entry.detail;
  if (entry.result !== undefined) group["result"] = entry.result;
  if (entry.lastError !== undefined) group["lastError"] = entry.lastError;
  return canonicalJson(group);
}

/** Order two entries by descriptor stamp, then by descriptor content. */
function compareDescriptor(a: TaskEntry, b: TaskEntry): number {
  const byStamp = compareHlc(a.hlc, b.hlc);
  if (byStamp !== 0) return byStamp;
  return breakTie(canonicalDescriptor(a), canonicalDescriptor(b));
}

/**
 * Union two token lists, then truncate to the smallest N by sort order.
 *
 * Sorted, not insertion-ordered: if `x` is dropped then at least N elements
 * smaller than `x` were kept, and those survive into every later union — so `x`
 * can never be in the final min-N either, whichever order the ops arrive in.
 * Truncating by insertion order would diverge the replicas permanently.
 */
function boundedUnion(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
  limit: number,
): string[] {
  const union = new Set<string>([...(left ?? []), ...(right ?? [])]);
  return [...union].sort().slice(0, limit);
}

/**
 * Merge two copies of a task.
 *
 * The join described in the module header, field by field. The signature is
 * handled last and separately: the join produces content, never authorship.
 */
export function mergeTasks(a: TaskEntry, b: TaskEntry): TaskEntry {
  const winner = compareDescriptor(a, b) >= 0 ? a : b;
  const status = statusRank(a.status) >= statusRank(b.status) ? a.status : b.status;
  const needs = boundedUnion(a.needs, b.needs, MAX_TASK_NEEDS);
  const deps = boundedUnion(a.deps, b.deps, MAX_TASK_DEPS);

  const merged: TaskEntry = {
    kind: "task",
    hlc: winner.hlc,
    title: winner.title,
    ...(winner.detail !== undefined ? { detail: winner.detail } : {}),
    // Presence of the field is itself a union: an entry that declared an empty
    // list keeps it, so re-merging a copy of itself is byte-identical and does
    // not look like a change to `writeTask` or drop the author's signature.
    ...(a.needs !== undefined || b.needs !== undefined ? { needs } : {}),
    ...(a.deps !== undefined || b.deps !== undefined ? { deps } : {}),
    priority: winner.priority,
    status,
    ...(winner.result !== undefined ? { result: winner.result } : {}),
    ...(winner.lastError !== undefined ? { lastError: winner.lastError } : {}),
    attempts: Math.max(a.attempts, b.attempts),
    createdBy: winner.createdBy,
    createdAt: winner.createdAt,
  };

  // Signature handling mirrors `mergeAdds`/`boundSet`: a genuinely combined
  // entry has no single author, so it is stored unsigned rather than relayed
  // with a signature that no longer covers its content — every peer would then
  // reject it as a forgery. An entry the join reproduced exactly still has one
  // author, so its signature is kept and stays verifiable after a relay.
  const content = canonicalTask(merged);
  const fromA = content === canonicalTask(a);
  const fromB = content === canonicalTask(b);
  if (fromA && fromB) {
    // Identical content implies the same author — content includes `hlc.n`, and
    // `verifyOp` binds `by` to it — and Ed25519 signing here is deterministic,
    // so preferring the signed copy is the same decision on both replicas.
    return isSigned(a) ? a : isSigned(b) ? b : a;
  }
  if (fromA) return a;
  if (fromB) return b;
  return merged;
}

/**
 * How far ahead of local time `createdAt` may be.
 *
 * The same ceiling `isAcceptableHlc` applies to a stamp. Stated separately
 * because this bounds a *different* peer-supplied number that happens to want
 * the same limit: `createdAt` orders the queue, so a value far in the future
 * pins a task at the back of its priority band for as long as the task exists.
 */
export const MAX_TASK_CREATED_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Merge-time bounds on an entry arriving from a peer.
 *
 * The twin of `isAcceptableTtl` / `isAcceptableGen` / `isAcceptableClaimStamp`.
 * The schema in `types.ts` enforces the same bounds at the validation boundary;
 * this is the second layer, because `mergeOp` is reachable from
 * `applyPeerSnapshot` and from `load()`, where the on-disk replica is treated as
 * untrusted input.
 */
export function isAcceptableTaskEntry(entry: TaskEntry, now: number): boolean {
  if (!(TASK_STATUS as readonly string[]).includes(entry.status)) return false;
  if (
    !Number.isSafeInteger(entry.attempts) ||
    entry.attempts < 0 ||
    entry.attempts > MAX_ACCEPTED_TASK_ATTEMPTS
  ) {
    return false;
  }
  if (
    !Number.isSafeInteger(entry.priority) ||
    entry.priority < MIN_TASK_PRIORITY ||
    entry.priority > MAX_TASK_PRIORITY
  ) {
    return false;
  }
  return (
    Number.isSafeInteger(entry.createdAt) &&
    entry.createdAt >= 0 &&
    entry.createdAt <= now + MAX_TASK_CREATED_SKEW_MS
  );
}

/**
 * Is this task old enough to collect?
 *
 * An `open` task is never collected however old it is — it is the work queue,
 * and dropping it would silently lose the job rather than a record of one.
 */
export function isTaskCollectable(entry: TaskEntry, now: number): boolean {
  return isTerminal(entry.status) && now - entry.hlc.w > TASK_RETENTION_MS;
}

/** Build the next draft from what is on record, changing only what was asked. */
export function draftFrom(entry: TaskEntry, patch: Partial<TaskDraft>): TaskDraft {
  const base: TaskDraft = {
    title: entry.title,
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    ...(entry.needs !== undefined ? { needs: [...entry.needs] } : {}),
    ...(entry.deps !== undefined ? { deps: [...entry.deps] } : {}),
    priority: entry.priority,
    status: entry.status,
    ...(entry.result !== undefined ? { result: entry.result } : {}),
    ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
    attempts: entry.attempts,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt,
  };
  return { ...base, ...patch };
}

/**
 * Derive a task id from a title.
 *
 * Ids appear in Markdown tables, in keys, and in log lines, so everything
 * outside `[a-z0-9]` collapses to a separator. A title of pure punctuation or of
 * non-Latin script leaves nothing behind, which is why there is a fallback: an
 * empty slug would produce the key `@task/-abc123`, or worse `@task/`, and the
 * caller would be minting ids that collide. The suffix is what makes two agents
 * creating "write the tests" get two tasks rather than silently sharing one.
 */
export function slugTaskId(title: string, suffix: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_TASK_SLUG)
    .replace(/-+$/g, "");
  const id = `${slug.length > 0 ? slug : "task"}-${suffix}`;
  // The pattern is the contract for every key this id can appear in, so it is
  // asserted here rather than trusted from the transformation above.
  return isValidTaskId(id) ? id : `task-${suffix}`;
}

/** A task joined with its lease and with what it is waiting on. */
export interface TaskView {
  taskId: string;
  title: string;
  detail: string | null;
  status: TaskStatus;
  priority: number;
  attempts: number;
  needs: string[];
  deps: string[];
  /** Dependencies that are not `done` on this replica — an unknown dep counts. */
  blockedBy: string[];
  /** From `@claim/<id>`, never from the task. Null when nobody holds it now. */
  holder: string | null;
  leaseExpiresAt: string | null;
  /**
   * Node id on the most recent lease, live or lapsed.
   *
   * Distinct from `holder`, which is null the moment the lease expires. The
   * abandonment sweep needs to know *who* dropped the work, which is exactly the
   * information `holder` stops carrying at expiry.
   */
  lastHolder: string | null;
  leaseGeneration: number | null;
  /** True when the last holder gave the lease up deliberately. */
  leaseReleased: boolean | null;
  holderRole: string | null;
  holderLive: boolean | null;
  runnable: boolean;
  heldByYou: boolean;
  createdBy: string;
  createdAt: string;
  /** Epoch ms, so FIFO ordering never depends on re-parsing a rendered string. */
  createdAtMs: number;
  result: JsonValue | null;
  lastError: string | null;
}

/** What `describeTask` needs from outside the task itself, when it is available. */
export interface TaskViewContext {
  /** This node's id, so a view can say whether the lease is ours. */
  selfNodeId?: string;
  /** Capabilities this node announced. Absent means it has announced none. */
  capabilities?: ReadonlySet<string>;
  /** Presence, keyed by node id, so the board can say whether a holder is alive. */
  agents?: ReadonlyMap<string, { role: string; live: boolean }>;
}

/**
 * Render a task for an agent or a human to read.
 *
 * The join happens here and nowhere else: `@task/<id>` supplies the work,
 * `@claim/<id>` supplies the holder, `@agent/<holder>` supplies whether that
 * holder is still alive. Nothing is copied between the three.
 */
export function describeTask(
  taskId: string,
  entry: TaskEntry,
  lease: ClaimEntry | undefined,
  tasksById: ReadonlyMap<string, TaskEntry>,
  now: number,
  context: TaskViewContext = {},
): TaskView {
  // An unknown dependency counts as unsatisfied, never as satisfied: a replica
  // that has not finished syncing must not conclude the work is clear.
  const blockedBy = (entry.deps ?? []).filter(
    (dep) => tasksById.get(dep)?.status !== "done",
  );
  const holder = lease ? holderOf(lease, now) : null;
  const capabilities = context.capabilities;
  const covered =
    (entry.needs ?? []).length === 0 ||
    (capabilities !== undefined &&
      (entry.needs ?? []).every((need) => capabilities.has(need)));
  const presence = holder !== null ? context.agents?.get(holder) : undefined;

  return {
    taskId,
    title: entry.title,
    detail: entry.detail ?? null,
    status: entry.status,
    priority: entry.priority,
    attempts: entry.attempts,
    needs: [...(entry.needs ?? [])],
    deps: [...(entry.deps ?? [])],
    blockedBy,
    holder,
    leaseExpiresAt: lease ? new Date(expiresAt(lease)).toISOString() : null,
    lastHolder: lease ? lease.hlc.n : null,
    leaseGeneration: lease ? lease.gen : null,
    leaseReleased: lease ? lease.released === true : null,
    holderRole: presence?.role ?? null,
    holderLive: presence !== undefined ? presence.live : null,
    runnable:
      entry.status === "open" &&
      blockedBy.length === 0 &&
      holder === null &&
      covered,
    heldByYou:
      context.selfNodeId !== undefined && holder === context.selfNodeId,
    createdBy: entry.createdBy,
    createdAt: new Date(entry.createdAt).toISOString(),
    createdAtMs: entry.createdAt,
    result: entry.result ?? null,
    lastError: entry.lastError ?? null,
  };
}

export interface SelectOptions {
  /** Capabilities this node announced. Empty means it announced none. */
  capabilities: ReadonlySet<string>;
  /** Narrow to tasks that demand this capability. */
  capability?: string;
}

/**
 * Tasks this node could actually pick up, best first.
 *
 * The ordering is total — priority, then age, then id — so two replicas offered
 * the same board choose the same task, and a race is decided by the lease rather
 * than by which agent happened to iterate its map first.
 */
export function selectCandidates(
  views: TaskView[],
  opts: SelectOptions,
): TaskView[] {
  return views
    .filter((view) => {
      if (view.status !== "open") return false;
      // A peer can send `attempts: 999` with `status: "open"`. Without this the
      // board keeps offering work everybody has already given up on.
      if (view.attempts >= TASK_MAX_ATTEMPTS) return false;
      if (view.blockedBy.length > 0) return false;
      if (!view.needs.every((need) => opts.capabilities.has(need))) return false;
      if (opts.capability !== undefined && !view.needs.includes(opts.capability)) {
        return false;
      }
      // Includes a task this node already holds: an agent asking for the *next*
      // task is not asking to be handed the one it is already doing, and
      // `list_tasks(mine: true)` answers that question instead.
      return view.holder === null;
    })
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.createdAtMs - b.createdAtMs ||
        (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
    );
}

export interface AbandonReport {
  taskId: string;
  title: string;
  /** Node that held the lease when it lapsed. */
  holder: string;
  generation: number;
}

/**
 * Reports made, so each lapsed lease is announced once.
 *
 * Bounded with FIFO eviction because it is keyed by peer-supplied task ids: an
 * unbounded "already told you" set is a remote memory-growth primitive like any
 * other. Evicting the oldest can re-report a very old abandonment after 1 000
 * distinct ones, which is a duplicate event rather than a lost one.
 */
export const MAX_ABANDON_REPORTS = 1_000;

export class AbandonedTasks {
  private readonly reported = new Set<string>();

  /**
   * Open tasks whose lease lapsed with nothing recorded.
   *
   * Abandonment is *observed*, not detected: this runs when an agent next asks
   * the board for work, because P2PA has no failure detector and a timer here
   * would look like one. A lease that was *released* is not abandonment — that
   * is an agent handing work back on purpose, which `fail_task` already reports.
   */
  sweep(views: TaskView[]): AbandonReport[] {
    const out: AbandonReport[] = [];
    for (const view of views) {
      if (view.status !== "open") continue;
      if (view.holder !== null) continue;
      if (view.lastHolder === null || view.leaseGeneration === null) continue;
      if (view.leaseReleased === true) continue;
      const token = `${view.taskId}|${view.lastHolder}|${view.leaseGeneration}`;
      if (this.reported.has(token)) continue;
      this.remember(token);
      out.push({
        taskId: view.taskId,
        title: view.title,
        holder: view.lastHolder,
        generation: view.leaseGeneration,
      });
    }
    return out;
  }

  private remember(token: string): void {
    this.reported.add(token);
    while (this.reported.size > MAX_ABANDON_REPORTS) {
      const oldest = this.reported.values().next();
      if (oldest.done === true) break;
      this.reported.delete(oldest.value);
    }
  }
}
