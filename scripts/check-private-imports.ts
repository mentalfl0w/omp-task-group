/**
 * omp-task-group — private API import guard (CI gate).
 *
 * Fails when any source file imports OMP internals. The plugin depends ONLY
 * on documented public contracts (docs/extensions.md, docs/tools/eval.md,
 * docs/tools/hub.md) reproduced as hand-written types in src/types.ts.
 *
 * Forbidden:
 *   - ANY runtime import of @oh-my-pi/* or oh-my-pi packages
 *   - deep package paths (packages/..., coding-agent/src/..., .../src/*)
 *   - known internal modules (task/structured-subagent, AsyncJobManager, ...)
 *
 * Run: bun run scripts/check-private-imports.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /from\s+["']@oh-my-pi\//, why: "@oh-my-pi/* import — use documented public contracts only" },
  { pattern: /from\s+["']oh-my-pi["']/, why: "oh-my-pi package import" },
  { pattern: /require\(\s*["']@oh-my-pi\//, why: "@oh-my-pi/* require" },
  { pattern: /import\(\s*["']@oh-my-pi\//, why: "@oh-my-pi/* dynamic import" },
  { pattern: /coding-agent\/src\//, why: "deep host source path" },
  { pattern: /packages\/coding-agent/, why: "host package path" },
  { pattern: /structured-subagent/, why: "internal task module" },
  { pattern: /AsyncJobManager/, why: "internal async job manager" },
  { pattern: /AgentSession["'\s]*from/, why: "internal agent session" },
  { pattern: /agent-session\.js|agent-session\.ts/, why: "internal agent session module" },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      yield* walk(full);
    } else if (/\.(ts|js|mjs|cjs)$/.test(entry)) {
      yield full;
    }
  }
}

const violations: string[] = [];
for (const file of walk(join(ROOT, "src"))) {
  const text = readFileSync(file, "utf8");
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(text)) {
      violations.push(`${relative(ROOT, file)}: ${why} (matched ${String(pattern)})`);
    }
  }
}

if (violations.length > 0) {
  console.error("PRIVATE API IMPORT GUARD FAILED:");
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("private API import guard: OK (no forbidden imports in src/)");
