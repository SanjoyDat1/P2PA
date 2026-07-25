/** Minimal typings for hyperdht (CJS, no shipped .d.ts). */
declare module "hyperdht" {
  export interface HyperDhtKeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }

  export default class DHT {
    /**
     * Derive an ed25519 keypair. Deterministic when `seed` (32 bytes) is given,
     * random otherwise.
     */
    static keyPair(seed?: Buffer | Uint8Array): HyperDhtKeyPair;
    ready(): Promise<void>;
    destroy(): Promise<void>;
  }
}

/** In-process DHT for tests — lets the suite run without touching the public DHT. */
declare module "hyperdht/testnet" {
  import type DHT from "hyperdht";

  export interface Testnet {
    nodes: DHT[];
    bootstrap: Array<{ host: string; port: number }>;
    createNode(options?: Record<string, unknown>): DHT;
    destroy(): Promise<void>;
  }

  export default function createTestnet(
    size?: number,
    options?: Record<string, unknown>,
  ): Promise<Testnet>;
}
