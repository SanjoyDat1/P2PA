import jsonpatch from "fast-json-patch";
import type { Operation } from "fast-json-patch";
import type { ContextStore } from "./store.js";
import type { MarkdownLog } from "./markdown-log.js";
import type { P2PNode } from "./p2p.js";
import type { ConflictQueue } from "./conflicts.js";
import type {
  AuditPeer,
  ContextState,
  MergeStrategy,
  Source,
} from "./types.js";
import {
  JsonPatchArraySchema,
  MAX_PAYLOAD_BYTES,
  PeerEnvelopeSchema,
  VERSION_KEY,
  extractPatchVersion,
  isReservedKey,
  readLocalVersion,
  stripVersionOps,
  toJsonValue,
} from "./types.js";

const { compare, deepClone } = jsonpatch;

export interface SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  p2p?: P2PNode;
  conflicts?: ConflictQueue;
}

export type ApplyPatchResult =
  | { ok: true; ops: Operation[] }
  | { ok: false; error: string };

export type ApplySnapshotResult =
  | { ok: true; state: ContextState }
  | { ok: false; error: string };

export type InboundPatchResult =
  | { status: "applied"; ops: Operation[] }
  | { status: "collision"; conflictId: string; localVersion: number; peerVersion: number | null }
  | { status: "rejected"; error: string };

export type ResolveResult =
  | { ok: true; strategy: MergeStrategy; conflictId: string; ops: Operation[] }
  | { ok: false; error: string };

/**
 * Local mutation path: run `mutate`, bump `_version` only if state changed,
 * audit, and broadcast.
 */
export function commitLocalMutation(
  services: SyncServices,
  mutate: (store: ContextStore) => void,
): ApplyPatchResult {
  const before = services.store.snapshot();
  try {
    mutate(services.store);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  const mid = services.store.snapshot();
  const provisional = compare(before, mid) as Operation[];
  if (provisional.length === 0) {
    return { ok: true, ops: [] };
  }

  const nextVersion = services.store.getVersion() + 1;
  services.store.setVersion(nextVersion);
  const after = services.store.snapshot();
  const ops = compare(before, after) as Operation[];

  const serialized = JSON.stringify(ops);
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    services.store.replaceAll(before);
    return {
      ok: false,
      error: `Patch exceeds max size of ${MAX_PAYLOAD_BYTES} bytes`,
    };
  }

  services.log.syncStatePatch("Local", ops, after);
  if (services.p2p) {
    services.p2p.broadcast({ type: "patch", ops });
  }
  return { ok: true, ops };
}

/**
 * Apply a validated RFC 6902 patch without auto-bumping `_version`
 * (used for peer applies where the patch already carries version).
 */
export function applyStatePatch(
  services: SyncServices,
  ops: Operation[],
  source: Source,
  broadcast: boolean,
  peer?: AuditPeer,
): ApplyPatchResult {
  const parsed = JsonPatchArraySchema.safeParse(ops);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }

  const validated = parsed.data;
  const serialized = JSON.stringify(validated);
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      error: `Patch exceeds max size of ${MAX_PAYLOAD_BYTES} bytes`,
    };
  }

  try {
    services.store.applyOps(validated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `applyPatch failed: ${message}` };
  }

  services.log.syncStatePatch(source, validated, services.store.snapshot(), peer);

  if (broadcast && services.p2p) {
    services.p2p.broadcast({ type: "patch", ops: validated });
  }

  return { ok: true, ops: validated };
}

/**
 * Inbound peer patch with collision detection against local `_version`.
 */
export function handleInboundPatch(
  services: SyncServices,
  ops: Operation[],
  peer?: AuditPeer,
): InboundPatchResult {
  const parsed = JsonPatchArraySchema.safeParse(ops);
  if (!parsed.success) {
    return { status: "rejected", error: parsed.error.message };
  }

  const validated = parsed.data;
  const peerVersion = extractPatchVersion(validated);
  const localVersion = services.store.getVersion();

  // Strict successor only — equal/lower OR gaps → collision queue.
  const isCollision =
    peerVersion === null ||
    peerVersion <= localVersion ||
    peerVersion > localVersion + 1;

  if (isCollision) {
    if (!services.conflicts) {
      return {
        status: "rejected",
        error: "collision detected but conflict queue is unavailable",
      };
    }

    const item = services.conflicts.enqueue({
      peerOps: validated,
      peerVersion,
      localState: services.store.snapshot(),
      localVersion,
    });

    if (!item) {
      console.error(
        `[p2pa] COLLISION at local v=${localVersion} peer v=${peerVersion ?? "missing"} — queue full, dropping`,
      );
      return {
        status: "rejected",
        error: "conflict queue is full",
      };
    }

    console.error(
      `[p2pa] COLLISION DETECTED at version ${localVersion} (peer attempted ${peerVersion ?? "missing"}) id=${item.id}`,
    );

    services.conflicts.syncMarkdown(services.log);
    services.log.syncMarkdownLog({
      source: "Peer",
      peer,
      action: "Collision Detected",
      localVersion,
      peerVersion,
      conflictId: item.id,
    });

    return {
      status: "collision",
      conflictId: item.id,
      localVersion,
      peerVersion,
    };
  }

  const beforeApply = services.store.snapshot();
  const applied = applyStatePatch(services, validated, "Peer", false, peer);
  if (!applied.ok) {
    return { status: "rejected", error: applied.error };
  }

  // Post-condition: peer may not smuggle a different clock past the gate.
  if (services.store.getVersion() !== localVersion + 1) {
    services.store.replaceAll(beforeApply);
    return {
      status: "rejected",
      error: "peer patch altered _version inconsistently; rolled back",
    };
  }

  return { status: "applied", ops: applied.ops };
}

/**
 * Resolve the oldest queued conflict via LLM-chosen strategy.
 */
export function resolveConflict(
  services: SyncServices,
  strategy: MergeStrategy,
  customStateRaw?: string,
): ResolveResult {
  if (!services.conflicts) {
    return { ok: false, error: "conflict queue is unavailable" };
  }

  const item = services.conflicts.shift();
  if (!item) {
    return { ok: false, error: "No conflicts in queue." };
  }

  const before = services.store.snapshot();
  let detail: string;

  try {
    const baseVersion =
      typeof before[VERSION_KEY] === "number"
        ? (before[VERSION_KEY] as number)
        : 0;

    if (strategy === "accept_peer") {
      const peerOps = stripVersionOps(item.peerOps);
      if (peerOps.length > 0) {
        services.store.applyOps(peerOps);
      }
      services.store.setVersion(baseVersion + 1);
      detail = `Accepted peer patch (${peerOps.length} op(s)); version → ${services.store.getVersion()}`;
    } else if (strategy === "keep_local") {
      services.store.setVersion(baseVersion + 1);
      detail = `Kept local state; version → ${services.store.getVersion()}`;
    } else {
      // custom_merge
      if (customStateRaw === undefined || customStateRaw.trim().length === 0) {
        services.conflicts.requeue(item);
        services.conflicts.syncMarkdown(services.log);
        return {
          ok: false,
          error: "custom_merge requires custom_state (JSON object string)",
        };
      }
      if (customStateRaw.length > MAX_PAYLOAD_BYTES) {
        services.conflicts.requeue(item);
        services.conflicts.syncMarkdown(services.log);
        return { ok: false, error: "custom_state exceeds max payload size" };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(customStateRaw);
      } catch {
        services.conflicts.requeue(item);
        services.conflicts.syncMarkdown(services.log);
        return { ok: false, error: "custom_state is not valid JSON" };
      }

      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        services.conflicts.requeue(item);
        services.conflicts.syncMarkdown(services.log);
        return { ok: false, error: "custom_state must be a JSON object" };
      }

      const merged = deepClone(before) as ContextState;
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (isReservedKey(key) || key === VERSION_KEY) continue;
        merged[key] = toJsonValue(value);
      }
      merged[VERSION_KEY] = baseVersion + 1;
      services.store.replaceAll(merged);
      detail = `Custom merge applied; version → ${baseVersion + 1}`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    services.conflicts.requeue(item);
    services.conflicts.syncMarkdown(services.log);
    return { ok: false, error: message };
  }

  const after = services.store.snapshot();
  const ops = compare(before, after) as Operation[];

  services.log.syncMarkdownLog(
    {
      source: "Local",
      action: "Conflict Resolution",
      strategy,
      conflictId: item.id,
      detail,
    },
    after,
  );

  // Also emit a State Patch audit when there are ops to broadcast.
  if (ops.length > 0) {
    services.log.syncStatePatch("Local", ops, after);
    if (services.p2p) {
      services.p2p.broadcast({ type: "patch", ops });
    }
  }

  services.conflicts.syncMarkdown(services.log);
  return { ok: true, strategy, conflictId: item.id, ops };
}

/**
 * Replace local shared state from a peer handshake snapshot.
 * Never rebroadcasts. Empty snapshots do not wipe non-empty local state.
 */
export function applyPeerSnapshot(
  services: SyncServices,
  state: ContextState,
  source: Source,
  peer?: AuditPeer,
): ApplySnapshotResult {
  const parsed = PeerEnvelopeSchema.safeParse({ type: "snapshot", state });
  if (!parsed.success || parsed.data.type !== "snapshot") {
    return {
      ok: false,
      error: parsed.success ? "invalid snapshot" : parsed.error.message,
    };
  }

  const clean: ContextState = {};
  for (const [key, value] of Object.entries(parsed.data.state)) {
    if (isReservedKey(key)) continue;
    clean[key] = value;
  }

  const peerVersion = readLocalVersion(clean);
  const localVersion = services.store.getVersion();
  if (peerVersion < localVersion) {
    return {
      ok: false,
      error: `refusing snapshot clock downgrade (peer v=${peerVersion} < local v=${localVersion})`,
    };
  }

  const incomingEmpty =
    Object.keys(clean).filter((k) => k !== VERSION_KEY).length === 0;
  const localKeys = Object.keys(services.store.snapshot()).filter(
    (k) => k !== VERSION_KEY,
  ).length;
  if (incomingEmpty && localKeys > 0) {
    return {
      ok: false,
      error: "refusing empty snapshot overwrite of non-empty local state",
    };
  }

  services.store.replaceAll(clean);
  services.log.syncSnapshot(source, services.store.snapshot(), peer);
  return { ok: true, state: services.store.snapshot() };
}

/**
 * Record a peer/local message in the Audit Trail and optionally broadcast.
 */
export function recordMessage(
  services: SyncServices,
  text: string,
  source: Source,
  broadcast: boolean,
  peer?: AuditPeer,
): void {
  services.log.syncMessage(source, text, peer);
  if (broadcast && services.p2p) {
    services.p2p.broadcast({ type: "message", text });
  }
}
