import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import Hyperswarm from "hyperswarm";
import {
  MAX_PAYLOAD_BYTES,
  PeerEnvelopeSchema,
  type PeerEnvelope,
  type ContextState,
} from "./types.js";

export type PeerMessageHandler = (envelope: PeerEnvelope, remoteLabel: string) => void;

export interface P2POptions {
  /** Human-readable pairing topic (capability secret). */
  topic: string;
  /** Called to obtain the current Active State for handshake snapshots. */
  getActiveState: () => ContextState;
  onPeerMessage: PeerMessageHandler;
}

interface ConnState {
  buffer: string;
  /** Only the first inbound snapshot per connection is accepted (handshake). */
  snapshotAccepted: boolean;
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
  private readonly getActiveState: () => ContextState;
  private readonly onPeerMessage: PeerMessageHandler;
  private readonly connState = new WeakMap<Duplex, ConnState>();
  private started = false;

  constructor(options: P2POptions) {
    this.topic = options.topic;
    this.topicFingerprint = createHash("sha256")
      .update(options.topic)
      .digest("hex")
      .slice(0, 8);
    this.getActiveState = options.getActiveState;
    this.onPeerMessage = options.onPeerMessage;
    this.swarm = new Hyperswarm();

    this.swarm.on("connection", (conn) => {
      this.handleConnection(conn);
    });
  }

  /** Short hash of the topic for logs (never log the raw topic after share). */
  get fingerprint(): string {
    return this.topicFingerprint;
  }

  /**
   * Join the topic swarm and wait for DHT announcement (`flush`).
   * Must be awaited before relying on discovery.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const topicKey = createHash("sha256").update(this.topic).digest();
    this.swarm.join(topicKey, { client: true, server: true });
    await this.swarm.flush();
    console.error(
      `[p2p] Looking for peers on topic fingerprint: ${this.topicFingerprint}`,
    );
  }

  /** Send an envelope to every connected peer as NDJSON. */
  broadcast(envelope: PeerEnvelope): void {
    const line = encodeNdjsonLine(envelope);
    for (const conn of this.swarm.connections) {
      writeLine(conn, line);
    }
  }

  /** Number of currently open peer connections. */
  connectionCount(): number {
    return this.swarm.connections.size;
  }

  async close(): Promise<void> {
    await this.swarm.destroy();
  }

  private handleConnection(conn: Duplex): void {
    const remoteLabel = peerLabel(conn);
    console.error(`[p2p] Peer connected! (${remoteLabel})`);
    this.connState.set(conn, { buffer: "", snapshotAccepted: false });

    // Handshake: push full Active State so the peer converges immediately.
    const snapshot: PeerEnvelope = {
      type: "snapshot",
      state: this.getActiveState(),
    };
    writeLine(conn, encodeNdjsonLine(snapshot));

    conn.on("data", (chunk: Buffer | Uint8Array | string) => {
      this.onData(conn, remoteLabel, chunk);
    });

    conn.on("error", (err: Error) => {
      console.error(`[p2p] connection error (${remoteLabel}): ${err.message}`);
    });

    conn.on("close", () => {
      this.connState.delete(conn);
      console.error(`[p2p] Peer disconnected (${remoteLabel})`);
    });
  }

  private onData(
    conn: Duplex,
    remoteLabel: string,
    chunk: Buffer | Uint8Array | string,
  ): void {
    const state = this.connState.get(conn);
    if (!state) return;

    const text =
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    state.buffer += text;

    if (state.buffer.length > MAX_PAYLOAD_BYTES * 2) {
      console.error(
        `[p2p] destroying ${remoteLabel}: oversized NDJSON buffer`,
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
      this.handleLine(conn, state, line, remoteLabel);
    }
  }

  private handleLine(
    conn: Duplex,
    state: ConnState,
    line: string,
    remoteLabel: string,
  ): void {
    if (line.length > MAX_PAYLOAD_BYTES) {
      console.error(
        `[p2p] destroying ${remoteLabel}: oversized NDJSON line`,
      );
      this.connState.delete(conn);
      conn.destroy();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.error(`[p2p] ignoring non-JSON NDJSON line from ${remoteLabel}`);
      return;
    }

    const result = PeerEnvelopeSchema.safeParse(parsed);
    if (!result.success) {
      console.error(
        `[p2p] ignoring invalid envelope from ${remoteLabel}: ${result.error.message}`,
      );
      return;
    }

    const envelope = result.data;

    // Handshake gate: only the first snapshot on this connection is applied.
    if (envelope.type === "snapshot") {
      if (state.snapshotAccepted) {
        console.error(
          `[p2p] ignoring post-handshake snapshot from ${remoteLabel}`,
        );
        return;
      }
      state.snapshotAccepted = true;
    }

    console.error(`[p2p] received ${envelope.type} from ${remoteLabel}`);
    this.onPeerMessage(envelope, remoteLabel);
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

function peerLabel(conn: Duplex): string {
  const remote = (conn as Duplex & { remotePublicKey?: Uint8Array }).remotePublicKey;
  if (remote && remote.length > 0) {
    return Buffer.from(remote).subarray(0, 4).toString("hex");
  }
  return "peer";
}
