/**
 * The agent roster, and directed messages.
 *
 * Leases stop two agents doing the same work. They do not say which agent should
 * do it, because a peer used to be nothing but a hex fingerprint. These pin the
 * two properties the roster has to have to be usable for routing:
 *
 * - a card can only be written by the agent it describes, so the roster cannot
 *   be poisoned by a peer announcing on someone else's behalf, and
 * - liveness comes from the card's own timestamp, so an agent that stops
 *   refreshing goes stale rather than lingering as available forever.
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
import { EventBus } from "../src/events.js";
import { OpSigner } from "../src/signing.js";
import {
  AGENT_KEY_PREFIX,
  PRESENCE_STALE_MS,
  agentKeyFor,
  buildCard,
  candidatesFor,
  describeCard,
  isOwnCard,
  parseCard,
} from "../src/presence.js";
import { CrdtOpArraySchema, PeerEnvelopeSchema } from "../src/types.js";
import { announceSelf, applyPeerSnapshot, handleInboundOps } from "../src/sync.js";
import type { SyncServices } from "../src/sync.js";
import type { CrdtOp } from "../src/crdt.js";

interface Node extends SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  contention: ContentionLog;
  events: EventBus;
  dir: string;
  pubkey: string;
}

function makeNode(name: string): Node {
  const dir = mkdtempSync(join(tmpdir(), `p2pa-presence-${name}-`));
  const log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
  const seed = randomBytes(32);
  const keyPair = DHT.keyPair(seed);
  const pubkey = Buffer.from(keyPair.publicKey).toString("hex");
  return {
    store: new ContextStore(pubkey, Date.now, new OpSigner(seed, pubkey)),
    log,
    contention: new ContentionLog(),
    events: new EventBus(),
    dir,
    pubkey,
  };
}

let reviewer: Node;
let builder: Node;

beforeEach(() => {
  reviewer = makeNode("reviewer");
  builder = makeNode("builder");
});

afterEach(() => {
  rmSync(reviewer.dir, { recursive: true, force: true });
  rmSync(builder.dir, { recursive: true, force: true });
});

describe("announcing an agent", () => {
  it("publishes a card under this node's own key", () => {
    const result = announceSelf(
      reviewer,
      buildCard({ role: "reviewer", capabilities: ["typescript"], status: "idle" }),
    );
    assert.ok(result.ok);

    const card = reviewer.store.ownCard();
    assert.ok(card);
    assert.equal(card.role, "reviewer");
    assert.deepEqual(card.capabilities, ["typescript"]);
  });

  it("shows up on the peer's roster after a sync", () => {
    announceSelf(
      reviewer,
      buildCard({ role: "reviewer", capabilities: ["typescript"], status: "idle" }),
    );
    applyPeerSnapshot(builder, reviewer.store.export(), "Peer");

    const roster = builder.store.listAgents();
    assert.equal(roster.length, 1);
    assert.equal(roster[0]?.role, "reviewer");
    assert.equal(roster[0]?.nodeId, reviewer.store.nodeId);
    assert.equal(roster[0]?.isSelf, false);
    assert.equal(roster[0]?.live, true);
  });

  it("marks its own card as self so an agent does not route work to itself", () => {
    announceSelf(reviewer, buildCard({ role: "reviewer", status: "idle" }));
    const mine = reviewer.store.listAgents().find((agent) => agent.isSelf);
    assert.ok(mine);
    assert.equal(mine.nodeId, reviewer.store.nodeId);
  });

  it("wakes a waiting agent with a presence event, not a bare key change", () => {
    announceSelf(reviewer, buildCard({ role: "reviewer", status: "idle" }));
    handleInboundOps(
      builder,
      reviewer.store.export().filter((op) => op.key.startsWith(AGENT_KEY_PREFIX)),
      "Peer",
      { fingerprint: "abcd1234", label: null },
      reviewer.pubkey,
    );

    const events = builder.events.recent(10);
    const presence = events.find((event) => event.kind === "presence");
    assert.ok(presence, "a peer joining should raise a presence event");
    assert.equal(presence.role, "reviewer");
    assert.equal(presence.status, "idle");
  });

  it("refuses a direct write into the agent namespace", () => {
    // Cards go through announce, which derives the key from this node's own id.
    assert.throws(
      () => reviewer.store.setKey(agentKeyFor(builder.store.nodeId), { role: "x" }),
      /agent-presence namespace/,
    );
  });
});

describe("a card cannot be forged", () => {
  it("rejects a card stamped by a node other than the one it describes", () => {
    const forged: CrdtOp = {
      key: agentKeyFor(reviewer.store.nodeId),
      entry: {
        kind: "lww",
        // Builder stamping a card that claims to be the reviewer's.
        hlc: { w: Date.now(), c: 0, n: builder.store.nodeId },
        value: {
          role: "reviewer",
          capabilities: [],
          status: "idle",
          at: new Date().toISOString(),
        },
      },
    };

    // Refused at the validation boundary, so every path in is covered at once.
    assert.equal(CrdtOpArraySchema.safeParse([forged]).success, false);

    const summary = applyPeerSnapshot(builder, [forged], "Peer");
    assert.equal(summary.applied, 0);
    assert.ok(summary.rejected > 0);
  });

  it("rejects a lease entry parked in the agent namespace", () => {
    const wrongKind: CrdtOp = {
      key: agentKeyFor(reviewer.store.nodeId),
      entry: {
        kind: "claim",
        hlc: { w: Date.now(), c: 0, n: reviewer.store.nodeId },
        gen: 0,
        ttl: 60_000,
      },
    };
    assert.equal(CrdtOpArraySchema.safeParse([wrongKind]).success, false);
  });

  it("agrees with the ownership predicate it is built on", () => {
    const mine = "a3f9c1b2d4e5f607";
    const theirs = "0011223344556677";
    assert.equal(isOwnCard(agentKeyFor(mine), mine), true);
    assert.equal(isOwnCard(agentKeyFor(mine), theirs), false);
    assert.equal(isOwnCard("plan", mine), false);
  });

  it("refuses a card slot whose node id is not a full 16 hex characters", () => {
    // A card at a short id would be a valid roster entry that any lookup for that
    // id could resolve to, which is how a directed question reaches the wrong
    // agent. The slot itself has to be exact.
    for (const short of ["abc", "c", "a3f9"]) {
      assert.equal(
        isOwnCard(agentKeyFor(short), short),
        false,
        `${short} must not own a card slot`,
      );
    }
  });

  it("skips a card whose stamp stopped matching after a hand edit", () => {
    // The wire cannot deliver this, but a hand-edited replica file can.
    announceSelf(reviewer, buildCard({ role: "reviewer", status: "idle" }));
    const ops = reviewer.store.export().map((op) =>
      op.key.startsWith(AGENT_KEY_PREFIX)
        ? { key: agentKeyFor("someoneelse"), entry: op.entry }
        : op,
    );

    const fresh = makeNode("rehydrated");
    try {
      fresh.store.load(ops);
      assert.equal(
        fresh.store.listAgents().length,
        0,
        "a card in the wrong slot must not appear on the roster",
      );
    } finally {
      rmSync(fresh.dir, { recursive: true, force: true });
    }
  });
});

describe("liveness", () => {
  it("reports a fresh card as live", () => {
    const now = Date.now();
    const card = buildCard({ role: "builder", status: "idle", now });
    assert.equal(describeCard("node1", card, now, "other").live, true);
  });

  it("reports a card that stopped being refreshed as stale", () => {
    const now = Date.now();
    const card = buildCard({ role: "builder", status: "idle", now });
    const later = now + PRESENCE_STALE_MS + 1_000;
    const view = describeCard("node1", card, later, "other");
    assert.equal(view.live, false);
    assert.ok(view.ageMs > PRESENCE_STALE_MS);
  });

  it("treats an explicit offline card as not live even when fresh", () => {
    const now = Date.now();
    const card = buildCard({ role: "builder", status: "offline", now });
    assert.equal(describeCard("node1", card, now, "other").live, false);
  });

  it("treats an unparseable timestamp as stale rather than live", () => {
    const view = describeCard(
      "node1",
      { role: "x", capabilities: [], status: "idle", at: "not-a-date" },
      Date.now(),
      "other",
    );
    assert.equal(view.live, false);
  });
});

describe("choosing who to hand work to", () => {
  const now = Date.now();
  const roster = [
    describeCard("aaaa", buildCard({ role: "reviewer", capabilities: ["ts"], status: "idle", now }), now, "me"),
    describeCard("bbbb", buildCard({ role: "builder", capabilities: ["ts", "sql"], status: "working", now }), now, "me"),
    describeCard("cccc", buildCard({ role: "builder", capabilities: ["sql"], status: "idle", now }), now, "me"),
    describeCard("me", buildCard({ role: "planner", capabilities: ["ts"], status: "idle", now }), now, "me"),
    describeCard("dddd", buildCard({ role: "builder", capabilities: ["ts"], status: "idle", now: now - PRESENCE_STALE_MS - 1 }), now, "me"),
  ];

  it("offers only live, idle peers", () => {
    const picked = candidatesFor(roster, undefined).map((agent) => agent.nodeId);
    assert.deepEqual(picked.sort(), ["aaaa", "cccc"]);
  });

  it("never offers the asking agent itself", () => {
    assert.equal(
      candidatesFor(roster, "ts").some((agent) => agent.isSelf),
      false,
    );
  });

  it("filters by capability", () => {
    assert.deepEqual(
      candidatesFor(roster, "sql").map((agent) => agent.nodeId),
      ["cccc"],
    );
  });

  it("returns nothing rather than guessing when no peer matches", () => {
    assert.deepEqual(candidatesFor(roster, "cobol"), []);
  });
});

describe("card validation", () => {
  it("rejects a card missing a role", () => {
    assert.equal(parseCard({ status: "idle", at: new Date().toISOString() }), null);
  });

  it("rejects an unknown status", () => {
    assert.equal(
      parseCard({ role: "x", status: "vibing", at: new Date().toISOString() }),
      null,
    );
  });

  it("truncates oversized fields rather than refusing the announce", () => {
    const card = buildCard({
      role: "r".repeat(500),
      capabilities: Array.from({ length: 200 }, (_, i) => `c${i}`),
      status: "idle",
    });
    assert.ok(card.role.length <= 64);
    assert.ok(card.capabilities.length <= 32);
  });
});

describe("directed messages", () => {
  it("carries a recipient, correlation id and intent on the wire", () => {
    const parsed = PeerEnvelopeSchema.safeParse({
      type: "message",
      v: 4,
      text: "can you review this diff?",
      to: "a".repeat(64),
      corr: "abc123",
      intent: "ask",
    });
    assert.equal(parsed.success, true);
    if (parsed.success && parsed.data.type === "message") {
      assert.equal(parsed.data.intent, "ask");
      assert.equal(parsed.data.corr, "abc123");
    }
  });

  it("still accepts an unaddressed broadcast, as v3 sent", () => {
    const parsed = PeerEnvelopeSchema.safeParse({
      type: "message",
      v: 3,
      text: "morning",
    });
    assert.equal(parsed.success, true);
  });

  it("rejects a recipient that is not a public key", () => {
    for (const to of ["nope", "A".repeat(64), "a".repeat(63)]) {
      const parsed = PeerEnvelopeSchema.safeParse({
        type: "message",
        v: 4,
        text: "hi",
        to,
      });
      assert.equal(parsed.success, false, `${to} should be refused`);
    }
  });

  it("rejects an intent outside the three the protocol defines", () => {
    const parsed = PeerEnvelopeSchema.safeParse({
      type: "message",
      v: 4,
      text: "hi",
      intent: "demand",
    });
    assert.equal(parsed.success, false);
  });
});
