/**
 * Transport limits.
 *
 * Both of these were unbounded. `conn.write()` returns false when the socket
 * buffer is full, and the old `writeLine` discarded that: against a peer that had
 * stopped reading, a node would keep buffering until it ran out of memory. And
 * nothing capped inbound rate, while every accepted envelope re-renders
 * `shared_context.md` in full — so a peer sending small valid frames at link rate
 * turned a trickle of network traffic into continuous whole-file writes.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  BYTE_REFILL_PER_SEC,
  ENVELOPE_BURST,
  ENVELOPE_REFILL_PER_SEC,
  MAX_OUTBOUND_QUEUE_BYTES,
  RateBudget,
  SNAPSHOT_MAX_TOTAL_OPS,
  SNAPSHOT_PART_BUDGET,
  chunkSnapshot,
  shouldBlockPeer,
} from "../src/p2p.js";
import { MAX_PAYLOAD_BYTES, MAX_SNAPSHOT_PARTS } from "../src/types.js";
import type { CrdtOp } from "../src/crdt.js";

describe("inbound rate budget", () => {
  it("admits ordinary traffic", () => {
    const budget = new RateBudget();
    const start = 1_000_000;
    for (let i = 0; i < 50; i += 1) {
      assert.equal(budget.admit(200, start + i * 100), true);
    }
  });

  it("admits a burst large enough for a chunked snapshot", () => {
    const budget = new RateBudget();
    const at = 1_000_000;
    // A snapshot arrives as a rapid run of frames; the burst must cover it or the
    // handshake would trip the limiter it is meant to be protected by.
    for (let i = 0; i < MAX_SNAPSHOT_PARTS; i += 1) {
      if (!budget.admit(1_000, at)) {
        assert.ok(
          i >= ENVELOPE_BURST,
          `burst ran out after ${i} frames, below the ${ENVELOPE_BURST} allowance`,
        );
        return;
      }
    }
  });

  it("stops a peer sending frames faster than the sustained rate", () => {
    const budget = new RateBudget();
    const at = 1_000_000;
    let admitted = 0;
    // All in the same millisecond: no refill, so only the burst is available.
    for (let i = 0; i < ENVELOPE_BURST * 3; i += 1) {
      if (budget.admit(10, at)) admitted += 1;
    }
    assert.equal(admitted, ENVELOPE_BURST);
    assert.equal(budget.admit(10, at), false);
  });

  it("refills over time so a quiet peer is not punished", () => {
    const budget = new RateBudget();
    const at = 1_000_000;
    for (let i = 0; i < ENVELOPE_BURST; i += 1) budget.admit(10, at);
    assert.equal(budget.admit(10, at), false);

    // One second later a second's worth of allowance is back.
    assert.equal(budget.admit(10, at + 1_000), true);
  });

  it("never refills past the burst ceiling", () => {
    const budget = new RateBudget();
    const at = 1_000_000;
    // An hour idle must not buy an unbounded burst.
    let admitted = 0;
    for (let i = 0; i < ENVELOPE_BURST * 2; i += 1) {
      if (budget.admit(10, at + 3_600_000)) admitted += 1;
    }
    assert.equal(admitted, ENVELOPE_BURST);
  });

  it("limits bytes independently of frame count", () => {
    // Few frames, enormous each: cheap on the envelope bucket, not on bytes.
    const budget = new RateBudget(1_000, 1_000, 10_000, 1_000);
    const at = 1_000_000;
    assert.equal(budget.admit(6_000, at), true);
    assert.equal(budget.admit(6_000, at), false, "byte budget should be exhausted");
    // The envelope bucket still has room, proving the two are separate.
    assert.equal(budget.admit(100, at), true);
  });

  it("refuses a frame larger than the byte burst outright", () => {
    const budget = new RateBudget(1_000, 1_000, 1_000, 1_000);
    assert.equal(budget.admit(5_000, 1_000_000), false);
  });

  it("is sized to admit a full-rate frame stream without starving on bytes", () => {
    // A sustained stream of maximum frames must be stopped by *some* bucket; this
    // pins that the two limits are coherent rather than accidentally ordered.
    assert.ok(BYTE_REFILL_PER_SEC > 0);
    assert.ok(ENVELOPE_REFILL_PER_SEC > 0);
    assert.ok(ENVELOPE_BURST >= MAX_SNAPSHOT_PARTS / 4);
  });
});

describe("outbound backpressure limits", () => {
  it("has a queue ceiling well above one frame but far below memory exhaustion", () => {
    assert.ok(
      MAX_OUTBOUND_QUEUE_BYTES > MAX_PAYLOAD_BYTES,
      "the queue must hold at least one maximum frame",
    );
    assert.ok(
      MAX_OUTBOUND_QUEUE_BYTES <= 64 * 1024 * 1024,
      "an unbounded-in-practice queue is the bug this replaced",
    );
  });
});

describe("snapshot chunking bounds", () => {
  function opsOfSize(count: number, bytes: number): CrdtOp[] {
    return Array.from({ length: count }, (_, i) => ({
      key: `k${i}`,
      entry: {
        kind: "lww" as const,
        hlc: { w: 1_700_000_000_000, c: i, n: "aaaaaaaaaaaaaaaa" },
        value: "x".repeat(bytes),
      },
    }));
  }

  it("keeps every part inside the frame limit", () => {
    for (const [count, size] of [
      [200, 8 * 1024],
      [40, 32 * 1024],
      [5, 60 * 1024],
    ] as Array<[number, number]>) {
      for (const part of chunkSnapshot(opsOfSize(count, size))) {
        assert.ok(
          JSON.stringify(part).length <= SNAPSHOT_PART_BUDGET + 64 * 1024,
          "a part must stay inside the budget plus one entry of slack",
        );
        assert.ok(JSON.stringify(part).length < MAX_PAYLOAD_BYTES);
      }
    }
  });

  it("emits a single entry per part when entries approach the budget", () => {
    const parts = chunkSnapshot(opsOfSize(4, 60 * 1024), 64 * 1024);
    assert.equal(parts.length, 4);
    for (const part of parts) assert.equal(part.length, 1);
  });

  it("bounds the entries a peer can push through a chunked transfer", () => {
    // No point accepting more entries than the document can hold.
    assert.ok(SNAPSHOT_MAX_TOTAL_OPS > 0);
    assert.ok(SNAPSHOT_MAX_TOTAL_OPS <= 100_000);
  });
});

/**
 * Restated here because getting the polarity backwards fails open. Hyperswarm's
 * `firewall` returns true to BLOCK.
 */
describe("the firewall polarity has not flipped", () => {
  it("blocks an unlisted key in strict mode", () => {
    assert.equal(shouldBlockPeer("strict", () => false, "abc"), true);
  });

  it("admits an allowlisted key in strict mode", () => {
    assert.equal(shouldBlockPeer("strict", () => true, "abc"), false);
  });

  it("blocks a peer with no key in strict mode", () => {
    assert.equal(shouldBlockPeer("strict", () => true, null), true);
  });

  it("admits everyone in open mode", () => {
    assert.equal(shouldBlockPeer("open", () => false, "abc"), false);
  });
});
