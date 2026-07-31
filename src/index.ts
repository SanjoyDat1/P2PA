#!/usr/bin/env node
/**
 * P2PA — runtime (Phase 5 + living-doc bridge)
 *
 * Modes:
 *   P2PA_DAEMON=1  → background Hyperswarm sync (no MCP); logs → daemon-error.log
 *   otherwise       → foreground MCP + Hyperswarm over real stdin/stdout
 *
 * State lives in ~/.p2pa/shared_context.md (override with P2PA_CONFIG_DIR).
 *
 * Prefer one writer: either the PM2 daemon OR `p2pa mcp`, not both mutating.
 */
import { appendFileSync, createWriteStream, chmodSync } from "node:fs";
import { join } from "node:path";
import type { WriteStream } from "node:fs";
import { resolveRuntimeOptions } from "./daemon-options.js";
import {
  ensureConfigDir,
  getConfigDir,
  getDaemonErrorLogPath,
  readConfig,
  resolveAuthMode,
  resolveRequireSignatures,
} from "./config.js";
import { loadOrCreateIdentity } from "./identity.js";
import { OpSigner } from "./signing.js";
import { createAllowlist } from "./allowlist.js";
import { sanitizeLabel } from "./peer-key.js";
import { ContextStore } from "./store.js";
import { MarkdownLog } from "./markdown-log.js";
import { P2PNode, describePeer, type PeerIdentity } from "./p2p.js";
import { ContentionLog } from "./conflicts.js";
import { EventBus } from "./events.js";
import { acquireLock, releaseLock, STATE_WRITER_LOCK } from "./lock.js";
import { Outbox } from "./outbox.js";
import { createMcpServer, startMcpServer } from "./mcp-server.js";
import {
  applyPeerSnapshot,
  handleAck,
  handleInboundOps,
  receiveMessage,
  replayOutbox,
} from "./sync.js";
import { DocBridge } from "./doc/bridge.js";
import {
  releaseDocBridgeLock,
  tryAcquireDocBridgeLock,
} from "./doc/bridge-lock.js";
import { createGoogleDocsClientFromEnv } from "./doc/google-docs-client.js";
import type { AuditPeer, PeerEnvelope } from "./types.js";

function isDaemonMode(): boolean {
  return process.env["P2PA_DAEMON"] === "1";
}

/**
 * In daemon mode, redirect all diagnostic logging to ~/.p2pa/daemon-error.log
 * so nothing touches stdout/stderr (PM2 and future MCP bridges stay clean).
 */
function installDaemonLogging(): WriteStream {
  ensureConfigDir();
  const logPath = getDaemonErrorLogPath();
  const stream = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  try {
    chmodSync(logPath, 0o600);
  } catch {
    // best-effort
  }

  const write = (...args: unknown[]): void => {
    const line =
      args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ") + "\n";
    try {
      stream.write(line);
    } catch {
      try {
        appendFileSync(logPath, line, "utf8");
      } catch {
        // last resort: swallow — never write to stdout
      }
    }
  };

  console.log = write;
  console.error = write;
  console.warn = write;
  console.info = write;

  return stream;
}

function tryCreateDocBridge(services: {
  store: ContextStore;
  log: MarkdownLog;
  p2p?: P2PNode;
  contention?: ContentionLog;
  events?: EventBus;
  outbox?: Outbox;
}): DocBridge | undefined {
  const config = readConfig();
  const doc = config?.doc;
  if (!doc) return undefined;

  const client = createGoogleDocsClientFromEnv();
  if (!client) {
    console.error(
      "[p2pa:doc] Doc linked but P2PA_GOOGLE_SA_JSON is missing/invalid — bridge disabled",
    );
    return undefined;
  }

  if (!tryAcquireDocBridgeLock()) {
    console.error(
      "[p2pa:doc] Another p2pa process already holds the living-doc poller lock — bridge disabled here",
    );
    return undefined;
  }

  const bridge = new DocBridge({
    documentId: doc.documentId,
    url: doc.url,
    client,
    services,
  });
  bridge.start();
  console.error(`[p2pa:doc] Living doc bridge polling ${doc.url}`);
  return bridge;
}

async function main(): Promise<void> {
  ensureConfigDir();
  const daemon = isDaemonMode();
  let logStream: WriteStream | undefined;
  let docBridge: DocBridge | undefined;

  if (daemon) {
    logStream = installDaemonLogging();
  } else {
    // MCP mode: stdout is JSON-RPC — keep diagnostics on stderr only.
    console.log = (...args: unknown[]) => {
      console.error(...args);
    };
  }

  const options = resolveRuntimeOptions();

  // Two writers each hold a full copy of the document and rewrite it whole, so
  // running both the daemon and `p2pa mcp` silently loses whichever saved
  // first. Fail loudly at startup instead of corrupting quietly.
  const writerLock = acquireLock(STATE_WRITER_LOCK);
  if (!writerLock.acquired) {
    const owner = writerLock.heldBy ? ` (pid ${writerLock.heldBy})` : "";
    console.error(
      `[p2pa] another P2PA process is already writing this context${owner}.\n` +
        "       Run either the background daemon or `p2pa mcp`, not both:\n" +
        "         p2pa stop     # if the daemon is running\n" +
        "       Then start this one again.\n" +
        `       Lock file: ${join(getConfigDir(), "state-writer.lock")}`,
    );
    process.exit(1);
  }
  // A stale lock is detected by pid anyway, but clearing it on exit keeps the
  // next start from having to reason about it.
  process.on("exit", () => {
    releaseLock(STATE_WRITER_LOCK);
  });

  // Identity first: the node's public key seeds the clock that stamps every
  // write, and stamps are what let concurrent edits merge deterministically.
  const identity = loadOrCreateIdentity();

  // The signing key is the identity key: whatever Noise proves at the transport
  // is exactly what signs each operation, so an entry stays attributable to its
  // author after any number of peers relay it. A failure here is not fatal —
  // unsigned entries still merge correctly, they are just not independently
  // verifiable — so it degrades with a warning rather than refusing to start.
  let signer: OpSigner | undefined;
  try {
    signer = new OpSigner(
      identity.keyPair.secretKey.subarray(0, 32),
      identity.publicKeyHex,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[p2pa] could not build a signing key (${message}) — writes will be ` +
        `unsigned and cannot be verified by peers after a relay`,
    );
  }

  const store = new ContextStore(identity.publicKeyHex, Date.now, signer);
  const log = new MarkdownLog(options.contextFile);
  const contention = new ContentionLog();
  const events = new EventBus();
  const outbox = new Outbox(join(getConfigDir(), "outbox.json"));
  log.ensureInitialized();

  const replica = log.readReplicaState();
  if (replica.length > 0) {
    store.load(replica);
    console.error(
      `[p2pa] Markdown log: ${log.path} (restored ${replica.length} stamped key(s), state=${store.stateHash()})`,
    );
  } else {
    // No stamps on disk: either a fresh install or a document written by the
    // retired counter protocol. Re-stamp locally — those documents carry no
    // causal history worth preserving.
    const seeded = store.hydrateLegacy(log.readActiveState());
    console.error(
      `[p2pa] Markdown log: ${log.path} (seeded ${seeded} unstamped key(s), state=${store.stateHash()})`,
    );
  }

  const { mode: authMode, legacy } = resolveAuthMode(readConfig());
  const requireSignatures = resolveRequireSignatures(readConfig());
  const allowlist = createAllowlist();

  console.error(
    `[p2pa] identity ${identity.fingerprint} (${identity.label}) — ` +
      `auth=${authMode}, ${allowlist.size} allowlisted peer(s)`,
  );
  if (authMode === "open") {
    console.error(
      legacy
        ? "[p2pa] WARNING: running in legacy OPEN mode — anyone who learns your " +
            "topic can read and write your shared context. Pair your peers " +
            "(`p2pa pair`) then run `p2pa auth strict`."
        : "[p2pa] WARNING: auth mode is OPEN — anyone who learns your topic can " +
            "read and write your shared context. Run `p2pa auth strict` to lock it down.",
    );
  } else if (allowlist.size === 0) {
    console.error(
      "[p2pa] auth is STRICT and the allowlist is empty — no peer can connect. " +
        "Run `p2pa pair` to exchange invite tokens.",
    );
  }

  if (requireSignatures) {
    console.error(
      "[p2pa] signature enforcement ON — relayed operations without a valid " +
        "signature are refused (protocol v3 peers cannot sync)",
    );
  } else if (allowlist.size > 1) {
    // Only worth raising with three or more nodes: with a single peer there are
    // no third-party entries to relay, so an unsigned relay proves nothing less
    // than the transport already does.
    console.error(
      `[p2pa] ${allowlist.size} peers paired and signature enforcement is OFF — a ` +
        "handshake snapshot relays entries its sender did not author, so any one " +
        "peer can fabricate another's writes. Once every node runs v0.8+, run " +
        "`p2pa auth require-signatures`.",
    );
  }

  // Set by the envelope handler when an inbound op's signature did not verify, and
  // read by the transport immediately afterwards. A flag rather than a throw: the
  // rest of the frame still merges correctly, only the connection has to end.
  //
  // One flag serves every connection because the handler is synchronous — the
  // transport calls it and reads the result in the same tick, with no await in
  // between, so two peers' frames cannot interleave here. If anything on this
  // path ever becomes async, this has to become per-connection state or it will
  // start closing the wrong peer's connection.
  let sawForgery = false;

  const p2p = new P2PNode({
    topic: options.topic,
    keyPair: identity.keyPair,
    authMode,
    isPeerAllowed: (pubkey) => allowlist.isAllowed(pubkey),
    lookupPeer: (pubkey) => allowlist.lookup(pubkey),
    getActiveState: () => store.export(),
    // Advertised in `hello`, so two peers already holding the same document skip
    // the handshake snapshot instead of re-shipping it on every reconnect.
    getDigest: () => ({ state: store.stateHash(), claims: store.claimsHash() }),
    label: identity.label,
    onPeerConnect: (peer: PeerIdentity) => {
      if (peer.pubkey === null) return;
      if (authMode !== "strict" || !allowlist.isAllowed(peer.pubkey)) {
        // Message history is only replayed to a peer we have actually paired
        // with; in open mode any node that learns the topic can connect.
        return;
      }
      const replayed = replayOutbox({ store, log, p2p, outbox }, peer.pubkey);
      if (replayed > 0) {
        console.error(
          `[p2pa:outbox] replayed ${replayed} undelivered message(s) to ${describePeer(peer)}`,
        );
      }
      outbox.prune(allowlist.keys());
    },
    onPeerMessage: (envelope: PeerEnvelope, peer: PeerIdentity) => {
      sawForgery = handlePeerEnvelope(
        { store, log, contention, events, outbox, p2p, requireSignatures },
        envelope,
        peer,
      );
    },
    sawForgery: () => sawForgery,
  });

  allowlist.onChange(() => {
    // A peer removed from the allowlist should lose its live session too, not
    // just be barred from reconnecting.
    const closed = p2p.enforceAllowlist();
    if (closed > 0) {
      console.error(`[p2pa:auth] closed ${closed} revoked peer connection(s)`);
    }
    // And a peer just added should be discovered now rather than on the next
    // 10-minute Hyperswarm refresh tick.
    void p2p.refreshDiscovery();
  });

  await p2p.start();

  docBridge = tryCreateDocBridge({ store, log, p2p, contention, events, outbox });

  if (daemon) {
    console.error(
      `[p2pa] Phase 5 daemon running — topic fingerprint=${p2p.fingerprint} (no MCP stdio)`,
    );
    const shutdown = async (): Promise<void> => {
      try {
        docBridge?.stop();
        releaseDocBridgeLock();
        outbox.flush();
        events.close();
        releaseLock(STATE_WRITER_LOCK);
        allowlist.close();
        await p2p.close();
      } finally {
        releaseLock(STATE_WRITER_LOCK);
        logStream?.end();
        process.exit(0);
      }
    };
    process.on("SIGINT", () => {
      void shutdown();
    });
    process.on("SIGTERM", () => {
      void shutdown();
    });
    return;
  }

  const mcp = createMcpServer({
    store,
    log,
    p2p,
    contention,
    events,
    outbox,
    recipients: () => allowlist.keys(),
    doc: docBridge,
  });
  await startMcpServer(mcp);

  console.error(
    `[p2pa] Phase 5 MCP running — topic fingerprint=${p2p.fingerprint}`,
  );

  const shutdownMcp = async (): Promise<void> => {
    docBridge?.stop();
    releaseDocBridgeLock();
    outbox.flush();
    events.close();
    allowlist.close();
    await p2p.close();
    releaseLock(STATE_WRITER_LOCK);
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdownMcp();
  });
  process.on("SIGTERM", () => {
    void shutdownMcp();
  });
}

function handlePeerEnvelope(
  services: {
    store: ContextStore;
    log: MarkdownLog;
    contention: ContentionLog;
    events: EventBus;
    outbox: Outbox;
    p2p: P2PNode;
    requireSignatures: boolean;
  },
  envelope: PeerEnvelope,
  peer: PeerIdentity,
  /** Returns true when this frame carried an operation with a forged signature. */
): boolean {
  const remoteLabel = describePeer(peer);
  const audit: AuditPeer = {
    fingerprint: peer.fingerprint,
    label: peer.label,
  };

  if (envelope.type === "snapshot") {
    const summary = applyPeerSnapshot(services, envelope.ops, "Peer", audit);
    console.error(
      `[p2pa] peer snapshot from ${remoteLabel}: ${summary.applied} applied, ` +
        `${summary.ignored} already current, ${summary.rejected} refused, ` +
        `state=${services.store.stateHash()}`,
    );
    return summary.forged > 0;
  }

  if (envelope.type === "update") {
    const summary = handleInboundOps(
      services,
      envelope.ops,
      "Peer",
      audit,
      peer.pubkey ?? undefined,
    );
    if (summary.rejected > 0) {
      console.error(
        `[p2pa] refused ${summary.rejected} op(s) from ${remoteLabel}: ` +
          `${summary.rejections.join("; ")}`,
      );
    }
    console.error(
      `[p2pa] peer update from ${remoteLabel}: ${summary.applied} applied, ` +
        `${summary.contended} contended, state=${services.store.stateHash()}`,
    );
    return summary.forged > 0;
  }

  if (envelope.type === "ack") {
    const acked = handleAck(services, peer.pubkey, envelope.ids);
    if (acked > 0) {
      console.error(`[p2pa:outbox] ${remoteLabel} confirmed ${acked} message(s)`);
    }
    return false;
  }

  if (envelope.type === "message") {
    const { duplicate } = receiveMessage(
      services,
      envelope.text,
      envelope.id,
      audit,
      peer.pubkey,
      {
        ...(envelope.corr !== undefined ? { corr: envelope.corr } : {}),
        ...(envelope.intent !== undefined ? { intent: envelope.intent } : {}),
      },
    );
    console.error(
      duplicate
        ? `[p2pa] ignoring replayed message from ${remoteLabel}`
        : `[p2pa] peer ${envelope.intent ?? "message"} from ${remoteLabel} ` +
            `(${envelope.text.length} chars` +
            // Peer-chosen string: sanitized so it cannot forge a log line.
            `${envelope.corr !== undefined ? `, corr=${sanitizeLabel(envelope.corr)}` : ""})`,
    );
    return false;
  }

  // `hello` and `bye` are settled inside the transport, which owns the
  // connection lifecycle; nothing above it needs to see them.
  return false;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  if (isDaemonMode()) {
    try {
      appendFileSync(
        getDaemonErrorLogPath(),
        `[p2pa] fatal: ${message}\n`,
        "utf8",
      );
    } catch {
      // ignore
    }
  } else {
    console.error(`[p2pa] fatal: ${message}`);
  }
  process.exit(1);
});
