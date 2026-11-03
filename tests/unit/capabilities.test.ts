import { describe, expect, test } from "bun:test";
import { probeCapabilities } from "../../src/capabilities";
import { defaultConfig } from "../../src/config";

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
    expect(groupPool?.note).toContain("runtime preflight for competing jobs/live agents");

    config.execution.pool.enabled = "off";
    const disabled = probeCapabilities(undefined, config);
    expect(disabled.rows.find((row) => row.name === "workpool")?.ok).toBe(true);
    expect(disabled.rows.find((row) => row.name === "workpool")?.availability).toBe("conditional");
    expect(disabled.rows.find((row) => row.name === "task-group-pool")?.ok).toBe(false);
    expect(disabled.rows.find((row) => row.name === "task-group-pool")?.availability).toBe("unavailable");
    expect(disabled.usable).toBe(true);
  });
});
