/**
 * Smoke test for work claiming (no network).
 * Run: npm run smoke:claim
 *
 * The scenario the lease exists for: two agents pull from the same task list
 * and must not both do the same job.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { ContentionLog } from "../src/conflicts.js";
import { claimKeyFor } from "../src/claim.js";
import { claimTask, handleInboundOps, releaseTask } from "../src/sync.js";
import type { SyncServices } from "../src/sync.js";
import type { CrdtOp } from "../src/crdt.js";

const LOG_DIR = "./logs/smoke-claim";
rmSync(LOG_DIR, { recursive: true, force: true });
mkdirSync(LOG_DIR, { recursive: true });

/**
 * Two agents on separate machines, whose clocks are close but never identical.
 * A same-millisecond tie is settled by node id, which is deterministic but
 * would starve one agent — so this models the drift real peers actually have.
 */
function agent(
  name: string,
  id: string,
  clock: () => number,
): SyncServices & { name: string } {
  const log = new MarkdownLog(`${LOG_DIR}/${name}.md`);
  log.ensureInitialized();
  return {
    name,
    store: new ContextStore(id.repeat(64), clock),
    log,
    contention: new ContentionLog(),
  };
}
function ops(node: SyncServices, taskId: string): CrdtOp[] {
  const entry = node.store.claim(taskId);
  return entry ? [{ key: claimKeyFor(taskId), entry }] : [];
}
function sync(from: SyncServices, to: SyncServices, taskId: string) {
  handleInboundOps(to, ops(from, taskId), "Peer");
}

let tick = Date.now();
const jitter = () => Math.floor(Math.random() * 20);
const alice = agent("alice", "a", () => tick + jitter());
const bob = agent("bob", "b", () => tick + jitter());
const BACKLOG = ["refactor-auth", "write-tests", "update-docs"];

// Both agents reach for every task at the same moment, each unaware of the
// other — the race the lease exists to settle.
const done: Record<string, string[]> = { alice: [], bob: [] };
for (const task of BACKLOG) {
  tick += 1000;
  claimTask(alice, task, 60_000, `alice working ${task}`);
  claimTask(bob, task, 60_000, `bob working ${task}`);

  // Ops cross in flight.
  sync(alice, bob, task);
  sync(bob, alice, task);

  for (const who of [alice, bob]) {
    if (who.store.holdsClaim(task)) done[who.name]!.push(task);
  }
}

console.error("alice picked up:", done["alice"]);
console.error("bob picked up:  ", done["bob"]);

const overlap = done["alice"]!.filter((t) => done["bob"]!.includes(t));
assert.equal(overlap.length, 0, `both agents took: ${overlap.join(", ")}`);
assert.equal(
  done["alice"]!.length + done["bob"]!.length,
  BACKLOG.length,
  "every task should have been picked up exactly once",
);
console.error("no task was claimed twice: PASS");

// Both replicas agree on every holder.
for (const task of BACKLOG) {
  sync(alice, bob, task);
  sync(bob, alice, task);
  assert.equal(
    alice.store.holder(task),
    bob.store.holder(task),
    `disagreement on ${task}`,
  );
}
console.error("both replicas agree on every holder: PASS");

// Releasing hands work back.
const [firstTask] = BACKLOG;
const holder = alice.store.holdsClaim(firstTask!) ? alice : bob;
const other = holder === alice ? bob : alice;
assert.ok(releaseTask(holder, firstTask!).ok);
sync(holder, other, firstTask!);
assert.equal(other.store.holder(firstTask!), null);
assert.ok(claimTask(other, firstTask!, 60_000).ok, "released task is claimable");
console.error("released task is picked up by the other agent: PASS");

rmSync(LOG_DIR, { recursive: true, force: true });
console.error("\nall claim smoke checks passed");
