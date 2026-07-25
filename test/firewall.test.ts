/**
 * The authentication boundary.
 *
 * Two layers are covered:
 *  1. `shouldBlockPeer` — the pure gate, including its inverted return polarity.
 *  2. Two live `P2PNode`s on an in-process DHT testnet, proving that an
 *     unlisted peer never receives the handshake snapshot. No internet needed.
 */
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import createTestnet from "hyperdht/testnet";
import DHT from "hyperdht";
import { P2PNode, describePeer, shouldBlockPeer } from "../src/p2p.js";
import type { PeerEnvelope } from "../src/types.js";
import { ContextStore } from "../src/store.js";
import type { CrdtOp } from "../src/crdt.js";

const KEY_A = "a1".repeat(32);
const KEY_B = "b2".repeat(32);

describe("shouldBlockPeer", () => {
  const allowOnlyA = (key: string) => key === KEY_A;

  it("allows everything in open mode, even an unknown key", () => {
    assert.equal(shouldBlockPeer("open", allowOnlyA, KEY_B), false);
    assert.equal(shouldBlockPeer("open", () => false, KEY_B), false);
  });

  it("allows an allowlisted key in strict mode", () => {
    assert.equal(shouldBlockPeer("strict", allowOnlyA, KEY_A), false);
  });

  it("BLOCKS an unlisted key in strict mode", () => {
    assert.equal(shouldBlockPeer("strict", allowOnlyA, KEY_B), true);
  });

  it("BLOCKS an unidentifiable peer in strict mode (fail closed)", () => {
    assert.equal(shouldBlockPeer("strict", () => true, null), true);
  });

  it("allows an unidentifiable peer in open mode", () => {
    assert.equal(shouldBlockPeer("open", () => false, null), false);
  });

  it("BLOCKS everyone when the allowlist is empty", () => {
    assert.equal(shouldBlockPeer("strict", () => false, KEY_A), true);
    assert.equal(shouldBlockPeer("strict", () => false, KEY_B), true);
  });

  it("returns true to BLOCK, matching Hyperswarm's inverted contract", () => {
    // Regression guard: flipping this polarity would allow every peer while
    // still looking correct at the call site.
    const blocked = shouldBlockPeer("strict", () => false, KEY_A);
    const allowed = shouldBlockPeer("strict", () => true, KEY_A);
    assert.equal(blocked, true, "unlisted peer must produce true (= blocked)");
    assert.equal(allowed, false, "listed peer must produce false (= allowed)");
  });
});

describe("describePeer", () => {
  it("renders fingerprint and label", () => {
    assert.equal(
      describePeer({ pubkey: KEY_A, label: "sanjoy-laptop", fingerprint: "a1a1a1a1" }),
      "a1a1a1a1 (sanjoy-laptop)",
    );
  });

  it("renders the fingerprint alone when the peer is unlabelled", () => {
    assert.equal(
      describePeer({ pubkey: KEY_A, label: null, fingerprint: "a1a1a1a1" }),
      "a1a1a1a1",
    );
  });
});

describe("P2PNode firewall (live, local testnet)", () => {
  let testnet: Awaited<ReturnType<typeof createTestnet>>;
  let bootstrap: Array<{ host: string; port: number }>;

  before(async () => {
    // 10 nodes: a smaller ring does not reliably route announce/lookup, which
    // would make the "peer is blocked" assertions pass for the wrong reason.
    testnet = await createTestnet(10);
    bootstrap = testnet.bootstrap as Array<{ host: string; port: number }>;
  });

  after(async () => {
    await testnet.destroy();
  });

  const TOPIC = "firewall-test-topic-0001";

  interface Harness {
    node: P2PNode;
    pubkey: string;
    received: Array<{ envelope: PeerEnvelope; peer: string }>;
  }

  /**
 * Build stamped ops for a handshake fixture. The transport carries CRDT
 * entries now, so a plain object is no longer a valid snapshot payload.
 */
function stampedOps(state: Record<string, string>): CrdtOp[] {
  const store = new ContextStore("f".repeat(64));
  for (const [key, value] of Object.entries(state)) store.setKey(key, value);
  return store.export();
}

function makeNode(options: {
    seed: number;
    authMode: "strict" | "open";
    allow: string[];
    state?: Record<string, string>;
  }): Harness {
    const keyPair = DHT.keyPair(Buffer.alloc(32, options.seed));
    const allow = new Set(options.allow);
    const received: Harness["received"] = [];

    const node = new P2PNode({
      topic: TOPIC,
      keyPair,
      authMode: options.authMode,
      bootstrap,
      isPeerAllowed: (key) => allow.has(key),
      lookupPeer: (key) => (allow.has(key) ? { label: `peer-${key.slice(0, 4)}` } : undefined),
      getActiveState: () => stampedOps(options.state ?? {}),
      onPeerMessage: (envelope, peer) => {
        received.push({ envelope, peer: describePeer(peer) });
      },
    });

    return {
      node,
      pubkey: Buffer.from(keyPair.publicKey).toString("hex"),
      received,
    };
  }

  /**
   * Start both nodes and force a discovery refresh.
   *
   * Hyperswarm's announce query only yields peers that were already published
   * when it ran, and its automatic refresh is on a 10-minute timer — so without
   * an explicit second pass neither node ever sees the other in a short test.
   */
  async function connect(nodes: Harness[], settleMs = 1500): Promise<void> {
    await Promise.all(nodes.map((n) => n.node.start()));
    await Promise.all(nodes.map((n) => n.node.refreshDiscovery()));
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  /**
   * Poll for `predicate`, re-running discovery between attempts.
   *
   * A single refresh is not reliable on a local testnet: whether a node sees
   * the other depends on whether its announce query happened to run after the
   * peer published. Retrying converges quickly instead of racing one window.
   *
   * The budget is deliberately generous — this suite shares a machine with CI,
   * and a short budget turns a slow host into a false "peer was blocked" pass.
   * `npm test` also pins --test-concurrency=1 so the testnet is not competing
   * with the other suites for the event loop.
   */
  async function waitForCondition(
    nodes: Harness[],
    predicate: () => boolean,
    attempts = 20,
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (predicate()) return true;
      await Promise.all(nodes.map((n) => n.node.refreshDiscovery()));
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return predicate();
  }

  it("connects two mutually-allowlisted peers and exchanges the handshake", async () => {
    const aKey = Buffer.from(DHT.keyPair(Buffer.alloc(32, 11)).publicKey).toString("hex");
    const bKey = Buffer.from(DHT.keyPair(Buffer.alloc(32, 12)).publicKey).toString("hex");

    const a = makeNode({
      seed: 11,
      authMode: "strict",
      allow: [bKey],
      state: { mission: "from-a" },
    });
    const b = makeNode({
      seed: 12,
      authMode: "strict",
      allow: [aKey],
      state: { mission: "from-b" },
    });

    try {
      await connect([a, b]);
      const linked = await waitForCondition(
        [a, b],
        () => a.received.length > 0 && b.received.length > 0,
      );

      assert.ok(linked, "mutually allowlisted peers should exchange handshakes");
      assert.ok(
        a.node.connectionCount() > 0 && b.node.connectionCount() > 0,
        "both sides should hold a live connection",
      );
      assert.equal(a.received[0]?.envelope.type, "snapshot");
      assert.equal(b.received[0]?.envelope.type, "snapshot");
      assert.equal(a.node.blockedConnections, 0);
      assert.equal(b.node.blockedConnections, 0);
    } finally {
      await a.node.close();
      await b.node.close();
    }
  });

  it("refuses a peer that is not allowlisted — no state is shared", async () => {
    const victimKey = Buffer.from(DHT.keyPair(Buffer.alloc(32, 21)).publicKey).toString("hex");

    // The victim allowlists nobody; the attacker knows the topic and allowlists
    // the victim, which is exactly the pre-0.7 threat model.
    const victim = makeNode({
      seed: 21,
      authMode: "strict",
      allow: [],
      state: { secret_plan: "do not leak" },
    });
    const attacker = makeNode({
      seed: 22,
      authMode: "open",
      allow: [victimKey],
      state: { evil: "takeover" },
    });

    try {
      await connect([victim, attacker]);

      // Wait for positive proof that the gate actually ran: the victim's
      // firewall must have SEEN and REFUSED the attacker's key. Asserting only
      // "nothing was received" would also pass if the two never found each
      // other, which would make this test worthless.
      const refused = await waitForCondition(
        [victim, attacker],
        () => victim.node.blockedConnections > 0,
      );
      assert.ok(
        refused,
        "victim's firewall should have refused the attacker at least once",
      );

      assert.equal(
        victim.received.length,
        0,
        "victim must not accept any envelope from an unlisted peer",
      );
      assert.equal(
        attacker.received.length,
        0,
        "attacker must never receive the victim's handshake snapshot",
      );
      assert.equal(victim.node.connectionCount(), 0, "no connection should survive");
    } finally {
      await victim.node.close();
      await attacker.node.close();
    }
  });

  it("open mode still connects an unlisted peer (backwards compatibility)", async () => {
    const a = makeNode({ seed: 31, authMode: "open", allow: [], state: { k: "a" } });
    const b = makeNode({ seed: 32, authMode: "open", allow: [], state: { k: "b" } });

    try {
      await connect([a, b]);
      const linked = await waitForCondition(
        [a, b],
        () => a.received.length > 0 && b.received.length > 0,
      );

      assert.ok(linked, "open mode must preserve pre-0.7 behaviour");
    } finally {
      await a.node.close();
      await b.node.close();
    }
  });
});
