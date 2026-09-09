import { describe, expect, test } from "bun:test";
import { scanAutoBackgroundConfig } from "../../src/barriers";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("barrier guard (eval.autoBackground detection)", () => {
  test("no config files → safe", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-bar-"));
    try {
      expect(scanAutoBackgroundConfig(dir)).toMatchObject({ safe: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("project config with autoBackground enabled → unsafe with reason", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-bar-"));
    try {
      const omp = join(dir, ".omp");
      mkdirSync(omp, { recursive: true });
      writeFileSync(
        join(omp, "config.yml"),
        ["model: x", "eval:", "  autoBackground:", "    enabled: true", "    thresholdMs: 1000", "task:", "  maxConcurrency: 4"].join("\n"),
      );
      const check = scanAutoBackgroundConfig(dir);
      expect(check.safe).toBe(false);
      expect(check.reason).toContain("one-continuation");
      expect(check.thresholdMs).toBe(1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("explicit false stays safe", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-bar-"));
    try {
      const omp = join(dir, ".omp");
      mkdirSync(omp, { recursive: true });
      writeFileSync(join(omp, "config.yml"), ["eval:", "  autoBackground:", "    enabled: false"].join("\n"));
      expect(scanAutoBackgroundConfig(dir)).toMatchObject({ safe: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
