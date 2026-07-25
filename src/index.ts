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
import type { WriteStream } from "node:fs";
import { resolveRuntimeOptions } from "./daemon-options.js";
import {
  ensureConfigDir,
  getDaemonErrorLogPath,
  readConfig,
  resolveAuthMode,
} from "./config.js";
import { loadOrCreateIdentity } from "./identity.js";
import { createAllowlist } from "./allowlist.js";
import { ContextStore } from "./store.js";
import { MarkdownLog } from "./markdown-log.js";
import { P2PNode, describePeer, type PeerIdentity } from "./p2p.js";
import { ConflictQueue } from "./conflicts.js";
import { createMcpServer, startMcpServer } from "./mcp-server.js";
import {
  applyPeerSnapshot,
  handleInboundPatch,
  recordMessage,
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
  conflicts?: ConflictQueue;
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

  const store = new ContextStore();
  const log = new MarkdownLog(options.contextFile);
  const conflicts = new ConflictQueue();
  log.ensureInitialized();

  const hydrated = log.readActiveState();
  store.replaceAll(hydrated);
  console.error(
    `[p2pa] Markdown log: ${log.path} (hydrated ${Object.keys(hydrated).length} key(s), _version=${store.getVersion()})`,
  );

  const identity = loadOrCreateIdentity();
  const { mode: authMode, legacy } = resolveAuthMode(readConfig());
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

  const p2p = new P2PNode({
    topic: options.topic,
    keyPair: identity.keyPair,
    authMode,
    isPeerAllowed: (pubkey) => allowlist.isAllowed(pubkey),
    lookupPeer: (pubkey) => allowlist.lookup(pubkey),
    getActiveState: () => store.snapshot(),
    onPeerMessage: (envelope: PeerEnvelope, peer: PeerIdentity) => {
      handlePeerEnvelope({ store, log, conflicts }, envelope, peer);
    },
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

  docBridge = tryCreateDocBridge({ store, log, p2p, conflicts });

  if (daemon) {
    console.error(
      `[p2pa] Phase 5 daemon running — topic fingerprint=${p2p.fingerprint} (no MCP stdio)`,
    );
    const shutdown = async (): Promise<void> => {
      try {
        docBridge?.stop();
        releaseDocBridgeLock();
        allowlist.close();
        await p2p.close();
      } finally {
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
    conflicts,
    doc: docBridge,
  });
  await startMcpServer(mcp);

  console.error(
    `[p2pa] Phase 5 MCP running — topic fingerprint=${p2p.fingerprint}`,
  );

  const shutdownMcp = async (): Promise<void> => {
    docBridge?.stop();
    releaseDocBridgeLock();
    allowlist.close();
    await p2p.close();
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
    conflicts: ConflictQueue;
  },
  envelope: PeerEnvelope,
  peer: PeerIdentity,
): void {
  const remoteLabel = describePeer(peer);
  const audit: AuditPeer = {
    fingerprint: peer.fingerprint,
    label: peer.label,
  };

  if (envelope.type === "snapshot") {
    const result = applyPeerSnapshot(services, envelope.state, "Peer", audit);
    if (!result.ok) {
      console.error(
        `[p2pa] rejected peer snapshot from ${remoteLabel}: ${result.error}`,
      );
      return;
    }
    console.error(
      `[p2pa] peer snapshot from ${remoteLabel}: ${Object.keys(result.state).length} key(s), _version=${services.store.getVersion()}`,
    );
    return;
  }

  if (envelope.type === "patch") {
    const result = handleInboundPatch(services, envelope.ops, audit);
    if (result.status === "collision") {
      console.error(
        `[p2pa] queued collision ${result.conflictId} from ${remoteLabel}`,
      );
      return;
    }
    if (result.status === "rejected") {
      console.error(
        `[p2pa] rejected peer patch from ${remoteLabel}: ${result.error}`,
      );
      return;
    }
    console.error(
      `[p2pa] peer patch from ${remoteLabel}: ${result.ops.length} op(s), _version=${services.store.getVersion()}`,
    );
    return;
  }

  recordMessage(services, envelope.text, "Peer", false, audit);
  console.error(
    `[p2pa] peer message from ${remoteLabel} (${envelope.text.length} chars)`,
  );
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
