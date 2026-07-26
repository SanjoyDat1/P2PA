import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import Hyperswarm, { type HyperswarmDiscovery } from "hyperswarm";
import type { AuthMode } from "./config.js";
import type { KeyPair } from "./identity.js";
import { shortFingerprint } from "./peer-key.js";
import {
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  PeerEnvelopeSchema,
  type PeerEnvelope,
} from "./types.js";
import type { CrdtOp } from "./crdt.js";

/**
 * Who a message came from. `pubkey` is proven by the Noise handshake — the
 * transport will not hand us a connection unless the remote holds the matching
 * secret key — so it is safe to use for attribution.
 */
export interface PeerIdentity {
  /** Remote ed25519 public key, lowercase hex. Null only if the transport omits it. */
  pubkey: string | null;
  /** Allowlist label when known, else null. */
  label: string | null;
  /** Short display form, used in logs and the audit trail. */
  fingerprint: string;
}

export type PeerMessageHandler = (
  envelope: PeerEnvelope,
  peer: PeerIdentity,
) => void;

/** Resolves a public key to its allowlist entry. Consulted per connection. */
export type PeerLookup = (pubkeyHex: string) => { label: string } | undefined;

/**
 * The authorization decision, isolated so it can be tested without a swarm.
 *
 * Returns `true` to BLOCK, matching Hyperswarm's `firewall` contract — getting
 * this polarity backwards would silently allow everyone, so it is asserted
 * directly in the test suite.
 */
export function shouldBlockPeer(
  authMode: AuthMode,
  isPeerAllowed: (pubkeyHex: string) => boolean,
  pubkeyHex: string | null,
): boolean {
  if (authMode !== "strict") return false;
  if (pubkeyHex === null) return true;
  return !isPeerAllowed(pubkeyHex);
}

export interface P2POptions {
  /**
   * Pairing topic. Discovery material, not an access-control boundary — it is
   * announced on the public DHT. Authentication is `authMode` + `isPeerAllowed`.
   */
  topic: string;
  /** Stable node identity. A random keypair is used when omitted (tests). */
  keyPair?: KeyPair;
  /**
   * Connection policy. In `strict` mode only keys accepted by `isPeerAllowed`
   * may connect, inbound or outbound. Required rather than defaulted: a
   * forgotten argument must not silently open the swarm.
   */
  authMode: AuthMode;
  /**
   * Allowlist predicate, re-read on every connection attempt.
   * Omitted in `strict` mode means "allow nobody" — this fails closed.
   */
  isPeerAllowed?: (pubkeyHex: string) => boolean;
  /** Allowlist label lookup, for attribution. */
  lookupPeer?: PeerLookup;
  /** DHT bootstrap override. Only used by the test suite's local testnet. */
  bootstrap?: Array<{ host: string; port: number }>;
  /** Called to obtain the stamped replica state for handshake snapshots. */
  getActiveState: () => CrdtOp[];
  onPeerMessage: PeerMessageHandler;
  /** Called once a peer is authenticated and connected, for outbox replay. */
  onPeerConnect?: (peer: PeerIdentity) => void;
}

interface ConnState {
  buffer: string;
  /** Only the first inbound snapshot per connection is accepted (handshake). */
  snapshotAccepted: boolean;
  /** Rendered peer label, cached so log lines do not rebuild it per chunk. */
  label: string;
}

/**
 * Hyperswarm P2P transport (Phase 3).
 * - Discovers peers via DHT on sha256(topic)
 * - Frames envelopes as NDJSON (one JSON object per line)
 * - On connect: sends a full Active State snapshot, then diffs/messages
 * - Accepts at most one inbound snapshot per connection (handshake only)
 */
export class P2PNode {
  private readonly swarm: Hyperswarm;
  private readonly topic: string;
  private readonly topicFingerprint: string;
  private readonly getActiveState: () => CrdtOp[];
  private readonly onPeerMessage: PeerMessageHandler;
  private readonly onPeerConnect: (peer: PeerIdentity) => void;
  private readonly connState = new WeakMap<Duplex, ConnState>();
  private readonly authMode: AuthMode;
  private readonly isPeerAllowed: (pubkeyHex: string) => boolean;
  private readonly lookupPeer: PeerLookup;
  private readonly publicKeyHex: string;
  private blockedCount = 0;
  private started = false;
  private discovery: HyperswarmDiscovery | null = null;

  constructor(options: P2POptions) {
    this.topic = options.topic;
    this.topicFingerprint = createHash("sha256")
      .update(options.topic)
      .digest("hex")
      .slice(0, 8);
    this.getActiveState = options.getActiveState;
    this.onPeerMessage = options.onPeerMessage;
    this.onPeerConnect = options.onPeerConnect ?? (() => {});
    this.authMode = options.authMode;
    // Fail closed: strict mode with no allowlist admits nobody, not everybody.
    this.isPeerAllowed = options.isPeerAllowed ?? (() => false);
    this.lookupPeer = options.lookupPeer ?? (() => undefined);

    this.swarm = new Hyperswarm({
      ...(options.keyPair ? { keyPair: options.keyPair } : {}),
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
      // Hyperswarm's contract: return TRUE to BLOCK. Applied to both inbound
      // server connections and outbound dials, and must stay synchronous.
      firewall: (remotePublicKey: Buffer) => this.isFirewalled(remotePublicKey),
    });
    this.publicKeyHex = Buffer.from(this.swarm.keyPair.publicKey).toString("hex");

    this.swarm.on("connection", (conn) => {
      this.handleConnection(conn);
    });
  }

  /** Short hash of the topic for logs (never log the raw topic after share). */
  get fingerprint(): string {
    return this.topicFingerprint;
  }

  /** This node's ed25519 public key (lowercase hex) — its swarm address. */
  get publicKey(): string {
    return this.publicKeyHex;
  }

  /** Connection attempts refused by the allowlist since start. */
  get blockedConnections(): number {
    return this.blockedCount;
  }

  /**
   * The authentication boundary.
   *
   * In `strict` mode an unlisted key is refused before any application data is
   * exchanged, so an unauthorized peer can neither read state via the handshake
   * snapshot nor write it via a patch.
   */
  private isFirewalled(remotePublicKey: Buffer): boolean {
    const hex = Buffer.from(remotePublicKey).toString("hex");
    if (!shouldBlockPeer(this.authMode, this.isPeerAllowed, hex)) return false;

    this.blockedCount += 1;
    console.error(
      `[p2p] BLOCKED unauthorized peer ${shortFingerprint(hex)} ` +
        `(not in allowlist; add with \`p2pa pair\`)`,
    );
    return true;
  }

  /**
   * Join the topic swarm and wait for DHT announcement (`flush`).
   * Must be awaited before relying on discovery.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const topicKey = createHash("sha256").update(this.topic).digest();
    this.discovery = this.swarm.join(topicKey, { client: true, server: true });
    await this.swarm.flush();
    console.error(
      `[p2p] Looking for peers on topic fingerprint: ${this.topicFingerprint} ` +
        `(auth=${this.authMode}, me=${shortFingerprint(this.publicKeyHex)})`,
    );
  }

  /**
   * Re-run announce + lookup for the topic.
   *
   * Hyperswarm only refreshes discovery every 10 minutes, so a peer allowlisted
   * after startup would otherwise sit undiscovered for up to that long. Called
   * when the allowlist changes so pairing takes effect promptly.
   */
  async refreshDiscovery(): Promise<void> {
    if (!this.discovery) return;
    try {
      await this.discovery.refresh();
      // flush() waits for the resulting dial attempts to settle, so callers
      // that await this have an accurate connectionCount() afterwards.
      await this.swarm.flush();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[p2p] discovery refresh failed: ${message}`);
    }
  }

  /** Send an envelope to every connected peer as NDJSON. */
  broadcast(envelope: PeerEnvelope): void {
    const line = encodeNdjsonLine(envelope);
    for (const conn of this.swarm.connections) {
      writeLine(conn, line);
    }
  }

  /**
   * Send to one peer, if it is connected. Returns false when it is not.
   *
   * Used to replay a backlog to the peer that just arrived, rather than
   * broadcasting it at everyone who was already up to date.
   */
  sendTo(publicKeyHex: string, envelope: PeerEnvelope): boolean {
    const line = encodeNdjsonLine(envelope);
    for (const conn of this.swarm.connections) {
      const peer = this.identifyPeer(conn);
      if (peer.pubkey === publicKeyHex) {
        writeLine(conn, line);
        return true;
      }
    }
    return false;
  }

  /** Public keys of every currently connected peer. */
  connectedKeys(): string[] {
    const keys: string[] = [];
    for (const conn of this.swarm.connections) {
      const peer = this.identifyPeer(conn);
      if (peer.pubkey !== null) keys.push(peer.pubkey);
    }
    return keys;
  }

  /** Number of currently open peer connections. */
  connectionCount(): number {
    return this.swarm.connections.size;
  }

  async close(): Promise<void> {
    await this.swarm.destroy();
  }

  /**
   * Drop any open connection whose peer is no longer allowlisted.
   *
   * The firewall only runs at connect time, so revoking a peer would otherwise
   * leave its existing session live indefinitely. Called after the config
   * changes. Returns the number of connections closed.
   */
  enforceAllowlist(): number {
    if (this.authMode !== "strict") return 0;
    let closed = 0;
    for (const conn of this.swarm.connections) {
      const peer = this.identifyPeer(conn);
      if (peer.pubkey !== null && !this.isPeerAllowed(peer.pubkey)) {
        console.error(
          `[p2p] closing revoked peer ${describePeer(peer)} (removed from allowlist)`,
        );
        this.connState.delete(conn);
        conn.destroy();
        closed += 1;
      }
    }
    return closed;
  }

  private identifyPeer(conn: Duplex): PeerIdentity {
    const remote = (conn as Duplex & { remotePublicKey?: Uint8Array })
      .remotePublicKey;
    if (!remote || remote.length === 0) {
      return { pubkey: null, label: null, fingerprint: "unknown" };
    }
    const pubkey = Buffer.from(remote).toString("hex");
    return {
      pubkey,
      label: this.lookupPeer(pubkey)?.label ?? null,
      fingerprint: shortFingerprint(pubkey),
    };
  }

  private handleConnection(conn: Duplex): void {
    const peer = this.identifyPeer(conn);
    const remoteLabel = describePeer(peer);

    // Defence in depth: the firewall should already have refused this key, so a
    // connection reaching here unlisted means the gate was bypassed. Never
    // send the handshake snapshot to a peer we cannot vouch for.
    if (shouldBlockPeer(this.authMode, this.isPeerAllowed, peer.pubkey)) {
      this.blockedCount += 1;
      console.error(
        `[p2p] refusing connection from unauthorized peer ${remoteLabel} ` +
          `(firewall bypass — no state was shared)`,
      );
      conn.destroy();
      return;
    }

    console.error(`[p2p] Peer connected! (${remoteLabel})`);
    this.connState.set(conn, {
      buffer: "",
      snapshotAccepted: false,
      label: remoteLabel,
    });

    // Handshake: push the stamped replica so the peer converges immediately.
    // The receiver merges it key by key, so this cannot overwrite their work.
    const snapshot: PeerEnvelope = {
      type: "snapshot",
      v: PROTOCOL_VERSION,
      ops: this.getActiveState(),
    };
    writeLine(conn, encodeNdjsonLine(snapshot));

    conn.on("data", (chunk: Buffer | Uint8Array | string) => {
      this.onData(conn, peer, chunk);
    });

    conn.on("error", (err: Error) => {
      console.error(`[p2p] connection error (${remoteLabel}): ${err.message}`);
    });

    conn.on("close", () => {
      this.connState.delete(conn);
      console.error(`[p2p] Peer disconnected (${remoteLabel})`);
    });

    // Last: after the snapshot so the peer already has current state, and after
    // the error handler because a replay can push a batch of messages.
    try {
      this.onPeerConnect(peer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[p2p] connect handler failed for ${remoteLabel}: ${message}`);
    }
  }

  private onData(
    conn: Duplex,
    peer: PeerIdentity,
    chunk: Buffer | Uint8Array | string,
  ): void {
    const state = this.connState.get(conn);
    if (!state) return;

    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    state.buffer += text;

    if (state.buffer.length > MAX_PAYLOAD_BYTES * 2) {
      console.error(
        `[p2p] destroying ${state.label}: oversized NDJSON buffer`,
      );
      this.connState.delete(conn);
      conn.destroy();
      return;
    }

    let newline: number;
    while ((newline = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      this.handleLine(conn, state, line, peer);
    }
  }

  private handleLine(
    conn: Duplex,
    state: ConnState,
    line: string,
    peer: PeerIdentity,
  ): void {
    if (line.length > MAX_PAYLOAD_BYTES) {
      console.error(
        `[p2p] destroying ${state.label}: oversized NDJSON line`,
      );
      this.connState.delete(conn);
      conn.destroy();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.error(`[p2p] ignoring non-JSON NDJSON line from ${state.label}`);
      return;
    }

    let result: ReturnType<typeof PeerEnvelopeSchema.safeParse>;
    try {
      result = PeerEnvelopeSchema.safeParse(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[p2p] destroying ${state.label}: envelope validation failed hard (${message})`,
      );
      this.connState.delete(conn);
      conn.destroy();
      return;
    }
    if (!result.success) {
      console.error(
        `[p2p] ignoring invalid envelope from ${state.label}: ${result.error.message}`,
      );
      return;
    }

    const envelope = result.data;

    // Handshake gate: only the first snapshot on this connection is applied.
    if (envelope.type === "snapshot") {
      if (state.snapshotAccepted) {
        console.error(
          `[p2p] ignoring post-handshake snapshot from ${state.label}`,
        );
        return;
      }
      state.snapshotAccepted = true;
    }

    console.error(`[p2p] received ${envelope.type} from ${state.label}`);
    try {
      this.onPeerMessage(envelope, peer);
    } catch (err) {
      // A malformed envelope must cost this peer its connection, not the daemon.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[p2p] handler threw for ${state.label}: ${message}`);
      this.connState.delete(conn);
      conn.destroy();
    }
  }
}

function encodeNdjsonLine(envelope: PeerEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

function writeLine(conn: Duplex, line: string): void {
  try {
    if (conn.destroyed) return;
    conn.write(line);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[p2p] write failed: ${message}`);
  }
}

/** Render a peer for logs: `a3f9c1b2 (sanjoy-laptop)`, or just the fingerprint. */
export function describePeer(peer: PeerIdentity): string {
  return peer.label ? `${peer.fingerprint} (${peer.label})` : peer.fingerprint;
}
