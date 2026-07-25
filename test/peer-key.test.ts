import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  MAX_PEER_LABEL_LENGTH,
  isValidPublicKeyHex,
  isValidSeedHex,
  normalizePublicKeyHex,
  sanitizeLabel,
  shortFingerprint,
} from "../src/peer-key.js";

const PUBKEY = "0123456789abcdef".repeat(4);

describe("isValidPublicKeyHex", () => {
  it("accepts 64 lowercase hex characters", () => {
    assert.equal(isValidPublicKeyHex(PUBKEY), true);
  });

  it("rejects the wrong length", () => {
    assert.equal(isValidPublicKeyHex(PUBKEY.slice(0, 63)), false);
    assert.equal(isValidPublicKeyHex(PUBKEY + "a"), false);
  });

  it("rejects uppercase and non-hex characters", () => {
    assert.equal(isValidPublicKeyHex(PUBKEY.toUpperCase()), false);
    assert.equal(isValidPublicKeyHex("g".repeat(64)), false);
  });
});

describe("isValidSeedHex", () => {
  it("accepts 64 lowercase hex characters", () => {
    assert.equal(isValidSeedHex("a".repeat(64)), true);
  });

  it("rejects a short seed", () => {
    assert.equal(isValidSeedHex("a".repeat(32)), false);
  });
});

describe("normalizePublicKeyHex", () => {
  it("lowercases and trims", () => {
    assert.equal(normalizePublicKeyHex(`  ${PUBKEY.toUpperCase()}  `), PUBKEY);
  });

  it("returns null for anything malformed", () => {
    assert.equal(normalizePublicKeyHex("nope"), null);
    assert.equal(normalizePublicKeyHex(""), null);
  });
});

describe("shortFingerprint", () => {
  it("takes the first 8 characters", () => {
    assert.equal(shortFingerprint(PUBKEY), "01234567");
  });
});

describe("sanitizeLabel", () => {
  it("passes through an ordinary hostname", () => {
    assert.equal(sanitizeLabel("sanjoy-laptop"), "sanjoy-laptop");
  });

  it("strips newlines so a label cannot forge an audit entry", () => {
    const forged = sanitizeLabel("evil\n### [2026-01-01] - [SOURCE: Local]");
    assert.ok(!forged.includes("\n"));
    assert.ok(!forged.includes("["));
    assert.ok(!forged.includes("]"));
  });

  it("strips carriage returns and tabs", () => {
    assert.equal(sanitizeLabel("a\r\n\tb"), "a b");
  });

  it("strips the DEL control character", () => {
    assert.equal(sanitizeLabel(`a${String.fromCharCode(0x7f)}b`), "a b");
  });

  it("strips NUL and ANSI escape control characters", () => {
    assert.equal(sanitizeLabel(`a${String.fromCharCode(0)}b`), "a b");
    assert.equal(sanitizeLabel(`a${String.fromCharCode(0x1b)}[31mb`), "a 31mb");
  });

  it("strips Markdown structural characters", () => {
    assert.equal(sanitizeLabel("**bold** `code`"), "bold code");
  });

  it("collapses runs of whitespace", () => {
    assert.equal(sanitizeLabel("a     b"), "a b");
  });

  it("caps length", () => {
    assert.equal(sanitizeLabel("x".repeat(500)).length, MAX_PEER_LABEL_LENGTH);
  });

  it("falls back to a placeholder when everything is stripped", () => {
    assert.equal(sanitizeLabel("***"), "unnamed-peer");
    assert.equal(sanitizeLabel("   "), "unnamed-peer");
    assert.equal(sanitizeLabel(""), "unnamed-peer");
  });
});
