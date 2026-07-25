import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  MAX_TOKEN_LENGTH,
  MAX_TOPIC_LENGTH,
  TOKEN_PREFIX,
  decodeInvite,
  encodeInvite,
} from "../src/invite.js";

const PUBKEY = "a".repeat(64);
const OTHER_PUBKEY = "b3".repeat(32);

function validToken(overrides: Partial<Parameters<typeof encodeInvite>[0]> = {}) {
  return encodeInvite({
    topic: "our-secret-room-123",
    pubkey: PUBKEY,
    label: "sanjoy-laptop",
    ...overrides,
  });
}

describe("encodeInvite", () => {
  it("round-trips a well-formed invite", () => {
    const parsed = decodeInvite(validToken());
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.ok && parsed.invite, {
      topic: "our-secret-room-123",
      pubkey: PUBKEY,
      label: "sanjoy-laptop",
    });
  });

  it("emits the documented three-part format", () => {
    const parts = validToken().split(".");
    assert.equal(parts.length, 3);
    assert.equal(parts[0], TOKEN_PREFIX);
    assert.match(parts[1]!, /^[A-Za-z0-9_-]+$/);
    assert.equal(parts[2]!.length, 6);
  });

  it("normalizes an uppercase public key", () => {
    const parsed = decodeInvite(validToken({ pubkey: PUBKEY.toUpperCase() }));
    assert.equal(parsed.ok && parsed.invite.pubkey, PUBKEY);
  });

  it("rejects a malformed public key", () => {
    assert.throws(() => encodeInvite({ topic: "t", pubkey: "nope", label: "x" }), /64 lowercase hex/);
  });

  it("rejects an empty topic", () => {
    assert.throws(() => encodeInvite({ topic: "", pubkey: PUBKEY, label: "x" }), /must not be empty/);
  });

  it("rejects an oversized topic", () => {
    assert.throws(
      () => encodeInvite({ topic: "t".repeat(MAX_TOPIC_LENGTH + 1), pubkey: PUBKEY, label: "x" }),
      /exceeds/,
    );
  });

  it("produces distinct tokens for distinct keys", () => {
    assert.notEqual(validToken(), validToken({ pubkey: OTHER_PUBKEY }));
  });
});

describe("decodeInvite", () => {
  it("rejects an empty token", () => {
    const r = decodeInvite("   ");
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /empty/);
  });

  it("rejects a token over the length cap without parsing it", () => {
    const r = decodeInvite("x".repeat(MAX_TOKEN_LENGTH + 1));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /exceeds/);
  });

  it("rejects the wrong number of segments", () => {
    assert.equal(decodeInvite("p2pa1.abc").ok, false);
    assert.equal(decodeInvite("p2pa1.a.b.c").ok, false);
  });

  it("rejects an unknown prefix", () => {
    const [, payload, checksum] = validToken().split(".");
    const r = decodeInvite(`p2pa9.${payload}.${checksum}`);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /unsupported token version/);
  });

  it("catches a truncated payload via the checksum", () => {
    const [prefix, payload, checksum] = validToken().split(".");
    const r = decodeInvite(`${prefix}.${payload!.slice(0, -4)}.${checksum}`);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /checksum mismatch/);
  });

  it("catches a tampered payload via the checksum", () => {
    // Re-encoding a hostile payload without fixing the checksum must not pass.
    const evil = Buffer.from(
      JSON.stringify({ v: 1, t: "attacker-topic", k: OTHER_PUBKEY, l: "evil" }),
      "utf8",
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const [, , checksum] = validToken().split(".");
    const r = decodeInvite(`${TOKEN_PREFIX}.${evil}.${checksum}`);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /checksum mismatch/);
  });

  it("rejects non-base64url payload characters", () => {
    const r = decodeInvite(`${TOKEN_PREFIX}.not*valid*b64.abcdef`);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /base64url/);
  });

  it("rejects a payload that is not JSON", () => {
    const payload = Buffer.from("plain text", "utf8").toString("base64url");
    const r = decodeInvite(rebuild(payload));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /not valid JSON/);
  });

  it("rejects a JSON array payload", () => {
    const r = decodeInvite(rebuild(b64(JSON.stringify([1, 2, 3]))));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /not an object/);
  });

  it("rejects an unknown payload version", () => {
    const r = decodeInvite(rebuild(b64(JSON.stringify({ v: 2, t: "x", k: PUBKEY, l: "y" }))));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /unsupported token payload version/);
  });

  it("rejects a missing topic", () => {
    const r = decodeInvite(rebuild(b64(JSON.stringify({ v: 1, k: PUBKEY, l: "y" }))));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /missing a topic/);
  });

  it("rejects a bad public key inside a well-formed payload", () => {
    const r = decodeInvite(rebuild(b64(JSON.stringify({ v: 1, t: "x", k: "zz", l: "y" }))));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /not 64 hex characters/);
  });

  it("sanitizes a hostile label rather than rejecting the token", () => {
    const r = decodeInvite(
      rebuild(b64(JSON.stringify({ v: 1, t: "x", k: PUBKEY, l: "evil\n### [SOURCE: Local]" }))),
    );
    assert.equal(r.ok, true);
    const label = r.ok ? r.invite.label : "";
    assert.ok(!label.includes("\n"), "newline must be stripped");
    assert.ok(!label.includes("["), "bracket must be stripped");
  });

  it("falls back to a placeholder when the label is missing", () => {
    const r = decodeInvite(rebuild(b64(JSON.stringify({ v: 1, t: "x", k: PUBKEY }))));
    assert.equal(r.ok && r.invite.label, "unnamed-peer");
  });

  it("rejects an oversized topic inside the payload", () => {
    const r = decodeInvite(
      rebuild(b64(JSON.stringify({ v: 1, t: "t".repeat(MAX_TOPIC_LENGTH + 1), k: PUBKEY, l: "y" }))),
    );
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /topic exceeds/);
  });

  it("tolerates surrounding whitespace from a copy-paste", () => {
    assert.equal(decodeInvite(`\n  ${validToken()}  \n`).ok, true);
  });
});

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

/** Rebuild a token with a correct checksum so payload validation is what fails. */
function rebuild(payload: string): string {
  const checksum = createHash("sha256")
    .update(payload, "utf8")
    .digest("base64url")
    .slice(0, 6);
  return `${TOKEN_PREFIX}.${payload}.${checksum}`;
}
