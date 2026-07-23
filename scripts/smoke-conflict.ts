/**
 * Phase 4 conflict-resolution smoke (no Hyperswarm / DHT).
 * Run: npm run smoke:conflict
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import type { Operation } from "fast-json-patch";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { ConflictQueue } from "../src/conflicts.js";
import {
  commitLocalMutation,
  handleInboundPatch,
  resolveConflict,
} from "../src/sync.js";
import { VERSION_KEY } from "../src/types.js";

const LOG_DIR = "./logs/smoke-conflict";
const LOG_FILE = `${LOG_DIR}/conflict.md`;

function assert(cond: boolean, label: string): void {
  console.error(`${label}: ${cond ? "PASS" : "FAIL"}`);
  if (!cond) throw new Error(`Assertion failed: ${label}`);
}

async function main(): Promise<void> {
  rmSync(LOG_DIR, { recursive: true, force: true });
  mkdirSync(LOG_DIR, { recursive: true });

  const store = new ContextStore();
  const log = new MarkdownLog(LOG_FILE);
  const conflicts = new ConflictQueue();
  const services = { store, log, conflicts };
  log.ensureInitialized();

  // Local commit bumps _version and includes it in ops
  const push = commitLocalMutation(services, (s) => {
    s.setKey("project", "p2pa");
  });
  assert(push.ok, "local push ok");
  assert(store.getVersion() === 1, "version is 1 after first push");
  assert(
    push.ok &&
      push.ops.some(
        (op) => op.path === `/${VERSION_KEY}` && "value" in op && op.value === 1,
      ),
    "broadcast ops include /_version=1",
  );

  // Stale peer patch (same version) → collision
  const stalePeer: Operation[] = [
    { op: "replace", path: "/project", value: "peer-wins" },
    { op: "replace", path: "/_version", value: 1 },
  ];
  const collision = handleInboundPatch(services, stalePeer);
  assert(collision.status === "collision", "stale patch is collision");
  assert(conflicts.size === 1, "queue has 1 conflict");
  assert(store.get("project") === "p2pa", "local value unchanged after collision");

  const md1 = readFileSync(LOG_FILE, "utf8");
  assert(md1.includes("## Conflicts"), "Conflicts section present");
  assert(md1.includes("[ACTION: COLLISION DETECTED]"), "collision block present");

  // Missing version → collision
  const missingVer = handleInboundPatch(services, [
    { op: "add", path: "/extra", value: true },
  ]);
  assert(missingVer.status === "collision", "missing version is collision");
  assert(conflicts.size === 2, "queue has 2 conflicts");

  // Version gap (jump) → collision
  const gap = handleInboundPatch(services, [
    { op: "add", path: "/jumped", value: true },
    { op: "replace", path: "/_version", value: 99 },
  ]);
  assert(gap.status === "collision", "version jump is collision");

  // Fresh peer patch (version 2) applies while collisions remain queued
  const fresh: Operation[] = [
    { op: "add", path: "/phase", value: 4 },
    { op: "replace", path: "/_version", value: 2 },
  ];
  const applied = handleInboundPatch(services, fresh);
  assert(applied.status === "applied", "fresh patch applied");
  assert(store.getVersion() === 2, "version advanced to 2");
  assert(store.get("phase") === 4, "phase key applied");

  // Drain queue with keep_local (stale, missing-version, jump)
  while (conflicts.size > 0) {
    const r = resolveConflict(services, "keep_local");
    assert(r.ok, "keep_local drain ok");
  }
  assert(conflicts.size === 0, "queue drained");
  assert(store.get("project") === "p2pa", "local project preserved through drain");

  const md2 = readFileSync(LOG_FILE, "utf8");
  assert(!md2.includes("## Conflicts"), "Conflicts section cleared");
  assert(md2.includes("[ACTION: Conflict Resolution]"), "resolution audited");

  // Dedicated accept_peer scenario
  commitLocalMutation(services, (s) => {
    s.setKey("flag", "local");
  });
  const localV = store.getVersion();
  handleInboundPatch(services, [
    { op: "replace", path: "/flag", value: "from-peer" },
    { op: "replace", path: "/_version", value: localV },
  ]);
  assert(conflicts.size === 1, "accept_peer scenario queued");
  const accept = resolveConflict(services, "accept_peer");
  assert(accept.ok, "accept_peer resolve ok");
  assert(store.get("flag") === "from-peer", "accept_peer applied peer ops");
  assert(conflicts.size === 0, "queue empty after accept_peer");

  // custom_merge
  commitLocalMutation(services, (s) => {
    s.setKey("project", "local-again");
  });
  handleInboundPatch(services, [
    { op: "replace", path: "/project", value: "peer-again" },
    { op: "replace", path: "/_version", value: store.getVersion() },
  ]);
  assert(conflicts.size === 1, "new collision queued");
  const custom = resolveConflict(
    services,
    "custom_merge",
    JSON.stringify({ project: "merged-by-llm" }),
  );
  assert(custom.ok, "custom_merge ok");
  assert(store.get("project") === "merged-by-llm", "custom merge value applied");
  assert(conflicts.size === 0, "queue empty after custom_merge");

  console.error("smoke-conflict: all Phase 4 checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
