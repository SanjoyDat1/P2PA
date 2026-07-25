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
    log.syncStatePatch("Peer", [{ op: "add", path: "/k", value: 1 }], { k: 1 }, PEER);
    assert.match(body(), /\[SOURCE: Peer a3f9c1b2 \(sanjoy-laptop\)\]/);
  });

  it("records the fingerprint alone when the peer has no label", () => {
    log.syncStatePatch("Peer", [{ op: "add", path: "/k", value: 1 }], { k: 1 }, ANON);
    assert.match(body(), /\[SOURCE: Peer c1d0e2f3\]/);
    assert.doesNotMatch(body(), /\(null\)/);
  });

  it("attributes peer messages", () => {
    log.syncMessage("Peer", "ship it", PEER);
    assert.match(body(), /\[SOURCE: Peer a3f9c1b2 \(sanjoy-laptop\)\]/);
    assert.match(body(), /> ship it/);
  });

  it("attributes snapshots", () => {
    log.syncSnapshot("Peer", { k: 1 }, PEER);
    assert.match(body(), /\[SOURCE: Peer a3f9c1b2 \(sanjoy-laptop\)\].*\n.*State Snapshot|State Snapshot/);
    assert.match(body(), /Peer a3f9c1b2/);
  });

  it("attributes collision entries", () => {
    log.syncMarkdownLog({
      source: "Peer",
      peer: PEER,
      action: "Collision Detected",
      localVersion: 3,
      peerVersion: 3,
      conflictId: "abc-123",
    });
    assert.match(body(), /\[SOURCE: Peer a3f9c1b2 \(sanjoy-laptop\)\]/);
    assert.match(body(), /abc-123/);
  });

  it("leaves Local entries unchanged", () => {
    log.syncStatePatch("Local", [{ op: "add", path: "/k", value: 1 }], { k: 1 });
    assert.match(body(), /\[SOURCE: Local\]/);
    assert.doesNotMatch(body(), /SOURCE: Local /);
  });

  it("falls back to bare Peer when attribution is absent", () => {
    log.syncStatePatch("Peer", [{ op: "add", path: "/k", value: 1 }], { k: 1 });
    assert.match(body(), /\[SOURCE: Peer\]/);
  });

  it("cannot be forged through a hostile label", () => {
    // The label reaching the log has already been through sanitizeLabel, which
    // is where the guarantee lives — assert the composed behaviour end to end.
    // The attacker's goal is a *second* heading line attributed to Local.
    const hostile = sanitizeLabel("x)]\n### [2020-01-01] - [SOURCE: Local] - [ACTION: Message");
    log.syncStatePatch("Peer", [{ op: "add", path: "/k", value: 1 }], { k: 1 }, {
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
      /^### \[[\d-]+ [\d:]+\] - \[SOURCE: Peer deadbeef \(([^[\]]*)\)\] - \[ACTION: State Patch\]$/;
    const match = shape.exec(heading);
    assert.ok(match, `heading lost its canonical shape: ${heading}`);
    assert.ok(!match[1]!.includes("["), "brackets must be stripped from the label");
    assert.ok(!match[1]!.includes("]"), "brackets must be stripped from the label");
  });

  it("keeps each entry on a single heading line", () => {
    log.syncStatePatch("Peer", [{ op: "add", path: "/k", value: 1 }], { k: 1 }, PEER);
    const headings = body()
      .split("\n")
      .filter((line) => line.startsWith("### ["));
    assert.equal(headings.length, 1);
  });
});
