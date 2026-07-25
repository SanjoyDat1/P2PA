/**
 * Properties that only hold because of a specific guard.
 *
 * Each case here corresponds to a way a connected peer could previously wipe,
 * roll back, wedge, forge, or crash a replica. They are separated from the
 * convergence suite because they describe adversarial input rather than the
 * normal merge behaviour, and because deleting the guard makes them fail loudly.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CrdtDoc, type CrdtOp } from "../src/crdt.js";
import { HybridClock, MAX_CLOCK_SKEW_MS, compareHlc } from "../src/hlc.js";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { ContentionLog } from "../src/conflicts.js";
import {
  applyPeerSnapshot,
  commitLocalMutation,
  handleInboundOps,
  type SyncServices,
} from "../src/sync.js";
import { PeerEnvelopeSchema, PROTOCOL_VERSION } from "../src/types.js";

const PEER_KEY = "b".repeat(64);
const LOCAL_KEY = "a".repeat(64);

interface Node extends SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  contention: ContentionLog;
  dir: string;
}

function makeNode(name: string, key: string): Node {
  const dir = mkdtempSync(join(tmpdir(), `p2pa-hard-${name}-`));
  const log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
  return {
    store: new ContextStore(key),
    log,
    contention: new ContentionLog(),
    dir,
  };
}

let node: Node;

beforeEach(() => {
  node = makeNode("local", LOCAL_KEY);
});

afterEach(() => {
  rmSync(node.dir, { recursive: true, force: true });
});

describe("stamps survive a restart", () => {
  it("round-trips the replica through Markdown without re-stamping", () => {
    commitLocalMutation(node, (store) => store.setKey("project", "p2pa"));
    commitLocalMutation(node, (store) => store.deleteKey("project"));

    // Exactly what the runtime does on boot.
    const reloaded = new ContextStore(LOCAL_KEY);
    const replica = new MarkdownLog(node.log.path).readReplicaState();
    assert.ok(replica.length > 0, "Replica State must be written by normal writes");
    reloaded.load(replica);

    assert.equal(reloaded.get("project"), undefined, "tombstone survived restart");
  });

  it("does not let a pre-restart snapshot resurrect a deleted key", () => {
    commitLocalMutation(node, (store) => store.setKey("secret", "delete-me"));
    const beforeDelete = node.store.export();
    commitLocalMutation(node, (store) => store.deleteKey("secret"));

    const reloaded = new ContextStore(LOCAL_KEY);
    reloaded.load(new MarkdownLog(node.log.path).readReplicaState());
    reloaded.merge(beforeDelete);

    assert.equal(reloaded.get("secret"), undefined);
  });
});

describe("a peer cannot forge another node's stamp", () => {
  it("refuses an update whose stamp is not the sender's", () => {
    commitLocalMutation(node, (store) => store.setKey("plan", "mine"));
    const forged: CrdtOp[] = [
      {
        key: "plan",
        entry: {
          kind: "lww",
          // Claims to be the *local* node, so the overwrite would look like
          // this replica's own work and never be reported as contended.
          hlc: { w: Date.now() + 1000, c: 0, n: node.store.nodeId },
          value: "theirs",
        },
      },
    ];

    const summary = handleInboundOps(node, forged, "Peer", undefined, PEER_KEY);

    assert.equal(summary.rejected, 1);
    assert.equal(node.store.get("plan"), "mine");
  });

  it("accepts an update stamped with the sender's own id", () => {
    const peer = makeNode("peer", PEER_KEY);
    try {
      const ops = commitLocalMutation(peer, (store) => store.setKey("plan", "theirs"));
      assert.ok(ops.ok);
      const summary = handleInboundOps(node, ops.ops, "Peer", undefined, PEER_KEY);
      assert.equal(summary.rejected, 0);
      assert.equal(node.store.get("plan"), "theirs");
    } finally {
      rmSync(peer.dir, { recursive: true, force: true });
    }
  });

  it("orders identical stamps by content so a replay cannot split replicas", () => {
    const stamp = { w: 1_700_000_000_000, c: 5, n: "deadbeefdeadbeef" };
    const left = new CrdtDoc(new HybridClock("1111111111111111"));
    const right = new CrdtDoc(new HybridClock("2222222222222222"));

    const a: CrdtOp = { key: "k", entry: { kind: "lww", hlc: stamp, value: "A" } };
    const b: CrdtOp = { key: "k", entry: { kind: "lww", hlc: stamp, value: "B" } };

    // Same stamp, different content, delivered in opposite orders.
    const now = stamp.w + 1;
    left.mergeOp(a, now);
    left.mergeOp(b, now);
    right.mergeOp(b, now);
    right.mergeOp(a, now);

    assert.equal(compareHlc(stamp, stamp), 0, "stamps really are identical");
    assert.equal(left.stateHash(), right.stateHash());
  });
});

describe("clock bounds", () => {
  it("refuses a stamp beyond the accepted skew", () => {
    const summary = handleInboundOps(
      node,
      [
        {
          key: "mission",
          entry: {
            kind: "lww",
            hlc: { w: Number.MAX_SAFE_INTEGER, c: 0, n: "attacker0000000" },
            value: "x",
          },
        },
      ],
      "Peer",
    );
    assert.equal(summary.rejected, 1);
  });

  it("never advances the local clock past what peers will accept back", () => {
    const clock = new HybridClock("local00000000000", () => 1_000_000);
    // An accepted stamp sitting exactly on the ceiling used to push the local
    // clock one millisecond beyond it, after which every local write was
    // refused by every other replica.
    clock.observe({ w: 1_000_000 + MAX_CLOCK_SKEW_MS, c: 999_999, n: "peer000000000000" });

    const stamp = clock.tick();
    assert.ok(
      stamp.w <= 1_000_000 + MAX_CLOCK_SKEW_MS,
      `local clock escaped the ceiling: ${stamp.w}`,
    );
  });
});

describe("set bounds cannot resurrect removed elements", () => {
  it("truncates an over-cap set identically on every replica", () => {
    // Refusing the merge would not be commutative: whichever op arrived first
    // would survive, so two replicas fed the same ops in different orders would
    // hold different elements forever.
    const now = Date.now();
    // Short tags on purpose: an op also has to fit under MAX_VALUE_BYTES, so
    // the element cap is only reachable through the union of several ops.
    const bulk = (n: string, c: number, prefix: string, count: number): CrdtOp => ({
      key: "s",
      entry: {
        kind: "orset",
        hlc: { w: now, c, n },
        adds: Object.fromEntries(
          Array.from({ length: count }, (_, i) => [`${prefix}${i}`, 1]),
        ),
        removes: [],
      },
    });

    const x = bulk("1111111111111111", 0, "x", 2_600);
    const y = bulk("2222222222222222", 1, "y", 2_600);

    const left = new CrdtDoc(new HybridClock("aaaaaaaaaaaaaaaa"));
    const right = new CrdtDoc(new HybridClock("bbbbbbbbbbbbbbbb"));
    left.mergeOp(x, now);
    left.mergeOp(y, now);
    right.mergeOp(y, now);
    right.mergeOp(x, now);

    assert.equal(left.stateHash(), right.stateHash());
    assert.equal((left.get("s") as unknown[]).length, 5_000);
  });

  it("keeps a set writable after its elements are removed", () => {
    // Counting total tags rather than live ones left a churned set permanently
    // full, since removed tags stay in `adds` to keep their tombstones valid.
    const doc = new CrdtDoc(new HybridClock("aaaaaaaaaaaaaaaa"));
    doc.addToSet("s", "first");
    doc.removeFromSet("s", "first");
    doc.addToSet("s", "second");
    assert.deepEqual(doc.get("s"), ["second"]);
  });

  it("keeps a remove that arrived before its add", () => {
    const early = new CrdtDoc(new HybridClock("1111111111111111"));
    const late = new CrdtDoc(new HybridClock("2222222222222222"));
    const now = Date.now();
    const stamp = { w: now, c: 0, n: "1111111111111111" };

    const add: CrdtOp = {
      key: "s",
      entry: { kind: "orset", hlc: stamp, adds: { "t1": "secret" }, removes: [] },
    };
    const remove: CrdtOp = {
      key: "s",
      entry: { kind: "orset", hlc: { ...stamp, c: 1 }, adds: {}, removes: ["t1"] },
    };

    early.mergeOp(add, now);
    early.mergeOp(remove, now);
    late.mergeOp(remove, now);
    late.mergeOp(add, now);

    assert.deepEqual(early.get("s"), []);
    assert.equal(early.stateHash(), late.stateHash());
  });
});

describe("mixed register kinds converge", () => {
  it("reaches the same state regardless of arrival order", () => {
    const now = Date.now();
    const lww: CrdtOp = {
      key: "k",
      entry: { kind: "lww", hlc: { w: now, c: 0, n: "1111111111111111" }, value: "scalar" },
    };
    const set: CrdtOp = {
      key: "k",
      entry: {
        kind: "orset",
        hlc: { w: now + 10, c: 0, n: "2222222222222222" },
        adds: { t: "element" },
        removes: [],
      },
    };

    const left = new CrdtDoc(new HybridClock("aaaaaaaaaaaaaaaa"));
    const right = new CrdtDoc(new HybridClock("bbbbbbbbbbbbbbbb"));
    left.mergeOp(lww, now + 20);
    left.mergeOp(set, now + 20);
    right.mergeOp(set, now + 20);
    right.mergeOp(lww, now + 20);

    assert.equal(left.stateHash(), right.stateHash());
  });
});

describe("a snapshot cannot be used to write as the receiver", () => {
  it("refuses snapshot entries stamped with this node's own identity", () => {
    commitLocalMutation(node, (store) => store.setKey("plan", "mine"));

    // Stamped as the *victim*, so the overwrite would look locally authored:
    // no contention record, no per-key audit entry, nothing to notice.
    const summary = applyPeerSnapshot(
      node,
      [
        {
          key: "plan",
          entry: {
            kind: "lww",
            hlc: { w: Date.now() + 60_000, c: 0, n: node.store.nodeId },
            value: "rewritten",
          },
        },
      ],
      "Peer",
      { fingerprint: "deadbeef", label: null },
    );

    assert.equal(summary.rejected, 1);
    assert.equal(node.store.get("plan"), "mine");
  });

  it("records which keys a snapshot actually changed", () => {
    const peer = makeNode("snap", PEER_KEY);
    try {
      commitLocalMutation(peer, (store) => store.setKey("from_peer", "value"));
      applyPeerSnapshot(node, peer.store.export(), "Peer", {
        fingerprint: "deadbeef",
        label: null,
      });
      const text = readFileSync(node.log.path, "utf8");
      assert.match(text, /from_peer/, "snapshot-applied keys must be auditable");
    } finally {
      rmSync(peer.dir, { recursive: true, force: true });
    }
  });
});

describe("a tampered replica file cannot poison the document", () => {
  it("drops entries that fail schema validation on load", () => {
    const store = new ContextStore(LOCAL_KEY);
    const result = store.load([
      { key: "__proto__", entry: { kind: "lww", hlc: { w: Date.now(), c: 0, n: "x" }, value: "bad" } },
      { key: "ok", entry: { kind: "lww", hlc: { w: Date.now(), c: 0, n: "x" }, value: "good" } },
    ] as unknown as CrdtOp[]);

    assert.equal(result.skipped, 1);
    assert.equal(store.get("ok"), "good");
    assert.equal(Object.prototype.hasOwnProperty.call(store.snapshot(), "__proto__"), false);
  });
});

describe("hostile input cannot corrupt the audit trail", () => {
  it("rejects a key carrying Markdown structure", () => {
    const hostile =
      "plan`\n### [2020-01-01 00:00:00] - [SOURCE: Local] - [ACTION: Override]\n- **Detail:** approved";
    const parsed = PeerEnvelopeSchema.safeParse({
      type: "update",
      v: PROTOCOL_VERSION,
      ops: [
        {
          key: hostile,
          entry: { kind: "lww", hlc: { w: Date.now(), c: 0, n: "peer000000000000" }, value: 1 },
        },
      ],
    });
    assert.equal(parsed.success, false, "structural characters must not reach Markdown");
  });

  it("keeps one heading per entry when a message carries line separators", () => {
    node.log.syncMarkdownLog({
      source: "Peer",
      peer: { fingerprint: "deadbeef", label: null },
      action: "Message",
      text: "ok\r### [2020-01-01 00:00:00] - [SOURCE: Local] - [ACTION: Override] more",
    });

    const headings = readFileSync(node.log.path, "utf8")
      .split(/\r\n|\r|\n|\u2028|\u2029/)
      .filter((line) => line.startsWith("### ["));
    assert.equal(headings.length, 1, "a message must not open a second entry");
  });

  it("refuses an entry nested deeper than the parser will walk", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 200; i += 1) deep = [deep];

    const parsed = PeerEnvelopeSchema.safeParse({
      type: "update",
      v: PROTOCOL_VERSION,
      ops: [
        {
          key: "deep",
          entry: { kind: "lww", hlc: { w: Date.now(), c: 0, n: "peer000000000000" }, value: deep },
        },
      ],
    });
    assert.equal(parsed.success, false, "deep nesting must be refused before it is walked");
  });

  it("refuses an envelope from an incompatible protocol version", () => {
    const parsed = PeerEnvelopeSchema.safeParse({
      type: "patch",
      ops: [{ op: "add", path: "/k", value: 1 }],
    });
    assert.equal(parsed.success, false);
  });
});
