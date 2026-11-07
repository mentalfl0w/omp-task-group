import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  BACKGROUND_RESULT_DIR_PREFIX,
  BACKGROUND_RESULT_OWNER_FILE,
  BackgroundResultNotFoundError,
  BackgroundResultStateError,
  BackgroundResultStore,
  sweepStaleBackgroundResultDirs,
  type BackgroundResultRecord,
} from "../../src/background/store";
import {
  BACKGROUND_RESULT_FORMAT,
  BackgroundResultIntegrityError,
  BackgroundResultPendingError,
  sha256Hex,
} from "../../src/background/result-file";
import { EVAL_RESULT_PROTOCOL } from "../../src/compiler/program";
import { defaultConfig } from "../../src/config";
import type { BackendCapabilities } from "../../src/backend/interface";
import type { TaskOutcome } from "../../src/backend/interface";
import type { PlanResult } from "../../src/engine/planner";
import { validateSpec } from "../../src/schema/task-group";
import { runResultGate } from "../../src/result/gate";

const SPEC = validateSpec({
  context: "Shared.",
  tasks: [
    { name: "alpha", agent: "sonic", task: "A" },
    { name: "beta", agent: "sonic", task: "B" },
  ],
});

const CAPABILITIES: BackendCapabilities = {
  fanout: true,
  workpool: true,
  taskGroupPool: true,
  summarize: false,
  structured: true,
  joinAll: true,
  joinAny: true,
  joinQuorum: true,
  rpcUi: false,
  notes: [],
};

const PLAN: PlanResult = { strategy: "fanout", reasons: [], concurrency: "auto" };
const POOL_PLAN: PlanResult = { strategy: "pool", reasons: [], concurrency: "auto" };

function registerPool(
  store: BackgroundResultStore,
  groupId = "tgpoolgroup",
  config = defaultConfig(),
): BackgroundResultRecord {
  return store.register({
    groupId,
    spec: SPEC,
    config,
    plan: POOL_PLAN,
    capabilities: CAPABILITIES,
  });
}

function poolPayload(groupId: string): Record<string, unknown> {
  const outcomes = [
    { name: "alpha", agent: "sonic", status: "succeeded", result: "A" },
    { name: "beta", agent: "sonic", status: "succeeded", result: "B" },
  ] as TaskOutcome[];
  const gate = runResultGate(outcomes, SPEC, { groupState: "completed" });
  return {
    protocol: EVAL_RESULT_PROTOCOL,
    groupId,
    strategy: "pool",
    groupState: "completed",
    rawChildChars: 2,
    outcomes,
    gateText: gate.deliveredText,
    gateMode: gate.mode,
    gatedChars: gate.deliveredChars,
  };
}

async function withStore(
  run: (store: BackgroundResultStore, root: string) => Promise<void> | void,
  options: { ttlMs?: number; pendingTtlMs?: number; consumedReceiptLimit?: number; now?: () => number } = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tg-bg-store-"));
  const store = new BackgroundResultStore({ rootDir: root, ...options });
  try {
    await run(store, root);
  } finally {
    store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

function register(
  store: BackgroundResultStore,
  groupId = "tgtestgroup",
  config = defaultConfig(),
): BackgroundResultRecord {
  return store.register({
    groupId,
    spec: SPEC,
    config,
    plan: PLAN,
    capabilities: CAPABILITIES,
  });
}

function wirePayload(groupId: string): Record<string, unknown> {
  return {
    protocol: EVAL_RESULT_PROTOCOL,
    groupId,
    strategy: "fanout",
    groupState: "completed",
    rawChildChars: 2,
    outcomes: [
      { name: "alpha", agent: "sonic", status: "succeeded", result: "A" },
      { name: "beta", agent: "sonic", status: "succeeded", result: "B" },
    ],
  };
}

function wrapper(record: BackgroundResultRecord, payload: Record<string, unknown> = wirePayload(record.groupId)): string {
  const payloadJson = JSON.stringify(payload);
  return JSON.stringify({
    format: BACKGROUND_RESULT_FORMAT,
    protocol: EVAL_RESULT_PROTOCOL,
    groupId: record.groupId,
    resultId: record.resultId,
    createdAtMs: Date.now(),
    payloadChars: payloadJson.length,
    sha256: sha256Hex(payloadJson),
    payloadJson,
  });
}

function writeResult(record: BackgroundResultRecord, text?: string, mode = 0o600): void {
  writeFileSync(record.path, text ?? wrapper(record), { mode });
}

function currentPidNamespace(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return undefined;
  }
}

function writeOwnerMarker(
  dir: string,
  pid: number,
  extra: { hostname?: string; pidNamespace?: string | null } = {},
): void {
  const owner: Record<string, unknown> = {
    pid,
    hostname: extra.hostname ?? hostname(),
    createdAtMs: Date.now(),
  };
  const namespace = extra.pidNamespace === null ? undefined : extra.pidNamespace ?? currentPidNamespace();
  if (namespace !== undefined) owner.pidNamespace = namespace;
  const path = join(dir, BACKGROUND_RESULT_OWNER_FILE);
  writeFileSync(path, JSON.stringify(owner), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function deadPid(): number {
  const result = spawnSync("/bin/sh", ["-c", "exit 0"]);
  if (typeof result.pid !== "number" || result.pid < 1) {
    throw new Error("could not obtain a dead pid for the sweep test");
  }
  return result.pid;
}

async function materializeText(
  store: BackgroundResultStore,
  record: BackgroundResultRecord,
  text: string,
): Promise<void> {
  await store.materialize(record.resultId, async () => ({ text, details: {}, isError: false }));
}

describe("background result store", () => {
  test("creates a private session directory under the configured root", async () => {
    await withStore((store, root) => {
      expect(dirname(store.dir)).toBe(root);
      expect(basename(store.dir).startsWith(BACKGROUND_RESULT_DIR_PREFIX)).toBe(true);
      const info = lstatSync(store.dir);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    });
  });

  test("register creates an unknown-record id, an in-directory path, and a TTL", async () => {
    await withStore((store) => {
      const record = register(store);
      expect(record.resultId).toMatch(/^tgbg_[a-f0-9]{16}$/);
      expect(dirname(record.path)).toBe(store.dir);
      expect(record.fileName).toBe("tgtestgroup.json");
      expect(record.expiresAtMs - record.createdAtMs).toBe(store.pendingTtlMs);
      expect(record.retentionMs).toBe(30 * 60 * 1000);
      expect(store.ttlMs).toBe(30 * 60 * 1000);
      expect(store.pendingTtlMs).toBe(2 * 60 * 60 * 1000);
      expect(store.get(record.resultId)).toBe(record);
      expect(() => store.get("tgbg_ffffffffffffffff")).toThrow(BackgroundResultNotFoundError);
      expect(() => store.get("../etc/passwd")).toThrow(BackgroundResultNotFoundError);
    });
  });

  test("each record uses its own configured retention and isolates its neighbors", async () => {
    let now = 1_000_000;
    await withStore(
      (store) => {
        const shortConfig = { ...defaultConfig(), background: { retentionMinutes: 1 } };
        const longConfig = { ...defaultConfig(), background: { retentionMinutes: 60 } };
        const short = register(store, "tgshortretention", shortConfig);
        const long = register(store, "tglongretention", longConfig);

        // The pending deadline is intentionally independent of retention.
        expect(short.retentionMs).toBe(60_000);
        expect(long.retentionMs).toBe(60 * 60_000);
        expect(short.expiresAtMs - short.createdAtMs).toBe(store.pendingTtlMs);
        expect(long.expiresAtMs - long.createdAtMs).toBe(store.pendingTtlMs);

        writeResult(short);
        writeResult(long);
        const firstShort = store.status(short.resultId);
        const firstLong = store.status(long.resultId);
        expect(firstShort.retentionMs).toBe(60_000);
        expect(firstLong.retentionMs).toBe(60 * 60_000);
        expect(firstShort.expiresAtMs).toBe(now + 60_000);
        expect(firstLong.expiresAtMs).toBe(now + 60 * 60_000);

        // Access renews each record by its own window, never the neighbor's.
        now += 30_000;
        expect(store.status(short.resultId).expiresAtMs).toBe(now + 60_000);
        expect(store.status(long.resultId).expiresAtMs).toBe(now + 60 * 60_000);

        // The short-retention result expires while the long one stays ready.
        now += 61_000;
        expect(() => store.status(short.resultId)).toThrow(BackgroundResultNotFoundError);
        expect(existsSync(short.path)).toBe(false);
        expect(store.status(long.resultId).state).toBe("ready");
        expect(existsSync(long.path)).toBe(true);
      },
      { now: () => now },
    );
  });

  test("a result observed late still gets its configured retention window", async () => {
    let now = 1_000_000;
    await withStore(
      (store) => {
        const config = { ...defaultConfig(), background: { retentionMinutes: 2 } };
        const record = register(store, "tglateobserve", config);
        now += store.pendingTtlMs - 1_000;
        writeResult(record);
        const status = store.status(record.resultId);
        expect(status.state).toBe("ready");
        expect(status.retentionMs).toBe(2 * 60_000);
        expect(status.expiresAtMs).toBe(now + 2 * 60_000);
      },
      { now: () => now },
    );
  });

  test("a missing file is pending, then ready after a valid atomic result appears", async () => {
    await withStore(async (store) => {
      const record = register(store);
      expect(() => store.readVerified(record.resultId)).toThrow(BackgroundResultPendingError);
      expect(store.status(record.resultId).state).toBe("pending");
      writeResult(record);
      expect(store.status(record.resultId).state).toBe("ready");
      const verified = store.readVerified(record.resultId);
      expect(verified.payload.groupId).toBe(record.groupId);
      expect(verified.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(store.status(record.resultId).state).toBe("ready");
    });
  });

  test("materialize is shared across concurrent callers and caches the gated text", async () => {
    await withStore(async (store) => {
      const record = register(store);
      writeResult(record);
      let calls = 0;
      const fn = async (): Promise<{ text: string; details: Record<string, unknown>; isError: boolean }> => {
        calls += 1;
        return { text: "gated text", details: { protocol: "x" }, isError: false };
      };
      const [a, b] = await Promise.all([
        store.materialize(record.resultId, fn),
        store.materialize(record.resultId, fn),
      ]);
      expect(calls).toBe(1);
      expect(a.text).toBe("gated text");
      expect(b).toBe(a);
      expect(store.status(record.resultId).state).toBe("materialized");
    });
  });

  test("an in-flight materialize that crosses the TTL is not deleted before its first segment", async () => {
    let now = 1_000_000;
    await withStore(
      async (store) => {
        const record = register(store);
        writeResult(record);
        const gate = Promise.withResolvers<void>();
        const pending = store.materialize(record.resultId, async () => {
          await gate.promise;
          return { text: "late text", details: {}, isError: false };
        });
        // The materializer is now in flight and the observed-result TTL is
        // running. Cross it while the read is still busy: lazy expiry must
        // neither delete the file nor schedule a post-read delete.
        now += store.ttlMs * 2;
        expect(store.get(record.resultId)).toBe(record);
        expect(record.disposeAfterBusy).toBe(false);
        expect(existsSync(record.path)).toBe(true);

        gate.resolve();
        await pending;
        const segment = store.readSegment(record.resultId);
        expect(segment.text).toBe("late text");
        expect(segment.complete).toBe(true);
        expect(existsSync(record.path)).toBe(true);

        // The completion renewed the window, but the result is still
        // unconsumed: leaving it past the new deadline cleans it normally.
        now += store.ttlMs + 1;
        expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
        expect(existsSync(record.path)).toBe(false);
      },
      { ttlMs: 10_000, now: () => now },
    );
  });

  test("access renews the unconsumed TTL only while the result is unexpired", async () => {
    let now = 1_000_000;
    await withStore(
      (store) => {
        const record = register(store);
        writeResult(record);
        const first = store.status(record.resultId);
        expect(first.state).toBe("ready");
        expect(first.expiresAtMs).toBe(now + store.ttlMs);

        now += store.ttlMs / 2;
        const second = store.status(record.resultId);
        expect(second.expiresAtMs).toBe(now + store.ttlMs);

        // Without the previous renewal this access would already be at the
        // original deadline.
        now += store.ttlMs / 2;
        const third = store.status(record.resultId);
        expect(third.expiresAtMs).toBe(now + store.ttlMs);
        expect(existsSync(record.path)).toBe(true);

        // No further access: the renewed deadline still expires the
        // unconsumed result instead of retaining it forever.
        now += store.ttlMs + 1;
        expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
        expect(existsSync(record.path)).toBe(false);
      },
      { ttlMs: 10_000, now: () => now },
    );
  });

  test("readSegment bounds, no-skip, and surrogate-safe splits", async () => {
    await withStore(async (store) => {
      const record = register(store);
      writeResult(record);
      const text = "a".repeat(3999) + "😀" + "b".repeat(5000);
      await materializeText(store, record, text);
      const first = store.readSegment(record.resultId);
      expect(first.offset).toBe(0);
      expect(first.end).toBe(3999);
      expect(first.text).toBe("a".repeat(3999));
      expect(first.complete).toBe(false);
      expect(() => store.readSegment(record.resultId, first.end + 10)).toThrow(BackgroundResultStateError);
      const second = store.readSegment(record.resultId);
      expect(second.offset).toBe(3999);
      expect(second.text.startsWith("😀")).toBe(true);
      const totalChars = text.length;
      let segment = second;
      let rounds = 0;
      while (!segment.complete && rounds < 10) {
        segment = store.readSegment(record.resultId);
        rounds += 1;
      }
      expect(segment.complete).toBe(true);
      expect(segment.total).toBe(totalChars);
      expect(segment.end).toBe(totalChars);
    });
  });

  test("consume requires a full read and then deletes only the registered file", async () => {
    await withStore(async (store) => {
      const record = register(store);
      writeResult(record);
      expect(() => store.consume(record.resultId)).toThrow(/read the background result before consuming/);
      await materializeText(store, record, "x".repeat(9000));
      store.readSegment(record.resultId);
      expect(() => store.consume(record.resultId)).toThrow(/have not been delivered/);
      store.readSegment(record.resultId);
      store.readSegment(record.resultId);
      expect(existsSync(record.path)).toBe(true);
      const consumed = store.consume(record.resultId);
      expect(consumed.deleted).toBe(true);
      expect(existsSync(record.path)).toBe(false);
      expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
    });
  });

  test("consume removes the record even when the file was already removed externally", async () => {
    await withStore(async (store) => {
      const record = register(store);
      writeResult(record);
      await materializeText(store, record, "done");
      store.readSegment(record.resultId);
      unlinkSync(record.path);
      const consumed = store.consume(record.resultId);
      expect(consumed.deleted).toBe(false);
      expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
    });
  });

  test("repeating consume returns a receipt and never deletes the path or re-delivers content", async () => {
    await withStore(async (store) => {
      const record = register(store);
      writeResult(record);
      await materializeText(store, record, "idempotent receipt");
      store.readSegment(record.resultId);
      const first = store.consume(record.resultId);
      expect("alreadyConsumed" in first).toBe(false);
      expect(first.deleted).toBe(true);
      expect(existsSync(record.path)).toBe(false);

      // A file placed at the same registered path after consumption belongs to
      // nobody; a repeated consume must not delete or touch it.
      writeFileSync(record.path, "unrelated sentinel", { mode: 0o600 });
      const repeat = store.consume(record.resultId);
      expect("alreadyConsumed" in repeat).toBe(true);
      if (!("alreadyConsumed" in repeat)) throw new Error("expected a consumption receipt");
      expect(repeat.alreadyConsumed).toBe(true);
      expect(repeat.deleted).toBe(false);
      expect(repeat.resultId).toBe(first.resultId);
      expect(repeat.groupId).toBe(first.groupId);
      expect(repeat.path).toBe(first.path);
      expect(repeat.checksum).toBe(first.checksum);
      expect(repeat.payloadChars).toBe(first.payloadChars);
      expect(readFileSync(record.path, "utf8")).toBe("unrelated sentinel");

      // The consumed record cannot be re-read, re-materialized, or re-delivered.
      expect(() => store.readSegment(record.resultId)).toThrow(BackgroundResultNotFoundError);
      expect(() => store.status(record.resultId)).toThrow(BackgroundResultNotFoundError);
      expect(() => store.get(record.resultId)).toThrow(/already consumed/);
      await expect(
        store.materialize(record.resultId, async () => ({ text: "again", details: {}, isError: false })),
      ).rejects.toThrow(BackgroundResultNotFoundError);
    });
  });

  test("an id that was never consumed is unknown, not an already-consumed receipt", async () => {
    await withStore(async (store) => {
      const record = register(store);
      writeResult(record);
      await materializeText(store, record, "known");
      store.readSegment(record.resultId);
      store.consume(record.resultId);
      const unknown =
        record.resultId === "tgbg_0000000000000000" ? "tgbg_0000000000000001" : "tgbg_0000000000000000";
      expect(() => store.consume(unknown)).toThrow(BackgroundResultNotFoundError);
      try {
        store.consume(unknown);
      } catch (error) {
        expect((error as Error).message).toContain("unknown background result");
        expect((error as Error).message).not.toContain("already consumed");
      }
    });
  });

  test("an expired result that was never consumed is not reported as consumed", async () => {
    let now = 1_000_000;
    await withStore(
      async (store) => {
        const record = register(store);
        writeResult(record);
        // Observing the file starts the unconsumed-result TTL.
        store.status(record.resultId);
        now += store.ttlMs + 1;
        expect(() => store.consume(record.resultId)).toThrow(BackgroundResultNotFoundError);
        expect(existsSync(record.path)).toBe(false);
        try {
          store.consume(record.resultId);
        } catch (error) {
          expect((error as Error).message).toContain("unknown background result");
          expect((error as Error).message).not.toContain("already consumed");
        }
      },
      { ttlMs: 10_000, now: () => now },
    );
  });

  test("a consumption receipt survives long past every TTL", async () => {
    let now = 1_000_000;
    await withStore(
      async (store) => {
        const record = register(store);
        writeResult(record);
        await materializeText(store, record, "receipt lifetime");
        store.readSegment(record.resultId);
        store.consume(record.resultId);
        now += store.pendingTtlMs * 4;
        const repeat = store.consume(record.resultId);
        expect("alreadyConsumed" in repeat).toBe(true);
        expect(repeat.deleted).toBe(false);
        expect(repeat.groupId).toBe(record.groupId);
      },
      { ttlMs: 10_000, pendingTtlMs: 20_000, now: () => now },
    );
  });

  test("consumption receipts are bounded by count and evict the oldest", async () => {
    await withStore(
      async (store) => {
        const ids: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const record = register(store, `tgreceipt${i}`);
          writeResult(record);
          await materializeText(store, record, `receipt ${i}`);
          store.readSegment(record.resultId);
          store.consume(record.resultId);
          ids.push(record.resultId);
        }
        expect(() => store.consume(ids[0] as string)).toThrow(/unknown background result/);
        const second = store.consume(ids[1] as string);
        const third = store.consume(ids[2] as string);
        expect("alreadyConsumed" in second).toBe(true);
        expect("alreadyConsumed" in third).toBe(true);
      },
      { consumedReceiptLimit: 2 },
    );
  });

  test("storeVerifiedPayload writes one verified file and is idempotent for identical retries", async () => {
    await withStore(async (store) => {
      const record = registerPool(store);
      const payloadJson = JSON.stringify(poolPayload(record.groupId));
      const first = store.storeVerifiedPayload({
        groupId: record.groupId,
        resultId: record.resultId,
        payloadJson,
      });
      expect(first.alreadyStored).toBe(false);
      expect(first.path).toBe(record.path);
      expect(first.payloadChars).toBe(payloadJson.length);
      expect(first.checksum).toBe(sha256Hex(payloadJson));
      expect(existsSync(record.path)).toBe(true);
      expect(lstatSync(record.path).mode & 0o777).toBe(0o600);
      expect(store.status(record.resultId).state).toBe("ready");

      const second = store.storeVerifiedPayload({
        groupId: record.groupId,
        resultId: record.resultId,
        payloadJson,
      });
      expect(second.alreadyStored).toBe(true);
      expect(second.checksum).toBe(first.checksum);
      expect(JSON.parse(readFileSync(record.path, "utf8")).payloadJson).toBe(payloadJson);
    });
  });

  test("storeVerifiedPayload rejects foreign ids, mismatched gates, malformed data, and oversized payloads", async () => {
    await withStore(async (store) => {
      const record = registerPool(store);
      const payload = poolPayload(record.groupId);
      const payloadJson = JSON.stringify(payload);
      expect(() =>
        store.storeVerifiedPayload({
          groupId: "tgothergroup",
          resultId: record.resultId,
          payloadJson,
        }),
      ).toThrow(BackgroundResultIntegrityError);
      expect(() =>
        store.storeVerifiedPayload({
          groupId: record.groupId,
          resultId: "tgbg_ffffffffffffffff",
          payloadJson,
        }),
      ).toThrow(BackgroundResultNotFoundError);

      const forgedText = `${String(payload.gateText)}\nforged`;
      const forged = { ...payload, gateText: forgedText, gatedChars: forgedText.length };
      expect(() =>
        store.storeVerifiedPayload({
          groupId: record.groupId,
          resultId: record.resultId,
          payloadJson: JSON.stringify(forged),
        }),
      ).toThrow(/gate text does not match/);

      expect(() =>
        store.storeVerifiedPayload({
          groupId: record.groupId,
          resultId: record.resultId,
          payloadJson: "not json",
        }),
      ).toThrow(BackgroundResultIntegrityError);
      expect(() =>
        store.storeVerifiedPayload({
          groupId: record.groupId,
          resultId: record.resultId,
          payloadJson: "x".repeat(4 * 1024 * 1024 + 1),
        }),
      ).toThrow(/limit/);
      expect(existsSync(record.path)).toBe(false);
    });
  });

  test("a different payload cannot replace an already stored result", async () => {
    await withStore(async (store) => {
      const record = registerPool(store);
      const payload = poolPayload(record.groupId);
      store.storeVerifiedPayload({
        groupId: record.groupId,
        resultId: record.resultId,
        payloadJson: JSON.stringify(payload),
      });
      const changedOutcomes = [
        { name: "alpha", agent: "sonic", status: "succeeded", result: "CHANGED" },
        { name: "beta", agent: "sonic", status: "succeeded", result: "B" },
      ] as TaskOutcome[];
      const gate = runResultGate(changedOutcomes, SPEC, { groupState: "completed" });
      const changed = {
        ...payload,
        outcomes: changedOutcomes,
        gateText: gate.deliveredText,
        gateMode: gate.mode,
        gatedChars: gate.deliveredChars,
      };
      expect(() =>
        store.storeVerifiedPayload({
          groupId: record.groupId,
          resultId: record.resultId,
          payloadJson: JSON.stringify(changed),
        }),
      ).toThrow(/different result is already stored/);
      expect(JSON.parse(readFileSync(record.path, "utf8")).payloadJson).toBe(JSON.stringify(payload));
    });
  });

  test("a tampered payload fails integrity verification", async () => {
    await withStore(async (store) => {
      const record = register(store);
      writeResult(record);
      const raw = JSON.parse(wrapper(record)) as Record<string, unknown>;
      raw.payloadJson = String(raw.payloadJson).replace('"A"', '"evil"');
      writeFileSync(record.path, JSON.stringify(raw), { mode: 0o600 });
      expect(() => store.readVerified(record.resultId)).toThrow(BackgroundResultIntegrityError);
    });
  });

  test("non-private file modes and symlinks are rejected without touching their targets", async () => {
    await withStore(async (store, root) => {
      const record = register(store);
      writeResult(record, undefined, 0o644);
      expect(() => store.readVerified(record.resultId)).toThrow(/permissions are not private/);
      unlinkSync(record.path);

      const target = join(root, "outside.json");
      writeFileSync(target, wrapper(record), { mode: 0o600 });
      symlinkSync(target, record.path);
      expect(() => store.readVerified(record.resultId)).toThrow(BackgroundResultIntegrityError);
      expect(() => store.discard(record.resultId)).toThrow(/not a regular file/);
      expect(existsSync(target)).toBe(true);
      unlinkSync(record.path);
      expect(existsSync(target)).toBe(true);
    });
  });

  test("a record path mutated outside the private directory is refused and never deleted", async () => {
    await withStore(async (store, root) => {
      const record = register(store);
      const decoy = join(root, "decoy.json");
      writeFileSync(decoy, "keep me", { mode: 0o600 });
      record.path = decoy;
      expect(() => store.readVerified(record.resultId)).toThrow(/escapes the private result directory/);
      expect(() => store.discard(record.resultId)).toThrow(/escapes the private result directory/);
      expect(existsSync(decoy)).toBe(true);
    });
  });

  test("cleanupAll never deletes a file while materialization is in flight", async () => {
    await withStore(async (store) => {
      const record = register(store);
      writeResult(record);
      const { promise: gate, resolve: release } = Promise.withResolvers<void>();
      const pending = store.materialize(record.resultId, async () => {
        await gate;
        return { text: "late text", details: {}, isError: false };
      });
      expect(store.cleanupAll()).toBe(0);
      expect(existsSync(record.path)).toBe(true);
      release();
      await pending;
      expect(existsSync(record.path)).toBe(false);
      expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
    });
  });

  test("TTL expiry removes the record and file", async () => {
    let now = 1_000_000;
    await withStore(
      (store) => {
        const record = register(store);
        writeResult(record);
        // First access observes the result file and starts the short
        // unconsumed-result TTL.
        expect(store.status(record.resultId).state).toBe("ready");
        now += store.ttlMs + 1;
        expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
        expect(existsSync(record.path)).toBe(false);
      },
      { ttlMs: 10_000, now: () => now },
    );
  });

  test("a group with no result file expires at the longer pending deadline", async () => {
    let now = 1_000_000;
    await withStore(
      (store) => {
        const record = register(store);
        now += store.pendingTtlMs + 1;
        expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
        expect(existsSync(record.path)).toBe(false);
      },
      { ttlMs: 10_000, pendingTtlMs: 20_000, now: () => now },
    );
  });

  test("a partially delivered result survives the TTL and can still be read and consumed", async () => {
    let now = 1_000_000;
    await withStore(
      async (store) => {
        const record = register(store);
        writeResult(record);
        const text = "x".repeat(9000);
        await materializeText(store, record, text);
        const first = store.readSegment(record.resultId);
        expect(first.complete).toBe(false);
        expect(record.nextOffset).toBeGreaterThan(0);
        expect(record.nextOffset).toBeLessThan(text.length);

        // Cross the original TTL while the caller still holds undelivered
        // characters. Neither a status call nor the next read may delete it.
        now += store.ttlMs * 2;
        expect(store.status(record.resultId).state).toBe("materialized");
        expect(existsSync(record.path)).toBe(true);
        expect(() => store.get(record.resultId)).not.toThrow();

        const second = store.readSegment(record.resultId);
        const third = store.readSegment(record.resultId);
        expect(third.complete).toBe(true);
        expect(first.text.length + second.text.length + third.text.length).toBe(text.length);
        expect(third.text).toBe(text.slice(second.end));

        const consumed = store.consume(record.resultId);
        expect(consumed.deleted).toBe(true);
        expect(existsSync(record.path)).toBe(false);
      },
      { ttlMs: 10_000, now: () => now },
    );
  });

  test("a fully delivered but unconsumed result still expires after the TTL", async () => {
    let now = 1_000_000;
    await withStore(
      async (store) => {
        const record = register(store);
        writeResult(record);
        await materializeText(store, record, "small");
        const segment = store.readSegment(record.resultId);
        expect(segment.complete).toBe(true);
        now += store.ttlMs + 1;
        expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
        expect(existsSync(record.path)).toBe(false);
      },
      { ttlMs: 10_000, now: () => now },
    );
  });

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  test.skipIf(isRoot)("consume keeps the record when deletion fails and succeeds on retry", async () => {
    await withStore(async (store) => {
      const record = register(store);
      writeResult(record);
      await materializeText(store, record, "done");
      store.readSegment(record.resultId);

      chmodSync(store.dir, 0o500);
      try {
        expect(() => store.consume(record.resultId)).toThrow();
        expect(existsSync(record.path)).toBe(true);
        expect(store.status(record.resultId).state).toBe("materialized");
      } finally {
        chmodSync(store.dir, 0o700);
      }

      const consumed = store.consume(record.resultId);
      expect(consumed.deleted).toBe(true);
      expect(existsSync(record.path)).toBe(false);
      expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
    });
  });

  test.skipIf(isRoot)("lazy expiry retains a failed delete and retries it on the next access", async () => {
    let now = 1_000_000;
    await withStore(
      (store) => {
        const record = register(store);
        writeResult(record);
        expect(store.status(record.resultId).state).toBe("ready");
        now += store.ttlMs + 1;

        chmodSync(store.dir, 0o500);
        try {
          expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
          expect(existsSync(record.path)).toBe(true);
        } finally {
          chmodSync(store.dir, 0o700);
        }

        // The pending delete is retried by the next lazy-expiry pass.
        expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
        expect(existsSync(record.path)).toBe(false);
        expect(store.cleanupAll()).toBe(0);
      },
      { ttlMs: 10_000, now: () => now },
    );
  });

  test.skipIf(isRoot)("cleanupAll retries a failed expiry delete instead of dropping it", async () => {
    let now = 1_000_000;
    await withStore(
      (store) => {
        const record = register(store);
        writeResult(record);
        expect(store.status(record.resultId).state).toBe("ready");
        now += store.ttlMs + 1;

        chmodSync(store.dir, 0o500);
        try {
          expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
        } finally {
          chmodSync(store.dir, 0o700);
        }
        expect(existsSync(record.path)).toBe(true);

        expect(store.cleanupAll()).toBe(1);
        expect(existsSync(record.path)).toBe(false);
        expect(() => store.get(record.resultId)).toThrow(BackgroundResultNotFoundError);
      },
      { ttlMs: 10_000, now: () => now },
    );
  });

  test("dispose deletes the registered result file and the session directory", async () => {
    await withStore((store) => {
      const record = registerPool(store);
      store.storeVerifiedPayload({
        groupId: record.groupId,
        resultId: record.resultId,
        payloadJson: JSON.stringify(poolPayload(record.groupId)),
      });
      const dir = store.dir;
      expect(existsSync(record.path)).toBe(true);
      store.dispose();
      expect(existsSync(record.path)).toBe(false);
      expect(existsSync(dir)).toBe(false);
      expect(() =>
        store.storeVerifiedPayload({
          groupId: record.groupId,
          resultId: record.resultId,
          payloadJson: JSON.stringify(poolPayload(record.groupId)),
        }),
      ).toThrow(/closed/);
    });
  });

  test("creates a private owner marker for cross-process liveness", async () => {
    await withStore((store) => {
      const marker = lstatSync(join(store.dir, BACKGROUND_RESULT_OWNER_FILE));
      expect(marker.isFile()).toBe(true);
      expect(marker.mode & 0o777).toBe(0o600);
    });
  });
});

describe("stale background directory sweep", () => {
  const old = 1_000_000_000;
  const now = old + 10_000_000;
  const ttl = 1_000_000;
  const oldSeconds = old / 1000;

  function makeOldDir(root: string, name: string): string {
    const dir = join(root, `${BACKGROUND_RESULT_DIR_PREFIX}${name}`);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    return dir;
  }

  function writeOldFile(dir: string, name: string, content = "{}"): string {
    const path = join(dir, name);
    writeFileSync(path, content, { mode: 0o600 });
    utimesSync(path, oldSeconds, oldSeconds);
    return path;
  }

  function ageDir(dir: string): void {
    utimesSync(dir, oldSeconds, oldSeconds);
  }

  test("removes only old, private, exact-pattern directories with a provably dead owner", () => {
    const root = mkdtempSync(join(tmpdir(), "tg-bg-sweep-"));
    try {
      const valid = makeOldDir(root, "valid1");
      writeOwnerMarker(valid, deadPid());
      utimesSync(join(valid, BACKGROUND_RESULT_OWNER_FILE), oldSeconds, oldSeconds);
      writeOldFile(valid, "tgabc.json");
      ageDir(valid);

      const foreign = makeOldDir(root, "foreign1");
      writeOldFile(foreign, "keep.txt", "keep");
      ageDir(foreign);

      const linked = makeOldDir(root, "link1");
      const target = join(root, "target.json");
      writeFileSync(target, "{}", { mode: 0o600 });
      symlinkSync(target, join(linked, "tgabc.json"));
      ageDir(linked);

      const unrelated = join(root, "not-ours");
      mkdirSync(unrelated);

      const removed = sweepStaleBackgroundResultDirs(root, ttl, now);
      expect(removed).toBe(1);
      expect(existsSync(valid)).toBe(false);
      expect(existsSync(foreign)).toBe(true);
      expect(existsSync(join(foreign, "keep.txt"))).toBe(true);
      expect(existsSync(linked)).toBe(true);
      expect(existsSync(join(linked, "tgabc.json"))).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves empty, live-owner, missing-marker, and unprovable directories", () => {
    const root = mkdtempSync(join(tmpdir(), "tg-bg-sweep-"));
    try {
      // No result yet and no marker: a live session may have just created it.
      const empty = makeOldDir(root, "empty1");
      ageDir(empty);

      // The owning process is still running: never reclaim its directory.
      const live = makeOldDir(root, "live1");
      writeOwnerMarker(live, process.pid);
      utimesSync(join(live, BACKGROUND_RESULT_OWNER_FILE), oldSeconds, oldSeconds);
      writeOldFile(live, "tgabc.json");
      ageDir(live);

      // A running group may have no result file yet; the live marker protects
      // its directory just the same.
      const pendingLive = makeOldDir(root, "pendinglive1");
      writeOwnerMarker(pendingLive, process.pid);
      utimesSync(join(pendingLive, BACKGROUND_RESULT_OWNER_FILE), oldSeconds, oldSeconds);
      ageDir(pendingLive);

      // No marker at all: ownership/liveness is unprovable (fail safe).
      const markerless = makeOldDir(root, "markerless1");
      writeOldFile(markerless, "tgabc.json");
      ageDir(markerless);

      // Marker from another host: the PID is meaningless here.
      const foreignHost = makeOldDir(root, "foreignhost1");
      writeOwnerMarker(foreignHost, deadPid(), { hostname: "another-host.invalid" });
      utimesSync(join(foreignHost, BACKGROUND_RESULT_OWNER_FILE), oldSeconds, oldSeconds);
      writeOldFile(foreignHost, "tgabc.json");
      ageDir(foreignHost);

      // Marker from another PID namespace: the PID is meaningless here.
      const foreignNamespace = makeOldDir(root, "foreignns1");
      writeOwnerMarker(foreignNamespace, deadPid(), { pidNamespace: "pid:[1]" });
      utimesSync(join(foreignNamespace, BACKGROUND_RESULT_OWNER_FILE), oldSeconds, oldSeconds);
      writeOldFile(foreignNamespace, "tgabc.json");
      ageDir(foreignNamespace);

      // Unknown entry: the whole directory is ineligible.
      const unknownEntry = makeOldDir(root, "unknown1");
      writeOwnerMarker(unknownEntry, deadPid());
      utimesSync(join(unknownEntry, BACKGROUND_RESULT_OWNER_FILE), oldSeconds, oldSeconds);
      writeOldFile(unknownEntry, "keep.txt", "keep");
      ageDir(unknownEntry);

      const removed = sweepStaleBackgroundResultDirs(root, ttl, now);
      expect(removed).toBe(0);
      for (const dir of [empty, live, pendingLive, markerless, foreignHost, foreignNamespace, unknownEntry]) {
        expect(existsSync(dir)).toBe(true);
      }
      expect(existsSync(join(live, "tgabc.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves a dead-owner directory alone while any result file is fresh", () => {
    const root = mkdtempSync(join(tmpdir(), "tg-bg-sweep-"));
    try {
      const dir = makeOldDir(root, "freshfile1");
      writeOwnerMarker(dir, deadPid());
      utimesSync(join(dir, BACKGROUND_RESULT_OWNER_FILE), oldSeconds, oldSeconds);
      writeOldFile(dir, "tgabc.json");
      const fresh = join(dir, "tgdef.json");
      writeFileSync(fresh, "{}", { mode: 0o600 });
      ageDir(dir);

      expect(sweepStaleBackgroundResultDirs(root, ttl, now)).toBe(0);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
