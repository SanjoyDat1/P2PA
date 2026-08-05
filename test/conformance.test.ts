/**
 * SPEC.md §11 — conformance vectors.
 *
 * This file exists so the specification cannot drift from the implementation. A
 * spec with a wrong test vector is worse than no spec: it sends whoever is
 * porting P2PA to another language chasing a bug that is not theirs.
 *
 * Every case here is quoted verbatim from SPEC.md. If a change makes one of these
 * fail, either the change is wrong or SPEC.md needs updating in the same commit —
 * never neither.
 *
 * A second implementation should be able to port this file directly.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { canonicalJson } from "../src/canonical.js";
import { signableBytes } from "../src/signing.js";
import { compareHlc } from "../src/hlc.js";
import { claimWins, type ClaimEntry } from "../src/claim.js";
import { mergeTasks, type TaskEntry, type TaskStatus } from "../src/task.js";
import { negotiate } from "../src/protocol.js";
import type { Hlc } from "../src/hlc.js";

describe("SPEC §11.1 — HLC ordering", () => {
  const A: Hlc = { w: 100, c: 0, n: "aaaa" };
  const B: Hlc = { w: 100, c: 1, n: "aaaa" };
  const C: Hlc = { w: 100, c: 0, n: "bbbb" };
  const D: Hlc = { w: 101, c: 0, n: "aaaa" };

  it("orders by counter when the wall clock ties", () => {
    assert.ok(compareHlc(B, A) > 0);
  });

  it("orders by node id when wall clock and counter tie", () => {
    assert.ok(compareHlc(C, A) > 0);
  });

  it("orders by wall clock first", () => {
    assert.ok(compareHlc(D, B) > 0);
  });

  it("is antisymmetric and reflexive", () => {
    assert.equal(compareHlc(A, A), 0);
    assert.equal(compareHlc(A, B), -compareHlc(B, A));
  });

  it("is transitive across all four vectors", () => {
    for (const [x, y, z] of [[A, B, D], [A, C, D]] as Hlc[][]) {
      assert.ok(compareHlc(y as Hlc, x as Hlc) > 0);
      assert.ok(compareHlc(z as Hlc, y as Hlc) > 0);
      assert.ok(compareHlc(z as Hlc, x as Hlc) > 0);
    }
  });
});

describe("SPEC §11.2 — canonical JSON", () => {
  const vectors: Array<[unknown, string]> = [
    [{ b: 1, a: 2 }, '{"a":2,"b":1}'],
    [{ outer: { z: 1, a: 2 } }, '{"outer":{"a":2,"z":1}}'],
    [[1, { b: 1, a: 2 }], '[1,{"a":2,"b":1}]'],
    [null, "null"],
  ];

  for (const [input, expected] of vectors) {
    it(`renders ${JSON.stringify(input)} as ${expected}`, () => {
      assert.equal(canonicalJson(input as never), expected);
    });
  }
});

describe("SPEC §11.3 — signed bytes", () => {
  it("matches the documented encoding byte for byte", () => {
    const bytes = signableBytes({
      key: "plan",
      entry: { kind: "lww", hlc: { w: 1, c: 0, n: "aaaaaaaaaaaaaaaa" }, value: "x" },
    });
    assert.equal(
      bytes.toString("utf8"),
      'p2pa-op-v1\nplan\n{"hlc":{"c":0,"n":"aaaaaaaaaaaaaaaa","w":1},"kind":"lww","value":"x"}',
    );
  });

  it("excludes by/sig from the signed bytes, so a signature cannot cover itself", () => {
    const bare = signableBytes({
      key: "plan",
      entry: { kind: "lww", hlc: { w: 1, c: 0, n: "aaaaaaaaaaaaaaaa" }, value: "x" },
    });
    const decorated = signableBytes({
      key: "plan",
      entry: {
        kind: "lww",
        hlc: { w: 1, c: 0, n: "aaaaaaaaaaaaaaaa" },
        value: "x",
        by: "f".repeat(64),
        sig: "A".repeat(88),
      },
    });
    assert.equal(bare.toString("utf8"), decorated.toString("utf8"));
  });

  it("binds the key, so a signature cannot be lifted elsewhere", () => {
    const entry = {
      kind: "lww" as const,
      hlc: { w: 1, c: 0, n: "aaaaaaaaaaaaaaaa" },
      value: "x",
    };
    assert.notEqual(
      signableBytes({ key: "plan", entry }).toString("utf8"),
      signableBytes({ key: "other", entry }).toString("utf8"),
    );
  });
});

describe("SPEC §11.4 — lease merge", () => {
  const claim = (gen: number, w: number, n: string, released?: boolean): ClaimEntry => ({
    kind: "claim",
    gen,
    ttl: 60_000,
    hlc: { w, c: 0, n },
    ...(released === true ? { released: true } : {}),
  });

  it("prefers the earliest stamp within a generation (first come, first served)", () => {
    const first = claim(0, 100, "aaaa");
    const later = claim(0, 200, "bbbb");
    assert.equal(claimWins(first, later), true);
    assert.equal(claimWins(later, first), false);
  });

  it("prefers a higher generation regardless of stamp", () => {
    assert.equal(claimWins(claim(1, 300, "bbbb"), claim(0, 100, "aaaa")), true);
  });

  it("makes a release absorbing within its generation", () => {
    const held = claim(1, 300, "bbbb");
    const released = claim(1, 300, "bbbb", true);
    assert.equal(claimWins(released, held), true);
    assert.equal(claimWins(held, released), false);
  });

  it("is idempotent", () => {
    const entry = claim(1, 300, "bbbb");
    assert.equal(claimWins(entry, { ...entry }), false);
  });
});

describe("SPEC §11.6 — task merge", () => {
  const task = (
    overrides: Partial<TaskEntry> & { w?: number; n?: string } = {},
  ): TaskEntry => {
    const { w = 100, n = "aaaa", ...rest } = overrides;
    return {
      kind: "task",
      hlc: { w, c: 0, n },
      title: "X",
      priority: 5,
      status: "open",
      attempts: 0,
      createdBy: "aaaa",
      createdAt: 50,
      ...rest,
    };
  };

  const statusVectors: Array<[TaskStatus, TaskStatus, TaskStatus]> = [
    ["open", "done", "done"],
    ["failed", "cancelled", "failed"],
    ["done", "cancelled", "done"],
    ["done", "failed", "done"],
  ];

  for (const [left, right, expected] of statusVectors) {
    it(`joins ${left} with ${right} as ${expected}`, () => {
      assert.equal(mergeTasks(task({ status: left }), task({ status: right })).status, expected);
      assert.equal(mergeTasks(task({ status: right }), task({ status: left })).status, expected);
    });
  }

  it("joins attempts 2 and 5 as 5", () => {
    assert.equal(mergeTasks(task({ attempts: 2 }), task({ attempts: 5 })).attempts, 5);
  });

  it('joins deps ["a"] and ["b"] as ["a","b"], sorted', () => {
    assert.deepEqual(
      mergeTasks(task({ deps: ["a"] }), task({ deps: ["b"] })).deps,
      ["a", "b"],
    );
    assert.deepEqual(
      mergeTasks(task({ deps: ["b"] }), task({ deps: ["a"] })).deps,
      ["a", "b"],
    );
  });

  it("takes the descriptor whole from the greater stamp", () => {
    const merged = mergeTasks(
      task({ w: 100, n: "aaaa", title: "X", priority: 5 }),
      task({ w: 200, n: "bbbb", title: "Y", priority: 1 }),
    );
    assert.equal(merged.title, "Y");
    assert.equal(merged.priority, 1);
    assert.equal(merged.hlc.w, 200);
    assert.equal(merged.hlc.n, "bbbb");
  });

  it("keeps the later result", () => {
    assert.equal(
      mergeTasks(
        task({ w: 100, result: "early", status: "done" }),
        task({ w: 200, n: "bbbb", result: "late", status: "done" }),
      ).result,
      "late",
    );
  });

  it("is idempotent, signature included", () => {
    const signed: TaskEntry = {
      ...task({ deps: ["a"], attempts: 2 }),
      by: "f".repeat(64),
      sig: "A".repeat(88),
    };
    assert.deepEqual(mergeTasks(signed, { ...signed }), signed);
  });
});

describe("SPEC §11.5 — negotiation", () => {
  const local = { min: 3, max: 4, caps: ["sig", "chunk"] };

  const vectors: Array<[number, number, number | "incompatible"]> = [
    [3, 4, 4],
    [3, 3, 3],
    [9, 9, "incompatible"],
    [5, 2, "incompatible"],
  ];

  for (const [min, max, expected] of vectors) {
    it(`remote ${min}-${max} settles on ${expected}`, () => {
      const result = negotiate({ min, max, node: "peer", caps: [] }, local);
      if (expected === "incompatible") {
        assert.equal(result.ok, false);
      } else {
        assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.version, expected);
      }
    });
  }

  it("intersects capabilities rather than unioning them", () => {
    const result = negotiate(
      { min: 4, max: 4, node: "peer", caps: ["sig", "telepathy"] },
      local,
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual([...result.caps], ["sig"]);
  });
});
