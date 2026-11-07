import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCapabilities } from "../../src/capabilities";
import { defaultConfig } from "../../src/config";
import type { ExtensionContext } from "../../src/types";

describe("capability reporting", () => {
  test("distinguishes native Workpool from Task Group Pool eligibility", () => {
    const config = defaultConfig();
    const enabled = probeCapabilities(undefined, config);
    const nativePool = enabled.rows.find((row) => row.name === "workpool");
    const groupPool = enabled.rows.find((row) => row.name === "task-group-pool");
    expect(nativePool?.ok).toBe(true);
    expect(nativePool?.availability).toBe("conditional");
    expect(groupPool?.ok).toBe(true);
    expect(groupPool?.availability).toBe("conditional");
    expect(groupPool?.note).toContain("background dispatch never waits");

    const background = enabled.rows.find((row) => row.name === "background");
    expect(background?.ok).toBe(true);
    expect(background?.availability).toBe("conditional");
    expect(background?.note).toContain("ompTaskGroupCollect");
    expect(background?.note).toContain("independent of eval.autoBackground");
    expect(enabled.rows.find((row) => row.name === "foreground-barrier")?.ok).toBe(true);

    config.execution.pool.enabled = "off";
    const disabled = probeCapabilities(undefined, config);
    expect(disabled.rows.find((row) => row.name === "workpool")?.ok).toBe(true);
    expect(disabled.rows.find((row) => row.name === "workpool")?.availability).toBe("conditional");
    expect(disabled.rows.find((row) => row.name === "task-group-pool")?.ok).toBe(false);
    expect(disabled.rows.find((row) => row.name === "task-group-pool")?.availability).toBe("unavailable");
    expect(disabled.rows.find((row) => row.name === "background")?.ok).toBe(false);
    expect(disabled.rows.find((row) => row.name === "background")?.availability).toBe("unavailable");
    expect(disabled.usable).toBe(true);
  });

  test("background availability is independent of the foreground autoBackground scan", () => {
    const root = mkdtempSync(join(tmpdir(), "tg-cap-bg-"));
    const agent = join(root, "agent");
    mkdirSync(join(agent), { recursive: true });
    const keys = ["PI_CODING_AGENT_DIR", "PI_CONFIG_FILES", "PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.PI_CODING_AGENT_DIR = agent;
    for (const key of keys) {
      if (key !== "PI_CODING_AGENT_DIR") delete process.env[key];
    }
    try {
      const ctx = { cwd: root, mode: "print" } as ExtensionContext;
      const withoutConfig = probeCapabilities(ctx, defaultConfig());
      expect(withoutConfig.rows.find((row) => row.name === "background")?.ok).toBe(true);

      const omp = join(root, ".omp");
      mkdirSync(omp, { recursive: true });
      writeFileSync(join(omp, "config.yml"), "eval: { autoBackground: { enabled: true, thresholdMs: 0 } }\n");
      const withConfig = probeCapabilities(ctx, defaultConfig());
      const background = withConfig.rows.find((row) => row.name === "background");
      expect(background?.ok).toBe(true);
      expect(background?.availability).toBe("conditional");
      expect(background?.note).toContain("task_group_result");
      // The scan still reports the foreground-protection state.
      expect(withConfig.rows.find((row) => row.name === "foreground-barrier")?.availability).toBe("unavailable");
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
