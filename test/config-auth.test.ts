/**
 * Config-backed auth state: allowlist CRUD, auth-mode resolution, and the
 * field-preservation invariant that keeps `setDocLink` from wiping peers.
 *
 * `P2PA_CONFIG_DIR` must point somewhere under $HOME (enforced by config.ts),
 * so each test gets a scratch directory inside the home tree rather than /tmp.
 */
import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const SCRATCH_ROOT = join(homedir(), ".p2pa-test-scratch");

let configDir: string;

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  configDir = mkdtempSync(join(SCRATCH_ROOT, "cfg-"));
  process.env["P2PA_CONFIG_DIR"] = configDir;
  delete process.env["P2PA_TOPIC"];
});

afterEach(() => {
  delete process.env["P2PA_CONFIG_DIR"];
  rmSync(configDir, { recursive: true, force: true });
});

// Imported after the env contract is documented above; config.ts reads
// P2PA_CONFIG_DIR lazily on every call, so a static import is safe.
const {
  addPeer,
  clearDocLink,
  findPeer,
  getConfigPath,
  listPeers,
  readConfig,
  removePeer,
  resolveAuthMode,
  setAuthMode,
  setDocLink,
  writeConfig,
  writeTopicPreservingRest,
} = await import("../src/config.js");

const KEY_A = "a1".repeat(32);
const KEY_B = "b2".repeat(32);
const KEY_C = "c3".repeat(32);

function seedConfig(): void {
  writeConfig({ topic: "test-topic-aaaaaaaa", auth: "strict", peers: [] });
}

function rawConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(getConfigPath(), "utf8")) as Record<string, unknown>;
}

describe("resolveAuthMode", () => {
  it("defaults a missing config to strict", () => {
    assert.deepEqual(resolveAuthMode(null), { mode: "strict", legacy: false });
  });

  it("treats a pre-0.7 config with no auth field as legacy open", () => {
    assert.deepEqual(resolveAuthMode({ topic: "t" }), { mode: "open", legacy: true });
  });

  it("honours an explicit mode without flagging it legacy", () => {
    assert.deepEqual(resolveAuthMode({ topic: "t", auth: "strict" }), {
      mode: "strict",
      legacy: false,
    });
    assert.deepEqual(resolveAuthMode({ topic: "t", auth: "open" }), {
      mode: "open",
      legacy: false,
    });
  });

  it("reads back a mode written by setAuthMode", () => {
    seedConfig();
    setAuthMode("open");
    assert.deepEqual(resolveAuthMode(readConfig()), { mode: "open", legacy: false });
    setAuthMode("strict");
    assert.deepEqual(resolveAuthMode(readConfig()), { mode: "strict", legacy: false });
  });
});

describe("addPeer", () => {
  beforeEach(seedConfig);

  it("allowlists a peer", () => {
    const result = addPeer(KEY_A, "sanjoy-laptop");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.updated, false);
    assert.equal(listPeers().length, 1);
    assert.equal(findPeer(KEY_A)?.label, "sanjoy-laptop");
  });

  it("normalizes an uppercase key", () => {
    addPeer(KEY_A.toUpperCase(), "x");
    assert.equal(listPeers()[0]?.pubkey, KEY_A);
    assert.ok(findPeer(KEY_A.toUpperCase()));
  });

  it("rejects a malformed key", () => {
    const result = addPeer("not-a-key", "x");
    assert.equal(result.ok, false);
    assert.equal(listPeers().length, 0);
  });

  it("is idempotent — re-adding updates the label instead of duplicating", () => {
    addPeer(KEY_A, "old-name");
    const again = addPeer(KEY_A, "new-name");
    assert.equal(again.ok && again.updated, true);
    assert.equal(listPeers().length, 1);
    assert.equal(findPeer(KEY_A)?.label, "new-name");
  });

  it("preserves addedAt across a re-add", () => {
    addPeer(KEY_A, "old");
    const first = findPeer(KEY_A)?.addedAt;
    addPeer(KEY_A, "new");
    assert.equal(findPeer(KEY_A)?.addedAt, first);
  });

  it("sanitizes the stored label", () => {
    addPeer(KEY_A, "evil\n### forged");
    assert.ok(!findPeer(KEY_A)!.label.includes("\n"));
  });

  it("keeps multiple peers", () => {
    addPeer(KEY_A, "a");
    addPeer(KEY_B, "b");
    addPeer(KEY_C, "c");
    assert.equal(listPeers().length, 3);
  });
});

describe("removePeer", () => {
  beforeEach(() => {
    seedConfig();
    addPeer(KEY_A, "alpha");
    addPeer(KEY_B, "beta");
  });

  it("removes by full public key", () => {
    const removed = removePeer(KEY_A);
    assert.equal(removed?.label, "alpha");
    assert.equal(listPeers().length, 1);
    assert.equal(findPeer(KEY_A), undefined);
  });

  it("removes by exact label", () => {
    assert.equal(removePeer("beta")?.pubkey, KEY_B);
    assert.equal(listPeers().length, 1);
  });

  it("returns null for an unknown target and leaves the list alone", () => {
    assert.equal(removePeer(KEY_C), null);
    assert.equal(removePeer("nobody"), null);
    assert.equal(listPeers().length, 2);
  });

  it("does not match a partial key", () => {
    assert.equal(removePeer(KEY_A.slice(0, 16)), null);
    assert.equal(listPeers().length, 2);
  });
});

describe("config field preservation", () => {
  beforeEach(() => {
    seedConfig();
    addPeer(KEY_A, "alpha");
  });

  it("setDocLink keeps the allowlist and auth mode", () => {
    setDocLink({ documentId: "doc123", url: "https://docs.google.com/document/d/doc123/edit" });
    const config = readConfig();
    assert.equal(config?.peers?.length, 1);
    assert.equal(config?.auth, "strict");
    assert.equal(config?.doc?.documentId, "doc123");
  });

  it("clearDocLink keeps the allowlist and auth mode", () => {
    setDocLink({ documentId: "doc123", url: "https://example.invalid" });
    clearDocLink();
    const config = readConfig();
    assert.equal(config?.doc, undefined);
    assert.equal(config?.peers?.length, 1);
    assert.equal(config?.auth, "strict");
  });

  it("writeTopicPreservingRest keeps the allowlist, auth mode and doc link", () => {
    setDocLink({ documentId: "doc123", url: "https://example.invalid" });
    writeTopicPreservingRest("a-brand-new-topic");
    const config = readConfig();
    assert.equal(config?.topic, "a-brand-new-topic");
    assert.equal(config?.peers?.length, 1);
    assert.equal(config?.auth, "strict");
    assert.equal(config?.doc?.documentId, "doc123");
  });

  it("setAuthMode keeps the allowlist", () => {
    setAuthMode("open");
    assert.equal(readConfig()?.peers?.length, 1);
  });

  it("writes config.json with 0600 permissions", () => {
    assert.equal(statSync(getConfigPath()).mode & 0o777, 0o600);
  });
});

describe("readConfig hardening", () => {
  it("drops malformed allowlist entries without failing the whole config", () => {
    seedConfig();
    const raw = rawConfig();
    raw["peers"] = [
      { pubkey: KEY_A, label: "good", addedAt: "2026-01-01T00:00:00.000Z" },
      { pubkey: "too-short", label: "bad" },
      { label: "no-key" },
      null,
      "not-an-object",
      42,
    ];
    writeFileSync(getConfigPath(), JSON.stringify(raw));

    const peers = listPeers();
    assert.equal(peers.length, 1);
    assert.equal(peers[0]?.pubkey, KEY_A);
    assert.equal(readConfig()?.topic, "test-topic-aaaaaaaa");
  });

  it("collapses duplicate public keys to the first occurrence", () => {
    seedConfig();
    const raw = rawConfig();
    raw["peers"] = [
      { pubkey: KEY_A, label: "first", addedAt: "2026-01-01T00:00:00.000Z" },
      { pubkey: KEY_A, label: "second", addedAt: "2026-01-02T00:00:00.000Z" },
    ];
    writeFileSync(getConfigPath(), JSON.stringify(raw));

    const peers = listPeers();
    assert.equal(peers.length, 1);
    assert.equal(peers[0]?.label, "first");
  });

  it("ignores a non-array peers field", () => {
    seedConfig();
    const raw = rawConfig();
    raw["peers"] = { pubkey: KEY_A };
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    assert.equal(readConfig()?.peers, undefined);
    assert.deepEqual(listPeers(), []);
  });

  it("ignores an unrecognized auth value and reports legacy", () => {
    seedConfig();
    const raw = rawConfig();
    raw["auth"] = "paranoid";
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    assert.deepEqual(resolveAuthMode(readConfig()), { mode: "open", legacy: true });
  });

  it("sanitizes labels read from a hand-edited config", () => {
    seedConfig();
    const raw = rawConfig();
    raw["peers"] = [{ pubkey: KEY_A, label: "evil\n### [SOURCE: Local]" }];
    writeFileSync(getConfigPath(), JSON.stringify(raw));
    const label = listPeers()[0]!.label;
    assert.ok(!label.includes("\n"));
    assert.ok(!label.includes("["));
  });
});
