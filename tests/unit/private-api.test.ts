import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * P0 #9 — Private API guard as a test.
 * Mirrors scripts/check-private-imports.ts so `bun test` alone enforces the
 * architecture policy.
 */

const FORBIDDEN: Array<[RegExp, string]> = [
  [/from\s+["']@oh-my-pi\//, "@oh-my-pi/* import"],
  [/from\s+["']oh-my-pi["']/, "oh-my-pi import"],
  [/require\(\s*["']@oh-my-pi\//, "@oh-my-pi require"],
  [/import\(\s*["']@oh-my-pi\//, "@oh-my-pi dynamic import"],
  [/coding-agent\/src\//, "host source path"],
  [/packages\/coding-agent/, "host package path"],
  [/structured-subagent/, "internal task module"],
  [/AsyncJobManager/, "internal async job manager"],
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      yield* walk(full);
    } else if (/\.(ts|js|mjs)$/.test(entry)) {
      yield full;
    }
  }
}

describe("private API import guard", () => {
  test("src/ contains no forbidden imports", () => {
    const violations: string[] = [];
    for (const file of walk(join(import.meta.dir, "..", "..", "src"))) {
      const text = readFileSync(file, "utf8");
      for (const [pattern, why] of FORBIDDEN) {
        if (pattern.test(text)) violations.push(`${file}: ${why}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("compiled dist bundle contains no @oh-my-pi imports", () => {
    const dist = join(import.meta.dir, "..", "..", "dist", "index.js");
    let text: string;
    try {
      text = readFileSync(dist, "utf8");
    } catch {
      return; // not built yet; build-time guard covers this
    }
    expect(text).not.toMatch(/from\s*["']@oh-my-pi\//);
  });
});
