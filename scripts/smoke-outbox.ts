/**
 * Smoke test for offline messaging (no network).
 * Run: npm run smoke:outbox
 *
 * The case the outbox exists for: you leave word for someone whose agent is
 * not running, and they get it when they come back.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { EventBus } from "../src/events.js";
import { Outbox } from "../src/outbox.js";
import { handleAck, receiveMessage, replayOutbox, sendMessage } from "../src/sync.js";
import type { SyncServices } from "../src/sync.js";
import type { PeerEnvelope } from "../src/types.js";

const DIR = "./logs/smoke-outbox";
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const ALICE_KEY = "a".repeat(64);
const BOB_KEY = "b".repeat(64);

/** Link that can be cut, so "Bob is offline" is a real state. */
let linkUp = false;
const wire: Array<{ to: string; envelope: PeerEnvelope }> = [];
function transport(peerKey: string) {
  return {
    connectedKeys: () => (linkUp ? [peerKey] : []),
    connectionCount: () => (linkUp ? 1 : 0),
    sendTo: (to: string, envelope: PeerEnvelope) => {
      if (!linkUp) return false;
      wire.push({ to, envelope });
      return true;
    },
    broadcast: () => {},
  } as unknown as SyncServices["p2p"];
}
function agent(name: string, peerKey: string): SyncServices {
  const log = new MarkdownLog(`${DIR}/${name}.md`);
  log.ensureInitialized();
  return {
    store: new ContextStore(name === "alice" ? ALICE_KEY : BOB_KEY),
    log,
    events: new EventBus(),
    outbox: new Outbox(`${DIR}/${name}-outbox.json`),
    p2p: transport(peerKey),
  };
}

const alice = agent("alice", BOB_KEY);
const bob = agent("bob", ALICE_KEY);

// 1. Bob's agent is not running. Alice leaves word anyway.
linkUp = false;
const delivery = sendMessage(alice, "auth refactor is done, tests are green");
assert.equal(delivery.deliveredNow, 0, "nobody was reachable");
assert.equal(wire.length, 0, "nothing went on the wire");
assert.equal(alice.outbox!.pendingFor(BOB_KEY).length, 1);
console.error("offline: message queued, not lost: PASS");

// 2. Bob comes back. Alice replays what he missed.
linkUp = true;
const replayed = replayOutbox(alice, BOB_KEY);
assert.equal(replayed, 1);
const sent = wire.find((w) => w.envelope.type === "message")!;
assert.equal(sent.envelope.type === "message" && sent.envelope.text,
  "auth refactor is done, tests are green");
console.error("reconnect: undelivered message replayed automatically: PASS");

// 3. Bob receives it, wakes, and confirms.
const id = sent.envelope.type === "message" ? sent.envelope.id : undefined;
const first = receiveMessage(bob, "auth refactor is done, tests are green", id,
  { fingerprint: "a1a1a1a1", label: "sanjoy" }, ALICE_KEY);
assert.equal(first.duplicate, false);
assert.equal(bob.events!.latestSeq, 1, "Bob's agent is woken by it");
console.error("delivery: Bob logged it and was woken: PASS");

// 4. The ack lets Alice stop retrying.
assert.equal(handleAck(alice, BOB_KEY, [id!]), 1);
assert.equal(alice.outbox!.pendingFor(BOB_KEY).length, 0);
console.error("ack: Alice stops owing the message: PASS");

// 5. A duplicate replay does not double-log or double-wake Bob.
const again = receiveMessage(bob, "auth refactor is done, tests are green", id,
  { fingerprint: "a1a1a1a1", label: "sanjoy" }, ALICE_KEY);
assert.equal(again.duplicate, true);
assert.equal(bob.events!.latestSeq, 1, "no second wake");
console.error("replay: duplicate ignored, agent not woken twice: PASS");

rmSync(DIR, { recursive: true, force: true });
console.error("\nall outbox smoke checks passed");
