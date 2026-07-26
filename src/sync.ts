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
  type JsonValue,
  type Source,
} from "./types.js";
import { nodeIdFromPublicKey } from "./hlc.js";
import type { EventBus } from "./events.js";
import type { Outbox } from "./outbox.js";
import {
  describeClaim,
  isClaimKey,
  taskIdFromKey,
  type ClaimEntry,
  type ClaimView,
} from "./claim.js";

export interface SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  p2p?: P2PNode;
  contention?: ContentionLog;
  /** Wakes agents blocked on peer activity. Absent in tests that do not need it. */
  events?: EventBus;
  /** Holds messages until the recipient confirms them. */
  outbox?: Outbox;
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
        applied: 0,
        ignored: 0,
        contended: 0,
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
      applied: 0,
      ignored: 0,
      contended: 0,
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
    return { applied: 0, ignored: 0, contended: 0, rejected: 0, rejections: [] };
  }

  // A snapshot legitimately relays stamps authored by third parties, so its
  // entries cannot be bound to the sender the way a direct update's are. What
  // it may never carry is *our own* node id: that is not relaying, it is a peer
  // writing as us — which would sail past the contention check (the stamp looks
  // locally authored) and leave no record that anything was overwritten.
  const impersonating = ops.filter(
    (op) => op?.entry?.hlc?.n === services.store.nodeId,
  );
  const relayed = ops.filter((op) => op?.entry?.hlc?.n !== services.store.nodeId);

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
  const summary: InboundSummary = {
    applied: 0,
    ignored: 0,
    contended: 0,
    rejected: 0,
    rejections: [],
  };
  const touched: string[] = [];
  const refused: string[] = [];

  for (const result of results) {
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

  const stateKeys = touched.filter((key) => !isClaimKey(key));
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

export interface MessageDelivery {
  id: string | null;
  /** Peers the message reached immediately. */
  deliveredNow: number;
  /** Still queued for peers that were not reachable. */
  queued: boolean;
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
): MessageDelivery {
  services.log.syncMessage("Local", text);

  if (!services.outbox) {
    services.p2p?.broadcast({ type: "message", v: PROTOCOL_VERSION, text });
    return { id: null, deliveredNow: services.p2p?.connectionCount() ?? 0, queued: false };
  }

  // Addressed to whoever is paired now, so a peer added later does not receive
  // a backlog of conversation it was never part of.
  const message = services.outbox.enqueue(text, recipients);
  let delivered = 0;
  for (const key of services.p2p?.connectedKeys() ?? []) {
    const sent = services.p2p?.sendTo(key, {
      type: "message",
      v: PROTOCOL_VERSION,
      text,
      id: message.id,
    });
    if (sent === true) delivered += 1;
  }
  return { id: message.id, deliveredNow: delivered, queued: true };
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
