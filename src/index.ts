#!/usr/bin/env node
/**
 * P2PA — runtime (Phase 5)
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
} from "./config.js";
import { ContextStore } from "./store.js";
import { MarkdownLog } from "./markdown-log.js";
import { P2PNode } from "./p2p.js";
import { ConflictQueue } from "./conflicts.js";
import { createMcpServer, startMcpServer } from "./mcp-server.js";
import {
  applyPeerSnapshot,
  handleInboundPatch,
  recordMessage,
} from "./sync.js";
import type { PeerEnvelope } from "./types.js";

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

async function main(): Promise<void> {
  ensureConfigDir();
  const daemon = isDaemonMode();
  let logStream: WriteStream | undefined;

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

  const p2p = new P2PNode({
    topic: options.topic,
    getActiveState: () => store.snapshot(),
    onPeerMessage: (envelope: PeerEnvelope, remoteLabel: string) => {
      handlePeerEnvelope({ store, log, conflicts }, envelope, remoteLabel);
    },
  });
  await p2p.start();

  if (daemon) {
    console.error(
      `[p2pa] Phase 5 daemon running — topic fingerprint=${p2p.fingerprint} (no MCP stdio)`,
    );
    // Keep the process alive for Hyperswarm; PM2 manages lifecycle.
    const shutdown = async (): Promise<void> => {
      try {
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

  const mcp = createMcpServer({ store, log, p2p, conflicts });
  await startMcpServer(mcp);

  console.error(
    `[p2pa] Phase 5 MCP running — topic fingerprint=${p2p.fingerprint}`,
  );
}

function handlePeerEnvelope(
  services: {
    store: ContextStore;
    log: MarkdownLog;
    conflicts: ConflictQueue;
  },
  envelope: PeerEnvelope,
  remoteLabel: string,
): void {
  if (envelope.type === "snapshot") {
    const result = applyPeerSnapshot(services, envelope.state, "Peer");
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
    const result = handleInboundPatch(services, envelope.ops);
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

  recordMessage(services, envelope.text, "Peer", false);
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
