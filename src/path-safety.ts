import {
  resolve,
  relative,
  isAbsolute,
  extname,
  dirname,
  parse as parsePath,
} from "node:path";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { getConfigDir, ensureConfigDir } from "./config.js";

/**
 * Resolve a Markdown context file under a trusted root:
 * - process.cwd(), or
 * - ~/.p2pa (getConfigDir())
 *
 * Rejects traversal and symlink escapes outside those roots.
 */
export function resolveContextFile(input: string): string {
  ensureConfigDir();
  const trustedRoots = collectTrustedRoots();

  // Resolve then realpath the longest existing prefix so /tmp vs /private/tmp matches.
  const logical = resolve(process.cwd(), input);
  const resolved = realpathExistingPrefix(logical);

  const root = findContainingRoot(trustedRoots, resolved);
  if (!root) {
    throw new Error(
      `--context-file must stay under the working directory or ${getConfigDir()} (got: ${input})`,
    );
  }

  const ext = extname(resolved).toLowerCase();
  if (ext !== ".md" && ext !== ".markdown") {
    throw new Error(
      `--context-file must be a Markdown file (.md); got extension "${ext || "(none)"}"`,
    );
  }

  assertSafePathPrefixes(root, resolved, input);

  if (existsSync(resolved)) {
    if (lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`--context-file must not be a symbolic link (got: ${input})`);
    }
    const real = realpathSync(resolved);
    if (!findContainingRoot(trustedRoots, real)) {
      throw new Error(
        `--context-file must stay under a trusted root after realpath (got: ${input})`,
      );
    }
    return real;
  }

  const parent = dirname(resolved);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }

  return resolved;
}

function collectTrustedRoots(): string[] {
  const roots: string[] = [];
  try {
    roots.push(realpathSync(process.cwd()));
  } catch {
    roots.push(process.cwd());
  }
  const configDir = getConfigDir();
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  try {
    roots.push(realpathSync(configDir));
  } catch {
    roots.push(configDir);
  }
  return [...new Set(roots)];
}

/** Realpath as much of the path as exists (handles /tmp → /private/tmp). */
function realpathExistingPrefix(target: string): string {
  let current = target;
  const fsRoot = parsePath(target).root || "/";
  const missing: string[] = [];

  while (!existsSync(current) && current !== fsRoot && current !== dirname(current)) {
    missing.unshift(current.slice(dirname(current).length).replace(/^[\\/]/, ""));
    current = dirname(current);
  }

  try {
    const realBase = existsSync(current) ? realpathSync(current) : current;
    return missing.length === 0 ? realBase : resolve(realBase, ...missing);
  } catch {
    return target;
  }
}

function findContainingRoot(roots: string[], candidate: string): string | null {
  for (const root of roots) {
    const rel = relative(root, candidate);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      return root;
    }
  }
  return null;
}

function assertSafePathPrefixes(
  root: string,
  target: string,
  original: string,
): void {
  let current = target;
  const fsRoot = parsePath(root).root || "/";

  while (current !== root && current !== fsRoot && current !== dirname(current)) {
    if (existsSync(current)) {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(
          `--context-file path contains a symbolic link (got: ${original})`,
        );
      }
      const real = realpathSync(current);
      const rel = relative(root, real);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(
          `--context-file escapes trusted root via symlink (got: ${original})`,
        );
      }
    }
    current = dirname(current);
  }
}
