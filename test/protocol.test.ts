/**
 * The negotiated wire protocol.
 *
 * Three failures are pinned here, because each one was silent:
 *
 * 1. A document larger than one frame could never sync. The whole replica went
 *    out as a single `snapshot` on every connect, the receiver destroyed the
 *    connection over the framing check, and the two peers retried that forever.
 *    Nothing in the logs said "your context is too big to replicate".
 * 2. A version difference dropped every frame. `v` was pinned with a literal, so
 *    a peer on another build failed validation on everything it sent and neither
 *    operator could tell why two paired machines never converged.
 * 3. A snapshot relays entries the sender did not author, so in a swarm of three
 *    one peer could fabricate another's writes and the audit trail would name the
 *    wrong agent.
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
import { chunkSnapshot, SNAPSHOT_PART_BUDGET } from "../src/p2p.js";
import {
  CAP_PRESENCE,
  CAP_SIGNATURES,
  LOCAL_PROFILE,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  digestsMatch,
  negotiate,
} from "../src/protocol.js";
import { OpSigner, isSigned, verifyOp } from "../src/signing.js";
import { canonicalJson } from "../src/canonical.js";
import {
  MAX_PAYLOAD_BYTES,
  PeerEnvelopeSchema,
  CrdtOpArraySchema,
} from "../src/types.js";
import { applyPeerSnapshot, commitLocalMutation, handleInboundOps } from "../src/sync.js";
import type { SyncServices } from "../src/sync.js";
import type { CrdtOp } from "../src/crdt.js";

interface Node extends SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  contention: ContentionLog;
  dir: string;
}

/** A node with a real signing identity, so signatures are exercised end to end. */
function makeSignedNode(name: string): Node & { signer: OpSigner; pubkey: string } {
  const dir = mkdtempSync(join(tmpdir(), `p2pa-proto-${name}-`));
  const log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
  const seed = randomBytes(32);
  const keyPair = DHT.keyPair(seed);
  const pubkey = Buffer.from(keyPair.publicKey).toString("hex");
  const signer = new OpSigner(seed, pubkey);
  return {
    store: new ContextStore(pubkey, Date.now, signer),
    log,
    contention: new ContentionLog(),
    dir,
    signer,
    pubkey,
  };
}

function makePlainNode(name: string, idChar: string): Node {
  const dir = mkdtempSync(join(tmpdir(), `p2pa-proto-${name}-`));
  const log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
  return {
    store: new ContextStore(idChar.repeat(64)),
    log,
    contention: new ContentionLog(),
    dir,
  };
}

describe("version negotiation", () => {
  it("settles on the highest version both sides speak", () => {
    const result = negotiate({ min: 3, max: 4, node: "peer", caps: [] });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.version, 4);
  });

  it("falls back to the older peer's ceiling rather than refusing", () => {
    const result = negotiate({ min: 3, max: 3, node: "peer", caps: [] });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.version, 3);
  });

  it("refuses a peer newer than anything this build understands, and says so", () => {
    const result = negotiate(
      { min: 9, max: 9, node: "peer", caps: [] },
      { min: 3, max: 4, caps: [] },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "version-mismatch");
      // The point of the frame: an operator can act on this line.
      assert.match(result.detail, /v9/);
      assert.match(result.detail, /v3-v4/);
    }
  });

  it("treats an impossible range as a mismatch instead of guessing", () => {
    const result = negotiate({ min: 5, max: 2, node: "peer", caps: [] });
    assert.equal(result.ok, false);
  });

  it("activates only capabilities both sides implement", () => {
    const result = negotiate({
      min: 4,
      max: 4,
      node: "peer",
      caps: [CAP_SIGNATURES, "telepathy"],
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.caps.has(CAP_SIGNATURES), true);
      assert.equal(result.caps.has("telepathy"), false);
      // Advertised locally but not by the peer, so it stays off.
      assert.equal(result.caps.has(CAP_PRESENCE), false);
    }
  });

  it("advertises every capability this build implements", () => {
    const result = negotiate({
      min: 4,
      max: 4,
      node: "peer",
      caps: [...LOCAL_PROFILE.caps],
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.caps.size, LOCAL_PROFILE.caps.length);
  });

  it("accepts frames across the supported range, not one pinned version", () => {
    for (const v of [MIN_PROTOCOL_VERSION, PROTOCOL_VERSION]) {
      const parsed = PeerEnvelopeSchema.safeParse({
        type: "message",
        v,
        text: "hello",
      });
      assert.equal(parsed.success, true, `v${v} should be accepted`);
    }
  });

  it("refuses frames outside the supported range", () => {
    for (const v of [MIN_PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1]) {
      const parsed = PeerEnvelopeSchema.safeParse({
        type: "message",
        v,
        text: "hello",
      });
      assert.equal(parsed.success, false, `v${v} should be refused`);
    }
  });

  it("skips the handshake snapshot when both replicas already match", () => {
    const digest = { state: "abc123", claims: "def456" };
    assert.equal(digestsMatch(digest, { ...digest }), true);
    assert.equal(digestsMatch(digest, { state: "abc123", claims: "other" }), false);
    assert.equal(digestsMatch(digest, undefined), false);
  });
});

describe("a document larger than one frame", () => {
  let sender: Node;
  let receiver: Node;

  beforeEach(() => {
    sender = makePlainNode("big-sender", "1");
    receiver = makePlainNode("big-receiver", "2");
  });

  afterEach(() => {
    rmSync(sender.dir, { recursive: true, force: true });
    rmSync(receiver.dir, { recursive: true, force: true });
  });

  /** 40 x 32 KiB: every write individually legal, 1.3 MiB in total. */
  function fillPastOneFrame(node: Node): void {
    const blob = "x".repeat(32 * 1024);
    for (let i = 0; i < 40; i += 1) {
      const result = commitLocalMutation(node, (store) =>
        store.setKey(`working_notes_${i}`, blob),
      );
      assert.ok(result.ok);
    }
  }

  it("cannot be sent as a single frame — the case that used to hang", () => {
    fillPastOneFrame(sender);
    const oneFrame = JSON.stringify({
      type: "snapshot",
      v: PROTOCOL_VERSION,
      ops: sender.store.export(),
    });
    // This is what the old code put on the wire. The receiver's framing check
    // destroys the connection over it, on every connect, forever.
    assert.ok(oneFrame.length > MAX_PAYLOAD_BYTES);
  });

  it("splits into parts that each fit inside the frame limit", () => {
    fillPastOneFrame(sender);
    const parts = chunkSnapshot(sender.store.export());
    assert.ok(parts.length > 1, "an oversized replica must span several parts");

    parts.forEach((ops, index) => {
      const frame = JSON.stringify({
        type: "snapshot",
        v: PROTOCOL_VERSION,
        ops,
        part: index + 1,
        of: parts.length,
      });
      assert.ok(
        frame.length <= MAX_PAYLOAD_BYTES,
        `part ${index + 1} is ${frame.length} bytes, over the limit`,
      );
      assert.equal(PeerEnvelopeSchema.safeParse(JSON.parse(frame)).success, true);
    });
  });

  it("loses no entries across the split", () => {
    fillPastOneFrame(sender);
    const ops = sender.store.export();
    const flattened = chunkSnapshot(ops).flat();
    assert.equal(flattened.length, ops.length);
    assert.deepEqual(
      flattened.map((op) => op.key).sort(),
      ops.map((op) => op.key).sort(),
    );
  });

  it("converges the two replicas — the actual bug", () => {
    fillPastOneFrame(sender);

    // Each part is merged as it lands, exactly as the transport does it.
    for (const part of chunkSnapshot(sender.store.export())) {
      applyPeerSnapshot(receiver, part, "Peer");
    }

    assert.equal(receiver.store.stateHash(), sender.store.stateHash());
    assert.equal(Object.keys(receiver.store.snapshot()).length, 40);
  });

  it("leaves the receiver better off when a transfer is cut short", () => {
    fillPastOneFrame(sender);
    const parts = chunkSnapshot(sender.store.export());

    // Merge is commutative and idempotent, so a connection lost mid-snapshot is
    // partial progress rather than a corrupt document.
    applyPeerSnapshot(receiver, parts[0] as CrdtOp[], "Peer");
    const afterFirst = Object.keys(receiver.store.snapshot()).length;
    assert.ok(afterFirst > 0);
    assert.ok(afterFirst < 40);

    for (const part of parts) applyPeerSnapshot(receiver, part, "Peer");
    assert.equal(receiver.store.stateHash(), sender.store.stateHash());
  });

  it("handles an empty replica without producing a malformed frame", () => {
    const parts = chunkSnapshot([]);
    assert.equal(parts.length, 1);
    assert.deepEqual(parts[0], []);
  });

  it("packs many small entries into few parts", () => {
    for (let i = 0; i < 500; i += 1) {
      commitLocalMutation(sender, (store) => store.setKey(`k${i}`, i));
    }
    const parts = chunkSnapshot(sender.store.export());
    assert.equal(parts.length, 1, "500 tiny keys should need only one part");
    assert.ok(JSON.stringify(parts[0]).length < SNAPSHOT_PART_BUDGET);
  });
});

describe("operation signatures", () => {
  let alice: Node & { signer: OpSigner; pubkey: string };
  let bob: Node & { signer: OpSigner; pubkey: string };

  beforeEach(() => {
    alice = makeSignedNode("alice");
    bob = makeSignedNode("bob");
  });

  afterEach(() => {
    rmSync(alice.dir, { recursive: true, force: true });
    rmSync(bob.dir, { recursive: true, force: true });
  });

  it("signs what it stores, not only what it sends", () => {
    const result = commitLocalMutation(alice, (store) =>
      store.setKey("plan", "ship it"),
    );
    assert.ok(result.ok);

    // Signing only the outbound copy would leave this node relaying its own
    // writes unsigned inside snapshots — the exact case signatures cover.
    const stored = alice.store.export().find((op) => op.key === "plan");
    assert.ok(stored);
    assert.equal(isSigned(stored.entry), true);
    assert.equal(verifyOp(stored).status, "valid");
    if (result.ok) assert.equal(verifyOp(result.ops[0] as CrdtOp).status, "valid");
  });

  it("verifies a signature that survived a relay", () => {
    commitLocalMutation(alice, (store) => store.setKey("plan", "ship it"));
    const relayed = alice.store.export();

    applyPeerSnapshot(bob, relayed, "Peer");
    const atBob = bob.store.export().find((op) => op.key === "plan");
    assert.ok(atBob);
    assert.equal(verifyOp(atBob).status, "valid");
    assert.equal(atBob.entry.by, alice.pubkey);
  });

  it("rejects an entry whose value was edited after signing", () => {
    const result = commitLocalMutation(alice, (store) =>
      store.setKey("plan", "ship it"),
    );
    assert.ok(result.ok);
    const signed = (result.ok ? result.ops[0] : undefined) as CrdtOp;

    const tampered: CrdtOp = {
      key: signed.key,
      entry: { ...signed.entry, value: "do not ship" } as typeof signed.entry,
    };
    assert.equal(verifyOp(tampered).status, "invalid");

    const summary = applyPeerSnapshot(bob, [tampered], "Peer");
    assert.equal(summary.applied, 0);
    assert.equal(summary.rejected, 1);
    assert.equal(bob.store.get("plan"), undefined);
  });

  it("rejects a signature lifted onto a different key", () => {
    const result = commitLocalMutation(alice, (store) =>
      store.setKey("plan", "ship it"),
    );
    assert.ok(result.ok);
    const signed = (result.ok ? result.ops[0] : undefined) as CrdtOp;

    // The key is inside the signed bytes precisely so this fails.
    assert.equal(verifyOp({ key: "other", entry: signed.entry }).status, "invalid");
  });

  it("rejects a signature paired with somebody else's stamp", () => {
    const result = commitLocalMutation(alice, (store) =>
      store.setKey("plan", "ship it"),
    );
    assert.ok(result.ok);
    const signed = (result.ok ? result.ops[0] : undefined) as CrdtOp;

    const restamped: CrdtOp = {
      key: signed.key,
      entry: {
        ...signed.entry,
        hlc: { ...signed.entry.hlc, n: bob.store.nodeId },
      } as typeof signed.entry,
    };
    const outcome = verifyOp(restamped);
    assert.equal(outcome.status, "invalid");
    if (outcome.status === "invalid") {
      assert.match(outcome.reason, /node id/);
    }
  });

  it("refuses to sign a stamp this node did not author", () => {
    assert.throws(
      () =>
        alice.signer.signOp({
          key: "plan",
          entry: { kind: "lww", hlc: { w: Date.now(), c: 0, n: "someoneelse" }, value: 1 },
        }),
      /refusing to sign/,
    );
  });

  it("treats an unsigned entry as unsigned, not as invalid", () => {
    // A v3 peer sends no signature at all; that must stay mergeable.
    const outcome = verifyOp({
      key: "plan",
      entry: { kind: "lww", hlc: { w: Date.now(), c: 0, n: "abc" }, value: "x" },
    });
    assert.equal(outcome.status, "unsigned");
  });

  it("keeps the signed copy when the same write arrives both signed and bare", () => {
    const result = commitLocalMutation(alice, (store) =>
      store.setKey("plan", "ship it"),
    );
    assert.ok(result.ok);
    const signed = (result.ok ? result.ops[0] : undefined) as CrdtOp;
    const bare: CrdtOp = {
      key: signed.key,
      entry: { kind: "lww", hlc: signed.entry.hlc, value: "ship it" },
    };

    // A v3 relay strips the signature, so both forms circulate. Whichever order
    // they arrive in, the verifiable one is the one retained.
    const forwards = makePlainNode("order-a", "7");
    applyPeerSnapshot(forwards, [bare], "Peer");
    applyPeerSnapshot(forwards, [signed], "Peer");

    const backwards = makePlainNode("order-b", "8");
    applyPeerSnapshot(backwards, [signed], "Peer");
    applyPeerSnapshot(backwards, [bare], "Peer");

    try {
      for (const node of [forwards, backwards]) {
        const held = node.store.export().find((op) => op.key === "plan");
        assert.ok(held);
        assert.equal(isSigned(held.entry), true);
        assert.equal(node.store.get("plan"), "ship it");
      }
      assert.equal(forwards.store.stateHash(), backwards.store.stateHash());
    } finally {
      rmSync(forwards.dir, { recursive: true, force: true });
      rmSync(backwards.dir, { recursive: true, force: true });
    }
  });
});

/**
 * The three-node case.
 *
 * Hop-by-hop authentication cannot help here: a snapshot's whole job is to carry
 * operations the sender did not write, so "the sender proved who it is" says
 * nothing about who authored the entries inside.
 */
describe("a relayed snapshot cannot forge a third party's writes", () => {
  let alice: Node & { signer: OpSigner; pubkey: string };
  let carol: Node & { signer: OpSigner; pubkey: string };

  beforeEach(() => {
    alice = makeSignedNode("victim");
    carol = makeSignedNode("relay-target");
  });

  afterEach(() => {
    rmSync(alice.dir, { recursive: true, force: true });
    rmSync(carol.dir, { recursive: true, force: true });
  });

  it("rejects a fabricated entry stamped with the victim's node id", () => {
    // Bob knows Alice's node id — it is in every stamp he has ever seen from her.
    const forged: CrdtOp = {
      key: "deploy_approved",
      entry: {
        kind: "lww",
        hlc: { w: Date.now(), c: 5, n: alice.store.nodeId },
        value: "yes, approved by alice",
        by: alice.pubkey,
        // He cannot produce the signature, so he guesses.
        sig: Buffer.alloc(64, 7).toString("base64"),
      },
    };

    const summary = applyPeerSnapshot(carol, [forged], "Peer");
    assert.equal(summary.applied, 0);
    assert.equal(summary.rejected, 1);
    assert.match(summary.rejections.join(" "), /signature/);
    assert.equal(carol.store.get("deploy_approved"), undefined);
  });

  it("rejects a real signature replayed onto different content", () => {
    const real = commitLocalMutation(alice, (store) =>
      store.setKey("deploy_approved", "no"),
    );
    assert.ok(real.ok);
    const authentic = (real.ok ? real.ops[0] : undefined) as CrdtOp;

    const swapped: CrdtOp = {
      key: authentic.key,
      entry: { ...authentic.entry, value: "yes" } as typeof authentic.entry,
    };
    const summary = applyPeerSnapshot(carol, [swapped], "Peer");
    assert.equal(summary.rejected, 1);
    assert.notEqual(carol.store.get("deploy_approved"), "yes");
  });

  it("still accepts an unsigned relay by default, and refuses it when required", () => {
    const unsigned: CrdtOp = {
      key: "note",
      entry: {
        kind: "lww",
        hlc: { w: Date.now(), c: 1, n: alice.store.nodeId },
        value: "unverifiable",
      },
    };

    // Default: v3 peers must keep working, so an unsigned relay is accepted.
    const lenient = applyPeerSnapshot(carol, [unsigned], "Peer");
    assert.equal(lenient.applied, 1);

    // Opt in once the whole swarm speaks v4 and the gap closes.
    const strict = makeSignedNode("strict");
    strict.requireSignatures = true;
    try {
      const summary = applyPeerSnapshot(strict, [unsigned], "Peer");
      assert.equal(summary.applied, 0);
      assert.equal(summary.rejected, 1);
      assert.match(summary.rejections.join(" "), /no signature/);
      assert.equal(strict.store.get("note"), undefined);
    } finally {
      rmSync(strict.dir, { recursive: true, force: true });
    }
  });

  it("keeps refusing a peer that stamps as us, signed or not", () => {
    const asUs: CrdtOp = {
      key: "mine",
      entry: {
        kind: "lww",
        hlc: { w: Date.now(), c: 0, n: carol.store.nodeId },
        value: "written by someone else",
      },
    };
    const summary = applyPeerSnapshot(carol, [asUs], "Peer");
    assert.equal(summary.applied, 0);
    assert.equal(summary.rejected, 1);
    assert.equal(carol.store.get("mine"), undefined);
  });
});

describe("canonical encoding", () => {
  it("does not depend on object key order", () => {
    assert.equal(
      canonicalJson({ b: 1, a: 2 } as never),
      canonicalJson({ a: 2, b: 1 } as never),
    );
  });

  it("orders nested keys too, so a signature is order-independent", () => {
    assert.equal(
      canonicalJson({ outer: { z: 1, a: 2 } } as never),
      canonicalJson({ outer: { a: 2, z: 1 } } as never),
    );
  });

  it("distinguishes values that differ", () => {
    assert.notEqual(canonicalJson({ a: 1 } as never), canonicalJson({ a: 2 } as never));
  });
});

/**
 * `floor` records that a key was a last-write-wins register as recently as some
 * stamp, which is what makes a key flipping between `lww` and `orset` converge
 * regardless of delivery order. It was missing from the wire schema, so Zod
 * stripped it from every inbound op and the guard held inside one process only.
 */
describe("the OR-set lineage floor survives validation", () => {
  it("is preserved through inbound validation", () => {
    const withFloor: CrdtOp = {
      key: "items",
      entry: {
        kind: "orset",
        hlc: { w: Date.now(), c: 1, n: "aaaaaaaaaaaaaaaa" },
        floor: { w: Date.now(), c: 0, n: "bbbbbbbbbbbbbbbb" },
        adds: { "t.1.0.1": "one" },
        removes: [],
      },
    };

    const parsed = CrdtOpArraySchema.safeParse([withFloor]);
    assert.equal(parsed.success, true);
    if (parsed.success) {
      const entry = parsed.data[0]?.entry;
      assert.ok(entry && entry.kind === "orset");
      assert.ok(entry.floor, "floor must survive validation");
      assert.equal(entry.floor?.n, "bbbbbbbbbbbbbbbb");
    }
  });

  it("is kept when a local add rebuilds the entry", () => {
    const node = makePlainNode("floor-local", "3");
    try {
      // Establish a set with a floor by flipping the key from lww to orset.
      handleInboundOps(
        node,
        [
          {
            key: "items",
            entry: {
              kind: "lww",
              hlc: { w: Date.now() - 1000, c: 0, n: "cccccccccccccccc" },
              value: "was-a-scalar",
            },
          },
        ],
        "Peer",
      );
      handleInboundOps(
        node,
        [
          {
            key: "items",
            entry: {
              kind: "orset",
              hlc: { w: Date.now(), c: 0, n: "cccccccccccccccc" },
              adds: { "t.1.0.1": "first" },
              removes: [],
            },
          },
        ],
        "Peer",
      );

      const before = node.store.export().find((op) => op.key === "items");
      assert.ok(before && before.entry.kind === "orset");
      assert.ok(before.entry.floor, "the kind flip should have set a floor");

      commitLocalMutation(node, (store) => store.addToSet("items", "second"));

      const after = node.store.export().find((op) => op.key === "items");
      assert.ok(after && after.entry.kind === "orset");
      assert.ok(
        after.entry.floor,
        "a local add must not discard the established floor",
      );
    } finally {
      rmSync(node.dir, { recursive: true, force: true });
    }
  });
});
