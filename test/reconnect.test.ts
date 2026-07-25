/**
 * Rejoining after working offline.
 *
 * The counter protocol took a handshake snapshot whole whenever the sender's
 * clock was at least as high as the receiver's, then replaced local state with
 * it. A peer that edited while disconnected lost that work on reconnect, the
 * peer that stayed online never learned it existed, and with equal clocks the
 * two ends swapped documents outright.
 *
 * A snapshot is now merged key by key on the same rules as any other update, so
 * catching up cannot cost either side its own writes.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { ContentionLog } from "../src/conflicts.js";
import {
  applyPeerSnapshot,
  commitLocalMutation,
  handleInboundOps,
  type SyncServices,
} from "../src/sync.js";

interface Node extends SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  contention: ContentionLog;
  dir: string;
}

function makeNode(name: string, idChar: string): Node {
  const dir = mkdtempSync(join(tmpdir(), `p2pa-reconnect-${name}-`));
  const log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
  return {
    store: new ContextStore(idChar.repeat(64)),
    log,
    contention: new ContentionLog(),
    dir,
  };
}

/**
 * Both ends of a Hyperswarm connection send their snapshot on connect, so each
 * is built from the state that existed *before* either was applied.
 */
function exchangeHandshake(left: Node, right: Node): void {
  const fromLeft = left.store.export();
  const fromRight = right.store.export();
  applyPeerSnapshot(left, fromRight, "Peer");
  applyPeerSnapshot(right, fromLeft, "Peer");
}

let online: Node;
let offline: Node;

beforeEach(() => {
  online = makeNode("online", "0");
  offline = makeNode("offline", "f");
  const seed = commitLocalMutation(online, (store) =>
    store.setKey("project", "p2pa"),
  );
  assert.ok(seed.ok);
  handleInboundOps(offline, seed.ops, "Peer");
});

afterEach(() => {
  rmSync(online.dir, { recursive: true, force: true });
  rmSync(offline.dir, { recursive: true, force: true });
});

describe("reconnecting after a disconnect", () => {
  it("catches up a peer that made no offline edits", () => {
    commitLocalMutation(online, (store) => store.setKey("online_first", "done"));
    commitLocalMutation(online, (store) => store.setKey("online_second", "done"));

    exchangeHandshake(online, offline);

    assert.equal(offline.store.get("online_first"), "done");
    assert.equal(offline.store.get("online_second"), "done");
    assert.equal(online.store.get("project"), "p2pa");
  });

  it("keeps the edits a peer made while disconnected", () => {
    commitLocalMutation(online, (store) => store.setKey("online_first", "done"));
    commitLocalMutation(online, (store) => store.setKey("online_second", "done"));
    commitLocalMutation(offline, (store) => store.setKey("offline_work", "done"));

    exchangeHandshake(online, offline);

    assert.equal(offline.store.get("offline_work"), "done");
  });

  it("propagates offline edits to the peer that stayed online", () => {
    commitLocalMutation(online, (store) => store.setKey("online_first", "done"));
    commitLocalMutation(online, (store) => store.setKey("online_second", "done"));
    commitLocalMutation(offline, (store) => store.setKey("offline_work", "done"));

    exchangeHandshake(online, offline);

    assert.equal(online.store.get("offline_work"), "done");
  });

  it("leaves both peers converged after reconnect", () => {
    commitLocalMutation(online, (store) => store.setKey("online_first", "done"));
    commitLocalMutation(offline, (store) => store.setKey("offline_work", "done"));

    exchangeHandshake(online, offline);

    assert.deepEqual(online.store.snapshot(), offline.store.snapshot());
    assert.equal(online.store.stateHash(), offline.store.stateHash());
  });

  it("survives repeated reconnects without losing state", () => {
    commitLocalMutation(online, (store) => store.setKey("a", "1"));
    commitLocalMutation(offline, (store) => store.setKey("b", "2"));
    exchangeHandshake(online, offline);
    exchangeHandshake(online, offline);
    exchangeHandshake(online, offline);

    assert.deepEqual(online.store.snapshot(), offline.store.snapshot());
    assert.equal(online.store.get("a"), "1");
    assert.equal(online.store.get("b"), "2");
  });
});

/**
 * A snapshot arrives from whoever is on the other end of the connection. These
 * pin the properties that stop one from being used as a write primitive over
 * the whole document.
 */
describe("a snapshot cannot be used to overwrite a peer", () => {
  it("does not drop local keys the sender never mentioned", () => {
    commitLocalMutation(online, (store) => store.setKey("mine", "keep me"));

    // A sender that knows nothing about `mine` must not be able to erase it.
    applyPeerSnapshot(online, offline.store.export(), "Peer");

    assert.equal(online.store.get("mine"), "keep me");
  });

  it("refuses an entry stamped beyond the accepted clock skew", () => {
    commitLocalMutation(online, (store) => store.setKey("mission", "real work"));
    const before = online.store.snapshot();

    const summary = applyPeerSnapshot(
      online,
      [
        {
          key: "mission",
          entry: {
            kind: "lww",
            hlc: { w: Number.MAX_SAFE_INTEGER, c: 0, n: "attacker" },
            value: "overwritten",
          },
        },
      ],
      "Peer",
    );

    assert.equal(summary.rejected, 1);
    assert.equal(summary.applied, 0);
    assert.deepEqual(online.store.snapshot(), before);
  });

  it("stays writable after refusing a saturating stamp", () => {
    applyPeerSnapshot(
      online,
      [
        {
          key: "decoy",
          entry: {
            kind: "lww",
            hlc: { w: Number.MAX_SAFE_INTEGER, c: 0, n: "attacker" },
            value: "x",
          },
        },
      ],
      "Peer",
    );

    // The old protocol pinned the clock here and every later local write
    // silently stopped advancing.
    const after = commitLocalMutation(online, (store) =>
      store.setKey("still_working", "yes"),
    );
    assert.ok(after.ok);
    assert.equal(online.store.get("still_working"), "yes");

    const summary = handleInboundOps(offline, after.ok ? after.ops : [], "Peer");
    assert.equal(summary.applied, 1);
    assert.equal(offline.store.get("still_working"), "yes");
  });

  it("cannot resurrect a key that was deleted more recently", () => {
    const stale = online.store.export();
    commitLocalMutation(online, (store) => store.deleteKey("project"));

    applyPeerSnapshot(online, stale, "Peer");

    assert.equal(online.store.get("project"), undefined);
  });
});
