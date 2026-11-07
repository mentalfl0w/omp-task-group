import { describe, expect, test } from "bun:test";
import { scanAutoBackgroundConfig, type BarrierScanOptions } from "../../src/barriers";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function withTemp(run: (dir: string, homeDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tg-bar-"));
  const homeDir = join(dir, "home");
  mkdirSync(homeDir, { recursive: true });
  try {
    run(dir, homeDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeProjectConfig(dir: string, body: string, name = "config.yml"): void {
  const omp = join(dir, ".omp");
  mkdirSync(omp, { recursive: true });
  writeFileSync(join(omp, name), body);
}

function scan(dir: string, homeDir: string, overrides: Partial<BarrierScanOptions> = {}) {
  return scanAutoBackgroundConfig(dir, {
    mode: "print",
    argv: [],
    env: {},
    homeDir,
    ...overrides,
  });
}

describe("eval.autoBackground configuration diagnosis", () => {
  test("no config files uses the documented disabled default", () => {
    withTemp((dir, homeDir) => {
      const check = scan(dir, homeDir);
      expect(check.allow).toBe(true);
      expect(check.backgroundReady).toBe(false);
      expect(check.backgroundReason).toContain("defaults to false");
      expect(check.state).toBe("disabled");
      expect(check.configured).toBeUndefined();
      expect(check.defaultEnabled).toBe(false);
      expect(check.sources).toEqual([]);
    });
  });

  test("project block YAML with autoBackground enabled blocks with evidence", () => {
    withTemp((dir, homeDir) => {
      writeProjectConfig(
        dir,
        ["model: x", "eval:", "  autoBackground:", "    enabled: true", "    thresholdMs: 1000", "task:", "  maxConcurrency: 4"].join("\n"),
      );
      const check = scan(dir, homeDir);
      expect(check.allow).toBe(false);
      expect(check.backgroundReady).toBe(false);
      expect(check.backgroundReason).toContain("thresholdMs=1000");
      expect(check.state).toBe("enabled");
      expect(check.reason).toContain("eval.autoBackground.enabled=true");
      expect(check.reason).toContain("thresholdMs=1000");
      expect(check.sources[0]?.path).toBe(join(dir, ".omp", "config.yml"));
      expect(check.sources[0]?.enabled).toBe(true);
    });
  });

  test("inline flow-style YAML is parsed instead of treated as safe", () => {
    withTemp((dir, homeDir) => {
      writeProjectConfig(dir, "eval: { autoBackground: { enabled: true, thresholdMs: 0 } }\n");
      const check = scan(dir, homeDir);
      expect(check.allow).toBe(false);
      expect(check.backgroundReady).toBe(true);
      expect(check.state).toBe("enabled");
      expect(check.configured).toBe(true);
      expect(check.thresholdMs).toBe(0);
    });
  });

  test("explicit false remains foreground and is reported as configured", () => {
    withTemp((dir, homeDir) => {
      writeProjectConfig(dir, ["eval:", "  autoBackground:", "    enabled: false"].join("\n"));
      const check = scan(dir, homeDir);
      expect(check.allow).toBe(true);
      expect(check.backgroundReady).toBe(false);
      expect(check.backgroundReason).toContain("explicitly false");
      expect(check.state).toBe("disabled");
      expect(check.configured).toBe(false);
      expect(check.configuredDisabled).toBe(true);
    });
  });

  test("RPC mode pins OMP's setting default (false) instead of enabling auto-background", () => {
    withTemp((dir, homeDir) => {
      const rpc = scan(dir, homeDir, { mode: "rpc" });
      expect(rpc.allow).toBe(true);
      expect(rpc.state).toBe("disabled");
      expect(rpc.configured).toBeUndefined();
      expect(rpc.defaultEnabled).toBe(false);
      expect(rpc.reason).toBeUndefined();

      writeProjectConfig(dir, ["eval:", "  autoBackground:", "    enabled: true"].join("\n"));
      const enabled = scan(dir, homeDir, { mode: "rpc" });
      expect(enabled.allow).toBe(false);
      expect(enabled.state).toBe("enabled");
      expect(enabled.configured).toBe(true);
      expect(enabled.reason).toContain("eval.autoBackground.enabled=true");
    });
  });

  test("--config overlays are scanned and can enable auto-background", () => {
    withTemp((dir, homeDir) => {
      const overlay = join(dir, "overlay.yml");
      writeFileSync(overlay, ["eval:", "  autoBackground:", "    enabled: true"].join("\n"));
      const check = scan(dir, homeDir, { argv: ["--config", overlay] });
      expect(check.allow).toBe(false);
      expect(check.state).toBe("enabled");
      expect(check.sources.some((source) => source.path === overlay && source.layer === "overlay")).toBe(true);
    });
  });

  test("PI_CONFIG_FILES overlays are scanned", () => {
    withTemp((dir, homeDir) => {
      const overlay = join(dir, "env-overlay.yml");
      writeFileSync(overlay, "eval: { autoBackground: { enabled: true } }\n");
      const check = scan(dir, homeDir, { env: { PI_CONFIG_FILES: overlay } });
      expect(check.allow).toBe(false);
      expect(check.state).toBe("enabled");
    });
  });

  test("project settings.json is scanned", () => {
    withTemp((dir, homeDir) => {
      const omp = join(dir, ".omp");
      mkdirSync(omp, { recursive: true });
      writeFileSync(
        join(omp, "settings.json"),
        JSON.stringify({ eval: { autoBackground: { enabled: true, thresholdMs: 250 } } }),
      );
      const check = scan(dir, homeDir);
      expect(check.allow).toBe(false);
      expect(check.thresholdMs).toBe(250);
    });
  });

  test("project config.yml overrides .omp/settings.json and is read after it", () => {
    withTemp((dir, homeDir) => {
      const omp = join(dir, ".omp");
      mkdirSync(omp, { recursive: true });
      writeFileSync(
        join(omp, "settings.json"),
        JSON.stringify({ eval: { autoBackground: { enabled: false, thresholdMs: 250 } } }),
      );
      writeFileSync(join(omp, "config.yml"), ["eval:", "  autoBackground:", "    enabled: true"].join("\n"));
      const check = scan(dir, homeDir);
      expect(check.allow).toBe(false);
      expect(check.state).toBe("enabled");
      expect(check.configured).toBe(true);
      expect(check.sources.map((source) => source.path)).toEqual([
        join(omp, "settings.json"),
        join(omp, "config.yml"),
      ]);
    });
  });

  test("project config.yml can disable an enabled .omp/settings.json", () => {
    withTemp((dir, homeDir) => {
      const omp = join(dir, ".omp");
      mkdirSync(omp, { recursive: true });
      writeFileSync(
        join(omp, "settings.json"),
        JSON.stringify({ eval: { autoBackground: { enabled: true } } }),
      );
      writeFileSync(join(omp, "config.yml"), ["eval:", "  autoBackground:", "    enabled: false"].join("\n"));
      const check = scan(dir, homeDir);
      expect(check.allow).toBe(true);
      expect(check.state).toBe("disabled");
      expect(check.configured).toBe(false);
      expect(check.configuredDisabled).toBe(true);
    });
  });

  test("a named profile derives its agent directory when PI_CODING_AGENT_DIR is absent", () => {
    withTemp((dir, homeDir) => {
      const agent = join(homeDir, ".omp", "profiles", "work", "agent");
      mkdirSync(agent, { recursive: true });
      writeFileSync(join(agent, "config.yaml"), "eval: { autoBackground: { enabled: true } }\n");
      const check = scan(dir, homeDir, { argv: ["--profile", "work"] });
      expect(check.allow).toBe(false);
      expect(check.sources.some((source) => source.path === join(agent, "config.yaml"))).toBe(true);
    });
  });

  test("a named profile ignores PI_CODING_AGENT_DIR and uses the profile agent directory", () => {
    withTemp((dir, homeDir) => {
      const profileAgent = join(homeDir, ".omp", "profiles", "work", "agent");
      mkdirSync(profileAgent, { recursive: true });
      writeFileSync(join(profileAgent, "config.yml"), "eval: { autoBackground: { enabled: true } }\n");
      const customAgent = join(dir, "custom-agent");
      mkdirSync(customAgent, { recursive: true });
      writeFileSync(join(customAgent, "config.yml"), "eval: { autoBackground: { enabled: false } }\n");

      const cases: Array<Pick<BarrierScanOptions, "argv" | "env">> = [
        { argv: ["--profile", "work"], env: {} },
        { argv: ["--profile=work"], env: {} },
        { argv: [], env: { OMP_PROFILE: "work" } },
        { argv: [], env: { PI_PROFILE: "work" } },
      ];
      for (const overrides of cases) {
        const check = scan(dir, homeDir, {
          ...overrides,
          env: { ...(overrides.env ?? {}), PI_CODING_AGENT_DIR: customAgent },
        });
        const paths = check.sources.map((source) => source.path);
        expect(check.allow).toBe(false);
        expect(check.configured).toBe(true);
        expect(paths).toContain(join(profileAgent, "config.yml"));
        expect(paths).not.toContain(join(customAgent, "config.yml"));
      }
    });
  });

  test("an explicitly empty OMP_PROFILE overrides PI_PROFILE", () => {
    withTemp((dir, homeDir) => {
      const agent = join(dir, "custom-agent");
      mkdirSync(agent, { recursive: true });
      writeFileSync(join(agent, "config.yml"), "eval: { autoBackground: { enabled: true } }\n");
      const check = scan(dir, homeDir, {
        env: { OMP_PROFILE: " ", PI_PROFILE: "work", PI_CODING_AGENT_DIR: agent },
      });
      expect(check.allow).toBe(false);
      expect(check.sources.some((source) => source.path === join(agent, "config.yml"))).toBe(true);
    });
  });

  test("PI_CODING_AGENT_DIR overrides the derived global config directory", () => {
    withTemp((dir, homeDir) => {
      const agent = join(dir, "custom-agent");
      mkdirSync(agent, { recursive: true });
      writeFileSync(join(agent, "config.yml"), "eval: { autoBackground: { enabled: true } }\n");
      const check = scan(dir, homeDir, { env: { PI_CODING_AGENT_DIR: agent } });
      expect(check.allow).toBe(false);
      expect(check.sources.some((source) => source.path === join(agent, "config.yml"))).toBe(true);
    });
  });

  test("an unreadable overlay makes the result unknown instead of safe", () => {
    withTemp((dir, homeDir) => {
      const check = scan(dir, homeDir, { argv: ["--config", join(dir, "missing.yml")] });
      expect(check.allow).toBe(false);
      expect(check.state).toBe("unknown");
      expect(check.reason).toContain("could not be inspected");
    });
  });

  test("a higher-precedence parse error invalidates an earlier explicit false", () => {
    withTemp((dir, homeDir) => {
      writeProjectConfig(dir, ["eval:", "  autoBackground:", "    enabled: false"].join("\n"));
      const overlay = join(dir, "broken.json");
      writeFileSync(overlay, "{not json");
      const check = scan(dir, homeDir, { argv: ["--config", overlay] });
      expect(check.allow).toBe(false);
      expect(check.backgroundReady).toBe(false);
      expect(check.state).toBe("unknown");
    });
  });

  test("enabled with an explicit thresholdMs=0 is background-ready", () => {
    withTemp((dir, homeDir) => {
      writeProjectConfig(dir, "eval: { autoBackground: { enabled: true, thresholdMs: 0 } }\n");
      const check = scan(dir, homeDir);
      expect(check.allow).toBe(false);
      expect(check.state).toBe("enabled");
      expect(check.thresholdMs).toBe(0);
      expect(check.backgroundReady).toBe(true);
      expect(check.backgroundReason).toContain("thresholdMs=0");
    });
  });

  test("enabled without a threshold is not background-ready", () => {
    withTemp((dir, homeDir) => {
      writeProjectConfig(dir, "eval: { autoBackground: { enabled: true } }\n");
      const check = scan(dir, homeDir);
      expect(check.backgroundReady).toBe(false);
      expect(check.thresholdMs).toBeUndefined();
      expect(check.backgroundReason).toContain("thresholdMs is not configured");
    });
  });

  test("a non-zero threshold is not background-ready", () => {
    withTemp((dir, homeDir) => {
      writeProjectConfig(dir, "eval: { autoBackground: { enabled: true, thresholdMs: 250 } }\n");
      const check = scan(dir, homeDir);
      expect(check.backgroundReady).toBe(false);
      expect(check.thresholdMs).toBe(250);
      expect(check.backgroundReason).toContain("requires thresholdMs=0");
    });
  });

  test("threshold resolution is independent of the later enabled layer", () => {
    withTemp((dir, homeDir) => {
      const omp = join(dir, ".omp");
      mkdirSync(omp, { recursive: true });
      writeFileSync(
        join(omp, "settings.json"),
        JSON.stringify({ eval: { autoBackground: { thresholdMs: 0 } } }),
      );
      writeFileSync(join(omp, "config.yml"), "eval: { autoBackground: { enabled: true } }\n");
      const check = scan(dir, homeDir);
      expect(check.backgroundReady).toBe(true);
      expect(check.thresholdMs).toBe(0);
    });
  });

  test("an unreadable layer between thresholdMs=0 and a later enabled layer leaves threshold unresolved", () => {
    withTemp((dir, homeDir) => {
      const agent = join(homeDir, ".omp", "agent");
      mkdirSync(agent, { recursive: true });
      writeFileSync(join(agent, "config.yml"), "eval: { autoBackground: { thresholdMs: 0 } }\n");
      const omp = join(dir, ".omp");
      mkdirSync(omp, { recursive: true });
      writeFileSync(join(omp, "settings.json"), "{not json");
      writeFileSync(join(omp, "config.yml"), "eval: { autoBackground: { enabled: true } }\n");
      const check = scan(dir, homeDir);
      expect(check.state).toBe("enabled");
      expect(check.backgroundReady).toBe(false);
      expect(check.backgroundReason).toContain("could not be resolved");
    });
  });
});
