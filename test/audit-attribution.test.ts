/**
 * Audit-trail attribution.
 *
 * Before peer authentication every remote change was logged as a bare
 * `SOURCE: Peer`, which made "who changed this" unanswerable. These tests pin
 * the rendered form and, more importantly, that a peer-supplied label cannot
 * forge audit structure.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MarkdownLog } from "../src/markdown-log.js";
import { sanitizeLabel } from "../src/peer-key.js";
import type { AuditPeer } from "../src/types.js";

let dir: string;
let log: MarkdownLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "p2pa-audit-"));
  log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function body(): string {
  return readFileSync(log.path, "utf8");
}

const PEER: AuditPeer = { fingerprint: "a3f9c1b2", label: "sanjoy-laptop" };
const ANON: AuditPeer = { fingerprint: "c1d0e2f3", label: null };

describe("audit attribution", () => {
  it("records the peer fingerprint and label on a patch", () => {
    log.syncStateUpdate("Peer", ["k"], { k: 1 }, undefined, PEER);
    assert.match(body(), /\[SOURCE: Peer a3f9c1b2 \(sanjoy-laptop\)\]/);
  });

  it("records the fingerprint alone when the peer has no label", () => {
    log.syncStateUpdate("Peer", ["k"], { k: 1 }, undefined, ANON);
    assert.match(body(), /\[SOURCE: Peer c1d0e2f3\]/);
    assert.doesNotMatch(body(), /\(null\)/);
  });

  it("attributes peer messages", () => {
    log.syncMessage("Peer", "ship it", PEER);
    assert.match(body(), /\[SOURCE: Peer a3f9c1b2 \(sanjoy-laptop\)\]/);
    assert.match(body(), /> ship it/);
  });

  it("attributes snapshots", () => {
    log.syncSnapshot("Peer", 1, 0, PEER);
    assert.match(body(), /\[SOURCE: Peer a3f9c1b2 \(sanjoy-laptop\)\].*\n.*State Snapshot|State Snapshot/);
    assert.match(body(), /Peer a3f9c1b2/);
  });

  it("attributes concurrent-update entries", () => {
    log.syncMarkdownLog({
      source: "Peer",
      peer: PEER,
      action: "Concurrent Update",
      key: "plan",
      previousNode: "abc123",
    });
    assert.match(body(), /\[SOURCE: Peer a3f9c1b2 \(sanjoy-laptop\)\]/);
    assert.match(body(), /abc123/);
  });

  it("attributes refused updates so a dropped peer is visible", () => {
    log.syncMarkdownLog({
      source: "Peer",
      peer: PEER,
      action: "Rejected Update",
      reason: "stamp out of bounds",
      keys: ["mission"],
    });
    assert.match(body(), /\[ACTION: Rejected Update\]/);
    assert.match(body(), /stamp out of bounds/);
    assert.match(body(), /\[SOURCE: Peer a3f9c1b2 \(sanjoy-laptop\)\]/);
  });

  it("leaves Local entries unchanged", () => {
    log.syncStateUpdate("Local", ["k"], { k: 1 });
    assert.match(body(), /\[SOURCE: Local\]/);
    assert.doesNotMatch(body(), /SOURCE: Local /);
  });

  it("falls back to bare Peer when attribution is absent", () => {
    log.syncStateUpdate("Peer", ["k"], { k: 1 });
    assert.match(body(), /\[SOURCE: Peer\]/);
  });

  it("cannot be forged through a hostile label", () => {
    // The label reaching the log has already been through sanitizeLabel, which
    // is where the guarantee lives — assert the composed behaviour end to end.
    // The attacker's goal is a *second* heading line attributed to Local.
    const hostile = sanitizeLabel("x)]\n### [2020-01-01] - [SOURCE: Local] - [ACTION: Message");
    log.syncStateUpdate("Peer", ["k"], { k: 1 }, undefined, {
      fingerprint: "deadbeef",
      label: hostile,
    });

    const text = body();
    const headings = text.split("\n").filter((line) => line.startsWith("### ["));

    // One entry in, one entry out — the label could not open a new record.
    assert.equal(headings.length, 1, "hostile label must not create a second entry");

    // The heading still conforms to the canonical shape: the label sits inside
    // the SOURCE field and cannot close it early to fake ACTION or SOURCE.
    const heading = headings[0]!;
    const shape =
      /^### \[[\d-]+ [\d:]+\] - \[SOURCE: Peer deadbeef \(([^[\]]*)\)\] - \[ACTION: State Update\]$/;
    const match = shape.exec(heading);
    assert.ok(match, `heading lost its canonical shape: ${heading}`);
    assert.ok(!match[1]!.includes("["), "brackets must be stripped from the label");
    assert.ok(!match[1]!.includes("]"), "brackets must be stripped from the label");
  });

  it("keeps each entry on a single heading line", () => {
    log.syncStateUpdate("Peer", ["k"], { k: 1 }, undefined, PEER);
    const headings = body()
      .split("\n")
      .filter((line) => line.startsWith("### ["));
    assert.equal(headings.length, 1);
  });
});
