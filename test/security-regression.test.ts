/**
 * Regressions for findings from the v4 security audit.
 *
 * Each block here corresponds to a specific way a malicious but *allowlisted*
 * peer could previously damage a node that trusted it. They are kept together,
 * and named after the attack rather than the function, because the thing worth
 * preserving is the property — if one of these fails, a real capability came
 * back, whatever the implementation looks like at the time.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import DHT from "hyperdht";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { ContentionLog } from "../src/conflicts.js";
import { OpSigner } from "../src/signing.js";
import { RateBudget } from "../src/p2p.js";
import { Outbox } from "../src/outbox.js";
import { CrdtOpArraySchema } from "../src/types.js";
import { agentKeyFor, isWellFormedNodeId } from "../src/presence.js";
import { applyPeerSnapshot, handleInboundOps } from "../src/sync.js";
import type { SyncServices } from "../src/sync.js";
import type { CrdtOp } from "../src/crdt.js";

interface Node extends SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  contention: ContentionLog;
  dir: string;
  pubkey: string;
}

function makeNode(name: string): Node {
  const dir = mkdtempSync(join(tmpdir(), `p2pa-sec-${name}-`));
  const log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
  const seed = randomBytes(32);
  const pubkey = Buffer.from(DHT.keyPair(seed).publicKey).toString("hex");
  return {
    store: new ContextStore(pubkey, Date.now, new OpSigner(seed, pubkey)),
    log,
    contention: new ContentionLog(),
    dir,
    pubkey,
  };
}

let victim: Node;

beforeEach(() => {
  victim = makeNode("victim");
});

afterEach(() => {
  rmSync(victim.dir, { recursive: true, force: true });
});

/**
 * The worst of the findings: one stale op erased a key.
 *
 * A losing `orset` was still written over the winning `lww`, so the register's
 * value became `[]`. The merge reported "ignored", so nothing appeared in the
 * audit trail, the contention log, or the event feed — the value simply vanished.
 */
describe("a stale set op cannot erase a live value", () => {
  it("keeps the register when an older set op loses", () => {
    victim.store.setKey("plan", "the real plan");
    const before = victim.store.stateHash();

    const summary = handleInboundOps(
      victim,
      [
        {
          key: "plan",
          entry: {
            kind: "orset",
            hlc: { w: Date.now() - 60_000, c: 0, n: "2".repeat(16) },
            adds: {},
            removes: [],
          },
        },
      ],
      "Peer",
      { fingerprint: "attacker", label: null },
      // Stamped with the sender's own id, so sender binding is satisfied.
      "2".repeat(64),
    );

    assert.equal(victim.store.get("plan"), "the real plan");
    assert.equal(victim.store.stateHash(), before);
    assert.equal(summary.applied, 0);
  });

  it("converges no matter which order the two ops arrive in", () => {
    const lww: CrdtOp = {
      key: "plan",
      entry: { kind: "lww", hlc: { w: 2000, c: 0, n: "a".repeat(16) }, value: "real" },
    };
    const set: CrdtOp = {
      key: "plan",
      entry: {
        kind: "orset",
        hlc: { w: 1000, c: 0, n: "b".repeat(16) },
        adds: {},
        removes: [],
      },
    };

    const forwards = makeNode("order-fwd");
    const backwards = makeNode("order-rev");
    try {
      applyPeerSnapshot(forwards, [lww], "Peer");
      applyPeerSnapshot(forwards, [set], "Peer");
      applyPeerSnapshot(backwards, [set], "Peer");
      applyPeerSnapshot(backwards, [lww], "Peer");

      assert.equal(forwards.store.get("plan"), "real");
      assert.equal(backwards.store.get("plan"), "real");
      assert.equal(forwards.store.stateHash(), backwards.store.stateHash());
    } finally {
      rmSync(forwards.dir, { recursive: true, force: true });
      rmSync(backwards.dir, { recursive: true, force: true });
    }
  });

  it("still lets a newer set op legitimately take the key", () => {
    victim.store.setKey("items", "was-a-scalar");
    const summary = applyPeerSnapshot(
      victim,
      [
        {
          key: "items",
          entry: {
            kind: "orset",
            hlc: { w: Date.now() + 1000, c: 0, n: "c".repeat(16) },
            adds: { "t.1.0.1": "first" },
            removes: [],
          },
        },
      ],
      "Peer",
    );
    assert.ok(summary.applied > 0);
    assert.deepEqual(victim.store.get("items"), ["first"]);
  });

  it("still discards a stale set op after the key has flipped kind", () => {
    // The floor exists for exactly this: once a key has been an lww at stamp T,
    // set ops at or below T belong to a lineage the register moved past.
    applyPeerSnapshot(
      victim,
      [
        {
          key: "items",
          entry: { kind: "lww", hlc: { w: 2000, c: 0, n: "d".repeat(16) }, value: "scalar" },
        },
      ],
      "Peer",
    );
    applyPeerSnapshot(
      victim,
      [
        {
          key: "items",
          entry: {
            kind: "orset",
            hlc: { w: 3000, c: 0, n: "d".repeat(16) },
            adds: { "t.new": "current" },
            removes: [],
          },
        },
      ],
      "Peer",
    );
    // Stale: stamped below the floor the kind flip established.
    applyPeerSnapshot(
      victim,
      [
        {
          key: "items",
          entry: {
            kind: "orset",
            hlc: { w: 1000, c: 0, n: "d".repeat(16) },
            adds: { "t.old": "resurrected" },
            removes: [],
          },
        },
      ],
      "Peer",
    );

    assert.deepEqual(
      victim.store.get("items"),
      ["current"],
      "a set op below the floor must not be unioned back in",
    );
  });
});

/**
 * OR-set tags are peer-chosen and used as object keys. `__proto__` is not an
 * ordinary key: it resolves through the prototype chain, so a genuine element
 * was compared against `Object.prototype` and silently dropped.
 */
describe("reserved property names cannot be used as set tags", () => {
  for (const tag of ["__proto__", "constructor", "prototype"]) {
    it(`refuses "${tag}" in adds`, () => {
      const op: CrdtOp = {
        key: "list",
        entry: {
          kind: "orset",
          hlc: { w: Date.now(), c: 0, n: "e".repeat(16) },
          adds: { [tag]: "payload" },
          removes: [],
        },
      };
      assert.equal(CrdtOpArraySchema.safeParse([op]).success, false);
    });

    it(`refuses "${tag}" in removes`, () => {
      const op: CrdtOp = {
        key: "list",
        entry: {
          kind: "orset",
          hlc: { w: Date.now(), c: 0, n: "e".repeat(16) },
          adds: {},
          removes: [tag],
        },
      };
      assert.equal(CrdtOpArraySchema.safeParse([op]).success, false);
    });
  }

  it("does not lose a legitimate element when merging sets", () => {
    const peer = "f".repeat(16);
    applyPeerSnapshot(
      victim,
      [
        {
          key: "list",
          entry: {
            kind: "orset",
            hlc: { w: 1000, c: 0, n: peer },
            adds: { "t.1": "one" },
            removes: [],
          },
        },
      ],
      "Peer",
    );
    applyPeerSnapshot(
      victim,
      [
        {
          key: "list",
          entry: {
            kind: "orset",
            hlc: { w: 2000, c: 0, n: peer },
            adds: { "t.2": "two" },
            removes: [],
          },
        },
      ],
      "Peer",
    );
    assert.deepEqual(victim.store.get("list"), ["one", "two"]);
  });
});

/**
 * A presence card is addressed by node id, so a card at a short id would let a
 * lookup for that id resolve to an unintended peer.
 */
describe("presence node ids must be full length", () => {
  it("accepts a real node id", () => {
    assert.equal(isWellFormedNodeId("a3f9c1b2d4e5f607"), true);
  });

  it("rejects short, long, uppercase and non-hex ids", () => {
    for (const bad of ["c", "a3f9", "a".repeat(17), "A".repeat(16), "z".repeat(16)]) {
      assert.equal(isWellFormedNodeId(bad), false, `${bad} should be refused`);
    }
  });

  it("refuses a card published at a truncated node id", () => {
    const op: CrdtOp = {
      key: agentKeyFor("c"),
      entry: {
        kind: "lww",
        hlc: { w: Date.now(), c: 0, n: "c" },
        value: { role: "reviewer", capabilities: [], status: "idle", at: new Date().toISOString() },
      },
    };
    assert.equal(CrdtOpArraySchema.safeParse([op]).success, false);
  });

  it("keeps a short-id card off the roster even if it reaches the store", () => {
    const fresh = makeNode("short-id");
    try {
      fresh.store.load([
        {
          key: agentKeyFor("c"),
          entry: {
            kind: "lww",
            hlc: { w: Date.now(), c: 0, n: "c" },
            value: {
              role: "reviewer",
              capabilities: [],
              status: "idle",
              at: new Date().toISOString(),
            },
          },
        },
      ]);
      assert.equal(fresh.store.listAgents().length, 0);
    } finally {
      rmSync(fresh.dir, { recursive: true, force: true });
    }
  });
});

/**
 * The limiter charged the *trimmed* length after skipping blank lines, so a
 * frame padded with whitespace cost only its payload and a stream of newlines
 * cost nothing at all.
 */
describe("rate limiting cannot be bypassed with whitespace", () => {
  it("charges padding, not just payload", () => {
    const budget = new RateBudget(10_000, 1, 10_000, 1);
    const at = 1_000_000;
    // One padded frame must cost its full wire size.
    assert.equal(budget.admit(9_000, at), true);
    assert.equal(budget.admit(9_000, at), false);
  });

  it("charges every line, including empty ones", () => {
    const budget = new RateBudget(5, 0, 1_000_000, 0);
    const at = 1_000_000;
    let admitted = 0;
    for (let i = 0; i < 20; i += 1) {
      if (budget.admit(1, at)) admitted += 1;
    }
    assert.equal(admitted, 5, "the envelope bucket must bound blank lines too");
  });

  it("does not let a backwards clock refill the bucket", () => {
    const budget = new RateBudget(5, 100, 1_000_000, 1_000_000);
    const at = 1_000_000;
    for (let i = 0; i < 5; i += 1) budget.admit(1, at);
    assert.equal(budget.admit(1, at), false);
    // Clock jumps backwards: elapsed must floor at zero, not go negative.
    assert.equal(budget.admit(1, at - 60_000), false);
  });
});

/**
 * The snapshot is the only frame carrying stamps its sender did not author, so
 * the window in which one is accepted has to close.
 */
describe("signature enforcement is reachable and effective", () => {
  it("refuses an unsigned relayed op when required", () => {
    const strict = makeNode("strict");
    strict.requireSignatures = true;
    try {
      const summary = applyPeerSnapshot(
        strict,
        [
          {
            key: "note",
            entry: {
              kind: "lww",
              hlc: { w: Date.now(), c: 0, n: "9".repeat(16) },
              value: "unverifiable",
            },
          },
        ],
        "Peer",
      );
      assert.equal(summary.applied, 0);
      assert.equal(summary.rejected, 1);
      assert.equal(strict.store.get("note"), undefined);
    } finally {
      rmSync(strict.dir, { recursive: true, force: true });
    }
  });

  it("still accepts a properly signed relayed op when required", () => {
    const author = makeNode("author");
    const strict = makeNode("strict-ok");
    strict.requireSignatures = true;
    try {
      author.store.setKey("note", "verifiable");
      const summary = applyPeerSnapshot(strict, author.store.export(), "Peer");
      assert.ok(summary.applied > 0);
      assert.equal(strict.store.get("note"), "verifiable");
    } finally {
      rmSync(author.dir, { recursive: true, force: true });
      rmSync(strict.dir, { recursive: true, force: true });
    }
  });

  it("counts a bad signature separately so the transport can drop the peer", () => {
    const summary = applyPeerSnapshot(
      victim,
      [
        {
          key: "deploy_approved",
          entry: {
            kind: "lww",
            hlc: { w: Date.now(), c: 0, n: "8".repeat(16) },
            value: "yes",
            by: "8".repeat(64),
            sig: Buffer.alloc(64, 7).toString("base64"),
          },
        },
      ],
      "Peer",
    );
    assert.equal(summary.forged, 1, "a forgery must be distinguishable from a bound");
    assert.equal(summary.applied, 0);
  });

  it("does not flag an ordinary rejection as forgery", () => {
    const summary = applyPeerSnapshot(
      victim,
      [
        {
          key: "way_ahead",
          entry: {
            kind: "lww",
            hlc: { w: Number.MAX_SAFE_INTEGER, c: 0, n: "7".repeat(16) },
            value: "x",
          },
        },
      ],
      "Peer",
    );
    assert.equal(summary.rejected, 1);
    assert.equal(summary.forged, 0);
  });
});

/**
 * The outbox exists so a message survives the recipient being offline. It only
 * queued the text, so a question sent by `ask_peer` was replayed as an ordinary
 * broadcast: the recipient could not tell it had been asked anything, could not
 * reply with a matching id, and the asker waited on a correlation that was never
 * coming back. Being deliverable later is the whole promise — it has to carry
 * what makes the message answerable.
 */
describe("a queued question is still a question when it arrives", () => {
  it("retains correlation, intent and addressee across the queue", () => {
    const dir = mkdtempSync(join(tmpdir(), "p2pa-outbox-addr-"));
    try {
      const outbox = new Outbox(join(dir, "outbox.json"));
      const to = "b".repeat(64);
      const queued = outbox.enqueue("can you review this?", [to], {
        to,
        corr: "7c1d94a2ef0b3355",
        intent: "ask",
      });

      const pending = outbox.pendingFor(to);
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.corr, "7c1d94a2ef0b3355");
      assert.equal(pending[0]?.intent, "ask");
      assert.equal(pending[0]?.to, to);
      assert.equal(pending[0]?.id, queued.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives a restart with its addressing intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "p2pa-outbox-restart-"));
    try {
      const to = "c".repeat(64);
      const first = new Outbox(join(dir, "outbox.json"));
      first.enqueue("still need that review", [to], {
        to,
        corr: "abc123",
        intent: "ask",
      });
      first.flush();

      // A fresh process reads the file back — this is the offline path.
      const reloaded = new Outbox(join(dir, "outbox.json"));
      const pending = reloaded.pendingFor(to);
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.corr, "abc123");
      assert.equal(pending[0]?.intent, "ask");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a plain broadcast unaddressed", () => {
    const dir = mkdtempSync(join(tmpdir(), "p2pa-outbox-broadcast-"));
    try {
      const outbox = new Outbox(join(dir, "outbox.json"));
      const peer = "d".repeat(64);
      outbox.enqueue("morning everyone", [peer]);
      const pending = outbox.pendingFor(peer);
      assert.equal(pending[0]?.corr, undefined);
      assert.equal(pending[0]?.to, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A forged op must be refused *before* it can influence anything, including the
 * local clock — a stamp adopted on the way to being rejected would still shift
 * every later local write.
 */
describe("a refused op leaves no trace", () => {
  it("does not advance the local clock", () => {
    const fresh = makeNode("clock");
    try {
      const before = fresh.store.stampFor("anything");
      assert.equal(before, undefined);

      applyPeerSnapshot(
        fresh,
        [
          {
            key: "decoy",
            entry: {
              kind: "lww",
              hlc: { w: Number.MAX_SAFE_INTEGER, c: 0, n: "6".repeat(16) },
              value: "x",
            },
          },
        ],
        "Peer",
      );

      // The node must still be able to write, and its stamp must be near now.
      fresh.store.setKey("mine", "still working");
      const stamp = fresh.store.stampFor("mine");
      assert.ok(stamp);
      assert.ok(
        Math.abs(stamp.w - Date.now()) < 60_000,
        "a refused stamp must not have dragged the clock forward",
      );
    } finally {
      rmSync(fresh.dir, { recursive: true, force: true });
    }
  });
});
