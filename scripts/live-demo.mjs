/**
 * Live two-peer demo — run from repo root:
 *   node scripts/live-demo.mjs
 */
import { ContextStore } from "../dist/store.js";
import { MarkdownLog } from "../dist/markdown-log.js";
import { P2PNode, describePeer } from "../dist/p2p.js";
import { ContentionLog } from "../dist/conflicts.js";
import {
  commitLocalMutation,
  handleInboundOps,
  recordMessage,
  applyPeerSnapshot,
} from "../dist/sync.js";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const topic = "p2pa-live-demo";
const dirA = join(homedir(), ".p2pa-demo-a");
const dirB = join(homedir(), ".p2pa-demo-b");
mkdirSync(dirA, { recursive: true });
mkdirSync(dirB, { recursive: true });
const pathA = join(dirA, "shared_context.md");
const pathB = join(dirB, "shared_context.md");

function handle(store, log, contention) {
  return (envelope, peer) => {
    const audit = { fingerprint: peer.fingerprint, label: peer.label };
    if (envelope.type === "snapshot") {
      applyPeerSnapshot({ store, log, contention }, envelope.ops, "Peer", audit);
    } else if (envelope.type === "update") {
      handleInboundOps({ store, log, contention }, envelope.ops, "Peer", audit);
    } else {
      recordMessage({ store, log, contention }, envelope.text, "Peer", false, audit);
    }
    console.error(`[demo] received ${envelope.type} from ${describePeer(peer)}`);
  };
}

const storeA = new ContextStore();
const storeB = new ContextStore();
const logA = new MarkdownLog(pathA);
const logB = new MarkdownLog(pathB);
const contentionA = new ContentionLog();
const contentionB = new ContentionLog();
logA.ensureInitialized();
logB.ensureInitialized();

// Both peers live in this process, so there is nobody to allowlist — `open`
// keeps the demo about sync. Real deployments default to `strict`; see
// `p2pa pair` and the Peer authentication section of the README.
const a = new P2PNode({
  topic,
  authMode: "open",
  getActiveState: () => storeA.export(),
  onPeerMessage: handle(storeA, logA, contentionA),
});
const b = new P2PNode({
  topic,
  authMode: "open",
  getActiveState: () => storeB.export(),
  onPeerMessage: handle(storeB, logB, contentionB),
});

await a.start();
await b.start();

const deadline = Date.now() + 25000;
while (a.connectionCount() === 0 || b.connectionCount() === 0) {
  if (Date.now() > deadline) throw new Error("peers did not connect in time");
  await new Promise((r) => setTimeout(r, 200));
}
console.error("[demo] ✓ peers connected over Hyperswarm");
await new Promise((r) => setTimeout(r, 500));

console.error("[demo] Agent A pushes project + note ...");
commitLocalMutation(
  { store: storeA, log: logA, p2p: a, contention: contentionA },
  (s) => {
    return [
      s.setKey("project", "P2PA"),
      s.setKey("note", "hello from machine A"),
    ];
  },
);
await new Promise((r) => setTimeout(r, 1000));

console.error("[demo] Agent B sends a peer message ...");
recordMessage(
  { store: storeB, log: logB, p2p: b, contention: contentionB },
  "Hey A — I see your context!",
  "Local",
  true,
);
await new Promise((r) => setTimeout(r, 1000));

console.error("[demo] Agent B sets status=synced ...");
commitLocalMutation(
  { store: storeB, log: logB, p2p: b, contention: contentionB },
  (s) => {
    return s.setKey("status", "synced");
  },
);
await new Promise((r) => setTimeout(r, 1000));

console.error("\n=== IN-MEMORY STATE (should match) ===");
console.error("A:", JSON.stringify(storeA.snapshot(), null, 2));
console.error("B:", JSON.stringify(storeB.snapshot(), null, 2));
console.error("\nOpen these two files side-by-side in your IDE:");
console.error(" ", pathA);
console.error(" ", pathB);

await Promise.allSettled([a.close(), b.close()]);
console.error("\n[demo] done");
