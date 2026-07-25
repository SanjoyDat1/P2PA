/**
 * Work-claiming leases.
 *
 * The property that matters: two agents racing for the same task converge on
 * exactly one holder, in any delivery order, without either asking the other.
 * The rest of these pin the behaviour that makes a lease usable in practice —
 * it outlives a network blip, it does not outlive its TTL, and a crashed holder
 * cannot block a task forever.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  CLAIM_KEY_PREFIX,
  DEFAULT_CLAIM_TTL_MS,
  MAX_ACCEPTED_CLAIM_GEN,
  MAX_CLAIM_GEN,
  MAX_CLAIM_TTL_MS,
  claimKeyFor,
  claimWins,
  type ClaimEntry,
} from "../src/claim.js";
import type { CrdtOp } from "../src/crdt.js";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { ContentionLog } from "../src/conflicts.js";
import {
  claimTask,
  handleInboundOps,
  releaseTask,
  type SyncServices,
} from "../src/sync.js";
import { PeerEnvelopeSchema, PROTOCOL_VERSION } from "../src/types.js";

interface Node extends SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  contention: ContentionLog;
  dir: string;
}

function makeNode(name: string, idChar: string, now?: () => number): Node {
  const dir = mkdtempSync(join(tmpdir(), `p2pa-claim-${name}-`));
  const log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
  return {
    store: new ContextStore(idChar.repeat(64), now),
    log,
    contention: new ContentionLog(),
    dir,
  };
}

function opsFor(node: Node, taskId: string): CrdtOp[] {
  const entry = node.store.claim(taskId);
  assert.ok(entry, `expected a lease on ${taskId}`);
  return [{ key: claimKeyFor(taskId), entry }];
}

let a: Node;
let b: Node;

beforeEach(() => {
  a = makeNode("a", "a");
  b = makeNode("b", "b");
});

afterEach(() => {
  rmSync(a.dir, { recursive: true, force: true });
  rmSync(b.dir, { recursive: true, force: true });
});

describe("racing for the same task", () => {
  it("settles on exactly one holder", () => {
    assert.ok(claimTask(a, "refactor-auth", DEFAULT_CLAIM_TTL_MS).ok);
    assert.ok(claimTask(b, "refactor-auth", DEFAULT_CLAIM_TTL_MS).ok);

    // Both claimed locally; now they exchange.
    handleInboundOps(b, opsFor(a, "refactor-auth"), "Peer");
    handleInboundOps(a, opsFor(b, "refactor-auth"), "Peer");

    const holderA = a.store.holder("refactor-auth");
    const holderB = b.store.holder("refactor-auth");
    assert.equal(holderA, holderB, "both replicas must name the same holder");
    assert.ok(holderA !== null, "somebody must hold it");
  });

  it("reaches the same holder whichever order the ops arrive in", () => {
    const first = makeNode("r1", "c");
    const second = makeNode("r2", "d");
    const witness = makeNode("r3", "e");
    try {
      claimTask(first, "shared-task", DEFAULT_CLAIM_TTL_MS);
      claimTask(second, "shared-task", DEFAULT_CLAIM_TTL_MS);
      const fromFirst = opsFor(first, "shared-task");
      const fromSecond = opsFor(second, "shared-task");

      handleInboundOps(witness, fromFirst, "Peer");
      handleInboundOps(witness, fromSecond, "Peer");

      const reversed = makeNode("r4", "f");
      try {
        handleInboundOps(reversed, fromSecond, "Peer");
        handleInboundOps(reversed, fromFirst, "Peer");
        assert.equal(
          witness.store.holder("shared-task"),
          reversed.store.holder("shared-task"),
        );
      } finally {
        rmSync(reversed.dir, { recursive: true, force: true });
      }
    } finally {
      for (const node of [first, second, witness]) {
        rmSync(node.dir, { recursive: true, force: true });
      }
    }
  });

  it("gives the task to whoever asked first, not whoever wrote last", () => {
    let wall = 1_700_000_000_000;
    const early = makeNode("early", "c", () => wall);
    const late = makeNode("late", "d", () => wall);
    try {
      claimTask(early, "task", DEFAULT_CLAIM_TTL_MS);
      wall += 1000;
      claimTask(late, "task", DEFAULT_CLAIM_TTL_MS);

      handleInboundOps(early, opsFor(late, "task"), "Peer");
      handleInboundOps(late, opsFor(early, "task"), "Peer");

      assert.equal(early.store.holder("task", wall), early.store.nodeId);
      assert.equal(late.store.holder("task", wall), early.store.nodeId);
    } finally {
      rmSync(early.dir, { recursive: true, force: true });
      rmSync(late.dir, { recursive: true, force: true });
    }
  });

  it("tells the loser who holds the task", () => {
    claimTask(a, "task", DEFAULT_CLAIM_TTL_MS);
    handleInboundOps(b, opsFor(a, "task"), "Peer");

    const denied = claimTask(b, "task", DEFAULT_CLAIM_TTL_MS);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.holder, a.store.nodeId);
  });
});

describe("lease lifetime", () => {
  it("survives a disconnect and reconnect", () => {
    claimTask(a, "long-task", DEFAULT_CLAIM_TTL_MS);
    const held = opsFor(a, "long-task");

    // b learns of it, they part, then exchange handshakes again later.
    handleInboundOps(b, held, "Peer");
    handleInboundOps(b, held, "Peer");
    handleInboundOps(a, opsFor(b, "long-task"), "Peer");

    assert.equal(a.store.holder("long-task"), a.store.nodeId);
    assert.equal(b.store.holder("long-task"), a.store.nodeId);
  });

  it("expires on its own so a crashed holder cannot block the task", () => {
    let wall = 1_700_000_000_000;
    const holder = makeNode("holder", "c", () => wall);
    try {
      claimTask(holder, "task", 60_000);
      assert.equal(holder.store.holder("task", wall), holder.store.nodeId);

      // The holder goes away without ever releasing.
      wall += 61_000;
      assert.equal(holder.store.holder("task", wall), null, "lease must lapse");
    } finally {
      rmSync(holder.dir, { recursive: true, force: true });
    }
  });

  it("lets another agent take an expired task", () => {
    let wall = 1_700_000_000_000;
    const crashed = makeNode("crashed", "c", () => wall);
    const rescuer = makeNode("rescuer", "d", () => wall);
    try {
      claimTask(crashed, "task", 60_000);
      handleInboundOps(rescuer, opsFor(crashed, "task"), "Peer");

      wall += 95_000;
      const retaken = claimTask(rescuer, "task", 60_000);
      assert.ok(retaken.ok, "an expired task must be claimable");
      assert.equal(rescuer.store.holder("task", wall), rescuer.store.nodeId);
    } finally {
      rmSync(crashed.dir, { recursive: true, force: true });
      rmSync(rescuer.dir, { recursive: true, force: true });
    }
  });

  it("cannot be reinstated by a stale op once its successor is on record", () => {
    let wall = 1_700_000_000_000;
    const first = makeNode("first", "c", () => wall);
    const second = makeNode("second", "d", () => wall);
    try {
      claimTask(first, "task", 60_000);
      const stale = opsFor(first, "task");

      // The lease lapses, and enough clock-skew grace passes that another
      // node may safely take over.
      wall += 95_000;
      handleInboundOps(second, stale, "Peer");
      assert.ok(claimTask(second, "task", 60_000).ok);

      // The original op turns up again afterwards.
      handleInboundOps(second, stale, "Peer");

      assert.equal(
        second.store.holder("task", wall),
        second.store.nodeId,
        "a lapsed generation must not come back",
      );
    } finally {
      rmSync(first.dir, { recursive: true, force: true });
      rmSync(second.dir, { recursive: true, force: true });
    }
  });

  it("never lets a lapsed lease and its replacement both look held", () => {
    // The awkward case: `second` never saw the first lease, so it opens the
    // same generation. Whoever wins, the invariant that matters is that the two
    // replicas agree and an expired holder is not reported as holding.
    let wall = 1_700_000_000_000;
    const first = makeNode("blind1", "c", () => wall);
    const second = makeNode("blind2", "d", () => wall);
    try {
      claimTask(first, "task", 60_000);
      const stale = opsFor(first, "task");

      wall += 95_000;
      claimTask(second, "task", 60_000);
      handleInboundOps(second, stale, "Peer");
      handleInboundOps(first, opsFor(second, "task"), "Peer");

      assert.equal(
        first.store.holder("task", wall),
        second.store.holder("task", wall),
        "replicas must agree on the holder",
      );
      assert.notEqual(
        second.store.holder("task", wall),
        first.store.nodeId,
        "an expired lease must never be reported as held",
      );
    } finally {
      rmSync(first.dir, { recursive: true, force: true });
      rmSync(second.dir, { recursive: true, force: true });
    }
  });

  it("renews without handing the task to anyone else", () => {
    let wall = 1_700_000_000_000;
    const holder = makeNode("renew", "c", () => wall);
    try {
      claimTask(holder, "task", 60_000);
      wall += 30_000;
      const renewed = claimTask(holder, "task", 60_000);
      assert.ok(renewed.ok);

      wall += 40_000;
      assert.equal(
        holder.store.holder("task", wall),
        holder.store.nodeId,
        "renewal must extend the lease past the original expiry",
      );
    } finally {
      rmSync(holder.dir, { recursive: true, force: true });
    }
  });
});

describe("release", () => {
  it("frees the task for another agent immediately", () => {
    claimTask(a, "task", DEFAULT_CLAIM_TTL_MS);
    handleInboundOps(b, opsFor(a, "task"), "Peer");
    assert.equal(claimTask(b, "task", DEFAULT_CLAIM_TTL_MS).ok, false);

    assert.ok(releaseTask(a, "task").ok);
    handleInboundOps(b, opsFor(a, "task"), "Peer");

    assert.equal(b.store.holder("task"), null);
    assert.ok(claimTask(b, "task", DEFAULT_CLAIM_TTL_MS).ok);
  });

  it("cannot be undone by a claim that was still in flight", () => {
    claimTask(a, "task", DEFAULT_CLAIM_TTL_MS);
    const inFlight = opsFor(a, "task");
    releaseTask(a, "task");

    // The original claim arrives after the release.
    handleInboundOps(b, opsFor(a, "task"), "Peer");
    handleInboundOps(b, inFlight, "Peer");

    assert.equal(b.store.holder("task"), null, "release is terminal for its generation");
  });

  it("refuses a forged release from a peer that does not hold the task", () => {
    claimTask(a, "task", DEFAULT_CLAIM_TTL_MS);
    const entry = a.store.claim("task");
    assert.ok(entry);

    // Stamping with its own identity gets the attacker past sender binding, but
    // the release then no longer carries the holder's stamp, so it does not beat
    // the claim it was meant to end.
    const ownIdentity = handleInboundOps(
      a,
      [
        {
          key: claimKeyFor("task"),
          entry: { ...entry, released: true, hlc: { ...entry.hlc, n: "b".repeat(16) } },
        },
      ],
      "Peer",
      undefined,
      "b".repeat(64),
    );
    assert.equal(ownIdentity.applied, 0);
    assert.equal(a.store.holder("task"), a.store.nodeId, "lease must survive");

    // Copying the holder's stamp is what would actually win — and that is
    // exactly what sender binding refuses.
    const forgedIdentity = handleInboundOps(
      a,
      [{ key: claimKeyFor("task"), entry: { ...entry, released: true } }],
      "Peer",
      undefined,
      "b".repeat(64),
    );
    assert.equal(forgedIdentity.rejected, 1);
    assert.equal(a.store.holder("task"), a.store.nodeId, "lease must survive");
  });

  it("refuses to release a task held by someone else", () => {
    claimTask(a, "task", DEFAULT_CLAIM_TTL_MS);
    handleInboundOps(b, opsFor(a, "task"), "Peer");

    const result = releaseTask(b, "task");
    assert.equal(result.ok, false);
    assert.equal(b.store.holder("task"), a.store.nodeId);
  });
});

describe("lease merge is a semilattice", () => {
  const base: ClaimEntry = {
    kind: "claim",
    hlc: { w: 1_000, c: 0, n: "1111111111111111" },
    gen: 1,
    ttl: 60_000,
  };

  it("is idempotent", () => {
    assert.equal(claimWins(base, base), false);
  });

  it("prefers the higher generation regardless of stamp", () => {
    const older = { ...base, gen: 2, hlc: { w: 500, c: 0, n: "2222222222222222" } };
    assert.equal(claimWins(older, base), true);
    assert.equal(claimWins(base, older), false);
  });

  it("prefers a release over the exact claim it ends", () => {
    // A release carries the stamp of the claim it ends, which is what makes it
    // beat that claim and nothing else.
    const released = { ...base, released: true };
    assert.equal(claimWins(released, base), true);
    assert.equal(claimWins(base, released), false);
  });

  it("does not let a release end a different, earlier claim", () => {
    const earlier: ClaimEntry = {
      ...base,
      hlc: { w: 500, c: 0, n: "2222222222222222" },
    };
    const released = { ...base, released: true };
    assert.equal(claimWins(released, earlier), false);
  });
});

describe("leases are isolated from ordinary state", () => {
  it("refuses a state write into the lease namespace", () => {
    assert.throws(() => a.store.setKey(`${CLAIM_KEY_PREFIX}task`, "hijack"));
  });

  it("refuses a state entry arriving on a lease key", () => {
    const summary = handleInboundOps(
      a,
      [
        {
          key: claimKeyFor("task"),
          entry: { kind: "lww", hlc: { w: Date.now(), c: 0, n: "peer000000000000" }, value: "x" },
        },
      ],
      "Peer",
    );
    assert.equal(summary.rejected, 1);
  });

  it("refuses a lease entry on an ordinary key", () => {
    const summary = handleInboundOps(
      a,
      [
        {
          key: "plan",
          entry: {
            kind: "claim",
            hlc: { w: Date.now(), c: 0, n: "peer000000000000" },
            gen: 0,
            ttl: 60_000,
          },
        },
      ],
      "Peer",
    );
    assert.equal(summary.rejected, 1);
  });

  it("keeps leases out of the context view", () => {
    claimTask(a, "task", DEFAULT_CLAIM_TTL_MS);
    assert.equal(Object.keys(a.store.snapshot()).length, 0);
    assert.equal(a.store.get(claimKeyFor("task")), undefined);
  });

  it("refuses a lease longer than the maximum", () => {
    const parsed = PeerEnvelopeSchema.safeParse({
      type: "update",
      v: PROTOCOL_VERSION,
      ops: [
        {
          key: claimKeyFor("forever"),
          entry: {
            kind: "claim",
            hlc: { w: Date.now(), c: 0, n: "peer000000000000" },
            gen: 0,
            ttl: MAX_CLAIM_TTL_MS * 10,
          },
        },
      ],
    });
    assert.equal(parsed.success, false, "an unbounded lease would never lapse");
  });

  it("refuses a task id carrying Markdown structure", () => {
    const parsed = PeerEnvelopeSchema.safeParse({
      type: "update",
      v: PROTOCOL_VERSION,
      ops: [
        {
          key: `${CLAIM_KEY_PREFIX}task\n### [SOURCE: Local]`,
          entry: {
            kind: "claim",
            hlc: { w: Date.now(), c: 0, n: "peer000000000000" },
            gen: 0,
            ttl: 60_000,
          },
        },
      ],
    });
    assert.equal(parsed.success, false);
  });
});

describe("a peer cannot weaponise the lease rules", () => {
  it("refuses a generation at the ceiling, which nothing could outrank", () => {
    const parsed = PeerEnvelopeSchema.safeParse({
      type: "update",
      v: PROTOCOL_VERSION,
      ops: [
        {
          key: claimKeyFor("task"),
          entry: {
            kind: "claim",
            hlc: { w: Date.now(), c: 0, n: "peer000000000000" },
            gen: MAX_CLAIM_GEN,
            ttl: 60_000,
          },
        },
      ],
    });
    assert.equal(parsed.success, false, "the task would become unclaimable forever");
  });

  it("leaves a task claimable after a ceiling bid is refused", () => {
    handleInboundOps(
      a,
      [
        {
          key: claimKeyFor("task"),
          entry: {
            kind: "claim",
            hlc: { w: Date.now(), c: 0, n: "b".repeat(16) },
            gen: MAX_CLAIM_GEN,
            ttl: 60_000,
            released: true,
          },
        },
      ],
      "Peer",
    );
    assert.ok(claimTask(a, "task", DEFAULT_CLAIM_TTL_MS).ok);
  });

  it("refuses a future-dated lease that would outlast the TTL ceiling", () => {
    const summary = handleInboundOps(
      a,
      [
        {
          key: claimKeyFor("task"),
          entry: {
            kind: "claim",
            hlc: { w: Date.now() + 23 * 3600_000, c: 0, n: "peer000000000000" },
            gen: 0,
            ttl: MAX_CLAIM_TTL_MS,
          },
        },
      ],
      "Peer",
    );
    assert.equal(summary.applied, 0);
  });

  it("keeps shared state when a peer floods the lease namespace", () => {
    a.store.setKey("plan", "important");
    handleInboundOps(
      a,
      Array.from({ length: 2_000 }, (_, i) => ({
        key: claimKeyFor(`spam-${i}`),
        entry: {
          kind: "claim" as const,
          hlc: { w: Date.now(), c: i, n: "b".repeat(16) },
          gen: 0,
          ttl: 60_000,
        },
      })),
      "Peer",
    );

    const reloaded = new ContextStore("a".repeat(64));
    reloaded.load(a.store.export());
    assert.equal(reloaded.get("plan"), "important");
  });

  it("never reports holding a lease the merge rule would discard", () => {
    handleInboundOps(
      a,
      [
        {
          key: claimKeyFor("task"),
          entry: {
            kind: "claim",
            hlc: { w: Date.now(), c: 0, n: "b".repeat(16) },
            gen: MAX_ACCEPTED_CLAIM_GEN,
            ttl: 600_000,
          },
        },
      ],
      "Peer",
    );
    const mine = claimTask(a, "task", DEFAULT_CLAIM_TTL_MS);
    if (mine.ok) {
      assert.ok(a.store.holdsClaim("task"), "a reported win must be a real win");
    }
  });

  it("does not treat a lease as lapsed just because the local clock runs fast", () => {
    let wall = 1_700_000_000_000;
    const holder = makeNode("slow", "c", () => wall);
    const fast = makeNode("fast", "d", () => wall);
    try {
      claimTask(holder, "task", 60_000);
      handleInboundOps(fast, opsFor(holder, "task"), "Peer");

      // Just past expiry, but inside the skew grace.
      wall += 60_500;
      assert.equal(
        claimTask(fast, "task", 60_000).ok,
        false,
        "a few seconds of clock drift must not hand the task to someone else",
      );
    } finally {
      rmSync(holder.dir, { recursive: true, force: true });
      rmSync(fast.dir, { recursive: true, force: true });
    }
  });
});

describe("the log shows who is working on what", () => {
  it("lists live claims in a readable table", () => {
    claimTask(a, "refactor-auth", DEFAULT_CLAIM_TTL_MS, "splitting the token module");
    const text = readFileSync(a.log.path, "utf8");
    assert.match(text, /## Claims/);
    assert.match(text, /refactor-auth/);
    assert.match(text, /splitting the token module/);
  });

  it("drops a task from the table once released", () => {
    claimTask(a, "refactor-auth", DEFAULT_CLAIM_TTL_MS);
    releaseTask(a, "refactor-auth");
    const text = readFileSync(a.log.path, "utf8");
    const claimsSection = text.slice(text.indexOf("## Claims"), text.indexOf("## Audit"));
    assert.doesNotMatch(claimsSection, /refactor-auth/);
  });
});
