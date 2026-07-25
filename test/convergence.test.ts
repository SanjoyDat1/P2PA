/**
 * Convergence under concurrent writes.
 *
 * Written against the retired counter protocol, where a single global
 * `_version` plus a strict-successor rule meant two agents writing at the same
 * moment collided even when their keys did not overlap, and each side then
 * resolved independently — so two peers could settle on the same version number
 * holding different documents with no way to notice.
 *
 * Each key now carries its own HLC stamp. Disjoint writes merge because they
 * never touch the same register; same-key writes resolve by stamp order, which
 * every replica computes identically without coordinating.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CrdtOp } from "../src/crdt.js";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { ContentionLog } from "../src/conflicts.js";
import {
  commitLocalMutation,
  handleInboundOps,
  overrideKeys,
  type ApplyResult,
  type SyncServices,
} from "../src/sync.js";

interface Node extends SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  contention: ContentionLog;
  dir: string;
}

/** Distinct node ids, so stamp tiebreaks are meaningful and deterministic. */
function makeNode(name: string, idChar: string, now?: () => number): Node {
  const dir = mkdtempSync(join(tmpdir(), `p2pa-converge-${name}-`));
  const log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
  return {
    store: new ContextStore(idChar.repeat(64), now),
    log,
    contention: new ContentionLog(),
    dir,
  };
}

function opsOf(result: ApplyResult): CrdtOp[] {
  if (!result.ok) assert.fail(`local mutation failed: ${result.error}`);
  return result.ops;
}

let a: Node;
let b: Node;

beforeEach(() => {
  a = makeNode("a", "a");
  b = makeNode("b", "b");
  // Both peers start from an identical, already-synced document.
  const seed = opsOf(
    commitLocalMutation(a, (store) => store.setKey("project", "p2pa")),
  );
  handleInboundOps(b, seed, "Peer");
});

afterEach(() => {
  rmSync(a.dir, { recursive: true, force: true });
  rmSync(b.dir, { recursive: true, force: true });
});

describe("concurrent writes to disjoint keys", () => {
  it("applies a strictly sequential peer update", () => {
    const ops = opsOf(
      commitLocalMutation(a, (store) => store.setKey("only_writer", "value")),
    );

    const summary = handleInboundOps(b, ops, "Peer");
    assert.equal(summary.applied, 1);
    assert.equal(summary.rejected, 0);
    assert.equal(b.store.get("only_writer"), "value");
  });

  it("does not report a collision when peers edit different keys", () => {
    const fromA = opsOf(
      commitLocalMutation(a, (store) => store.setKey("agent_a_task", "refactor auth")),
    );
    const fromB = opsOf(
      commitLocalMutation(b, (store) => store.setKey("agent_b_task", "write tests")),
    );

    assert.equal(handleInboundOps(b, fromA, "Peer").contended, 0);
    assert.equal(handleInboundOps(a, fromB, "Peer").contended, 0);
    assert.equal(a.contention.size, 0);
    assert.equal(b.contention.size, 0);
  });

  it("converges both peers on the union of concurrent edits", () => {
    const fromA = opsOf(
      commitLocalMutation(a, (store) => store.setKey("agent_a_task", "refactor auth")),
    );
    const fromB = opsOf(
      commitLocalMutation(b, (store) => store.setKey("agent_b_task", "write tests")),
    );

    handleInboundOps(b, fromA, "Peer");
    handleInboundOps(a, fromB, "Peer");

    assert.equal(a.store.get("agent_a_task"), "refactor auth");
    assert.equal(a.store.get("agent_b_task"), "write tests");
    assert.deepEqual(a.store.snapshot(), b.store.snapshot());
    assert.equal(a.store.stateHash(), b.store.stateHash());
  });

  it("converges regardless of the order updates arrive in", () => {
    const first = opsOf(commitLocalMutation(a, (s) => s.setKey("k1", "v1")));
    const second = opsOf(commitLocalMutation(a, (s) => s.setKey("k2", "v2")));
    const third = opsOf(commitLocalMutation(a, (s) => s.setKey("k3", "v3")));

    // Delivered backwards, as a lossy transport might.
    handleInboundOps(b, third, "Peer");
    handleInboundOps(b, first, "Peer");
    handleInboundOps(b, second, "Peer");

    assert.deepEqual(a.store.snapshot(), b.store.snapshot());
  });
});

describe("concurrent writes to the same key", () => {
  it("settles on one winner, identically on both peers", () => {
    const fromA = opsOf(commitLocalMutation(a, (s) => s.setKey("plan", "from A")));
    const fromB = opsOf(commitLocalMutation(b, (s) => s.setKey("plan", "from B")));

    handleInboundOps(a, fromB, "Peer");
    handleInboundOps(b, fromA, "Peer");

    assert.equal(a.store.get("plan"), b.store.get("plan"));
    assert.equal(a.store.stateHash(), b.store.stateHash());
  });

  it("records the overwrite so an agent can see it was overruled", () => {
    // Driven off an explicit clock: which side wins is the point of the test,
    // so it must not depend on how the two Date.now() calls happen to land.
    let wall = 1_700_000_000_000;
    const early = makeNode("early", "c", () => wall);
    const late = makeNode("late", "d", () => wall);
    try {
      commitLocalMutation(early, (s) => s.setKey("plan", "written first"));
      wall += 1000;
      const newer = opsOf(
        commitLocalMutation(late, (s) => s.setKey("plan", "written second")),
      );

      const summary = handleInboundOps(early, newer, "Peer");

      assert.equal(summary.contended, 1);
      assert.equal(early.store.get("plan"), "written second");
      assert.equal(early.contention.size, 1);
      assert.equal(early.contention.peek()?.key, "plan");
    } finally {
      rmSync(early.dir, { recursive: true, force: true });
      rmSync(late.dir, { recursive: true, force: true });
    }
  });

  it("ignores a write that lost the stamp order", () => {
    let wall = 1_700_000_000_000;
    const early = makeNode("stale-a", "c", () => wall);
    const late = makeNode("stale-b", "d", () => wall);
    try {
      const stale = opsOf(
        commitLocalMutation(early, (s) => s.setKey("plan", "written first")),
      );
      wall += 1000;
      commitLocalMutation(late, (s) => s.setKey("plan", "written second"));

      const summary = handleInboundOps(late, stale, "Peer");

      assert.equal(summary.ignored, 1);
      assert.equal(summary.applied, 0);
      assert.equal(late.store.get("plan"), "written second");
    } finally {
      rmSync(early.dir, { recursive: true, force: true });
      rmSync(late.dir, { recursive: true, force: true });
    }
  });

  it("never blocks unrelated keys behind a contended one", () => {
    const contended = opsOf(commitLocalMutation(a, (s) => s.setKey("plan", "from A")));
    const unrelated = opsOf(commitLocalMutation(a, (s) => s.setKey("other", "fine")));

    handleInboundOps(b, [...contended, ...unrelated], "Peer");
    assert.equal(b.store.get("other"), "fine");
  });
});

describe("N concurrent writers", () => {
  it("converges every replica on the same document", () => {
    const ids = ["c", "d", "e", "f", "g"];
    const nodes = ids.map((id, i) => makeNode(`n${i}`, id));
    try {
      // Everyone writes their own key at the same logical moment.
      const broadcasts = nodes.map((node, i) =>
        opsOf(commitLocalMutation(node, (s) => s.setKey(`task_${i}`, `work ${i}`))),
      );

      // Full mesh delivery.
      for (const [i, node] of nodes.entries()) {
        for (const [j, ops] of broadcasts.entries()) {
          if (i !== j) handleInboundOps(node, ops, "Peer");
        }
      }

      const hashes = new Set(nodes.map((node) => node.store.stateHash()));
      assert.equal(hashes.size, 1, "all replicas agree on one state hash");
      assert.equal(Object.keys(nodes[0]!.store.snapshot()).length, ids.length);
      for (const node of nodes) assert.equal(node.contention.size, 0);
    } finally {
      for (const node of nodes) rmSync(node.dir, { recursive: true, force: true });
    }
  });
});

describe("agent override", () => {
  it("wins over the automatic resolution and propagates", () => {
    const fromA = opsOf(commitLocalMutation(a, (s) => s.setKey("plan", "from A")));
    handleInboundOps(b, fromA, "Peer");

    const override = opsOf(
      overrideKeys(b, { plan: "merged by agent" }, "combined both proposals"),
    );
    handleInboundOps(a, override, "Peer");

    assert.equal(a.store.get("plan"), "merged by agent");
    assert.equal(b.store.get("plan"), "merged by agent");
    assert.equal(b.contention.size, 0, "override clears the contention record");
  });
});
