/**
 * Live view of the peer allowlist.
 *
 * The firewall in `p2p.ts` is consulted on every connection attempt and must be
 * synchronous, so the allowlist is held in memory as a Map and refreshed when
 * `config.json` changes on disk. Without the watch, `p2pa pair` would only take
 * effect after restarting the daemon — a cliff that reliably gets misread as
 * "pairing is broken".
 *
 * The directory is watched rather than the file: `writeConfig` persists via
 * write-temp-then-rename, which swaps the inode and silently detaches a
 * file-level watcher after the first write.
 */
import { watch, type FSWatcher } from "node:fs";
import { getConfigDir, listPeers, type PeerEntry } from "./config.js";

/** Coalesce the burst of events a single atomic write produces. */
const RELOAD_DEBOUNCE_MS = 150;

export interface Allowlist {
  /** Firewall predicate. Synchronous by contract. */
  isAllowed(pubkeyHex: string): boolean;
  /** Attribution lookup for a connected peer. */
  lookup(pubkeyHex: string): { label: string } | undefined;
  /** Number of allowlisted peers. */
  readonly size: number;
  /** Re-read `config.json` immediately. Returns true if the set changed. */
  reload(): boolean;
  /** Register a callback fired after an on-disk change is picked up. */
  onChange(listener: () => void): void;
  /** Stop watching. Safe to call more than once. */
  close(): void;
}

function toMap(peers: PeerEntry[]): Map<string, PeerEntry> {
  return new Map(peers.map((p) => [p.pubkey, p]));
}

function sameKeys(a: Map<string, PeerEntry>, b: Map<string, PeerEntry>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) {
    if (!b.has(key)) return false;
  }
  return true;
}

/**
 * Build an allowlist backed by `config.json`, watching for changes.
 *
 * Watching is best-effort: on platforms or filesystems where `fs.watch` fails
 * we log once and fall back to load-at-boot rather than refusing to start.
 */
export function createAllowlist(): Allowlist {
  let peers = toMap(listPeers());
  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const listeners: Array<() => void> = [];

  const reload = (): boolean => {
    const next = toMap(listPeers());
    if (sameKeys(peers, next)) {
      // Labels may still have changed; adopt the new entries either way.
      peers = next;
      return false;
    }
    peers = next;
    return true;
  };

  const scheduleReload = (): void => {
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      if (closed) return;
      const changed = reload();
      console.error(
        `[p2pa:auth] allowlist reloaded from config.json (${peers.size} peer(s))`,
      );
      if (changed) {
        for (const listener of listeners) listener();
      }
    }, RELOAD_DEBOUNCE_MS);
    if (typeof debounce === "object" && "unref" in debounce) {
      debounce.unref();
    }
  };

  try {
    watcher = watch(getConfigDir(), (_event, filename) => {
      if (filename === null || filename === "config.json") {
        scheduleReload();
      }
    });
    watcher.on("error", (err: Error) => {
      console.error(
        `[p2pa:auth] allowlist watch error (${err.message}) — ` +
          "restart p2pa after pairing for changes to take effect",
      );
    });
    watcher.unref();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[p2pa:auth] could not watch config.json (${message}) — ` +
        "restart p2pa after pairing for changes to take effect",
    );
  }

  return {
    isAllowed: (pubkeyHex: string) => peers.has(pubkeyHex),
    lookup: (pubkeyHex: string) => {
      const entry = peers.get(pubkeyHex);
      return entry ? { label: entry.label } : undefined;
    },
    get size() {
      return peers.size;
    },
    reload,
    onChange: (listener: () => void) => {
      listeners.push(listener);
    },
    close: () => {
      closed = true;
      if (debounce !== null) {
        clearTimeout(debounce);
        debounce = null;
      }
      watcher?.close();
      watcher = null;
    },
  };
}
