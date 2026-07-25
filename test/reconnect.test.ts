/**
 * Rejoining after working offline.
 *
 * On connect each side pushes a full Active State snapshot, and
 * `applyPeerSnapshot` refuses any snapshot whose `_version` sits below the
 * local clock so a stale peer cannot roll state backwards. The guard only runs
 * one way round: the peer with the higher clock refuses the lower one, while
 * the peer with the lower clock accepts and `replaceAll`s straight over its own
 * document.
 *
 * A peer that keeps working while disconnected therefore loses that work on
 * reconnect, and the peer that stayed online never finds out it existed. These
 * tests state the outcome an agent pair actually needs — offline edits survive
 * and propagate — and are marked `todo` until reconnect exchanges the ops each
 * side is missing instead of one all-or-nothing snapshot (phase 4).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ContextStore } from "../src/store.js";
import { MarkdownLog } from "../src/markdown-log.js";
import { ConflictQueue } from "../src/conflicts.js";
import {
  applyPeerSnapshot,
  commitLocalMutation,
  type SyncServices,
} from "../src/sync.js";

interface Node extends SyncServices {
  store: ContextStore;
  log: MarkdownLog;
  conflicts: ConflictQueue;
  dir: string;
}

function makeNode(name: string): Node {
  const dir = mkdtempSync(join(tmpdir(), `p2pa-reconnect-${name}-`));
  const log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
  return { store: new ContextStore(), log, conflicts: new ConflictQueue(), dir };
}

/**
 * Both ends of a Hyperswarm connection send their snapshot on connect, so each
 * is built from the state that existed *before* either was applied.
 */
function exchangeHandshake(left: Node, right: Node): void {
  const fromLeft = left.store.snapshot();
  const fromRight = right.store.snapshot();
  applyPeerSnapshot(left, fromRight, "Peer");
  applyPeerSnapshot(right, fromLeft, "Peer");
}

let online: Node;
let offline: Node;

beforeEach(() => {
  online = makeNode("online");
  offline = makeNode("offline");
  commitLocalMutation(online, (store) => {
    store.setKey("project", "p2pa");
  });
  offline.store.replaceAll(online.store.snapshot());
});

afterEach(() => {
  rmSync(online.dir, { recursive: true, force: true });
  rmSync(offline.dir, { recursive: true, force: true });
});

describe("reconnecting after a disconnect", () => {
  it("catches up a peer that made no offline edits", () => {
    // Control: the snapshot handshake is the only catch-up mechanism there is,
    // and for a purely passive peer it works. This must keep passing.
    commitLocalMutation(online, (store) => {
      store.setKey("online_first", "done");
    });
    commitLocalMutation(online, (store) => {
      store.setKey("online_second", "done");
    });

    exchangeHandshake(online, offline);

    assert.equal(offline.store.get("online_first"), "done");
    assert.equal(offline.store.get("online_second"), "done");
    assert.equal(online.store.get("project"), "p2pa");
  });

  it(
    "keeps the edits a peer made while disconnected",
    { todo: "phase 4: reconnect must merge missed ops, not overwrite" },
    () => {
      // The online peer runs ahead; the disconnected peer keeps working too.
      commitLocalMutation(online, (store) => {
        store.setKey("online_first", "done");
      });
      commitLocalMutation(online, (store) => {
        store.setKey("online_second", "done");
      });
      commitLocalMutation(offline, (store) => {
        store.setKey("offline_work", "done");
      });

      exchangeHandshake(online, offline);

      // The lower clock loses: `replaceAll` drops offline_work entirely.
      assert.equal(offline.store.get("offline_work"), "done");
    },
  );

  it(
    "propagates offline edits to the peer that stayed online",
    { todo: "phase 4: version-vector catch-up in both directions" },
    () => {
      commitLocalMutation(online, (store) => {
        store.setKey("online_first", "done");
      });
      commitLocalMutation(online, (store) => {
        store.setKey("online_second", "done");
      });
      commitLocalMutation(offline, (store) => {
        store.setKey("offline_work", "done");
      });

      exchangeHandshake(online, offline);

      // The higher clock refuses the incoming snapshot outright, so this edit
      // is never seen — no error surfaces to either agent.
      assert.equal(online.store.get("offline_work"), "done");
    },
  );

  it(
    "leaves both peers converged after reconnect",
    { todo: "phase 4: reconnect must be a merge, so both ends agree" },
    () => {
      commitLocalMutation(online, (store) => {
        store.setKey("online_first", "done");
      });
      commitLocalMutation(offline, (store) => {
        store.setKey("offline_work", "done");
      });

      exchangeHandshake(online, offline);

      assert.deepEqual(online.store.snapshot(), offline.store.snapshot());
    },
  );
});

/**
 * The `todo` cases above ask for reconnect to merge rather than overwrite. The
 * cheapest way to make them pass would be to drop the guards in
 * `applyPeerSnapshot` altogether, which would hand any connected peer a way to
 * roll another peer's state backwards or blank it. These pin the guards so that
 * shortcut fails loudly.
 */
describe("snapshot guards the phase 4 rewrite must preserve", () => {
  it("refuses a snapshot whose clock is behind the local one", () => {
    commitLocalMutation(online, (store) => {
      store.setKey("online_work", "done");
    });
    const before = online.store.snapshot();

    const stale = { project: "p2pa", _version: 1 };
    const result = applyPeerSnapshot(online, stale, "Peer");

    assert.equal(result.ok, false);
    assert.deepEqual(online.store.snapshot(), before);
  });

  it("refuses an empty snapshot over non-empty local state", () => {
    const before = online.store.snapshot();

    // Clock is ahead, so this clears the downgrade check and is stopped only
    // by the empty-overwrite guard.
    const result = applyPeerSnapshot(online, { _version: 99 }, "Peer");

    assert.equal(result.ok, false);
    assert.deepEqual(online.store.snapshot(), before);
  });
});
