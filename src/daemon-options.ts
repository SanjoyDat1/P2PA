import type { CliOptions } from "./types.js";
import { TOPIC_MIN_RECOMMENDED_LENGTH } from "./types.js";
import { resolveContextFile } from "./path-safety.js";
import {
  ensureTopic,
  getSharedContextPath,
  ensureConfigDir,
} from "./config.js";

export { generateTopicCode } from "./topic.js";

/**
 * Resolve runtime options for the index process (daemon or MCP).
 * Prefers env / ~/.p2pa config; optional argv overrides for smoke tests.
 */
export function resolveRuntimeOptions(
  argv: string[] = process.argv.slice(2),
): CliOptions {
  ensureConfigDir();

  let topicOverride: string | undefined;
  let contextOverride: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--topic" && next !== undefined) {
      topicOverride = next;
      i++;
      continue;
    }
    if (arg === "--context-file" && next !== undefined) {
      contextOverride = next;
      i++;
      continue;
    }
  }

  const { topic } = ensureTopic(topicOverride);
  if (
    topicOverride !== undefined &&
    topicOverride.length < TOPIC_MIN_RECOMMENDED_LENGTH
  ) {
    // warning already emitted in ensureTopic
  }

  const contextFile = resolveContextFile(
    contextOverride ?? getSharedContextPath(),
  );

  return { topic, contextFile };
}
