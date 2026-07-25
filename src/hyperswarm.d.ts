/** Minimal typings for hyperswarm (CJS, no shipped .d.ts). */
declare module "hyperswarm" {
  import { EventEmitter } from "node:events";
  import type { Duplex } from "node:stream";

  export interface HyperswarmJoinOptions {
    client?: boolean;
    server?: boolean;
  }

  export interface HyperswarmDiscovery {
    flushed(): Promise<void>;
    /**
     * Re-run announce/lookup for this topic. Hyperswarm otherwise refreshes on
     * a 10-minute interval, so a peer that joins in between is not seen until
     * the next tick.
     */
    refresh(options?: { client?: boolean; server?: boolean }): Promise<void>;
  }

  export interface HyperswarmKeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  export interface HyperswarmOptions {
    /** Static Noise identity for this node. Random per-process when omitted. */
    keyPair?: HyperswarmKeyPair;
    /**
     * Connection gate, applied to both inbound and outbound attempts.
     * Return `true` to BLOCK the peer, `false` to allow. Must be synchronous.
     */
    firewall?: (remotePublicKey: Buffer, payload: unknown) => boolean;
    maxPeers?: number;
    /** DHT bootstrap nodes. Used by the test suite to run on a local testnet. */
    bootstrap?: Array<{ host: string; port: number }>;
  }

  export default class Hyperswarm extends EventEmitter {
    constructor(options?: HyperswarmOptions);
    readonly connections: Set<Duplex>;
    readonly keyPair: HyperswarmKeyPair;
    join(topic: Buffer | Uint8Array, options?: HyperswarmJoinOptions): HyperswarmDiscovery;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    on(event: "connection", listener: (conn: Duplex, info: unknown) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}
