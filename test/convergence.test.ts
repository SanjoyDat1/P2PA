/**
 * Convergence under concurrent writes.
 *
 * All shared state is serialized behind a single integer `_version`, and
 * `handleInboundPatch` accepts an inbound patch only when it is the strict
 * successor of the local clock. Two agents that write at the same moment
 * therefore collide even when they touch entirely unrelated keys, and the
 * conflict queue becomes the only path back to a shared view.
 *
 * These tests describe what a multi-writer protocol has to do instead:
 * concurrent edits to disjoint keys merge without operator involvement, and
 * every peer ends up holding the same document. They are marked `todo` because
 * a single global counter cannot express "these two writes do not overlap" —
 * clearing the flags is the exit criteria for the CRDT rewrite (phase 1).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Operation } from "fast-json-patch";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { ConflictQueue } from "../src/conflicts.js";
import {
  commitLocalMutation,
  handleInboundPatch,
  resolveConflict,
  type ApplyPatchResult,
  type SyncServices,
} from "../src/sync.js";

interface Node extends SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  conflicts: ConflictQueue;
  dir: string;
}

function makeNode(name: string): Node {
  const dir = mkdtempSync(join(tmpdir(), `p2pa-converge-${name}-`));
  const log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
  return { store: new ContextStore(), log, conflicts: new ConflictQueue(), dir };
}

/** Unwrap a local mutation, failing the test rather than returning a union. */
function opsOf(result: ApplyPatchResult): Operation[] {
  if (!result.ok) assert.fail(`local mutation failed: ${result.error}`);
  return result.ops;
}

let a: Node;
let b: Node;

beforeEach(() => {
  a = makeNode("a");
  b = makeNode("b");
  // Both peers start from an identical, already-synced document.
  commitLocalMutation(a, (store) => {
    store.setKey("project", "p2pa");
  });
  b.store.replaceAll(a.store.snapshot());
});

afterEach(() => {
  rmSync(a.dir, { recursive: true, force: true });
  rmSync(b.dir, { recursive: true, force: true });
});

describe("concurrent writes to disjoint keys", () => {
  it("applies a strictly sequential peer patch", () => {
    // Control: with one writer at a time the successor rule is satisfied, so
    // this must keep passing after the rewrite.
    const ops = opsOf(
      commitLocalMutation(a, (store) => {
        store.setKey("only_writer", "value");
      }),
    );

    assert.equal(handleInboundPatch(b, ops).status, "applied");
    assert.equal(b.store.get("only_writer"), "value");
  });

  it(
    "does not report a collision when peers edit different keys",
    { todo: "phase 1: per-key merge instead of one global _version" },
    () => {
      const fromA = opsOf(
        commitLocalMutation(a, (store) => {
          store.setKey("agent_a_task", "refactor auth");
        }),
      );
      const fromB = opsOf(
        commitLocalMutation(b, (store) => {
          store.setKey("agent_b_task", "write tests");
        }),
      );

      // Nothing about these two edits actually overlaps.
      assert.equal(handleInboundPatch(b, fromA).status, "applied");
      assert.equal(handleInboundPatch(a, fromB).status, "applied");
    },
  );

  it(
    "converges both peers on the union of concurrent edits",
    { todo: "phase 1: disjoint concurrent writes must merge, not queue" },
    () => {
      const fromA = opsOf(
        commitLocalMutation(a, (store) => {
          store.setKey("agent_a_task", "refactor auth");
        }),
      );
      const fromB = opsOf(
        commitLocalMutation(b, (store) => {
          store.setKey("agent_b_task", "write tests");
        }),
      );

      handleInboundPatch(b, fromA);
      handleInboundPatch(a, fromB);

      // Neither agent's work may be dropped, and both must see the same thing.
      assert.equal(a.store.get("agent_a_task"), "refactor auth");
      assert.equal(a.store.get("agent_b_task"), "write tests");
      assert.deepEqual(a.store.snapshot(), b.store.snapshot());
    },
  );
});

describe("independent conflict resolution", () => {
  it(
    "leaves both peers holding the same state",
    { todo: "phase 1: resolution outcome must be agreed, not chosen per-peer" },
    () => {
      const fromA = opsOf(
        commitLocalMutation(a, (store) => {
          store.setKey("agent_a_task", "refactor auth");
        }),
      );
      const fromB = opsOf(
        commitLocalMutation(b, (store) => {
          store.setKey("agent_b_task", "write tests");
        }),
      );
      handleInboundPatch(b, fromA);
      handleInboundPatch(a, fromB);

      // Each side runs its own LLM and picks independently. Both choices are
      // reasonable in isolation; nothing in the protocol reconciles them.
      const resolvedA = resolveConflict(a, "keep_local");
      const resolvedB = resolveConflict(b, "accept_peer");
      assert.ok(resolvedA.ok, "peer A failed to resolve");
      assert.ok(resolvedB.ok, "peer B failed to resolve");

      // Today both land on _version 3 holding different documents, which no
      // later exchange can detect or repair.
      assert.equal(a.store.getVersion(), b.store.getVersion());
      assert.deepEqual(a.store.snapshot(), b.store.snapshot());
    },
  );
});
