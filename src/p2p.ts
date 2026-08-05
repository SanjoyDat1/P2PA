import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import Hyperswarm, { type HyperswarmDiscovery } from "hyperswarm";
import type { AuthMode } from "./config.js";
import type { KeyPair } from "./identity.js";
import { sanitizeLabel, shortFingerprint } from "./peer-key.js";
import {
  CAP_ADDRESSED_MESSAGES,
  CAP_CHUNKED_SNAPSHOT,
  CAP_TASKS,
  LOCAL_PROFILE,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  digestsMatch,
  legacyNegotiation,
  negotiate,
  type CloseReason,
  type Negotiation,
  type StateDigest,
} from "./protocol.js";
import {
  MAX_PAYLOAD_BYTES,
  MAX_SNAPSHOT_PARTS,
  PeerEnvelopeSchema,
  type PeerEnvelope,
} from "./types.js";
import { MAX_CLAIM_KEYS, MAX_CRDT_KEYS, MAX_TASK_KEYS, type CrdtOp } from "./crdt.js";
import { isTaskKey } from "./task.js";
import { nodeIdFromPublicKey } from "./hlc.js";

/**
 * Bytes of serialized ops packed into one snapshot part.
 *
 * Half the frame ceiling, so the envelope wrapper and JSON escaping cannot push
 * a part over the limit the receiver enforces.
 */
export const SNAPSHOT_PART_BUDGET = 512 * 1024;

/**
 * Ops accepted across a whole inbound snapshot.
 *
 * There is no point receiving more entries than the document can hold, so this
 * is the natural bound: a peer cannot use a chunked transfer to stream forever.
 */
export const SNAPSHOT_MAX_TOTAL_OPS =
  MAX_CRDT_KEYS + MAX_CLAIM_KEYS + MAX_TASK_KEYS;

/** How long to wait for a peer's hello before assuming it is a v3 node. */
export const HELLO_TIMEOUT_MS = 5_000;

/**
 * How long the handshake snapshot window stays open.
 *
 * A snapshot is the only frame carrying stamps its sender did not author, so the
 * window has to close on a clock rather than on the sender's cooperation — a peer
 * that promises 512 parts and sends one must not keep relay rights indefinitely.
 * Generous enough for a large chunked transfer over a slow link.
 */
export const SNAPSHOT_WINDOW_MS = 120_000;

/**
 * Outbound bytes buffered for a peer that is not reading.
 *
 * `conn.write()` returning false means the kernel buffer is full; ignoring it
 * (as this did) lets a fast writer grow memory without limit against a peer that
 * has stopped consuming. Past this the peer is treated as failed rather than
 * carried indefinitely.
 */
export const MAX_OUTBOUND_QUEUE_BYTES = 8 * 1024 * 1024;

/**
 * Inbound envelope rate, as a token bucket.
 *
 * Every accepted envelope re-renders `shared_context.md` in full, so a peer
 * sending small valid frames at link rate amplifies into continuous whole-file
 * writes. The burst is sized to admit a legitimate chunked snapshot in one go.
 */
export const ENVELOPE_BURST = 600;
export const ENVELOPE_REFILL_PER_SEC = 100;

/** Inbound byte rate. Burst covers a large handshake snapshot. */
export const BYTE_BURST = 64 * 1024 * 1024;
export const BYTE_REFILL_PER_SEC = 8 * 1024 * 1024;

/**
 * Per-connection inbound budget.
 *
 * Isolated from the swarm so the policy can be asserted directly, in the same
 * spirit as `shouldBlockPeer`: a rate limiter that is only reachable through a
 * live DHT connection is a rate limiter nobody checks.
 *
 * Two buckets rather than one. Frames and bytes are independent abuses — a flood
 * of tiny valid updates is cheap on bandwidth but each one re-renders the whole
 * Markdown document, while one enormous frame is the reverse.
 */
export class RateBudget {
  private envelopeTokens: number;
  private byteTokens: number;
  private lastRefill: number;

  constructor(
    private readonly envelopeBurst: number = ENVELOPE_BURST,
    private readonly envelopeRefill: number = ENVELOPE_REFILL_PER_SEC,
    private readonly byteBurst: number = BYTE_BURST,
    private readonly byteRefill: number = BYTE_REFILL_PER_SEC,
    now: number = Date.now(),
  ) {
    this.envelopeTokens = envelopeBurst;
    this.byteTokens = byteBurst;
    this.lastRefill = now;
  }

  /**
   * Charge one frame of `bytes`. False means the peer is over budget.
   *
   * Refills before charging, so an idle connection is not penalised for the gap.
   */
  admit(bytes: number, now: number = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.envelopeTokens = Math.min(
      this.envelopeBurst,
      this.envelopeTokens + elapsed * this.envelopeRefill,
    );
    this.byteTokens = Math.min(
      this.byteBurst,
      this.byteTokens + elapsed * this.byteRefill,
    );

    if (this.envelopeTokens < 1 || this.byteTokens < bytes) return false;
    this.envelopeTokens -= 1;
    this.byteTokens -= bytes;
    return true;
  }
}

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

/**
 * Split a replica into frames that each fit inside the payload limit.
 *
 * Greedy by serialized size. An op larger than the budget still goes out on its
 * own — `MAX_VALUE_BYTES` already caps a single entry well below the frame
 * ceiling, so a lone oversized part cannot be constructed from valid entries.
 */
export function chunkSnapshot(
  ops: CrdtOp[],
  budget: number = SNAPSHOT_PART_BUDGET,
): CrdtOp[][] {
  if (ops.length === 0) return [[]];
  const parts: CrdtOp[][] = [];
  let current: CrdtOp[] = [];
  let size = 0;
  for (const op of ops) {
    const cost = JSON.stringify(op).length + 1;
    if (current.length > 0 && size + cost > budget) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(op);
    size += cost;
  }
  if (current.length > 0) parts.push(current);
  return parts;
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
  /**
   * Current replica digests, advertised in `hello`.
   *
   * Two peers whose documents already match skip the snapshot entirely, which is
   * what stops a reconnect storm from re-shipping the whole document per peer.
   */
  getDigest?: () => StateDigest;
  /** This node's label, shared with peers for display. */
  label?: string;
  onPeerMessage: PeerMessageHandler;
  /** Called once a peer is authenticated, negotiated and connected. */
  onPeerConnect?: (peer: PeerIdentity) => void;
  /**
   * Did the frame just handed to `onPeerMessage` contain a forged signature?
   *
   * Consulted immediately after each frame. Reported this way rather than thrown
   * because the rest of the frame still merges correctly — only the connection
   * needs to end.
   */
  sawForgery?: () => boolean;
}

interface ConnState {
  buffer: string;
  /** Rendered peer label, cached so log lines do not rebuild it per chunk. */
  label: string;
  /** Settled version + capabilities, or null until the peer identifies itself. */
  negotiated: Negotiation | null;
  /** Our snapshot is deferred until negotiation, so it can be shaped correctly. */
  snapshotSent: boolean;
  /** Parts of the handshake snapshot accepted so far. */
  partsAccepted: number;
  /** Total parts the sender promised, from the first part that named one. */
  partsExpected: number | null;
  /** Ops accepted across the whole snapshot, bounded independently of parts. */
  snapshotOps: number;
  /** Set once the handshake snapshot is complete; later snapshots are refused. */
  snapshotComplete: boolean;
  /** Fires if the peer never sends a hello, so a v3 node still gets served. */
  helloTimer: NodeJS.Timeout | undefined;
  /** Frames held while the socket is saturated, in order. */
  queue: string[];
  queueBytes: number;
  drainHooked: boolean;
  /** True once `write()` reported a full buffer; cleared when it drains. */
  saturated: boolean;
  /** Distinct snapshot parts already accepted, so a part cannot be replayed. */
  partsSeen: Set<number>;
  /** When the handshake snapshot window closes, whatever the peer has sent. */
  snapshotDeadline: number;
  /** Inbound rate budget for this peer. */
  budget: RateBudget;
}

/**
 * Hyperswarm P2P transport.
 *
 * - Discovers peers via DHT on sha256(topic)
 * - Frames envelopes as NDJSON (one JSON object per line)
 * - Opens with `hello`, negotiates version + capabilities, then syncs
 * - Sends the replica as one or more `snapshot` parts, skipped when digests match
 * - Refuses to buffer for a peer that has stopped reading, and rate-limits inbound
 */
export class P2PNode {
  private readonly swarm: Hyperswarm;
  private readonly topic: string;
  private readonly topicFingerprint: string;
  private readonly getActiveState: () => CrdtOp[];
  private readonly getDigest: (() => StateDigest) | undefined;
  private readonly label: string | undefined;
  private readonly onPeerMessage: PeerMessageHandler;
  private readonly onPeerConnect: (peer: PeerIdentity) => void;
  private readonly forgeryReporter: (() => boolean) | undefined;
  private readonly connState = new WeakMap<Duplex, ConnState>();
  private readonly authMode: AuthMode;
  private readonly isPeerAllowed: (pubkeyHex: string) => boolean;
  private readonly lookupPeer: PeerLookup;
  private readonly publicKeyHex: string;
  private blockedCount = 0;
  private rejectedCount = 0;
  private started = false;
  private discovery: HyperswarmDiscovery | null = null;

  constructor(options: P2POptions) {
    this.topic = options.topic;
    this.topicFingerprint = createHash("sha256")
      .update(options.topic)
      .digest("hex")
      .slice(0, 8);
    this.getActiveState = options.getActiveState;
    this.getDigest = options.getDigest;
    this.label = options.label;
    this.onPeerMessage = options.onPeerMessage;
    this.onPeerConnect = options.onPeerConnect ?? (() => {});
    this.forgeryReporter = options.sawForgery;
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

  /** Connections dropped after connecting — bad version, rate, or backpressure. */
  get rejectedConnections(): number {
    return this.rejectedCount;
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
        `(auth=${this.authMode}, me=${shortFingerprint(this.publicKeyHex)}, ` +
        `protocol v${MIN_PROTOCOL_VERSION}-v${PROTOCOL_VERSION})`,
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

  /** Send an envelope to every negotiated peer as NDJSON. */
  broadcast(envelope: PeerEnvelope): void {
    for (const conn of this.swarm.connections) {
      const state = this.connState.get(conn);
      if (!state || !state.negotiated?.ok) continue;
      this.writeEnvelope(conn, state, envelope);
    }
  }

  /**
   * Send to one peer, if it is connected. Returns false when it is not.
   *
   * Used to replay a backlog to the peer that just arrived, rather than
   * broadcasting it at everyone who was already up to date.
   */
  sendTo(publicKeyHex: string, envelope: PeerEnvelope): boolean {
    for (const conn of this.swarm.connections) {
      const peer = this.identifyPeer(conn);
      if (peer.pubkey !== publicKeyHex) continue;
      const state = this.connState.get(conn);
      if (!state || !state.negotiated?.ok) return false;
      this.writeEnvelope(conn, state, envelope);
      return true;
    }
    return false;
  }

  /** Public keys of every currently connected, negotiated peer. */
  connectedKeys(): string[] {
    const keys: string[] = [];
    for (const conn of this.swarm.connections) {
      const state = this.connState.get(conn);
      if (!state || !state.negotiated?.ok) continue;
      const peer = this.identifyPeer(conn);
      if (peer.pubkey !== null) keys.push(peer.pubkey);
    }
    return keys;
  }

  /** Number of currently open peer connections. */
  connectionCount(): number {
    return this.swarm.connections.size;
  }

  /** Protocol version settled with a peer, or null when not negotiated. */
  versionFor(publicKeyHex: string): number | null {
    for (const conn of this.swarm.connections) {
      const peer = this.identifyPeer(conn);
      if (peer.pubkey !== publicKeyHex) continue;
      const state = this.connState.get(conn);
      return state?.negotiated?.ok === true ? state.negotiated.version : null;
    }
    return null;
  }

  /** Does the connection to this peer carry a capability? */
  peerSupports(publicKeyHex: string, cap: string): boolean {
    for (const conn of this.swarm.connections) {
      const peer = this.identifyPeer(conn);
      if (peer.pubkey !== publicKeyHex) continue;
      const state = this.connState.get(conn);
      return state?.negotiated?.ok === true && state.negotiated.caps.has(cap);
    }
    return false;
  }

  async close(): Promise<void> {
    for (const conn of this.swarm.connections) {
      const state = this.connState.get(conn);
      if (state) this.clearTimers(state);
    }
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
        this.closeConnection(conn, "unauthorized", "removed from allowlist");
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
    const state: ConnState = {
      buffer: "",
      label: remoteLabel,
      negotiated: null,
      snapshotSent: false,
      partsAccepted: 0,
      partsExpected: null,
      snapshotOps: 0,
      snapshotComplete: false,
      helloTimer: undefined,
      queue: [],
      queueBytes: 0,
      drainHooked: false,
      saturated: false,
      partsSeen: new Set<number>(),
      snapshotDeadline: Date.now() + SNAPSHOT_WINDOW_MS,
      budget: new RateBudget(),
    };
    this.connState.set(conn, state);

    conn.on("data", (chunk: Buffer | Uint8Array | string) => {
      this.onData(conn, peer, chunk);
    });

    conn.on("error", (err: Error) => {
      console.error(`[p2p] connection error (${remoteLabel}): ${err.message}`);
    });

    conn.on("close", () => {
      this.clearTimers(state);
      this.connState.delete(conn);
      console.error(`[p2p] Peer disconnected (${remoteLabel})`);
    });

    // Open with our own hello. The peer's reply settles the version, and only
    // then do we know whether to chunk the snapshot, or skip it entirely.
    this.writeLine(conn, state, encodeNdjsonLine(this.buildHello()));

    // A v3 peer never sends a hello — it opens with its snapshot. Usually that
    // arrives at once and identifies it. This covers the peer that says nothing:
    // without it, waiting for a hello that is never coming would mean neither
    // side ever sends state.
    state.helloTimer = setTimeout(() => {
      if (state.negotiated !== null) return;
      console.error(
        `[p2p] no hello from ${remoteLabel} within ${HELLO_TIMEOUT_MS}ms — ` +
          `treating it as a protocol v${MIN_PROTOCOL_VERSION} peer`,
      );
      this.settleNegotiation(conn, state, peer, legacyNegotiation());
    }, HELLO_TIMEOUT_MS);
    state.helloTimer.unref?.();
  }

  private buildHello(): PeerEnvelope {
    const digest = this.getDigest?.();
    return {
      type: "hello",
      v: PROTOCOL_VERSION,
      min: LOCAL_PROFILE.min,
      max: LOCAL_PROFILE.max,
      node: this.publicKeyHex.slice(0, 16),
      caps: [...LOCAL_PROFILE.caps],
      ...(digest ? { digest } : {}),
      ...(this.label !== undefined ? { label: this.label } : {}),
    };
  }

  /**
   * Record the negotiated version, then send state.
   *
   * Everything version-dependent happens here, once, so the rest of the
   * connection never has to ask what the peer can understand.
   */
  private settleNegotiation(
    conn: Duplex,
    state: ConnState,
    peer: PeerIdentity,
    result: Negotiation,
    remoteDigest?: StateDigest,
    remoteLabel?: string,
  ): void {
    if (state.helloTimer) {
      clearTimeout(state.helloTimer);
      state.helloTimer = undefined;
    }
    state.negotiated = result;

    if (!result.ok) {
      // The whole reason `hello` exists: say why, to both logs, instead of
      // dropping every frame in silence.
      console.error(
        `[p2p] cannot talk to ${state.label}: ${result.detail}`,
      );
      this.closeConnection(conn, result.reason, result.detail);
      return;
    }

    console.error(
      `[p2p] negotiated protocol v${result.version} with ${state.label}` +
        (result.caps.size > 0
          ? ` (caps: ${[...result.caps].sort().join(",")})`
          : " (no shared capabilities)") +
        // Peer-supplied and sanitized. Shown because it is the only human-readable
        // hint about an unpaired peer, and marked as self-reported because it is a
        // claim: the fingerprint above is the identity.
        (remoteLabel !== undefined ? ` — self-reported as "${remoteLabel}"` : ""),
    );

    this.sendSnapshot(conn, state, remoteDigest);

    // Last: after state has been offered, and after the error handler is
    // installed, because a replay can push a batch of messages.
    try {
      this.onPeerConnect(peer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[p2p] connect handler failed for ${state.label}: ${message}`);
    }
  }

  /**
   * Offer our replica to a freshly negotiated peer.
   *
   * Skipped outright when the digests in the two hellos already agree, which is
   * the common case for a reconnect and turns an O(document) transfer per peer
   * into nothing at all.
   */
  private sendSnapshot(
    conn: Duplex,
    state: ConnState,
    remoteDigest: StateDigest | undefined,
  ): void {
    if (state.snapshotSent) return;
    state.snapshotSent = true;

    const local = this.getDigest?.();
    if (local && digestsMatch(local, remoteDigest)) {
      console.error(
        `[p2p] ${state.label} already holds this document (state=${local.state}) — ` +
          `skipping the handshake snapshot`,
      );
      return;
    }

    // Filtered before chunking, not after, so the part counts the receiver
    // checks against still describe what it is actually sent.
    const ops = opsForPeer(this.getActiveState(), capsOf(state));
    const chunked =
      state.negotiated?.ok === true && state.negotiated.caps.has(CAP_CHUNKED_SNAPSHOT);

    if (!chunked) {
      // A v3 peer cannot read `part`/`of`, so there is nothing to split it into.
      // An oversized document simply cannot reach that peer; say so plainly
      // rather than shipping a frame it will disconnect over.
      const line = encodeNdjsonLine({ type: "snapshot", v: MIN_PROTOCOL_VERSION, ops });
      if (line.length > MAX_PAYLOAD_BYTES) {
        console.error(
          `[p2p] cannot send a ${line.length}-byte snapshot to ${state.label}: ` +
            `it speaks protocol v${MIN_PROTOCOL_VERSION}, which has no chunked ` +
            `transfer. Upgrade that peer to sync a document this large.`,
        );
        return;
      }
      this.writeLine(conn, state, line);
      return;
    }

    const parts = chunkSnapshot(ops);
    if (parts.length > MAX_SNAPSHOT_PARTS) {
      console.error(
        `[p2p] replica needs ${parts.length} snapshot parts, above the ` +
          `${MAX_SNAPSHOT_PARTS}-part limit — sending the first ${MAX_SNAPSHOT_PARTS}`,
      );
    }
    const sending = parts.slice(0, MAX_SNAPSHOT_PARTS);
    sending.forEach((chunk, index) => {
      this.writeEnvelope(conn, state, {
        type: "snapshot",
        v: PROTOCOL_VERSION,
        ops: chunk,
        part: index + 1,
        of: sending.length,
      });
    });
    if (sending.length > 1) {
      console.error(
        `[p2p] sent replica to ${state.label} in ${sending.length} parts ` +
          `(${ops.length} entries)`,
      );
    }
  }

  /**
   * Write an envelope, shaped for what this connection can understand.
   *
   * Version is stamped here rather than by callers: a single broadcast may go to
   * peers on different versions, and each must receive a frame it accepts.
   */
  private writeEnvelope(
    conn: Duplex,
    state: ConnState,
    envelope: PeerEnvelope,
  ): void {
    const version =
      state.negotiated?.ok === true ? state.negotiated.version : MIN_PROTOCOL_VERSION;
    const shaped = downgrade(envelope, version, capsOf(state));
    // Nothing left to say. An update whose every op was filtered out must not be
    // written as an empty `ops` array: `CrdtOpArraySchema` has `.min(1)`, so the
    // receiver would reject the frame and — depending on its accounting — count
    // a peer sending nothing as a peer sending garbage.
    if (shaped === null) return;
    this.writeLine(conn, state, encodeNdjsonLine(shaped));
  }

  /**
   * Queue a line, respecting backpressure.
   *
   * `conn.write()` returning false means the socket buffer is full. Continuing to
   * write anyway — which is what ignoring the return value does — grows memory
   * without bound whenever a peer stops reading. Frames are held in order and
   * flushed on `drain`; a peer that lets the queue pass its ceiling is dropped,
   * because the alternative is being taken down by it.
   */
  private writeLine(conn: Duplex, state: ConnState, line: string): void {
    if (conn.destroyed) return;

    // Once the socket has signalled "full", everything queues until it drains.
    // Gating on `queue.length` alone was the bug: the queue only ever grows via
    // this path, so it stayed empty forever, every later frame went straight into
    // the socket regardless, and the ceiling below was unreachable — exactly the
    // unbounded buffering the queue exists to prevent.
    if (state.saturated || state.queue.length > 0) {
      this.enqueue(conn, state, line);
      return;
    }

    try {
      if (!conn.write(line)) {
        state.saturated = true;
        this.hookDrain(conn, state);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[p2p] write failed to ${state.label}: ${message}`);
    }
  }

  private enqueue(conn: Duplex, state: ConnState, line: string): void {
    state.queue.push(line);
    state.queueBytes += line.length;
    if (state.queueBytes > MAX_OUTBOUND_QUEUE_BYTES) {
      console.error(
        `[p2p] dropping ${state.label}: ${state.queueBytes} bytes queued and the ` +
          `peer is not reading (slow consumer)`,
      );
      this.closeConnection(conn, "slow-consumer", "outbound queue ceiling reached");
    }
  }

  private hookDrain(conn: Duplex, state: ConnState): void {
    if (state.drainHooked) return;
    state.drainHooked = true;
    conn.once("drain", () => {
      state.drainHooked = false;
      while (state.queue.length > 0) {
        if (conn.destroyed) return;
        const next = state.queue[0] as string;
        const flushed = conn.write(next);
        state.queue.shift();
        state.queueBytes -= next.length;
        if (!flushed) {
          this.hookDrain(conn, state);
          return;
        }
      }
      // Drained with nothing left: writes may go direct again.
      state.saturated = false;
    });
  }

  /** Tell the peer why, then close. */
  private closeConnection(
    conn: Duplex,
    reason: CloseReason,
    detail?: string,
  ): void {
    const state = this.connState.get(conn);
    if (state) {
      this.clearTimers(state);
      try {
        if (!conn.destroyed) {
          conn.write(
            encodeNdjsonLine({
              type: "bye",
              v: PROTOCOL_VERSION,
              reason,
              ...(detail !== undefined ? { detail: detail.slice(0, 500) } : {}),
            }),
          );
        }
      } catch {
        // The peer may already be gone; closing is what matters.
      }
      this.connState.delete(conn);
    }
    this.rejectedCount += 1;
    conn.destroy();
  }

  private clearTimers(state: ConnState): void {
    if (state.helloTimer) {
      clearTimeout(state.helloTimer);
      state.helloTimer = undefined;
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
      console.error(`[p2p] destroying ${state.label}: oversized NDJSON buffer`);
      this.closeConnection(conn, "oversized", "NDJSON buffer ceiling exceeded");
      return;
    }

    let newline: number;
    while ((newline = state.buffer.indexOf("\n")) >= 0) {
      const raw = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (conn.destroyed) return;

      // Charged on the raw length, including the terminator, and before the line
      // is inspected. Charging the trimmed length let a peer prepend a megabyte of
      // spaces for the price of the payload, and skipping empty lines before this
      // point let an endless stream of newlines through for free — both defeating
      // the limit outright.
      if (!state.budget.admit(raw.length + 1)) {
        console.error(
          `[p2p] dropping ${state.label}: inbound rate limit exceeded ` +
            `(> ${ENVELOPE_REFILL_PER_SEC} frames/s or ${BYTE_REFILL_PER_SEC} bytes/s sustained)`,
        );
        this.closeConnection(conn, "rate-limit", "inbound rate limit exceeded");
        return;
      }

      const line = raw.trim();
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
      console.error(`[p2p] destroying ${state.label}: oversized NDJSON line`);
      this.closeConnection(conn, "oversized", "frame exceeds the payload limit");
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
      this.closeConnection(conn, "malformed", "envelope validation threw");
      return;
    }
    if (!result.success) {
      // A version outside the supported range is the one invalid envelope worth
      // explaining, because it is the one an operator can act on.
      const version = (parsed as { v?: unknown })?.v;
      if (typeof version === "number" && version > PROTOCOL_VERSION) {
        console.error(
          `[p2p] ${state.label} sent a protocol v${version} frame; this node ` +
            `supports up to v${PROTOCOL_VERSION}. Upgrade this node (\`npm i -g p2pa\`).`,
        );
        this.closeConnection(
          conn,
          "version-mismatch",
          `frame version v${version} above supported v${PROTOCOL_VERSION}`,
        );
        return;
      }
      console.error(
        `[p2p] ignoring invalid envelope from ${state.label}: ${result.error.message}`,
      );
      return;
    }

    const envelope = result.data;

    if (envelope.type === "hello") {
      if (state.negotiated !== null) {
        console.error(`[p2p] ignoring repeat hello from ${state.label}`);
        return;
      }
      // Cross-check the advertised node id against the key Noise proved. The
      // transport key is the stronger identity and everything downstream binds to
      // it, so this cannot be the security boundary — but a mismatch means the
      // peer is misconfigured or lying, and both are worth refusing here rather
      // than debugging later through inconsistent stamps.
      if (
        peer.pubkey !== null &&
        envelope.node !== nodeIdFromPublicKey(peer.pubkey)
      ) {
        console.error(
          `[p2p] refusing ${state.label}: hello claims node id ` +
            `${sanitizeLabel(envelope.node)} but its transport key is ` +
            `${nodeIdFromPublicKey(peer.pubkey)}`,
        );
        this.closeConnection(
          conn,
          "malformed",
          "hello node id does not match the transport key",
        );
        return;
      }
      this.settleNegotiation(
        conn,
        state,
        peer,
        negotiate({
          min: envelope.min,
          max: envelope.max,
          node: envelope.node,
          caps: envelope.caps,
          ...(envelope.digest ? { digest: envelope.digest } : {}),
        }),
        envelope.digest,
        envelope.label !== undefined ? sanitizeLabel(envelope.label) : undefined,
      );
      return;
    }

    if (envelope.type === "bye") {
      // Peer-authored strings. Length-bounded by the schema, but a newline or an
      // ANSI escape here would let a peer forge log lines or drive the operator's
      // terminal, so they go through the same sanitizer as an audit entry.
      console.error(
        `[p2p] ${state.label} closed the connection: ${sanitizeLabel(envelope.reason)}` +
          (envelope.detail ? ` — ${sanitizeLabel(envelope.detail)}` : ""),
      );
      this.clearTimers(state);
      this.connState.delete(conn);
      conn.destroy();
      return;
    }

    // Any frame other than a hello identifies a peer that does not negotiate.
    if (state.negotiated === null) {
      console.error(
        `[p2p] ${state.label} opened with ${envelope.type} rather than hello — ` +
          `treating it as a protocol v${MIN_PROTOCOL_VERSION} peer`,
      );
      this.settleNegotiation(conn, state, peer, legacyNegotiation());
      if (conn.destroyed) return;
    }

    // Somebody else's mail. Dropped at the transport so it never reaches the
    // audit trail or the event feed — an agent asked to review a diff should not
    // have to work out that the question was aimed at a different agent.
    if (
      envelope.type === "message" &&
      envelope.to !== undefined &&
      envelope.to !== this.publicKeyHex
    ) {
      return;
    }

    if (envelope.type === "snapshot" && !this.admitSnapshot(conn, state, envelope)) {
      return;
    }

    console.error(`[p2p] received ${envelope.type} from ${state.label}`);
    try {
      this.onPeerMessage(envelope, peer);
    } catch (err) {
      // A malformed envelope must cost this peer its connection, not the daemon.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[p2p] handler threw for ${state.label}: ${message}`);
      this.closeConnection(conn, "malformed", "handler threw");
      return;
    }

    // A forged signature is not a peer being sloppy, and verification is the most
    // expensive thing an inbound frame can buy. Dropping the connection makes
    // grinding forgeries cost a reconnect each time instead of being free.
    if (this.forgeryReporter?.() === true) {
      console.error(
        `[p2p] dropping ${state.label}: presented an operation whose signature ` +
          `does not verify`,
      );
      this.closeConnection(conn, "malformed", "operation signature did not verify");
    }
  }

  /**
   * Gate the handshake snapshot.
   *
   * A snapshot is only accepted while the handshake is in progress: it is the one
   * frame that carries stamps the sender did not author, so allowing one later
   * would hand a connected peer a way to keep replaying third-party entries. A
   * chunked transfer is several frames, so the gate counts parts and total ops
   * rather than admitting exactly one.
   */
  private admitSnapshot(
    conn: Duplex,
    state: ConnState,
    envelope: Extract<PeerEnvelope, { type: "snapshot" }>,
  ): boolean {
    if (state.snapshotComplete) {
      console.error(`[p2p] ignoring post-handshake snapshot from ${state.label}`);
      return false;
    }

    // A peer that announces 512 parts and sends one would otherwise hold the
    // window open for the life of the connection, keeping the ability to inject
    // third-party-stamped entries whenever it liked. The window is the handshake,
    // so it closes on time regardless of what the peer does or does not send.
    if (Date.now() > state.snapshotDeadline) {
      state.snapshotComplete = true;
      console.error(
        `[p2p] snapshot window closed for ${state.label} after ` +
          `${SNAPSHOT_WINDOW_MS}ms (${state.partsAccepted}/${state.partsExpected ?? 1} parts)`,
      );
      return false;
    }

    const of = envelope.of ?? 1;
    if (state.partsExpected === null) state.partsExpected = of;
    if (of !== state.partsExpected) {
      console.error(
        `[p2p] destroying ${state.label}: snapshot part count changed mid-transfer ` +
          `(${state.partsExpected} then ${of})`,
      );
      this.closeConnection(conn, "malformed", "snapshot part count changed");
      return false;
    }

    // Track parts by number rather than only counting them, so the same part
    // cannot be replayed to spend the op budget repeatedly.
    const part = envelope.part ?? 1;
    if (part > of) {
      console.error(
        `[p2p] destroying ${state.label}: snapshot part ${part} above the ` +
          `declared total of ${of}`,
      );
      this.closeConnection(conn, "malformed", "snapshot part out of range");
      return false;
    }
    if (state.partsSeen.has(part)) {
      console.error(`[p2p] ignoring repeated snapshot part ${part} from ${state.label}`);
      return false;
    }
    state.partsSeen.add(part);

    state.partsAccepted += 1;
    state.snapshotOps += envelope.ops.length;

    if (state.partsAccepted > state.partsExpected) {
      console.error(`[p2p] ignoring extra snapshot part from ${state.label}`);
      return false;
    }
    if (state.snapshotOps > SNAPSHOT_MAX_TOTAL_OPS) {
      console.error(
        `[p2p] destroying ${state.label}: snapshot carried more than ` +
          `${SNAPSHOT_MAX_TOTAL_OPS} entries`,
      );
      this.closeConnection(conn, "oversized", "snapshot exceeds the entry ceiling");
      return false;
    }

    // Each part is merged as it arrives — merge is commutative and idempotent, so
    // there is no reason to buffer a whole transfer before applying any of it, and
    // a connection lost mid-snapshot leaves the receiver strictly better off.
    if (state.partsAccepted === state.partsExpected) {
      state.snapshotComplete = true;
    }
    return true;
  }
}

const NO_CAPS: ReadonlySet<string> = new Set<string>();

/** Capabilities settled for a connection, or none until it has negotiated. */
function capsOf(state: ConnState): ReadonlySet<string> {
  return state.negotiated?.ok === true ? state.negotiated.caps : NO_CAPS;
}

/**
 * Ops a peer can actually accept.
 *
 * Pure and exported for the same reason `shouldBlockPeer` is: a filter only
 * reachable through a live DHT connection is a filter nobody checks, and this
 * one is load-bearing rather than cosmetic. A peer that did not negotiate `task`
 * validates entries as a *discriminated union*, so one unknown `kind` makes it
 * discard the entire frame — an unfiltered snapshot gives such a peer no sync at
 * all, not a degraded one.
 */
export function opsForPeer(ops: CrdtOp[], caps: ReadonlySet<string>): CrdtOp[] {
  return caps.has(CAP_TASKS) ? ops : ops.filter((op) => !isTaskKey(op.key));
}

/**
 * Shape a frame for what this connection can actually read.
 *
 * Sending a field a peer cannot read is not harmless: v3 validates with a fixed
 * shape, so an unknown field is silently dropped and the sender is left
 * believing it addressed a message the receiver treated as a broadcast.
 *
 * Entry kinds are worse than fields. A kind is discriminated, not additive, so a
 * receiver that does not know `task` rejects the whole frame rather than the one
 * op — which is why the task filter runs before the version shortcut below: a
 * peer can speak protocol v4 and still predate this namespace, and it must not
 * lose every unrelated state op riding in the same update.
 *
 * Returns `null` when nothing survives the filter. An `update` reduced to an
 * empty `ops` array is not writable: `CrdtOpArraySchema` has `.min(1)`, so the
 * receiver would refuse the frame and count us as a peer sending garbage.
 */
export function downgrade(
  envelope: PeerEnvelope,
  version: number,
  caps: ReadonlySet<string>,
): PeerEnvelope | null {
  if (!caps.has(CAP_TASKS)) {
    if (envelope.type === "update") {
      const ops = opsForPeer(envelope.ops, caps);
      if (ops.length === 0) return null;
      if (ops.length !== envelope.ops.length) return { ...envelope, ops, v: version };
    }
    // A snapshot is filtered before chunking, so by the time one reaches here it
    // is already clean. Filtering again is not redundant bookkeeping: this
    // function is exported and documented as the place a frame is shaped for
    // what a connection can read, so the next caller to route a snapshot
    // through it must not silently lose the §7A.7 guarantee. Unlike an update,
    // an emptied snapshot is still a valid frame and is sent as one — that is
    // how a peer learns we have nothing for it.
    if (envelope.type === "snapshot") {
      const ops = opsForPeer(envelope.ops, caps);
      if (ops.length !== envelope.ops.length) return { ...envelope, ops, v: version };
    }
  }

  if (version >= PROTOCOL_VERSION) return { ...envelope, v: version };

  if (envelope.type === "message") {
    if (caps.has(CAP_ADDRESSED_MESSAGES)) return { ...envelope, v: version };
    const { to: _to, corr: _corr, intent: _intent, ...rest } = envelope;
    return { ...rest, v: version };
  }
  if (envelope.type === "snapshot") {
    const { part: _part, of: _of, ...rest } = envelope;
    return { ...rest, v: version };
  }
  return { ...envelope, v: version };
}

function encodeNdjsonLine(envelope: PeerEnvelope): string {
  return `${JSON.stringify(envelope)}\n`;
}

/** Render a peer for logs: `a3f9c1b2 (sanjoy-laptop)`, or just the fingerprint. */
export function describePeer(peer: PeerIdentity): string {
  return peer.label ? `${peer.fingerprint} (${peer.label})` : peer.fingerprint;
}
