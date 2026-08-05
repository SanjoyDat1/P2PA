import type { ContextStore } from "./store.js";
import type { MarkdownLog } from "./markdown-log.js";
import type { P2PNode } from "./p2p.js";
import type { ContentionLog } from "./conflicts.js";
import type { CrdtOp, MergeResult } from "./crdt.js";
import {
  CrdtOpArraySchema,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  type AuditPeer,
  type ContextState,
  type TaskSettlement,
  type JsonValue,
  type Source,
} from "./types.js";
import { randomUUID } from "node:crypto";
import { nodeIdFromPublicKey } from "./hlc.js";
import { canonicalJson } from "./canonical.js";
import type { EventBus } from "./events.js";
import type { Outbox } from "./outbox.js";
import {
  describeClaim,
  holderOf,
  isClaimKey,
  taskIdFromKey,
  type ClaimEntry,
  type ClaimView,
} from "./claim.js";
import {
  MAX_ACCEPTED_TASK_ATTEMPTS,
  TASK_MAX_ATTEMPTS,
  draftFrom,
  isTaskKey,
  isTerminal,
  selectCandidates,
  taskIdFromTaskKey,
  type AbandonReport,
  type AbandonedTasks,
  type TaskStatus,
  type TaskView,
} from "./task.js";
import { isSigned } from "./signing.js";
import {
  isAgentKey,
  nodeIdFromAgentKey,
  parseCard,
  type AgentCard,
} from "./presence.js";

export interface SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  p2p?: P2PNode;
  contention?: ContentionLog;
  /** Wakes agents blocked on peer activity. Absent in tests that do not need it. */
  events?: EventBus;
  /** Holds messages until the recipient confirms them. */
  outbox?: Outbox;
  /**
   * Refuse peer operations that carry no signature.
   *
   * Off by default because it excludes every v3 peer. On, it closes the one gap
   * hop-by-hop authentication cannot: a snapshot relays entries the sender did
   * not author, so without signatures a three-node swarm lets one peer fabricate
   * another's writes. Worth turning on once every node speaks v4.
   */
  requireSignatures?: boolean;
}

export type ApplyResult =
  | { ok: true; ops: CrdtOp[] }
  | { ok: false; error: string };

export interface InboundSummary {
  applied: number;
  ignored: number;
  contended: number;
  rejected: number;
  rejections: string[];
  /**
   * Ops refused because a signature did not verify.
   *
   * Counted separately because it means something different from every other
   * rejection: a bound being hit is a peer misbehaving by degree, a bad signature
   * is a forgery attempt. The transport uses it to drop the connection, so
   * grinding forged signatures is not free.
   */
  forged: number;
}

/** A summary with nothing in it, so every construction site stays consistent. */
function emptySummary(): InboundSummary {
  return {
    applied: 0,
    ignored: 0,
    contended: 0,
    rejected: 0,
    rejections: [],
    forged: 0,
  };
}

/**
 * Run a local mutation, persist, and broadcast the resulting ops.
 *
 * The mutation hands back the ops it produced rather than the sync layer
 * diffing before against after: a CRDT write already knows which keys it
 * touched, and a structural diff cannot recover the stamps that make merge
 * deterministic on the other end.
 */
export function commitLocalMutation(
  services: SyncServices,
  mutate: (store: ContextStore) => CrdtOp[] | CrdtOp | null,
): ApplyResult {
  let produced: CrdtOp[];
  try {
    const result = mutate(services.store);
    produced = result === null ? [] : Array.isArray(result) ? result : [result];
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (produced.length === 0) return { ok: true, ops: [] };

  if (JSON.stringify(produced).length > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      error: `Update exceeds max size of ${MAX_PAYLOAD_BYTES} bytes`,
    };
  }

  // The op has to survive the same schema every receiver applies to it. Until
  // now only its byte size was checked here, so a tool with a looser input
  // schema than the wire's could mint an entry that is valid locally and
  // unparseable everywhere else — and because a snapshot is validated as one
  // array with no per-op tolerance, a single such entry makes this node's whole
  // replica undeliverable to every peer, permanently. Failing the call is the
  // only honest answer: the alternative is telling an agent its write landed
  // while the swarm silently stops syncing.
  const wireCheck = CrdtOpArraySchema.safeParse(produced);
  if (!wireCheck.success) {
    return {
      ok: false,
      error:
        `Refusing to broadcast an operation no peer could read: ` +
        `${wireCheck.error.issues[0]?.message ?? "failed wire validation"}`,
    };
  }

  services.log.syncStateUpdate(
    "Local",
    produced.map((op) => op.key),
    services.store.snapshot(),
    services.store.export(),
  );
  broadcastUpdate(services, produced);
  return { ok: true, ops: produced };
}

/**
 * Merge ops that arrived from a peer.
 *
 * A peer can only move the keys it names, and only by presenting a stamp that
 * beats the one already on that key. Nothing inbound replaces the document, and
 * nothing inbound stalls the merge of anything else — a refused op is recorded
 * and skipped rather than holding up its neighbours.
 */
export function handleInboundOps(
  services: SyncServices,
  ops: CrdtOp[],
  source: Source,
  peer?: AuditPeer,
  /**
   * Authenticated public key of the sender.
   *
   * A direct update is the sender's own write, so its stamps must carry the
   * sender's node id. Without this check a peer can stamp with a victim's id:
   * the overwrite then looks like the victim's own work, so it is neither
   * reported as contended nor recorded, and a replayed stamp can be used to
   * pin a key. Snapshots legitimately relay third-party stamps and are not
   * bound this way — that is why they stay merge-only and never authoritative.
   */
  senderPublicKey?: string,
): InboundSummary {
  if (senderPublicKey !== undefined) {
    const expected = nodeIdFromPublicKey(senderPublicKey);
    const forged = ops.filter((op) => op?.entry?.hlc?.n !== expected);
    if (forged.length > 0) {
      const summary: InboundSummary = {
        ...emptySummary(),
        rejected: forged.length,
        rejections: ["stamp does not match the sending peer's identity"],
      };
      recordRejection(
        services,
        summary,
        source,
        peer,
        forged.map((op) => op?.key ?? "?"),
      );
      return summary;
    }
  }

  const parsed = CrdtOpArraySchema.safeParse(ops);
  if (!parsed.success) {
    const summary: InboundSummary = {
      ...emptySummary(),
      rejected: ops.length,
      rejections: [parsed.error.message],
    };
    recordRejection(
      services,
      summary,
      source,
      peer,
      ops.map((op) => op?.key ?? "?"),
    );
    return summary;
  }

  return absorb(services, services.store.merge(parsed.data), source, peer);
}

/**
 * Merge a peer's handshake snapshot.
 *
 * The counter protocol took a snapshot whole whenever the sender claimed a
 * clock at least as high as the local one, then replaced local state with it.
 * That handed any connected peer a way to blank the document, and — with a
 * stamp near the integer ceiling — to wedge the receiver's clock permanently.
 * A snapshot is now merged key by key under the same rules as any other update:
 * it wins only the keys it can out-stamp, stamps beyond the accepted skew are
 * refused outright, and local keys the sender never mentioned are untouched.
 */
export function applyPeerSnapshot(
  services: SyncServices,
  ops: CrdtOp[],
  source: Source,
  peer?: AuditPeer,
): InboundSummary {
  if (ops.length === 0) {
    return emptySummary();
  }

  // A snapshot legitimately relays stamps authored by third parties, so its
  // entries cannot be bound to the sender the way a direct update's are. What
  // it may never carry is *our own* node id: that is not relaying, it is a peer
  // writing as us — which would sail past the contention check (the stamp looks
  // locally authored) and leave no record that anything was overwritten.
  const impersonating = ops.filter(
    (op) => op?.entry?.hlc?.n === services.store.nodeId,
  );
  let relayed = ops.filter((op) => op?.entry?.hlc?.n !== services.store.nodeId);

  // The relay gap, closed by policy. Sender-binding cannot help here — the whole
  // point of a snapshot is to carry other nodes' work — so a signature is the
  // only thing that distinguishes a faithful relay from a fabrication.
  let unsigned = 0;
  if (services.requireSignatures === true) {
    const verifiable = relayed.filter((op) => isSigned(op.entry));
    unsigned = relayed.length - verifiable.length;
    relayed = verifiable;
  }

  const appliedKeys: string[] = [];
  const results = services.store.merge(relayed);
  for (const result of results) {
    if (result.status === "applied" || result.status === "contended") {
      appliedKeys.push(result.key);
    }
  }
  const summary = absorb(services, results, source, peer, { snapshot: true });

  if (impersonating.length > 0) {
    summary.rejected += impersonating.length;
    summary.rejections.push("snapshot entry stamped with this node's identity");
    recordRejection(
      services,
      summary,
      source,
      peer,
      impersonating.map((op) => op?.key ?? "?"),
    );
  }
  if (unsigned > 0) {
    summary.rejected += unsigned;
    summary.rejections.push(
      "relayed entry carries no signature and signatures are required",
    );
  }
  services.log.syncSnapshot(
    source,
    summary.applied,
    summary.ignored,
    peer,
    services.store.snapshot(),
    services.store.export(),
  );
  if (summary.applied > 0) {
    services.log.syncMarkdownLog({
      source,
      peer,
      action: "State Update",
      keys: appliedKeys.slice(0, 50),
    });
  }
  return summary;
}

/** Fold merge results into audit entries, contention records, and a summary. */
function absorb(
  services: SyncServices,
  results: MergeResult[],
  source: Source,
  peer: AuditPeer | undefined,
  options: { snapshot?: boolean } = {},
): InboundSummary {
  const summary: InboundSummary = emptySummary();
  const touched: string[] = [];
  const refused: string[] = [];
  /**
   * What a task's status was before this batch, per key.
   *
   * Kept so the audit trail can record a *transition* into a terminal state
   * rather than any later change to a task that was already settled. Without
   * that distinction a peer can nudge one finished task indefinitely and every
   * nudge reads as a fresh settlement — a peer-controlled lever on the live
   * audit file, which is bounded and rotates.
   */
  const wasStatus = new Map<string, TaskStatus | undefined>();

  for (const result of results) {
    if (result.status === "applied" || result.status === "contended") {
      // First observation, not the last: one envelope may carry several ops for
      // the same task, and the status that matters is the one held when the
      // batch began. Recording the last would let a peer suppress the entry
      // entirely by sending the settlement and any trivial follow-up together —
      // the follow-up's "before" is already terminal, so the transition test
      // fails and a settlement in the one namespace anybody may write goes
      // unattributed.
      if (isTaskKey(result.key) && !wasStatus.has(result.key)) {
        wasStatus.set(result.key, result.previousStatus);
      }
    }
    if (result.status === "applied") {
      summary.applied += 1;
      touched.push(result.key);
      continue;
    }
    if (result.status === "ignored") {
      summary.ignored += 1;
      continue;
    }
    if (result.status === "rejected") {
      summary.rejected += 1;
      refused.push(result.key);
      // A signature that does not verify is the one rejection that means the peer
      // is lying rather than merely out of bounds; the caller drops the connection
      // over it, so grinding forged signatures costs the attacker its session.
      if (result.reason?.startsWith("bad signature")) summary.forged += 1;
      if (result.reason && !summary.rejections.includes(result.reason)) {
        summary.rejections.push(result.reason);
      }
      continue;
    }

    // contended: merge already settled it, identically on both replicas.
    summary.contended += 1;
    summary.applied += 1;
    touched.push(result.key);
    services.contention?.record({
      key: result.key,
      previousNode: result.previousNode ?? "unknown",
      peerFingerprint: peer?.fingerprint ?? null,
      winningValue: services.store.get(result.key),
    });
    services.log.syncMarkdownLog({
      source,
      peer,
      action: "Concurrent Update",
      key: result.key,
      previousNode: result.previousNode ?? "unknown",
    });
  }

  // One rewrite for the whole batch. Writing per lease made a single envelope
  // cost time quadratic in its size, with the whole file re-rendered each pass.
  const leaseKeys = touched.filter((key) => isClaimKey(key));
  if (leaseKeys.length > 0) {
    const now = services.store.nowMs();
    const claimed: string[] = [];
    const released: string[] = [];
    for (const key of leaseKeys.slice(0, 50)) {
      const taskId = taskIdFromKey(key);
      const entry = taskId === null ? undefined : services.store.claim(taskId);
      if (taskId === null || !entry) continue;
      const view = describeClaim(taskId, entry, now);
      (view.released ? released : claimed).push(taskId);
      if (source === "Peer") {
        services.events?.emit({
          kind: view.released ? "release" : "claim",
          peer: peer?.fingerprint ?? null,
          taskId,
          holder: view.holder,
        });
      }
    }
    if (claimed.length > 0) {
      services.log.syncMarkdownLog({
        source,
        peer,
        action: "State Update",
        keys: claimed.map((id) => `lease:${id}`),
      });
    }
    if (released.length > 0) {
      services.log.syncMarkdownLog({
        source,
        peer,
        action: "State Update",
        keys: released.map((id) => `release:${id}`),
      });
    }
    services.log.rewriteClaims(services.store.listClaims());
  }

  // A peer joining or changing status is worth waking an agent for on its own —
  // it is the signal that decides whether work can be handed off — so it is
  // reported as `presence` rather than buried in a list of changed keys.
  const agentKeys = touched.filter((key) => isAgentKey(key));
  if (agentKeys.length > 0 && source === "Peer") {
    for (const key of agentKeys.slice(0, 20)) {
      const card = parseCard(services.store.get(key));
      if (!card) continue;
      services.events?.emit({
        kind: "presence",
        peer: peer?.fingerprint ?? null,
        holder: nodeIdFromAgentKey(key) ?? undefined,
        role: card.role,
        status: card.status,
        ...(card.task !== undefined ? { taskId: card.task } : {}),
      });
    }
  }

  // One rewrite for the whole batch here too, and the views are built once
  // rather than per key: `listTasks` walks the backlog, so doing it per touched
  // key would make a single envelope cost time quadratic in its size.
  const taskKeys = touched.filter((key) => isTaskKey(key));
  if (taskKeys.length > 0) {
    const views = services.store.listTasks();
    const byId = new Map(views.map((view) => [view.taskId, view]));
    const finished: string[] = [];
    const settlements: TaskSettlement[] = [];

    for (const key of taskKeys.slice(0, 50)) {
      const taskId = taskIdFromTaskKey(key);
      const view = taskId === null ? undefined : byId.get(taskId);
      if (!view) continue;
      if (view.status === "done") finished.push(view.taskId);
      // Emission stays peer-only, like `claim`/`release`/`presence`: a local
      // write does not need to wake the agent that just made it. `touched` only
      // holds keys where the merge actually changed something, so a re-delivered
      // completion merges to "ignored" and raises nothing.
      if (source !== "Peer") continue;

      // A peer's settlement is recorded as one, not as a generic key change:
      // without it the file said only that `@task/<id>` moved, never to what or
      // by whom, which is the question an audit trail exists to answer for the
      // one namespace any peer is allowed to write. Collected here and written
      // once below — an audit write re-reads and rewrites the whole document, so
      // one per settled task would make an envelope quadratic in its size.
      //
      // Only on the *transition* into a terminal state. A task that was already
      // settled changing again is an ordinary merge, and treating each one as a
      // settlement hands a peer a lever on the live audit window.
      const before = wasStatus.get(key);
      if (isTerminal(view.status) && (before === undefined || !isTerminal(before))) {
        settlements.push({
          taskId: view.taskId,
          status: view.status,
          attempt: view.attempts,
          // From the entry's own stamp: the node that wrote the outcome, which
          // is neither necessarily the lease holder nor the creator.
          settledBy: view.settledBy,
          ...(view.lastError !== null ? { detail: view.lastError } : {}),
        });
      }
      if (view.status === "done") {
        services.events?.emit({
          kind: "task_done",
          peer: peer?.fingerprint ?? null,
          taskId: view.taskId,
          status: view.status,
          ...(view.lastHolder !== null ? { holder: view.lastHolder } : {}),
          text: view.result === null ? view.title : canonicalJson(view.result),
        });
        continue;
      }
      if (view.status === "failed" || view.status === "cancelled") {
        services.events?.emit({
          kind: "task_failed",
          peer: peer?.fingerprint ?? null,
          taskId: view.taskId,
          status: view.status,
          ...(view.lastHolder !== null ? { holder: view.lastHolder } : {}),
          text: view.lastError ?? view.title,
        });
        continue;
      }
      services.events?.emit({
        kind: "task",
        peer: peer?.fingerprint ?? null,
        taskId: view.taskId,
        status: view.status,
        text: view.title,
      });
    }

    // A dependency clearing is the other half of the delegation loop: without
    // it an agent blocked on somebody else's work has nothing to wake on.
    if (source === "Peer" && finished.length > 0) {
      let announced = 0;
      for (const doneId of finished.slice(0, 50)) {
        for (const candidate of views) {
          if (announced >= 20) break;
          if (candidate.status !== "open") continue;
          if (!candidate.deps.includes(doneId)) continue;
          if (candidate.blockedBy.length > 0) continue;
          services.events?.emit({
            kind: "task_ready",
            peer: peer?.fingerprint ?? null,
            taskId: candidate.taskId,
            text: `unblocked by ${doneId}`,
          });
          announced += 1;
        }
      }
    }

    if (settlements.length > 0) {
      services.log.syncMarkdownLog({
        source,
        peer,
        action: "Task Settled",
        tasks: settlements,
      });
    }

    services.log.rewriteBacklog(views);
  }

  // Tasks are excluded here as well as leases and cards: a generic `state`
  // event naming `@task/…` keys would send an agent to `pull_context`, which
  // deliberately cannot resolve them.
  const stateKeys = touched.filter(
    (key) => !isClaimKey(key) && !isAgentKey(key) && !isTaskKey(key),
  );
  if (stateKeys.length > 0 && source === "Peer") {
    services.events?.emit({
      kind: "state",
      peer: peer?.fingerprint ?? null,
      keys: stateKeys,
    });
  }

  if (touched.length > 0 && options.snapshot !== true) {
    services.log.syncStateUpdate(
      source,
      touched,
      services.store.snapshot(),
      services.store.export(),
      peer,
    );
  }
  if (refused.length > 0) {
    recordRejection(services, summary, source, peer, refused);
  }
  if (summary.contended > 0 && services.contention) {
    services.contention.syncMarkdown(services.log);
  }
  return summary;
}

/** Refusals go to the audit trail, not only to stderr. */
function recordRejection(
  services: SyncServices,
  summary: InboundSummary,
  source: Source,
  peer: AuditPeer | undefined,
  keys: string[],
): void {
  services.log.syncMarkdownLog({
    source,
    peer,
    action: "Rejected Update",
    reason: summary.rejections.join("; ") || "invalid update",
    keys: keys.slice(0, 20),
  });
}

/**
 * Overwrite keys with agent-chosen values, overriding a settled merge.
 *
 * The deterministic winner is correct by construction but not always correct by
 * intent; this is the escape hatch. It is an ordinary local write, so it
 * out-stamps what it replaces and converges like anything else.
 */
export function overrideKeys(
  services: SyncServices,
  values: Record<string, JsonValue>,
  detail: string,
): ApplyResult {
  const keys = Object.keys(values);
  if (keys.length === 0) {
    return { ok: false, error: "no keys supplied" };
  }

  const result = commitLocalMutation(services, (store) =>
    keys.map((key) => store.setKey(key, values[key] as JsonValue)),
  );
  if (!result.ok) return result;

  for (const key of keys) services.contention?.clearKey(key);
  services.contention?.syncMarkdown(services.log);
  services.log.syncMarkdownLog({
    source: "Local",
    action: "Override",
    keys,
    detail,
  });
  return result;
}

export type ClaimOutcome =
  | { ok: true; view: ClaimView }
  | { ok: false; error: string; holder?: string };

/**
 * Take a lease and tell peers about it.
 *
 * The answer is provisional against a peer that claimed at the same moment and
 * whose op has not arrived yet — see `settleClaim`, which the MCP layer uses to
 * turn this into a definitive one before an agent acts on it.
 */
export function claimTask(
  services: SyncServices,
  taskId: string,
  ttlMs: number,
  note?: string,
): ClaimOutcome {
  let taken: { ok: true; op: CrdtOp } | { ok: false; holder: string };
  try {
    taken = services.store.takeClaim(taskId, ttlMs, note);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!taken.ok) {
    return { ok: false, error: `already held by ${taken.holder}`, holder: taken.holder };
  }

  const committed = commitLocalMutation(services, () => taken.op);
  if (!committed.ok) return { ok: false, error: committed.error };

  const entry = services.store.claim(taskId);
  const view = describeClaim(taskId, entry as ClaimEntry, services.store.nowMs());
  services.log.syncMarkdownLog({
    source: "Local",
    action: "Claim",
    taskId,
    holder: view.holder,
    generation: view.generation,
    expiresAt: view.expiresAt,
  });
  services.log.rewriteClaims(services.store.listClaims());
  return { ok: true, view };
}

/** Give up a lease and tell peers. */
export function releaseTask(
  services: SyncServices,
  taskId: string,
): ClaimOutcome {
  const released = services.store.releaseClaim(taskId);
  if (!released.ok) return { ok: false, error: released.reason };

  const committed = commitLocalMutation(services, () => released.op);
  if (!committed.ok) return { ok: false, error: committed.error };

  const entry = services.store.claim(taskId) as ClaimEntry;
  const view = describeClaim(taskId, entry, services.store.nowMs());
  services.log.syncMarkdownLog({
    source: "Local",
    action: "Release",
    taskId,
    holder: view.holder,
    generation: view.generation,
  });
  services.log.rewriteClaims(services.store.listClaims());
  return { ok: true, view };
}

export type TaskOutcome =
  | { ok: true; view: TaskView; unblocked: string[]; alreadySettled: boolean }
  | { ok: false; error: string; holder?: string };

export type TaskCreation =
  | { ok: true; taskId: string; view: TaskView }
  | { ok: false; error: string };

/** Bytes of uniqueness appended to a slugged title. */
const TASK_ID_SUFFIX_LENGTH = 6;

/** The view of a task after a write, for callers that need to report it. */
function viewOf(services: SyncServices, taskId: string): TaskView | undefined {
  return services.store.listTasks().find((view) => view.taskId === taskId);
}

/**
 * Put work on the shared backlog.
 *
 * No lease is taken. Creating a task says the work exists and what it needs, not
 * that this agent is doing it — those are separate questions and conflating them
 * is what a `holder` field on a task would do.
 */
export function createTask(
  services: SyncServices,
  input: {
    title: string;
    detail?: string;
    needs?: string[];
    deps?: string[];
    priority?: number;
    taskId?: string;
  },
): TaskCreation {
  const suffix = randomUUID().replace(/-/g, "").slice(0, TASK_ID_SUFFIX_LENGTH);
  const created = services.store.createTask({ ...input, suffix });
  if (!created.ok) return created;

  const committed = commitLocalMutation(services, () => created.op);
  if (!committed.ok) return { ok: false, error: committed.error };

  const views = services.store.listTasks();
  const view = views.find((candidate) => candidate.taskId === created.taskId);
  if (!view) return { ok: false, error: `Could not read back "${created.taskId}"` };

  services.log.syncMarkdownLog({
    source: "Local",
    action: "Task Created",
    taskId: view.taskId,
    title: view.title,
    priority: view.priority,
    needs: view.needs,
    deps: view.deps,
  });
  services.log.rewriteBacklog(views);
  return { ok: true, taskId: created.taskId, view };
}

/**
 * Record that a task is finished, with what came out of it.
 *
 * The task is written **before** the lease is released, and the order is not
 * incidental. Releasing first and then crashing leaves an open, unleased task
 * that somebody else redoes from scratch; completing first and then crashing
 * leaves a finished task under a lease that expires harmlessly.
 */
export function completeTask(
  services: SyncServices,
  taskId: string,
  result?: JsonValue,
): TaskOutcome {
  return settle(services, taskId, { status: "done", ...(result !== undefined ? { result } : {}) });
}

/**
 * Give up on an attempt.
 *
 * `requeue` puts the work back for somebody else instead of losing it;
 * `outcome: "cancelled"` says nobody should attempt it again. Both are terminal
 * for *this* attempt, which is why they share a tool and a code path.
 */
export function failTask(
  services: SyncServices,
  taskId: string,
  reason: string,
  options: { requeue?: boolean; outcome?: "failed" | "cancelled" } = {},
): TaskOutcome {
  const entry = services.store.task(taskId);
  if (!entry) {
    return {
      ok: false,
      error:
        `No task "${taskId}" is on the backlog. Call list_tasks to see what is, ` +
        `or create_task to add it.`,
    };
  }
  // Bounded so a peer that has already pushed `attempts` to the ceiling cannot
  // make a local retry produce an entry every replica then rejects.
  const attempts = Math.min(entry.attempts + 1, MAX_ACCEPTED_TASK_ATTEMPTS);
  const requeue = options.requeue !== false;
  const status: TaskStatus =
    options.outcome === "cancelled"
      ? "cancelled"
      : requeue && attempts < TASK_MAX_ATTEMPTS
        ? "open"
        : "failed";
  return settle(services, taskId, { status, attempts, lastError: reason });
}

/**
 * The write half of `complete_task` and `fail_task`.
 *
 * The already-settled check makes the *tool* idempotent, which the lattice alone
 * does not: merge is idempotent over the same op, but a second `complete_task`
 * carrying a different result is a different op, and without this the second
 * caller would overwrite the first completer's answer.
 */
function settle(
  services: SyncServices,
  taskId: string,
  patch: { status: TaskStatus; result?: JsonValue; attempts?: number; lastError?: string },
): TaskOutcome {
  const entry = services.store.task(taskId);
  if (!entry) {
    return {
      ok: false,
      error:
        `No task "${taskId}" is on the backlog. Call list_tasks to see what is, ` +
        `or create_task to add it.`,
    };
  }
  if (isTerminal(entry.status)) {
    const settled = viewOf(services, taskId);
    return settled
      ? { ok: true, view: settled, unblocked: [], alreadySettled: true }
      : { ok: false, error: `Could not read back "${taskId}"` };
  }

  const now = services.store.nowMs();
  const lease = services.store.claim(taskId);
  const holder = lease ? holderOf(lease, now) : null;
  if (holder !== null && holder !== services.store.nodeId) {
    // An ergonomic guard, not a security boundary: any allowlisted peer can
    // write this entry directly, and the merge rules will accept it. What this
    // stops is the ordinary mistake of settling work another agent is still
    // doing, which is worth a clear error rather than a silent overwrite.
    return {
      ok: false,
      holder,
      error:
        `"${taskId}" is currently leased by ${holder}. Ask that agent with ` +
        `ask_peer before settling work it may still be doing.`,
    };
  }

  const blockedBefore = openDependents(services, taskId);

  const committed = commitLocalMutation(services, (store) =>
    store.putTask(taskId, draftFrom(entry, patch)),
  );
  if (!committed.ok) return { ok: false, error: committed.error };
  if (committed.ops.length === 0) {
    return { ok: false, error: `The backlog already holds that outcome for "${taskId}"` };
  }

  // Lease second. See the ordering note on `completeTask`.
  if (holder === services.store.nodeId) releaseTask(services, taskId);

  const views = services.store.listTasks();
  const view = views.find((candidate) => candidate.taskId === taskId);
  if (!view) return { ok: false, error: `Could not read back "${taskId}"` };

  services.log.syncMarkdownLog({
    source: "Local",
    action: "Task Settled",
    tasks: [
      {
        taskId,
        status: view.status,
        attempt: view.attempts,
        settledBy: view.settledBy,
        ...(view.lastError !== null ? { detail: view.lastError } : {}),
      },
    ],
  });

  // Dependents that were waiting on this task and are now waiting on nothing.
  // Computed from the pre-write list, so a task blocked on something else too is
  // not reported as freed.
  const cleared = new Set(
    views
      .filter((candidate) => candidate.blockedBy.length === 0)
      .map((candidate) => candidate.taskId),
  );
  const unblocked =
    view.status === "done" ? blockedBefore.filter((id) => cleared.has(id)) : [];

  services.log.rewriteBacklog(views);
  return { ok: true, view, unblocked, alreadySettled: false };
}

/**
 * Candidates `next_task` will race for before telling the agent there is none.
 *
 * Each settle costs one propagation window when peers are connected, so an
 * uncapped loop over a contended board would block an agent for minutes inside
 * one tool call. Five bounds the worst case to about 1.25 s, and a swarm that
 * loses five races in a row has more agents than work.
 */
export const MAX_NEXT_TASK_ATTEMPTS = 5;

export type NextTaskOutcome =
  | { ok: true; view: TaskView; lease: ClaimView }
  | { ok: false; candidates: number };

/**
 * Select a task, lease it, and confirm the lease — in one call.
 *
 * Selection and leasing are deliberately not two tools. An agent that picks a
 * task and then claims it has a window in which it has decided to do work it
 * does not hold, and every agent in the swarm has the same window at once.
 *
 * The claim goes through `claimTask` and the confirmation through the caller's
 * `settle`, which is the ordinary lease path and not a second one: nothing here
 * knows what a generation is. Losing the settle means a peer already holds the
 * task, so the loop moves on **without releasing anything** — there is nothing
 * of ours to give up, and releasing would hand back the winner's lease.
 */
export async function takeNextTask(
  services: SyncServices,
  options: {
    /** The board, already read — the caller needs it for the empty-state text. */
    views: TaskView[];
    capabilities: ReadonlySet<string>;
    capability?: string;
    ttlMs: number;
    maxAttempts?: number;
  },
  settle: (taskId: string) => Promise<boolean>,
): Promise<NextTaskOutcome> {
  const candidates = selectCandidates(options.views, {
    capabilities: options.capabilities,
    ...(options.capability !== undefined ? { capability: options.capability } : {}),
  });

  for (const candidate of candidates.slice(
    0,
    options.maxAttempts ?? MAX_NEXT_TASK_ATTEMPTS,
  )) {
    const taken = claimTask(
      services,
      candidate.taskId,
      options.ttlMs,
      candidate.title.slice(0, 500),
    );
    if (!taken.ok) continue;
    if (!(await settle(candidate.taskId))) continue;
    const view = viewOf(services, candidate.taskId);
    if (!view) continue;
    return { ok: true, view, lease: taken.view };
  }
  return { ok: false, candidates: candidates.length };
}

/**
 * Announce every open task whose lease lapsed with nothing recorded.
 *
 * Driven by an agent asking the board a question rather than by a timer. A timer
 * would look like a failure detector, and P2PA does not have one — reporting
 * abandonment lazily is the honest shape for a system with no liveness guarantee
 * to offer. `peer` is null because nothing arrived: this is an observation this
 * node made, not something a peer told us.
 */
export function reportAbandoned(
  services: SyncServices,
  tracker: AbandonedTasks,
  views: TaskView[],
): AbandonReport[] {
  const reports = tracker.sweep(views);
  for (const report of reports) {
    services.events?.emit({
      kind: "task_abandoned",
      peer: null,
      taskId: report.taskId,
      holder: report.holder,
      text: report.title,
    });
  }
  return reports;
}

/** Open tasks that name this one as a dependency. */
function openDependents(services: SyncServices, taskId: string): string[] {
  return services.store
    .taskEntries()
    .filter(
      ({ entry }) => entry.status === "open" && (entry.deps ?? []).includes(taskId),
    )
    .map(({ taskId: id }) => id);
}

export interface MessageDelivery {
  id: string | null;
  /** Peers the message reached immediately. */
  deliveredNow: number;
  /** Still queued for peers that were not reachable. */
  queued: boolean;
  /** Correlation id, when the caller asked for a reply. */
  corr?: string;
}

export interface SendOptions {
  /**
   * Single recipient's public key.
   *
   * Omitted broadcasts to everyone paired, which is all v3 could express. Naming
   * one peer is what makes a swarm workable: without it every question an agent
   * asks lands in every other agent's feed, and none of them can tell whether it
   * was meant for them.
   */
  to?: string;
  /** Ties a reply back to the message that prompted it. */
  corr?: string;
  intent?: "tell" | "ask" | "reply";
}

/**
 * Send a message, queuing it first so a disconnect cannot lose it.
 *
 * Queued before it is sent, not after: a message written to a socket that
 * closes mid-flight is exactly the case the outbox exists for, and it is only
 * removed once the recipient says it arrived.
 */
export function sendMessage(
  services: SyncServices,
  text: string,
  recipients: string[] = [],
  options: SendOptions = {},
): MessageDelivery {
  services.log.syncMessage("Local", text);

  const addressing = {
    ...(options.to !== undefined ? { to: options.to } : {}),
    ...(options.corr !== undefined ? { corr: options.corr } : {}),
    ...(options.intent !== undefined ? { intent: options.intent } : {}),
  };

  if (!services.outbox) {
    services.p2p?.broadcast({
      type: "message",
      v: PROTOCOL_VERSION,
      text,
      ...addressing,
    });
    return { id: null, deliveredNow: services.p2p?.connectionCount() ?? 0, queued: false };
  }

  // A directed message is queued for its addressee alone. Queuing it for everyone
  // paired would replay a private exchange to the rest of the swarm the next time
  // they reconnect.
  const audience = options.to !== undefined ? [options.to] : recipients;
  // Addressing is queued with the message, not just sent with it: a question
  // delivered after a reconnect has to still be answerable.
  const message = services.outbox.enqueue(text, audience, addressing);

  const targets =
    options.to !== undefined
      ? (services.p2p?.connectedKeys() ?? []).filter((key) => key === options.to)
      : (services.p2p?.connectedKeys() ?? []);

  let delivered = 0;
  for (const key of targets) {
    const sent = services.p2p?.sendTo(key, {
      type: "message",
      v: PROTOCOL_VERSION,
      text,
      id: message.id,
      ...addressing,
    });
    if (sent === true) delivered += 1;
  }
  return {
    id: message.id,
    deliveredNow: delivered,
    queued: true,
    ...(options.corr !== undefined ? { corr: options.corr } : {}),
  };
}

/** Push everything a peer has not confirmed. Called when it connects. */
export function replayOutbox(
  services: SyncServices,
  publicKeyHex: string,
): number {
  if (!services.outbox || !services.p2p) return 0;
  const pending = services.outbox.pendingFor(publicKeyHex);
  let sent = 0;
  for (const message of pending) {
    const ok = services.p2p.sendTo(publicKeyHex, {
      type: "message",
      v: PROTOCOL_VERSION,
      text: message.text,
      id: message.id,
      // Replayed with the addressing it was queued with, so a question that
      // waited out a disconnect still arrives as a question the peer can answer.
      ...(message.to !== undefined ? { to: message.to } : {}),
      ...(message.corr !== undefined ? { corr: message.corr } : {}),
      ...(message.intent !== undefined ? { intent: message.intent } : {}),
    });
    if (!ok) break;
    sent += 1;
  }
  return sent;
}

/** Confirm delivery so the sender can stop retrying. */
export function handleAck(
  services: SyncServices,
  publicKeyHex: string | null,
  ids: string[],
): number {
  if (!services.outbox || publicKeyHex === null) return 0;
  return services.outbox.ack(publicKeyHex, ids);
}

/**
 * Record an inbound message and confirm it.
 *
 * Replay is at-least-once by design, so the receiver is what makes it look
 * exactly-once: a message whose id has already been handled is acknowledged
 * again but not logged again.
 */
export function receiveMessage(
  services: SyncServices,
  text: string,
  id: string | undefined,
  peer: AuditPeer | undefined,
  senderPublicKey: string | null,
  addressing: { corr?: string; intent?: "tell" | "ask" | "reply" } = {},
): { duplicate: boolean } {
  // Dedupe is scoped to the sender: a shared id space would let one peer
  // pre-claim an id so another peer's real message is dropped as a duplicate.
  const duplicate =
    id !== undefined &&
    senderPublicKey !== null &&
    services.outbox?.isDuplicate(senderPublicKey, id) === true;

  if (!duplicate) {
    services.log.syncMessage("Peer", text, peer);
    services.events?.emit({
      kind: "message",
      peer: peer?.fingerprint ?? null,
      text,
      // Carried through so an agent can answer the question it was asked rather
      // than guessing which of several open threads a reply belongs to.
      ...(addressing.corr !== undefined ? { corr: addressing.corr } : {}),
      ...(addressing.intent !== undefined ? { intent: addressing.intent } : {}),
      ...(senderPublicKey !== null ? { from: senderPublicKey } : {}),
    });
    if (id !== undefined && senderPublicKey !== null) {
      services.outbox?.markSeen(senderPublicKey, id);
    }
  }

  // Acknowledged either way — a duplicate means our previous ack was lost.
  if (id !== undefined && senderPublicKey !== null) {
    services.p2p?.sendTo(senderPublicKey, {
      type: "ack",
      v: PROTOCOL_VERSION,
      ids: [id],
    });
  }
  return { duplicate };
}

/** Record a peer/local message in the Audit Trail and optionally broadcast. */
export function recordMessage(
  services: SyncServices,
  text: string,
  source: Source,
  broadcast: boolean,
  peer?: AuditPeer,
): void {
  services.log.syncMessage(source, text, peer);
  if (source === "Peer") {
    services.events?.emit({
      kind: "message",
      peer: peer?.fingerprint ?? null,
      text,
    });
  }
  if (broadcast && services.p2p) {
    services.p2p.broadcast({ type: "message", v: PROTOCOL_VERSION, text });
  }
}

function broadcastUpdate(services: SyncServices, ops: CrdtOp[]): void {
  if (!services.p2p || ops.length === 0) return;
  services.p2p.broadcast({ type: "update", v: PROTOCOL_VERSION, ops });
}

/** Current view of the document, for callers that only need plain JSON. */
export function activeState(services: SyncServices): ContextState {
  return services.store.snapshot();
}

/**
 * Publish this node's presence card and tell peers.
 *
 * An ordinary local write, so it persists, rides the handshake snapshot, and is
 * bound to this node's identity by the same rule as everything else.
 */
export function announceSelf(
  services: SyncServices,
  card: AgentCard,
): ApplyResult {
  return commitLocalMutation(services, (store) => store.announce(card));
}
