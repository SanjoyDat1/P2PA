/**
 * Identity persistence. The public key is a peer's permanent address, so the
 * property that matters most is that it survives restarts unchanged.
 */
import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  getIdentityPath,
  loadOrCreateIdentity,
  setIdentityLabel,
} from "../src/identity.js";
import { isValidPublicKeyHex, isValidSeedHex } from "../src/peer-key.js";

const SCRATCH_ROOT = join(homedir(), ".p2pa-test-scratch");

let configDir: string;

beforeEach(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  configDir = mkdtempSync(join(SCRATCH_ROOT, "id-"));
  process.env["P2PA_CONFIG_DIR"] = configDir;
  process.env["P2PA_PEER_LABEL"] = "test-node";
});

afterEach(() => {
  delete process.env["P2PA_CONFIG_DIR"];
  delete process.env["P2PA_PEER_LABEL"];
  rmSync(configDir, { recursive: true, force: true });
});

describe("loadOrCreateIdentity", () => {
  it("creates a valid identity on first run", () => {
    const identity = loadOrCreateIdentity();
    assert.ok(isValidPublicKeyHex(identity.publicKeyHex));
    assert.equal(identity.keyPair.publicKey.length, 32);
    assert.equal(identity.keyPair.secretKey.length, 64);
    assert.equal(identity.fingerprint, identity.publicKeyHex.slice(0, 8));
    assert.equal(identity.label, "test-node");
  });

  it("is stable across reloads — the public key must not change", () => {
    const first = loadOrCreateIdentity();
    const second = loadOrCreateIdentity();
    assert.equal(first.publicKeyHex, second.publicKeyHex);
    assert.ok(first.keyPair.secretKey.equals(second.keyPair.secretKey));
  });

  it("generates a different key for a different config dir", () => {
    const first = loadOrCreateIdentity();
    const other = mkdtempSync(join(SCRATCH_ROOT, "id-"));
    process.env["P2PA_CONFIG_DIR"] = other;
    try {
      assert.notEqual(loadOrCreateIdentity().publicKeyHex, first.publicKeyHex);
    } finally {
      process.env["P2PA_CONFIG_DIR"] = configDir;
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("persists only a seed, never the expanded secret key", () => {
    const identity = loadOrCreateIdentity();
    const raw = JSON.parse(readFileSync(getIdentityPath(), "utf8")) as Record<string, unknown>;
    assert.equal(raw["version"], 1);
    assert.ok(typeof raw["seed"] === "string" && isValidSeedHex(raw["seed"]));
    assert.equal(raw["secretKey"], undefined);
    const serialized = readFileSync(getIdentityPath(), "utf8");
    assert.ok(
      !serialized.includes(identity.keyPair.secretKey.toString("hex")),
      "secret key must not appear on disk",
    );
  });

  it("writes identity.json with 0600 permissions", () => {
    loadOrCreateIdentity();
    assert.equal(statSync(getIdentityPath()).mode & 0o777, 0o600);
  });

  it("regenerates rather than crashing on a corrupt file", () => {
    writeFileSync(getIdentityPath(), "{ not json");
    const identity = loadOrCreateIdentity();
    assert.ok(isValidPublicKeyHex(identity.publicKeyHex));
  });

  it("regenerates when the seed is the wrong length", () => {
    writeFileSync(getIdentityPath(), JSON.stringify({ version: 1, seed: "abcd", label: "x" }));
    const identity = loadOrCreateIdentity();
    assert.ok(isValidPublicKeyHex(identity.publicKeyHex));
    assert.ok(isValidSeedHex((JSON.parse(readFileSync(getIdentityPath(), "utf8")) as { seed: string }).seed));
  });

  it("regenerates when the seed is not hex", () => {
    writeFileSync(
      getIdentityPath(),
      JSON.stringify({ version: 1, seed: "z".repeat(64), label: "x" }),
    );
    assert.ok(isValidPublicKeyHex(loadOrCreateIdentity().publicKeyHex));
  });

  it("sanitizes a label read from a hand-edited file", () => {
    const identity = loadOrCreateIdentity();
    const raw = JSON.parse(readFileSync(getIdentityPath(), "utf8")) as Record<string, unknown>;
    raw["label"] = "evil\n### [SOURCE: Local]";
    writeFileSync(getIdentityPath(), JSON.stringify(raw));

    const reloaded = loadOrCreateIdentity();
    assert.equal(reloaded.publicKeyHex, identity.publicKeyHex, "key must be unchanged");
    assert.ok(!reloaded.label.includes("\n"));
    assert.ok(!reloaded.label.includes("["));
  });

  it("falls back to the hostname when P2PA_PEER_LABEL is unset", () => {
    delete process.env["P2PA_PEER_LABEL"];
    assert.ok(loadOrCreateIdentity().label.length > 0);
  });
});

describe("setIdentityLabel", () => {
  it("renames without rotating the key", () => {
    const before = loadOrCreateIdentity();
    const after = setIdentityLabel("renamed-box");
    assert.equal(after.publicKeyHex, before.publicKeyHex);
    assert.equal(after.label, "renamed-box");
    assert.equal(loadOrCreateIdentity().label, "renamed-box");
  });

  it("sanitizes the new label", () => {
    loadOrCreateIdentity();
    assert.ok(!setIdentityLabel("bad\nlabel").label.includes("\n"));
  });

  it("creates an identity when none exists yet", () => {
    const identity = setIdentityLabel("fresh");
    assert.ok(isValidPublicKeyHex(identity.publicKeyHex));
    assert.equal(identity.label, "fresh");
  });
});
