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
  }

  export default class Hyperswarm extends EventEmitter {
    readonly connections: Set<Duplex>;
    join(topic: Buffer | Uint8Array, options?: HyperswarmJoinOptions): HyperswarmDiscovery;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    on(event: "connection", listener: (conn: Duplex, info: unknown) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }
}
