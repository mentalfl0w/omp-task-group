import { describe, expect, test } from "bun:test";
import { defaultConfig, validateConfig, ConfigError } from "../../src/config";
import { loadConfig, ConfigLoadError } from "../../src/config-load";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config", () => {
  test("defaults match the documented baseline", () => {
    const cfg = defaultConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.dispatcher).toEqual({ mode: "suggest", detectMissedGroups: true });
    expect(cfg.execution.pool).toEqual({ enabled: "auto", threshold: 6, fallback: "fanout" });
    expect(cfg.output).toEqual({ mode: "compact", perTaskChars: 1200, maxTotalChars: 8000, preserveHandles: true });
    expect(cfg.telemetry).toEqual({ enabled: true, detectMissedGroups: true });
  });

  test("partial overlays keep untouched defaults", () => {
    const cfg = validateConfig({ output: { perTaskChars: 500 } });
    expect(cfg.output.perTaskChars).toBe(500);
    expect(cfg.output.maxTotalChars).toBe(8000);
    expect(cfg.dispatcher.mode).toBe("suggest");
  });

  test("invalid values throw with the config path", () => {
    expect(() => validateConfig({ dispatcher: { mode: "always" } })).toThrow(ConfigError);
    expect(() => validateConfig({ execution: { pool: { threshold: 1 } } })).toThrow(ConfigError);
    expect(() => validateConfig({ output: { perTaskChars: 50 } })).toThrow(ConfigError);
  });

  test("loadConfig merges user + project overlays", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-cfg-"));
    try {
      const homeDir = join(dir, "home", ".omp", "agent");
      const projDir = join(dir, "proj", ".omp");
      mkdirSync(homeDir, { recursive: true });
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(homeDir, "task-group.json"), JSON.stringify({ output: { perTaskChars: 900 } }));
      writeFileSync(join(projDir, "task-group.json"), JSON.stringify({ dispatcher: { mode: "off" } }));
      const cfg = loadConfig(join(dir, "proj"), join(dir, "home"));
      expect(cfg.output.perTaskChars).toBe(900);
      expect(cfg.dispatcher.mode).toBe("off");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("broken project config raises ConfigLoadError with path", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-cfg-"));
    try {
      const projDir = join(dir, ".omp");
      mkdirSync(projDir, { recursive: true });
      writeFileSync(join(projDir, "task-group.json"), "{not json");
      expect(() => loadConfig(dir)).toThrow(ConfigLoadError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing files fall back to defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-cfg-"));
    try {
      const cfg = loadConfig(dir);
      expect(cfg).toEqual(defaultConfig());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
