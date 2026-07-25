/**
 * Smoke test for concurrent merge (no network).
 * Run: npm run smoke:merge
 *
 * Exercises the property the counter protocol could not provide: two replicas
 * writing at the same time, in either order, end up holding the same document.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { ContentionLog } from "../src/conflicts.js";
import { commitLocalMutation, handleInboundOps } from "../src/sync.js";
import type { SyncServices } from "../src/sync.js";

const LOG_DIR = "./logs/smoke-merge";

function node(name: string, id: string): SyncServices {
  const log = new MarkdownLog(`${LOG_DIR}/${name}.md`);
  log.ensureInitialized();
  return {
    store: new ContextStore(id),
    log,
    contention: new ContentionLog(),
  };
}

function ops(result: ReturnType<typeof commitLocalMutation>) {
  assert(result.ok, "local mutation failed");
  return result.ops;
}

rmSync(LOG_DIR, { recursive: true, force: true });
mkdirSync(LOG_DIR, { recursive: true });

// --- disjoint concurrent writes -------------------------------------------
const a = node("a", "a".repeat(64));
const b = node("b", "b".repeat(64));

const fromA = ops(
  commitLocalMutation(a, (s) => s.setKey("agent_a_task", "refactor auth")),
);
const fromB = ops(
  commitLocalMutation(b, (s) => s.setKey("agent_b_task", "write tests")),
);

handleInboundOps(b, fromA, "Peer");
handleInboundOps(a, fromB, "Peer");

assert.deepEqual(a.store.snapshot(), b.store.snapshot(), "disjoint writes converge");
assert.equal(a.store.stateHash(), b.store.stateHash(), "state hashes agree");
assert.equal(a.contention?.size, 0, "disjoint writes are not contended");
console.error("disjoint concurrent writes converge: PASS");

// --- same-key concurrent writes, delivered in opposite orders -------------
const c = node("c", "c".repeat(64));
const d = node("d", "d".repeat(64));

const fromC = ops(commitLocalMutation(c, (s) => s.setKey("plan", "from C")));
const fromD = ops(commitLocalMutation(d, (s) => s.setKey("plan", "from D")));

handleInboundOps(c, fromD, "Peer");
handleInboundOps(d, fromC, "Peer");

assert.equal(c.store.get("plan"), d.store.get("plan"), "same-key writes agree");
assert.equal(c.store.stateHash(), d.store.stateHash(), "state hashes agree");
console.error(`same-key concurrent writes agree on "${String(c.store.get("plan"))}": PASS`);

// --- set adds from both sides survive -------------------------------------
const e = node("e", "e".repeat(64));
const f = node("f", "f".repeat(64));

const addE = ops(commitLocalMutation(e, (s) => s.addToSet("todo", "task-e")));
const addF = ops(commitLocalMutation(f, (s) => s.addToSet("todo", "task-f")));

handleInboundOps(f, addE, "Peer");
handleInboundOps(e, addF, "Peer");

assert.deepEqual(e.store.get("todo"), f.store.get("todo"), "sets converge");
assert.equal(
  (e.store.get("todo") as unknown[]).length,
  2,
  "concurrent set adds both survive",
);
console.error("concurrent set adds both survive: PASS");

rmSync(LOG_DIR, { recursive: true, force: true });
console.error("\nall merge smoke checks passed");
