/**
 * Waiting on peer activity.
 *
 * The exit criterion is that an agent blocked on `await_peer_event` wakes
 * within one round trip of the peer acting, with no polling loop. The rest pin
 * the bounds, because every event here originates from a peer: an unbounded
 * buffer, waiter list, or wait duration would each be a remote way to exhaust
 * the node.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  EventBus,
  MAX_EVENTS,
  MAX_EVENT_TEXT,
  MAX_WAITERS,
  MAX_WAIT_MS,
} from "../src/events.js";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { ContentionLog } from "../src/conflicts.js";
import { claimKeyFor } from "../src/claim.js";
import {
  claimTask,
  commitLocalMutation,
  handleInboundOps,
  recordMessage,
  type SyncServices,
} from "../src/sync.js";
import type { CrdtOp } from "../src/crdt.js";

interface Node extends SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  contention: ContentionLog;
  events: EventBus;
  dir: string;
}

function makeNode(name: string, idChar: string): Node {
  const dir = mkdtempSync(join(tmpdir(), `p2pa-events-${name}-`));
  const log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
  return {
    store: new ContextStore(idChar.repeat(64)),
    log,
    contention: new ContentionLog(),
    events: new EventBus(),
    dir,
  };
}

let node: Node;
let peer: Node;

beforeEach(() => {
  node = makeNode("local", "a");
  peer = makeNode("peer", "b");
});

afterEach(() => {
  node.events.close();
  peer.events.close();
  rmSync(node.dir, { recursive: true, force: true });
  rmSync(peer.dir, { recursive: true, force: true });
});

describe("waking on peer activity", () => {
  it("resolves as soon as a peer changes state", async () => {
    const waiting = node.events.wait(0, MAX_WAIT_MS);

    const pushed = commitLocalMutation(peer, (store) =>
      store.setKey("plan", "from peer"),
    );
    assert.ok(pushed.ok);
    handleInboundOps(node, pushed.ops, "Peer", {
      fingerprint: "deadbeef",
      label: null,
    });

    const events = await waiting;
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "state");
    assert.deepEqual(events[0]?.keys, ["plan"]);
    assert.equal(events[0]?.peer, "deadbeef");
  });

  it("resolves on a peer message", async () => {
    const waiting = node.events.wait(0, MAX_WAIT_MS);
    recordMessage(node, "ship it", "Peer", false, {
      fingerprint: "deadbeef",
      label: null,
    });

    const events = await waiting;
    assert.equal(events[0]?.kind, "message");
    assert.equal(events[0]?.text, "ship it");
  });

  it("resolves when a peer claims a task", async () => {
    claimTask(peer, "refactor-auth", 60_000);
    const entry = peer.store.claim("refactor-auth");
    assert.ok(entry);

    const waiting = node.events.wait(0, MAX_WAIT_MS);
    handleInboundOps(
      node,
      [{ key: claimKeyFor("refactor-auth"), entry }] as CrdtOp[],
      "Peer",
      { fingerprint: "deadbeef", label: null },
    );

    const events = await waiting;
    assert.equal(events[0]?.kind, "claim");
    assert.equal(events[0]?.taskId, "refactor-auth");
  });

  it("does not wake on this node's own activity", async () => {
    // Otherwise an agent wakes itself up every time it writes.
    commitLocalMutation(node, (store) => store.setKey("mine", "local"));
    claimTask(node, "my-task", 60_000);
    assert.equal(node.events.latestSeq, 0);
  });

  it("returns empty rather than failing when nothing happens", async () => {
    const events = await node.events.wait(0, 30);
    assert.deepEqual(events, []);
  });
});

describe("not missing events between calls", () => {
  it("returns immediately when something already happened", async () => {
    node.events.emit({ kind: "message", peer: "deadbeef", text: "first" });

    const started = Date.now();
    const events = await node.events.wait(0, MAX_WAIT_MS);
    assert.equal(events.length, 1);
    assert.ok(Date.now() - started < 500, "must not block for an event already in hand");
  });

  it("replays everything after the caller's cursor", async () => {
    node.events.emit({ kind: "message", peer: "p", text: "one" });
    node.events.emit({ kind: "message", peer: "p", text: "two" });
    node.events.emit({ kind: "message", peer: "p", text: "three" });

    const events = await node.events.wait(1, MAX_WAIT_MS);
    assert.deepEqual(
      events.map((event) => event.text),
      ["two", "three"],
    );
  });

  it("hands each event a cursor that only moves forward", () => {
    const first = node.events.emit({ kind: "message", peer: "p", text: "a" });
    const second = node.events.emit({ kind: "message", peer: "p", text: "b" });
    assert.ok(second.seq > first.seq);
    assert.equal(node.events.latestSeq, second.seq);
  });

  it("wakes every waiter, not just the first", async () => {
    const waiters = [
      node.events.wait(0, MAX_WAIT_MS),
      node.events.wait(0, MAX_WAIT_MS),
      node.events.wait(0, MAX_WAIT_MS),
    ];
    node.events.emit({ kind: "message", peer: "p", text: "broadcast" });

    for (const result of await Promise.all(waiters)) {
      assert.equal(result.length, 1);
    }
  });
});

describe("bounds, because peers supply the input", () => {
  it("keeps the buffer bounded under a flood", () => {
    for (let i = 0; i < MAX_EVENTS * 3; i += 1) {
      node.events.emit({ kind: "message", peer: "flood", text: `m${i}` });
    }
    assert.equal(node.events.size, MAX_EVENTS);
    // The cursor keeps counting, so a caller can still tell it fell behind.
    assert.equal(node.events.latestSeq, MAX_EVENTS * 3);
  });

  it("truncates message text instead of carrying it whole", () => {
    const event = node.events.emit({
      kind: "message",
      peer: "p",
      text: "x".repeat(MAX_EVENT_TEXT * 10),
    });
    assert.equal(event.text?.length, MAX_EVENT_TEXT);
  });

  it("caps the key list on a large state update", () => {
    const event = node.events.emit({
      kind: "state",
      peer: "p",
      keys: Array.from({ length: 500 }, (_, i) => `k${i}`),
    });
    assert.equal(event.keys?.length, 50);
  });

  it("refuses to park more waiters than the cap", async () => {
    const parked = Array.from({ length: MAX_WAITERS }, () =>
      node.events.wait(0, MAX_WAIT_MS),
    );
    assert.equal(node.events.waiterCount, MAX_WAITERS);

    // Over the cap, callers get an empty answer rather than accumulating.
    assert.deepEqual(await node.events.wait(0, MAX_WAIT_MS), []);

    node.events.emit({ kind: "message", peer: "p", text: "release them" });
    await Promise.all(parked);
    assert.equal(node.events.waiterCount, 0);
  });

  it("clamps a wait longer than the maximum", async () => {
    const started = Date.now();
    await node.events.wait(0, MAX_WAIT_MS * 100);
    assert.ok(
      Date.now() - started <= MAX_WAIT_MS + 1000,
      "an unbounded wait would park an agent indefinitely",
    );
  });

  it("does not leak a waiter once it times out", async () => {
    await node.events.wait(0, 30);
    assert.equal(node.events.waiterCount, 0);
  });

  it("releases waiters on shutdown", async () => {
    const waiting = node.events.wait(0, MAX_WAIT_MS);
    node.events.close();
    assert.deepEqual(await waiting, []);
  });

  it("reports how many events aged out from under a caller", () => {
    for (let i = 0; i < MAX_EVENTS + 25; i += 1) {
      node.events.emit({ kind: "message", peer: "flood", text: `m${i}` });
    }
    // A peer can bury a real action under cheap writes; the caller must be able
    // to tell that happened rather than silently seeing only the flood.
    assert.ok(node.events.missedSince(0) > 0);
    assert.equal(node.events.missedSince(node.events.latestSeq), 0);
  });

  it("does not block on a cursor left over from a previous run", async () => {
    node.events.emit({ kind: "message", peer: "p", text: "after restart" });

    // The buffer is in-memory and seq restarts at 1, so a stale high cursor
    // would otherwise park the agent through every real event.
    const started = Date.now();
    const events = await node.events.wait(9_999, 5_000);
    assert.equal(events.length, 1);
    assert.ok(Date.now() - started < 1_000);
  });

  it("releases a waiter when the caller cancels", async () => {
    const controller = new AbortController();
    const waiting = node.events.wait(0, MAX_WAIT_MS, controller.signal);
    assert.equal(node.events.waiterCount, 1);

    controller.abort();
    assert.deepEqual(await waiting, []);
    assert.equal(node.events.waiterCount, 0, "an abandoned waiter would fill the cap");
  });

  it("returns immediately when the caller already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(await node.events.wait(0, MAX_WAIT_MS, controller.signal), []);
    assert.equal(node.events.waiterCount, 0);
  });

  it("keeps delivering when a push listener throws", () => {
    node.events.onEvent(() => {
      throw new Error("client went away");
    });
    const event = node.events.emit({ kind: "message", peer: "p", text: "still recorded" });
    assert.equal(event.seq, 1);
    assert.equal(node.events.size, 1);
  });
});
