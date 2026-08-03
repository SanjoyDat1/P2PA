/**
 * Smoke test for Phase 3: Hyperswarm topic discovery + NDJSON sync (no MCP).
 * Run: npm run smoke
 *
 * Note: uses real Hyperswarm DHT / local discovery. May take several seconds.
 * UDP-restricted environments can time out.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { P2PNode } from "../src/p2p.js";
import {
  applyPeerSnapshot,
  commitLocalMutation,
  handleInboundOps,
  recordMessage,
} from "../src/sync.js";
import { generateTopicCode } from "../src/topic.js";
import type { PeerEnvelope } from "../src/types.js";

const LOG_DIR = "./logs/smoke";
const LOG_A = `${LOG_DIR}/a.md`;
const LOG_B = `${LOG_DIR}/b.md`;
const CONNECT_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${label}`);
    }
    await sleep(200);
  }
}

async function main(): Promise<void> {
  rmSync(LOG_DIR, { recursive: true, force: true });
  mkdirSync(LOG_DIR, { recursive: true });

  const topic = `p2pa-smoke-${generateTopicCode(8)}`;
  console.error(`[smoke] topic=${topic}`);

  const storeA = new ContextStore();
  const storeB = new ContextStore();
  const logA = new MarkdownLog(LOG_A);
  const logB = new MarkdownLog(LOG_B);
  logA.ensureInitialized();
  logB.ensureInitialized();

  const handle =
    (store: ContextStore, log: MarkdownLog) =>
    (envelope: PeerEnvelope): void => {
      if (envelope.type === "snapshot") {
        applyPeerSnapshot({ store, log }, envelope.ops, "Peer");
      } else if (envelope.type === "update") {
        handleInboundOps({ store, log }, envelope.ops, "Peer");
      } else if (envelope.type === "message") {
        recordMessage({ store, log }, envelope.text, "Peer", false);
      }
    };

  // This smoke test covers the transport, not authentication — `open` keeps it
  // focused on sync behaviour. Peer authentication has its own suite in
  // test/firewall.test.ts, which runs against a local DHT testnet.
  const nodeA = new P2PNode({
    topic,
    authMode: "open",
    getActiveState: () => storeA.export(),
    onPeerMessage: handle(storeA, logA),
  });
  const nodeB = new P2PNode({
    topic,
    authMode: "open",
    getActiveState: () => storeB.export(),
    onPeerMessage: handle(storeB, logB),
  });

  await nodeA.start();
  await nodeB.start();

  await waitFor(
    () => nodeA.connectionCount() > 0 && nodeB.connectionCount() > 0,
    CONNECT_TIMEOUT_MS,
    "Hyperswarm peer connection",
  );
  console.error("[smoke] peers connected");
  await sleep(400); // allow handshake snapshots to settle

  // A pushes nested context; the op carries its own stamp.
  commitLocalMutation({ store: storeA, log: logA, p2p: nodeA }, (store) =>
    store.setKey("project", { name: "p2pa", phase: 3 }),
  );
  await waitFor(
    () => storeB.get("project") !== undefined,
    10_000,
    "update sync to B",
  );

  // B sends a peer message
  recordMessage(
    { store: storeB, log: logB, p2p: nodeB },
    "hello from B",
    "Local",
    true,
  );
  await sleep(500);

  // B updates the same key. Both replicas agree because the newer stamp wins
  // everywhere, not because B happened to go second.
  const project = storeB.get("project");
  if (typeof project !== "object" || project === null || Array.isArray(project)) {
    throw new Error("expected project object on B");
  }
  commitLocalMutation({ store: storeB, log: logB, p2p: nodeB }, (store) =>
    store.setKey("project", { ...project, phase: 3, ready: true }),
  );
  await waitFor(
    () => {
      const p = storeA.get("project");
      return (
        typeof p === "object" &&
        p !== null &&
        !Array.isArray(p) &&
        (p as { ready?: unknown }).ready === true
      );
    },
    10_000,
    "ready:true sync to A",
  );

  const textA = readFileSync(LOG_A, "utf8");
  const textB = readFileSync(LOG_B, "utf8");
  const snapA = JSON.stringify(storeA.snapshot());
  const snapB = JSON.stringify(storeB.snapshot());

  const checks: Array<[string, boolean]> = [
    ["store A/B equal", snapA === snapB],
    ["A Active State has project", textA.includes('"name": "p2pa"')],
    ["B Active State has project", textB.includes('"name": "p2pa"')],
    ["A has Active State section", textA.includes("## Active State")],
    ["A has Audit Trail section", textA.includes("## Audit Trail")],
    [
      // "State Patch" was the counter protocol's action name and has not been
      // emitted since the CRDT rewrite, so this check could never pass — it
      // reported FAIL on every run while the behaviour it describes worked.
      // The attribution suffix also changed: peer entries now carry the
      // fingerprint, so `[SOURCE: Peer ...]` no longer ends at `Peer]`.
      "B recorded a peer state update",
      textB.includes("[SOURCE: Peer") && textB.includes("[ACTION: State Update]"),
    ],
    [
      "A has Peer Message",
      textA.includes("[SOURCE: Peer]") && textA.includes("hello from B"),
    ],
    ["A received ready:true via patch", textA.includes('"ready": true')],
  ];

  // Fence-break / heading regressions (local Markdown only)
  const fenceLog = new MarkdownLog(`${LOG_DIR}/fence.md`);
  fenceLog.ensureInitialized();
  const fenceStore = new ContextStore();
  commitLocalMutation({ store: fenceStore, log: fenceLog }, (store) =>
    store.setKey("note", "before ```json evil after"),
  );
  const rehydrated = fenceLog.readActiveState();
  checks.push([
    "Active State survives ``` in values",
    rehydrated.note === "before ```json evil after",
  ]);

  const headingLog = new MarkdownLog(`${LOG_DIR}/heading.md`);
  headingLog.ensureInitialized();
  const headingStore = new ContextStore();
  commitLocalMutation({ store: headingStore, log: headingLog }, (store) =>
    store.setKey("doc", "see ## Audit Trail below"),
  );
  const headingHydrated = headingLog.readActiveState();
  checks.push([
    "Active State survives ## Audit Trail in values",
    headingHydrated.doc === "see ## Audit Trail below",
  ]);

  let failed = false;
  for (const [label, ok] of checks) {
    console.error(`${label}: ${ok ? "PASS" : "FAIL"}`);
    if (!ok) failed = true;
  }

  await Promise.allSettled([nodeB.close(), nodeA.close()]);

  if (failed) process.exit(1);
  console.error("smoke-p2p: all Phase 3 checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
