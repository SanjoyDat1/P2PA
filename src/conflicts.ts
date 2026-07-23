import { randomUUID } from "node:crypto";
import type { Operation } from "fast-json-patch";
import type { MarkdownLog } from "./markdown-log.js";
import {
  MAX_CONFLICT_QUEUE,
  type ConflictItem,
  type ContextState,
} from "./types.js";

/**
 * In-memory FIFO queue of colliding peer patches awaiting LLM resolution.
 */
export class ConflictQueue {
  private readonly items: ConflictItem[] = [];

  get size(): number {
    return this.items.length;
  }

  list(): ConflictItem[] {
    return this.items.map((item) => ({
      ...item,
      peerOps: item.peerOps.map((op) => ({ ...op })),
      localState: { ...item.localState },
    }));
  }

  peek(): ConflictItem | undefined {
    return this.items[0];
  }

  /**
   * Enqueue a collision. Returns the item, or null if the queue is full.
   */
  enqueue(input: {
    peerOps: Operation[];
    peerVersion: number | null;
    localState: ContextState;
    localVersion: number;
  }): ConflictItem | null {
    if (this.items.length >= MAX_CONFLICT_QUEUE) {
      return null;
    }
    const item: ConflictItem = {
      id: randomUUID(),
      peerOps: input.peerOps.map((op) => ({ ...op })),
      peerVersion: input.peerVersion,
      localState: { ...input.localState },
      localVersion: input.localVersion,
      detectedAt: new Date().toISOString(),
    };
    this.items.push(item);
    return item;
  }

  /** Pop the oldest conflict (FIFO). */
  shift(): ConflictItem | undefined {
    return this.items.shift();
  }

  /** Put a conflict back at the front after a failed resolve attempt. */
  requeue(item: ConflictItem): void {
    if (this.items.length >= MAX_CONFLICT_QUEUE) {
      const dropped = this.items.pop();
      console.error(
        `[conflicts] requeue at capacity — dropped newest conflict ${dropped?.id ?? "(unknown)"}`,
      );
    }
    this.items.unshift(item);
  }

  /** Rewrite the Markdown ## Conflicts section from the current queue. */
  syncMarkdown(log: MarkdownLog): void {
    log.rewriteConflicts(this.items);
  }
}
