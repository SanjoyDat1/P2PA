import { randomUUID } from "node:crypto";
import type { MarkdownLog } from "./markdown-log.js";
import {
  MAX_CONTENTION_LOG,
  MAX_CONTENTION_PER_PEER,
  type ContentionItem,
  type JsonValue,
} from "./types.js";

/**
 * Record of writes that landed on a key another node had written.
 *
 * Under the counter protocol this was a blocking queue: a colliding patch was
 * held here and *no* further peer state applied until an LLM drained it, so a
 * peer could stall sync entirely just by sending non-successor versions. Merge
 * is deterministic now, so nothing blocks on this — it is a bounded,
 * informational ring buffer an agent can consult to notice it was overruled.
 *
 * Bounded twice over: a global cap, and a per-peer cap so one noisy peer cannot
 * evict everyone else's entries.
 */
export class ContentionLog {
  private readonly items: ContentionItem[] = [];

  get size(): number {
    return this.items.length;
  }

  list(): ContentionItem[] {
    return this.items.map((item) => ({ ...item }));
  }

  peek(): ContentionItem | undefined {
    return this.items[0];
  }

  /** Record a settled contended write. Always succeeds; never blocks sync. */
  record(input: {
    key: string;
    previousNode: string;
    peerFingerprint: string | null;
    winningValue: JsonValue | undefined;
  }): ContentionItem {
    const item: ContentionItem = {
      id: randomUUID(),
      key: input.key,
      previousNode: input.previousNode,
      peerFingerprint: input.peerFingerprint,
      winningValue: input.winningValue,
      detectedAt: new Date().toISOString(),
    };

    this.evictForPeer(item.peerFingerprint);
    this.items.push(item);
    while (this.items.length > MAX_CONTENTION_LOG) {
      this.items.shift();
    }
    return item;
  }

  /** Drop this peer's oldest entry once it holds its share of the buffer. */
  private evictForPeer(fingerprint: string | null): void {
    const mine = this.items.filter(
      (item) => item.peerFingerprint === fingerprint,
    );
    if (mine.length < MAX_CONTENTION_PER_PEER) return;
    const oldest = mine[0];
    if (!oldest) return;
    const index = this.items.findIndex((item) => item.id === oldest.id);
    if (index >= 0) this.items.splice(index, 1);
  }

  /** Forget entries for one key, e.g. after an agent overrides the outcome. */
  clearKey(key: string): number {
    let removed = 0;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i]?.key === key) {
        this.items.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.items.length = 0;
  }

  /** Rewrite the Markdown ## Concurrent Updates section from current entries. */
  syncMarkdown(log: MarkdownLog): void {
    log.rewriteContention(this.items);
  }
}
