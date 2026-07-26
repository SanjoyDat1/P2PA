/**
 * Messages that survive a disconnect.
 *
 * The guarantee: a message written while the other agent is offline is
 * delivered when they come back, without anyone resending it by hand. That is
 * the ordinary case for two people coordinating across machines, not an edge
 * case — leaving word for someone who is not looking right now is the point.
 *
 * Replay is at-least-once, so the receiver is what makes it look exactly-once.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  MAX_OUTBOX_AGE_MS,
  MAX_OUTBOX_MESSAGES,
  MAX_REPLAY_BATCH,
  MAX_SEEN_PER_PEER,
  Outbox,
} from "../src/outbox.js";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { EventBus } from "../src/events.js";
import {
  handleAck,
  receiveMessage,
  sendMessage,
  type SyncServices,
} from "../src/sync.js";
import type { PeerEnvelope } from "../src/types.js";

const PEER_KEY = "b".repeat(64);
const OTHER_KEY = "c".repeat(64);

let dir: string;
let outbox: Outbox;

/** A transport that can be taken offline, so "peer is away" is testable. */
function fakeP2P(connected: string[], sink: Array<{ to: string; envelope: PeerEnvelope }>) {
  return {
    connectedKeys: () => connected,
    connectionCount: () => connected.length,
    sendTo: (key: string, envelope: PeerEnvelope) => {
      if (!connected.includes(key)) return false;
      sink.push({ to: key, envelope });
      return true;
    },
    broadcast: () => {},
  } as unknown as SyncServices["p2p"];
}

function makeServices(
  connected: string[],
  sink: Array<{ to: string; envelope: PeerEnvelope }>,
): SyncServices {
  const log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
  return {
    store: new ContextStore("a".repeat(64)),
    log,
    events: new EventBus(),
    outbox,
    p2p: fakeP2P(connected, sink),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "p2pa-outbox-"));
  outbox = new Outbox(join(dir, "outbox.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a message to an offline peer is not lost", () => {
  it("queues when nobody is connected", () => {
    const sent: Array<{ to: string; envelope: PeerEnvelope }> = [];
    const services = makeServices([], sent);

    const delivery = sendMessage(services, "ship the auth refactor");

    assert.equal(delivery.deliveredNow, 0);
    assert.equal(delivery.queued, true);
    assert.equal(sent.length, 0);
    assert.equal(outbox.pendingFor(PEER_KEY).length, 1);
  });

  it("delivers it when the peer comes back", () => {
    const offline: Array<{ to: string; envelope: PeerEnvelope }> = [];
    sendMessage(makeServices([], offline), "left while you were away");
    assert.equal(offline.length, 0);

    // The peer reconnects.
    const online: Array<{ to: string; envelope: PeerEnvelope }> = [];
    const services = makeServices([PEER_KEY], online);
    const replayed = replay(services, PEER_KEY);

    assert.equal(replayed, 1);
    assert.equal(online[0]?.to, PEER_KEY);
    const envelope = online[0]?.envelope;
    assert.equal(envelope?.type === "message" ? envelope.text : null, "left while you were away");
  });

  it("keeps a message queued until the peer confirms it", () => {
    const sent: Array<{ to: string; envelope: PeerEnvelope }> = [];
    const services = makeServices([PEER_KEY], sent);
    sendMessage(services, "did you get this?");

    // Written to the socket is not the same as received.
    assert.equal(outbox.pendingFor(PEER_KEY).length, 1);

    const id = outbox.pendingFor(PEER_KEY)[0]!.id;
    handleAck(services, PEER_KEY, [id]);
    assert.equal(outbox.pendingFor(PEER_KEY).length, 0);
  });

  it("still owes a message to a peer that has not confirmed it", () => {
    const sent: Array<{ to: string; envelope: PeerEnvelope }> = [];
    const services = makeServices([PEER_KEY, OTHER_KEY], sent);
    sendMessage(services, "to both of you");

    const id = outbox.pendingFor(PEER_KEY)[0]!.id;
    handleAck(services, PEER_KEY, [id]);

    assert.equal(outbox.pendingFor(PEER_KEY).length, 0);
    assert.equal(outbox.pendingFor(OTHER_KEY).length, 1);
  });

  it("survives a restart of the sender", () => {
    sendMessage(makeServices([], []), "written before the crash");

    // A new process reads the same file.
    const reopened = new Outbox(join(dir, "outbox.json"));
    assert.equal(reopened.pendingFor(PEER_KEY).length, 1);
    assert.equal(reopened.pendingFor(PEER_KEY)[0]?.text, "written before the crash");
  });

  it("keeps the queue file owner-only", () => {
    sendMessage(makeServices([], []), "private");
    const mode = statSync(join(dir, "outbox.json")).mode & 0o777;
    assert.equal(mode, 0o600, "queued messages are user content");
  });
});

describe("a replayed message is not logged twice", () => {
  it("ignores a message it has already handled", () => {
    const sent: Array<{ to: string; envelope: PeerEnvelope }> = [];
    const services = makeServices([PEER_KEY], sent);
    const peer = { fingerprint: "deadbeef", label: null };

    const first = receiveMessage(services, "hello", "msg-1", peer, PEER_KEY);
    const second = receiveMessage(services, "hello", "msg-1", peer, PEER_KEY);

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
  });

  it("acknowledges a duplicate anyway, since the first ack may have been lost", () => {
    const sent: Array<{ to: string; envelope: PeerEnvelope }> = [];
    const services = makeServices([PEER_KEY], sent);
    const peer = { fingerprint: "deadbeef", label: null };

    receiveMessage(services, "hello", "msg-1", peer, PEER_KEY);
    receiveMessage(services, "hello", "msg-1", peer, PEER_KEY);

    const acks = sent.filter((entry) => entry.envelope.type === "ack");
    assert.equal(acks.length, 2, "a lost ack must be recoverable by resending");
  });

  it("wakes the agent once, not once per replay", () => {
    const sent: Array<{ to: string; envelope: PeerEnvelope }> = [];
    const services = makeServices([PEER_KEY], sent);
    const peer = { fingerprint: "deadbeef", label: null };

    receiveMessage(services, "hello", "msg-1", peer, PEER_KEY);
    receiveMessage(services, "hello", "msg-1", peer, PEER_KEY);

    assert.equal(services.events?.latestSeq, 1);
  });

  it("still accepts a message from a build that sends no id", () => {
    const sent: Array<{ to: string; envelope: PeerEnvelope }> = [];
    const services = makeServices([PEER_KEY], sent);
    const result = receiveMessage(services, "no id here", undefined, undefined, PEER_KEY);
    assert.equal(result.duplicate, false);
  });

  it("remembers ids across a restart", () => {
    const services = makeServices([PEER_KEY], []);
    receiveMessage(services, "hello", "msg-1", undefined, PEER_KEY);

    outbox.flush();
    const reopened = new Outbox(join(dir, "outbox.json"));
    assert.equal(reopened.isDuplicate(PEER_KEY, "msg-1"), true);
  });
});

describe("the queue cannot grow without bound", () => {
  it("drops the oldest once the message cap is reached", () => {
    for (let i = 0; i < MAX_OUTBOX_MESSAGES + 50; i += 1) outbox.enqueue(`m${i}`);
    assert.equal(outbox.size, MAX_OUTBOX_MESSAGES);
  });

  it("bounds how many ids it remembers per sender", () => {
    for (let i = 0; i < MAX_SEEN_PER_PEER + 50; i += 1) {
      outbox.markSeen(PEER_KEY, `id-${i}`);
    }
    assert.equal(outbox.status().seenIds, MAX_SEEN_PER_PEER);
  });

  it("does not let one peer evict another peer's dedupe state", () => {
    outbox.markSeen(PEER_KEY, "important");
    for (let i = 0; i < MAX_SEEN_PER_PEER + 50; i += 1) {
      outbox.markSeen(OTHER_KEY, `flood-${i}`);
    }
    assert.equal(
      outbox.isDuplicate(PEER_KEY, "important"),
      true,
      "a flooding peer must not push out another peer's ids",
    );
  });

  it("does not let a peer pre-claim another peer's message id", () => {
    // Scoped per sender, so B marking id X does not make A's real X look like
    // a duplicate — which would drop it and ack it back as delivered.
    outbox.markSeen(OTHER_KEY, "shared-id");
    assert.equal(outbox.isDuplicate(PEER_KEY, "shared-id"), false);
  });

  it("gives up on a message no peer ever collected", () => {
    outbox.enqueue("nobody is coming");
    const removed = outbox.prune([PEER_KEY], Date.now() + MAX_OUTBOX_AGE_MS + 1000);
    assert.equal(removed, 1);
    assert.equal(outbox.size, 0);
  });

  it("forgets a message every current peer has confirmed", () => {
    const message = outbox.enqueue("done with this");
    outbox.ack(PEER_KEY, [message.id]);
    outbox.ack(OTHER_KEY, [message.id]);

    assert.equal(outbox.prune([PEER_KEY, OTHER_KEY]), 1);
    assert.equal(outbox.size, 0);
  });

  it("keeps a message a peer has not confirmed", () => {
    const message = outbox.enqueue("still owed");
    outbox.ack(PEER_KEY, [message.id]);

    assert.equal(outbox.prune([PEER_KEY, OTHER_KEY]), 0);
    assert.equal(outbox.size, 1);
  });

  it("batches a long backlog rather than sending it all at once", () => {
    for (let i = 0; i < MAX_REPLAY_BATCH * 2; i += 1) outbox.enqueue(`m${i}`);
    assert.equal(outbox.pendingFor(PEER_KEY).length, MAX_REPLAY_BATCH);
  });

  it("ignores an ack for ids it never sent", () => {
    outbox.enqueue("real");
    assert.equal(outbox.ack(PEER_KEY, ["made-up-id"]), 0);
    assert.equal(outbox.size, 1);
  });

  it("does not hand a newly paired peer the earlier backlog", () => {
    // Addressed at enqueue time, so a peer paired later was never a recipient.
    outbox.enqueue("private to the original pair", [PEER_KEY]);
    assert.equal(outbox.pendingFor(PEER_KEY).length, 1);
    assert.equal(
      outbox.pendingFor(OTHER_KEY).length,
      0,
      "a peer added later was not party to this conversation",
    );
  });

  it("reports messages it gave up on rather than dropping them silently", () => {
    outbox.enqueue("nobody collected this");
    outbox.prune([PEER_KEY], Date.now() + MAX_OUTBOX_AGE_MS + 1000);
    assert.equal(outbox.status().dropped, 1, "a discarded message must be visible");
  });

  it("does not lose a second writer's queued messages", () => {
    // The daemon and `p2pa mcp` can both hold this file; a blind overwrite
    // would erase whichever saved first.
    const path = join(dir, "shared-outbox.json");
    const first = new Outbox(path);
    const second = new Outbox(path);

    first.enqueue("from the daemon");
    second.enqueue("from the mcp server");
    first.flush();
    second.flush();

    const reopened = new Outbox(path);
    const texts = reopened.pendingFor(PEER_KEY).map((m) => m.text);
    assert.ok(texts.includes("from the daemon"), "first writer's message survived");
    assert.ok(texts.includes("from the mcp server"), "second writer's message survived");
  });

  it("merges acknowledgements from another writer instead of clobbering them", () => {
    const path = join(dir, "merge-ack.json");
    const first = new Outbox(path);
    const message = first.enqueue("needs two acks");
    first.flush();

    const second = new Outbox(path);
    second.ack(OTHER_KEY, [message.id]);
    second.flush();

    first.ack(PEER_KEY, [message.id]);
    first.flush();

    const reopened = new Outbox(path);
    assert.equal(reopened.pendingFor(PEER_KEY).length, 0);
    assert.equal(reopened.pendingFor(OTHER_KEY).length, 0);
  });

  it("leaves no temp files behind", () => {
    for (let i = 0; i < 5; i += 1) outbox.enqueue(`m${i}`);
    outbox.flush();
    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  });

  it("starts empty rather than throwing on a corrupt file", () => {
    const path = join(dir, "broken.json");
    rmSync(path, { force: true });
    writeFileSync(path, "{ not json", "utf8");
    const recovered = new Outbox(path);
    assert.equal(recovered.size, 0);
  });
});

/** Mirrors what index.ts does when a peer connects. */
function replay(services: SyncServices, publicKeyHex: string): number {
  const pending = services.outbox?.pendingFor(publicKeyHex) ?? [];
  let sent = 0;
  for (const message of pending) {
    const ok = services.p2p?.sendTo(publicKeyHex, {
      type: "message",
      v: 3,
      text: message.text,
      id: message.id,
    });
    if (ok !== true) break;
    sent += 1;
  }
  return sent;
}
