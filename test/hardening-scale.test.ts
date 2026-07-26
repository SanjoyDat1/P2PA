/**
 * Keeping the node fast and the file honest as history accumulates.
 *
 * The whole document is re-rendered on every mutation, so an unbounded audit
 * trail makes each write proportional to the entire history — a slowdown that
 * arrives gradually and for reasons nobody can see. And two processes each
 * rewriting their own full copy silently lose each other's work.
 */
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MAX_AUDIT_BYTES, MAX_AUDIT_ENTRIES, MarkdownLog } from "../src/markdown-log.js";
import { ContextStore } from "../src/store.js";
import { commitLocalMutation } from "../src/sync.js";
import { acquireLock, lockHolder, releaseLock } from "../src/lock.js";
import { getConfigDir } from "../src/config.js";

const TEST_LOCK = "p2pa-test-writer";

let dir: string;
let log: MarkdownLog;

function auditHeadings(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("### [")).length;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "p2pa-scale-"));
  log = new MarkdownLog(join(dir, "shared_context.md"));
  log.ensureInitialized();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the audit trail stays bounded", () => {
  it("caps how many entries the live file carries", () => {
    for (let i = 0; i < MAX_AUDIT_ENTRIES + 60; i += 1) {
      log.syncMessage("Local", `entry ${i}`);
    }
    assert.ok(
      auditHeadings(log.path) <= MAX_AUDIT_ENTRIES,
      `live file kept ${auditHeadings(log.path)} entries`,
    );
  });

  it("moves older entries to an archive rather than losing them", () => {
    const total = MAX_AUDIT_ENTRIES + 60;
    for (let i = 0; i < total; i += 1) log.syncMessage("Local", `entry ${i}`);

    assert.ok(existsSync(log.archivePath), "history must still be somewhere");
    assert.equal(
      auditHeadings(log.path) + auditHeadings(log.archivePath),
      total,
      "every entry is either live or archived",
    );
  });

  it("keeps the newest entries live and archives the oldest", () => {
    for (let i = 0; i < MAX_AUDIT_ENTRIES + 20; i += 1) {
      log.syncMessage("Local", `entry ${i}`);
    }
    const live = readFileSync(log.path, "utf8");
    assert.match(live, /entry 219/, "the most recent entry must stay in view");
    assert.doesNotMatch(live, /> entry 0$/m, "the oldest should have rolled off");
    assert.match(readFileSync(log.archivePath, "utf8"), /entry 0/);
  });

  it("does not let the live file grow without limit", () => {
    for (let i = 0; i < 100; i += 1) log.syncMessage("Local", `warmup ${i}`);
    const early = statSync(log.path).size;

    for (let i = 0; i < 900; i += 1) log.syncMessage("Local", `later ${i}`);
    const later = statSync(log.path).size;

    // Ten times the writes must not mean ten times the file.
    assert.ok(
      later < early * 4,
      `live file grew from ${early} to ${later} bytes`,
    );
  });

  it("keeps per-write cost flat as history accumulates", () => {
    const timeBatch = (label: string): number => {
      const started = Date.now();
      for (let i = 0; i < 200; i += 1) log.syncMessage("Local", `${label} ${i}`);
      return Date.now() - started;
    };

    const first = timeBatch("first");
    for (let i = 0; i < 2_000; i += 1) log.syncMessage("Local", `bulk ${i}`);
    const later = timeBatch("later");

    // Unbounded growth showed up here as the later batch costing many times
    // the first; bounded, the two are comparable.
    assert.ok(
      later < first * 5 + 500,
      `writes slowed from ${first}ms to ${later}ms as history grew`,
    );
  });

  it("bounds the live file by bytes, not just entry count", () => {
    // A peer may send up to a megabyte per message, so 200 entries is not a
    // bound on anything if each one can be enormous.
    for (let i = 0; i < 40; i += 1) {
      log.syncMessage("Peer", "x".repeat(200_000), { fingerprint: "deadbeef", label: null });
    }
    assert.ok(
      statSync(log.path).size < MAX_AUDIT_BYTES * 4,
      `live file reached ${statSync(log.path).size} bytes`,
    );
  });

  it("truncates an oversized message in the audit entry", () => {
    log.syncMessage("Peer", "y".repeat(50_000), { fingerprint: "deadbeef", label: null });
    const body = readFileSync(log.path, "utf8");
    assert.match(body, /\[truncated\]/);
    assert.ok(body.length < 50_000, "the whole message must not be embedded");
  });

  it("says in the file that history was moved", () => {
    for (let i = 0; i < MAX_AUDIT_ENTRIES + 20; i += 1) {
      log.syncMessage("Local", `entry ${i}`);
    }
    assert.match(
      readFileSync(log.path, "utf8"),
      /archive\.md/,
      "a reader must be able to tell entries were archived, not lost",
    );
  });

  it("does not accumulate rotation markers", () => {
    for (let i = 0; i < MAX_AUDIT_ENTRIES + 400; i += 1) {
      log.syncMessage("Local", `entry ${i}`);
    }
    const markers = readFileSync(log.path, "utf8").split("archive.md").length - 1;
    assert.ok(markers <= 1, `found ${markers} rotation markers`);
  });

  it("refuses to append through a symlinked archive", () => {
    const target = join(dir, "elsewhere.md");
    writeFileSync(target, "", "utf8");
    symlinkSync(target, log.archivePath);

    for (let i = 0; i < MAX_AUDIT_ENTRIES + 20; i += 1) {
      log.syncMessage("Local", `entry ${i}`);
    }
    assert.equal(
      readFileSync(target, "utf8"),
      "",
      "a planted symlink must not redirect the archive",
    );
  });

  it("still round-trips state through a rotated file", () => {
    const store = new ContextStore("a".repeat(64));
    commitLocalMutation({ store, log }, (s) => s.setKey("project", "p2pa"));
    for (let i = 0; i < MAX_AUDIT_ENTRIES + 40; i += 1) {
      log.syncMessage("Local", `noise ${i}`);
    }

    const reloaded = new ContextStore("a".repeat(64));
    reloaded.load(new MarkdownLog(log.path).readReplicaState());
    assert.equal(reloaded.get("project"), "p2pa", "rotation must not touch state");
  });
});

describe("only one process writes the context", () => {
  it("grants the lock to the first caller", () => {
    const first = acquireLock(TEST_LOCK);
    assert.equal(first.acquired, true);
    releaseLock(TEST_LOCK);
  });

  it("is re-entrant for the process that already holds it", () => {
    acquireLock(TEST_LOCK);
    assert.equal(acquireLock(TEST_LOCK).acquired, true);
    releaseLock(TEST_LOCK);
  });

  it("reports who holds it", () => {
    acquireLock(TEST_LOCK);
    assert.equal(lockHolder(TEST_LOCK), process.pid);
    releaseLock(TEST_LOCK);
    assert.equal(lockHolder(TEST_LOCK), null);
  });

  it("refuses a caller when a live process holds it", () => {
    // A pid that exists but is not us: the parent is always alive.
    writeFileSync(join(getConfigDir(), `${TEST_LOCK}.lock`), `${process.ppid}\n`);
    const result = acquireLock(TEST_LOCK);
    assert.equal(result.acquired, false);
    assert.equal(result.heldBy, process.ppid);
    rmSync(join(getConfigDir(), `${TEST_LOCK}.lock`), { force: true });
  });

  it("treats a lock written before this boot as stale", () => {
    // Pids are recycled; without this a reboot can lock the user out forever.
    writeFileSync(
      join(getConfigDir(), `${TEST_LOCK}.lock`),
      `${process.ppid} 1\n`,
    );
    assert.equal(acquireLock(TEST_LOCK).acquired, true);
    releaseLock(TEST_LOCK);
  });

  it("clears a lock whose owner has died", () => {
    // A crash must not leave the tool permanently unusable.
    writeFileSync(join(getConfigDir(), `${TEST_LOCK}.lock`), "999999999\n");
    assert.equal(acquireLock(TEST_LOCK).acquired, true);
    releaseLock(TEST_LOCK);
  });

  it("does not release a lock owned by someone else", () => {
    writeFileSync(join(getConfigDir(), `${TEST_LOCK}.lock`), `${process.ppid}\n`);
    releaseLock(TEST_LOCK);
    assert.equal(
      existsSync(join(getConfigDir(), `${TEST_LOCK}.lock`)),
      true,
      "releasing must be owner-only",
    );
    rmSync(join(getConfigDir(), `${TEST_LOCK}.lock`), { force: true });
  });
});
