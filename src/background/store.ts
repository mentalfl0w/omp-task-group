/**
 * omp-task-group — private background result store.
 *
 * One session-private directory (0700) under the OS temp root holds one
 * atomically renamed result file (0600) per explicitly backgrounded group.
 * The store never accepts a path from the model: reads, status, and deletion
 * operate only on records created by this plugin and only inside that
 * directory, rejecting symlinks, foreign owners, non-private modes, and
 * oversized files.
 *
 * Records are registered at Workpool dispatch and remain pending until the
 * explicit collect cell writes the checksummed wrapper; a completed pool with
 * no collect never fabricates a file.
 *
 * Lifecycle: records carry an access-renewed TTL (renewal only while still
 * unexpired), expire lazily on access, and are swept on session lifecycle
 * events. A record that is materializing or being read is never deleted
 * underneath the caller; cleanup marks it `disposeAfterBusy` and the completion
 * path performs the delete. Lazy TTL expiry never removes a partially delivered
 * record and never schedules a delete for an in-flight read. A failed delete
 * keeps the record so the next access retries it. No timers and no detached
 * promises are used.
 *
 * Each store directory carries a `.owner` marker (pid, hostname, pid
 * namespace). The cross-process sweep only removes a directory when that
 * marker proves the owning process is gone; anything it cannot prove is left
 * alone.
 */

import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { BackendCapabilities } from "../backend/interface";
import type { TaskGroupConfig } from "../config";
import type { PlanResult } from "../engine/planner";
import type { TaskGroupSpec } from "../schema/task-group";
import { decodeEvalPayload, EvalResultError } from "../backend/eval-result";
import { BACKGROUND_RESULT_FORMAT, EVAL_RESULT_PROTOCOL } from "../compiler/program";
import { isRecord } from "../guards";
import { runResultGate } from "../result/gate";
import {
  BACKGROUND_RESULT_MAX_BYTES,
  BackgroundResultIntegrityError,
  BackgroundResultPendingError,
  parseBackgroundResultFile,
  sha256Hex,
  type VerifiedBackgroundResultFile,
} from "./result-file";

export const BACKGROUND_RESULT_DIR_PREFIX = "omp-task-group-results-";
/** Session-liveness marker written once per store directory. */
export const BACKGROUND_RESULT_OWNER_FILE = ".owner";
/** Documented default observed-result retention; config overrides it per group. */
export const BACKGROUND_RESULT_RETENTION_MINUTES = 30;
/** Time an observed, unconsumed result file may remain readable by default. */
export const BACKGROUND_RESULT_TTL_MS = BACKGROUND_RESULT_RETENTION_MINUTES * 60 * 1000;
/** Time a registered group may remain pending before any result file appears. */
export const BACKGROUND_RESULT_PENDING_TTL_MS = 2 * 60 * 60 * 1000;
export const BACKGROUND_RESULT_SEGMENT_CHARS = 4_000;
/** Hard UTF-8 byte cap for payloads accepted by the write-approved store tool. */
export const BACKGROUND_RESULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
/**
 * Maximum explicit-consumption receipts retained per session store. Receipts
 * only answer a repeated `consume`; they never hold payload text. Keeping the
 * most recent receipts bounds memory without ever reclassifying a consumed
 * result as expired (receipts have no time-based expiry).
 */
export const BACKGROUND_RESULT_CONSUME_RECEIPT_LIMIT = 256;
/** Orphan temp/result files younger than this are left alone (a job may be finishing). */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

const RESULT_ID_PATTERN = /^tgbg_[a-f0-9]{16}$/;
const GROUP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}\.json(\.[a-z0-9]{1,24}\.tmp)?$/;

export class BackgroundStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackgroundStoreError";
  }
}

export class BackgroundResultNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackgroundResultNotFoundError";
  }
}

export class BackgroundResultStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackgroundResultStateError";
  }
}

export interface BackgroundResultMaterialized {
  /** Result Gate output; the only text delivered to the parent. */
  text: string;
  details: Record<string, unknown>;
  isError: boolean;
  checksum: string;
  payloadChars: number;
}

export interface BackgroundResultRecord {
  resultId: string;
  groupId: string;
  path: string;
  fileName: string;
  createdAtMs: number;
  expiresAtMs: number;
  /** Last issued, per-Collect capability; rotated before every compiled cell. */
  storeCapability?: string;
  /** Observed-result retention derived from this group's config at registration. */
  retentionMs: number;
  spec: TaskGroupSpec;
  config: TaskGroupConfig;
  plan: PlanResult;
  capabilities: BackendCapabilities;
  materialized?: BackgroundResultMaterialized;
  loading?: Promise<BackgroundResultMaterialized>;
  busy: boolean;
  disposeAfterBusy: boolean;
  /** Deletion was attempted and failed; kept so a later access retries it. */
  deletePending: boolean;
  /** True once a valid-looking result file has been observed; TTL restarts then. */
  resultObserved: boolean;
  nextOffset: number;
}

export interface BackgroundResultSegment {
  resultId: string;
  groupId: string;
  offset: number;
  end: number;
  total: number;
  /** Maximum delivered prefix; can exceed `end` after a re-read. */
  deliveredChars: number;
  complete: boolean;
  text: string;
  checksum: string;
  path: string;
}

export interface BackgroundResultStatus {
  resultId: string;
  groupId: string;
  state: "pending" | "ready" | "materialized";
  path: string;
  createdAtMs: number;
  expiresAtMs: number;
  expiresInMs: number;
  /** Observed-result retention for this record's own group config. */
  retentionMs: number;
  fileBytes?: number;
  checksum?: string;
  payloadChars?: number;
  deliveredChars?: number;
  totalChars?: number;
}

export interface BackgroundResultConsume {
  resultId: string;
  groupId: string;
  path: string;
  checksum: string;
  payloadChars: number;
  deleted: boolean;
}

/** Receipt returned only after a verified write/readback of the result file. */
export interface BackgroundResultStored {
  resultId: string;
  groupId: string;
  path: string;
  checksum: string;
  payloadChars: number;
  createdAtMs: number;
  /** True when an identical payload was already stored (idempotent retry). */
  alreadyStored: boolean;
}

/**
 * Non-error confirmation for a repeated `consume` of an already consumed
 * result. It is a receipt only: no path is deleted again and no result text is
 * re-delivered.
 */
export interface BackgroundResultConsumeReceipt {
  alreadyConsumed: true;
  resultId: string;
  groupId: string;
  path: string;
  checksum: string;
  payloadChars: number;
  /** A repeated consume never deletes anything; the file is already gone. */
  deleted: false;
  consumedAtMs: number;
}

export interface BackgroundStoreOptions {
  /** Test seam; production uses the OS temp root. */
  rootDir?: string;
  /**
   * Test seam: when set, overrides every record's configured
   * `background.retentionMinutes`. Unset in production, where each record uses
   * the config resolved from its own cwd.
   */
  ttlMs?: number;
  /** TTL for a group with no result file yet. */
  pendingTtlMs?: number;
  /** Test seam; bounds the retained consumption receipts. */
  consumedReceiptLimit?: number;
  now?: () => number;
}

function isRegularFile(info: { isFile(): boolean; isSymbolicLink(): boolean }): boolean {
  return info.isFile() && !info.isSymbolicLink();
}

function uidOf(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Identifies the PID namespace of this process (Linux only). A PID is only
 * meaningful for liveness probing inside the namespace that created it.
 */
function pidNamespaceId(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return undefined;
  }
}

interface BackgroundSessionOwner {
  pid: number;
  hostname: string;
  pidNamespace?: string;
  createdAtMs: number;
}

/** Write the liveness marker for a freshly created store directory. */
function writeOwnerMarker(dirPath: string): void {
  const owner: BackgroundSessionOwner = {
    pid: process.pid,
    hostname: hostname(),
    createdAtMs: Date.now(),
  };
  const namespace = pidNamespaceId();
  if (namespace !== undefined) owner.pidNamespace = namespace;
  const path = join(dirPath, BACKGROUND_RESULT_OWNER_FILE);
  writeFileSync(path, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

/** Read the marker with the same no-symlink/owner/mode checks as result files. */
function readOwnerMarker(path: string): BackgroundSessionOwner | undefined {
  let fd: number | undefined;
  try {
    const flags = fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
    fd = openSync(path, flags);
    const info = fstatSync(fd);
    if (!isRegularFile(info) || info.size > 4096) return undefined;
    const uid = uidOf();
    if (uid !== undefined && info.uid !== uid) return undefined;
    if ((info.mode & 0o077) !== 0) return undefined;
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const bytes = readSync(fd, buffer, offset, info.size - offset, offset);
      if (bytes === 0) break;
      offset += bytes;
    }
    const parsed: unknown = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    const pid = record.pid;
    const host = record.hostname;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1) return undefined;
    if (typeof host !== "string" || host.length === 0 || host.length > 255) return undefined;
    const namespace = record.pidNamespace;
    if (namespace !== undefined && (typeof namespace !== "string" || namespace.length > 255)) return undefined;
    const createdAtMs = record.createdAtMs;
    if (typeof createdAtMs !== "number" || !Number.isFinite(createdAtMs)) return undefined;
    const owner: BackgroundSessionOwner = { pid, hostname: host, createdAtMs };
    if (namespace !== undefined) owner.pidNamespace = namespace;
    return owner;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The marker read result is unaffected by a failed close.
      }
    }
  }
}

/**
 * Classify the marker owner as alive, dead, or unknown. Only a positive
 * `ESRCH` from the same host and PID namespace counts as dead; hostname,
 * namespace, permission, PID-reuse, or probe failures all fail safe as
 * "unknown" so the sweep keeps the directory.
 */
function ownerLiveness(owner: BackgroundSessionOwner): "alive" | "dead" | "unknown" {
  if (owner.hostname !== hostname()) return "unknown";
  const currentNamespace = pidNamespaceId();
  if (currentNamespace !== undefined || owner.pidNamespace !== undefined) {
    if (currentNamespace === undefined || owner.pidNamespace === undefined) return "unknown";
    if (currentNamespace !== owner.pidNamespace) return "unknown";
  }
  try {
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "dead";
    // EPERM still proves the process exists; anything else is unproven.
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

/** Validate that `path` is the session-private directory this store created. */
function assertOwnedDirectory(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    throw new BackgroundStoreError(
      `background result directory is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new BackgroundStoreError("background result directory is not a real directory");
  }
  const uid = uidOf();
  if (uid !== undefined && info.uid !== uid) {
    throw new BackgroundStoreError("background result directory is owned by a different user");
  }
  if ((info.mode & 0o077) !== 0) {
    throw new BackgroundStoreError("background result directory permissions are not private (expected 0700)");
  }
}

/**
 * Read one verified result file. O_NOFOLLOW prevents a swapped symlink from
 * redirecting the read; fstat validates the opened descriptor, not a path.
 */
function readVerifiedFile(path: string, groupId: string, resultId: string): VerifiedBackgroundResultFile {
  let fd: number | undefined;
  try {
    const flags = fsConstants.O_RDONLY | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
    fd = openSync(path, flags);
    const info = fstatSync(fd);
    if (!isRegularFile(info)) {
      throw new BackgroundResultIntegrityError("background result is not a regular file");
    }
    if (info.size > BACKGROUND_RESULT_MAX_BYTES) {
      throw new BackgroundResultIntegrityError(
        `background result file is ${info.size} bytes; the limit is ${BACKGROUND_RESULT_MAX_BYTES}`,
      );
    }
    const uid = uidOf();
    if (uid !== undefined && info.uid !== uid) {
      throw new BackgroundResultIntegrityError("background result file is owned by a different user");
    }
    if ((info.mode & 0o077) !== 0) {
      throw new BackgroundResultIntegrityError("background result file permissions are not private (expected 0600)");
    }
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const bytes = readSync(fd, buffer, offset, info.size - offset, offset);
      if (bytes === 0) break;
      offset += bytes;
    }
    const text = buffer.subarray(0, offset).toString("utf8");
    return parseBackgroundResultFile(text, { groupId, resultId });
  } catch (error) {
    if (
      error instanceof BackgroundResultIntegrityError ||
      error instanceof BackgroundResultPendingError
    ) {
      throw error;
    }
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new BackgroundResultPendingError();
    }
    if (code === "ELOOP") {
      throw new BackgroundResultIntegrityError("background result path is a symbolic link");
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor is already unusable; the read result is unaffected.
      }
    }
  }
}

function highSurrogateAt(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff;
}

function deleteVerifiedFile(path: string): boolean {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
  if (!isRegularFile(info)) {
    throw new BackgroundResultIntegrityError("refusing to delete a background result path that is not a regular file");
  }
  const uid = uidOf();
  if (uid !== undefined && info.uid !== uid) {
    throw new BackgroundResultIntegrityError("refusing to delete a background result file owned by another user");
  }
  unlinkSync(path);
  return true;
}

/**
 * Remove only directories and files this plugin created, from a process that
 * is proven gone. The prefix, owner, private mode, and exact file-name pattern
 * are all required; unknown entries make the whole directory ineligible
 * (nothing is recursively deleted).
 *
 * Cross-process safety: a directory is removed only when its `.owner` marker
 * identifies a process on this host, in this PID namespace, that no longer
 * exists. Empty directories are always preserved (a live session may have
 * created the directory but not yet written its marker), and any marker that
 * is missing, unreadable, foreign, or otherwise unprovable preserves the
 * directory. Time alone never authorizes deletion.
 *
 * Limitation: liveness is `kill(pid, 0)` on the same host/PID namespace. PID
 * reuse can only delay cleanup (reported alive), never cause a wrongful
 * delete. Directories with a marker from a different host or namespace (for
 * example, a shared temp mount across containers) are preserved forever and
 * must be cleaned by their owner or the OS temp policy.
 */
export function sweepStaleBackgroundResultDirs(
  rootDir: string = tmpdir(),
  ttlMs: number = BACKGROUND_RESULT_PENDING_TTL_MS,
  now: number = Date.now(),
): number {
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return 0;
  }
  const uid = uidOf();
  let removedDirs = 0;
  for (const name of entries) {
    if (!name.startsWith(BACKGROUND_RESULT_DIR_PREFIX)) continue;
    const dir = join(rootDir, name);
    let dirInfo;
    try {
      dirInfo = lstatSync(dir);
    } catch {
      continue;
    }
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) continue;
    if (uid !== undefined && dirInfo.uid !== uid) continue;
    if ((dirInfo.mode & 0o077) !== 0) continue;
    if (now - dirInfo.mtimeMs < ttlMs) continue;

    let children: string[];
    try {
      children = readdirSync(dir);
    } catch {
      continue;
    }
    // An empty directory may belong to a session that is still starting up
    // (mkdtemp runs before the marker write); there is nothing to reclaim.
    if (children.length === 0) continue;

    let safe = true;
    let owner: BackgroundSessionOwner | undefined;
    for (const child of children) {
      if (child === BACKGROUND_RESULT_OWNER_FILE) {
        owner = readOwnerMarker(join(dir, child));
        if (owner === undefined) {
          safe = false;
          break;
        }
        continue;
      }
      const path = join(dir, child);
      let info;
      try {
        info = lstatSync(path);
      } catch {
        safe = false;
        break;
      }
      if (!isRegularFile(info) || !FILE_NAME_PATTERN.test(child)) {
        safe = false;
        break;
      }
      if (uid !== undefined && info.uid !== uid) {
        safe = false;
        break;
      }
      if ((info.mode & 0o077) !== 0) {
        safe = false;
        break;
      }
      if (now - info.mtimeMs < ttlMs) {
        // A live job may still be writing; leave the directory for next time.
        safe = false;
        break;
      }
    }
    if (!safe || owner === undefined) continue;
    // No marker, unreadable marker, foreign host/namespace, live process, or
    // an inconclusive probe: the directory is not provably stale.
    if (ownerLiveness(owner) !== "dead") continue;
    try {
      // Remove result/temp files first; the marker goes last so a failed
      // unlink leaves a provably-dead marker for the next sweep to retry.
      for (const child of children) {
        if (child === BACKGROUND_RESULT_OWNER_FILE) continue;
        unlinkSync(join(dir, child));
      }
      unlinkSync(join(dir, BACKGROUND_RESULT_OWNER_FILE));
      rmdirSync(dir);
      removedDirs += 1;
    } catch {
      // Best effort: never widen the deletion scope on a failure. The marker
      // and files remain for the next sweep.
    }
  }
  return removedDirs;
}

export class BackgroundResultStore {
  private readonly options: Required<
    Pick<BackgroundStoreOptions, "ttlMs" | "pendingTtlMs" | "consumedReceiptLimit" | "now">
  > & {
    rootDir: string;
  };
  private readonly records = new Map<string, BackgroundResultRecord>();
  /** Explicit-consumption receipts, insertion-ordered for the memory bound. */
  private readonly consumedReceipts = new Map<string, BackgroundResultConsumeReceipt>();
  private readonly dirPath: string;
  /** Present only when the test seam overrides per-record config. */
  private readonly ttlOverrideMs: number | undefined;
  private disposed = false;

  constructor(options: BackgroundStoreOptions = {}) {
    this.ttlOverrideMs = options.ttlMs;
    this.options = {
      rootDir: options.rootDir ?? tmpdir(),
      ttlMs: options.ttlMs ?? BACKGROUND_RESULT_TTL_MS,
      pendingTtlMs: options.pendingTtlMs ?? BACKGROUND_RESULT_PENDING_TTL_MS,
      consumedReceiptLimit: options.consumedReceiptLimit ?? BACKGROUND_RESULT_CONSUME_RECEIPT_LIMIT,
      now: options.now ?? Date.now,
    };
    try {
      this.dirPath = mkdtempSync(join(this.options.rootDir, BACKGROUND_RESULT_DIR_PREFIX));
      chmodSync(this.dirPath, 0o700);
      writeOwnerMarker(this.dirPath);
      assertOwnedDirectory(this.dirPath);
    } catch (error) {
      throw new BackgroundStoreError(
        `cannot create a private background result directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  get dir(): string {
    return this.dirPath;
  }

  /** Baseline default; each record carries its own configured retention. */
  get ttlMs(): number {
    return this.options.ttlMs;
  }

  get pendingTtlMs(): number {
    return this.options.pendingTtlMs;
  }

  private now(): number {
    return this.options.now();
  }

  register(init: {
    groupId: string;
    spec: TaskGroupSpec;
    config: TaskGroupConfig;
    plan: PlanResult;
    capabilities: BackendCapabilities;
  }): BackgroundResultRecord {
    if (this.disposed) throw new BackgroundStoreError("the background result store is closed");
    assertOwnedDirectory(this.dirPath);
    if (!GROUP_ID_PATTERN.test(init.groupId)) {
      throw new BackgroundStoreError(`invalid Task Group id for a background result: ${JSON.stringify(init.groupId)}`);
    }
    for (const existing of this.records.values()) {
      if (existing.groupId === init.groupId) {
        throw new BackgroundStoreError(`a background result is already registered for group ${init.groupId}`);
      }
    }
    const fileName = `${init.groupId}.json`;
    const path = join(this.dirPath, fileName);
    const createdAtMs = this.now();
    const retentionMs = this.ttlOverrideMs ?? init.config.background.retentionMinutes * 60_000;
    const record: BackgroundResultRecord = {
      resultId: `tgbg_${randomBytes(8).toString("hex")}`,
      groupId: init.groupId,
      path,
      fileName,
      createdAtMs,
      expiresAtMs: createdAtMs + this.options.pendingTtlMs,
      retentionMs,
      spec: init.spec,
      config: init.config,
      plan: init.plan,
      capabilities: init.capabilities,
      busy: false,
      disposeAfterBusy: false,
      deletePending: false,
      resultObserved: false,
      nextOffset: 0,
    };
    this.records.set(record.resultId, record);
    return record;
  }

  /**
   * Validate and atomically store the collect payload for a registered group.
   * The caller supplies only group/result identity and bounded payload JSON;
   * the path, mode, checksum, readiness, and deletion rules stay host-owned.
   * Only a verified readback returns a ready receipt.
   */
  storeVerifiedPayload(input: {
    groupId: string;
    resultId: string;
    payloadJson: string;
  }): BackgroundResultStored {
    if (this.disposed) throw new BackgroundStoreError("the background result store is closed");
    const { groupId, resultId, payloadJson } = input;
    if (typeof payloadJson !== "string" || payloadJson.length === 0) {
      throw new BackgroundResultIntegrityError("background result payloadJson must be a non-empty string");
    }
    const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
    if (payloadBytes > BACKGROUND_RESULT_MAX_PAYLOAD_BYTES) {
      throw new BackgroundResultIntegrityError(
        `background result payload is ${payloadBytes} UTF-8 bytes; the limit is ${BACKGROUND_RESULT_MAX_PAYLOAD_BYTES}`,
      );
    }
    const record = this.get(resultId);
    if (record.groupId !== groupId) {
      throw new BackgroundResultIntegrityError(
        `background result groupId ${JSON.stringify(groupId)} does not match the registered group ${JSON.stringify(record.groupId)}`,
      );
    }
    if (record.materialized !== undefined) {
      throw new BackgroundResultStateError(
        "background result has already been read; a late write cannot replace the delivered result",
      );
    }
    this.assertOwnedPath(record);

    let rawPayload: unknown;
    try {
      rawPayload = JSON.parse(payloadJson);
    } catch {
      throw new BackgroundResultIntegrityError("background result payloadJson does not contain valid JSON");
    }
    if (!isRecord(rawPayload)) {
      throw new BackgroundResultIntegrityError("background result payload must be an object");
    }

    let decoded;
    try {
      decoded = decodeEvalPayload(rawPayload, record.spec, record.groupId);
    } catch (error) {
      if (error instanceof EvalResultError) {
        throw new BackgroundResultIntegrityError(`background result payload is invalid: ${error.message}`);
      }
      throw error;
    }
    if (decoded.strategy !== "pool" || record.plan.strategy !== "pool") {
      throw new BackgroundResultIntegrityError("background result payload must come from the Workpool strategy");
    }

    const groupState = rawPayload.groupState;
    if (groupState !== "completed" && groupState !== "failed" && groupState !== "cancelled") {
      throw new BackgroundResultIntegrityError("background result payload groupState is invalid");
    }
    const gatedState =
      groupState === "cancelled" ? "cancelled" : decoded.groupError !== undefined ? "failed" : "completed";
    const expectedGate = runResultGate(decoded.outcomes, record.spec, {
      groupState: gatedState,
      ...(decoded.groupError !== undefined ? { groupError: decoded.groupError } : {}),
      ...(decoded.summary !== undefined ? { summary: decoded.summary } : {}),
    });
    if (
      rawPayload.gateText !== expectedGate.deliveredText ||
      rawPayload.gateMode !== expectedGate.mode ||
      rawPayload.gatedChars !== expectedGate.deliveredChars
    ) {
      throw new BackgroundResultIntegrityError(
        "background result gate text does not match the deterministic Result Gate for these outcomes",
      );
    }
    if ((rawPayload.gateError ?? undefined) !== expectedGate.error) {
      throw new BackgroundResultIntegrityError(
        "background result gateError does not match the deterministic Result Gate for these outcomes",
      );
    }

    let existing: VerifiedBackgroundResultFile | undefined;
    try {
      existing = readVerifiedFile(record.path, record.groupId, record.resultId);
    } catch (error) {
      if (!(error instanceof BackgroundResultPendingError)) throw error;
    }
    if (existing !== undefined) {
      if (existing.payloadJson !== payloadJson) {
        throw new BackgroundResultIntegrityError("a different result is already stored for this group");
      }
      this.observeResultFile(record);
      return {
        resultId: record.resultId,
        groupId: record.groupId,
        path: record.path,
        checksum: existing.checksum,
        payloadChars: existing.payloadChars,
        createdAtMs: existing.createdAtMs,
        alreadyStored: true,
      };
    }

    const checksum = sha256Hex(payloadJson);
    const createdAtMs = this.now();
    const wrapper = JSON.stringify({
      format: BACKGROUND_RESULT_FORMAT,
      protocol: EVAL_RESULT_PROTOCOL,
      groupId: record.groupId,
      resultId: record.resultId,
      createdAtMs,
      payloadChars: payloadJson.length,
      sha256: checksum,
      payloadJson,
    });
    const tmp = `${record.path}.${randomBytes(6).toString("hex")}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeFileSync(fd, wrapper, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, record.path);
    } catch (error) {
      try {
        if (fd !== undefined) closeSync(fd);
      } catch {
        // The descriptor is already unusable; the write result is unaffected.
      }
      try {
        unlinkSync(tmp);
      } catch {
        // The TTL sweep removes an orphan temp file.
      }
      throw new BackgroundResultIntegrityError(
        `background result could not be written atomically: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let verified: VerifiedBackgroundResultFile;
    try {
      verified = readVerifiedFile(record.path, record.groupId, record.resultId);
    } catch (error) {
      try {
        unlinkSync(record.path);
      } catch {
        // The TTL sweep retries; the tool still reports failure.
      }
      throw new BackgroundResultIntegrityError(
        `background result failed readback verification: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (verified.payloadJson !== payloadJson) {
      try {
        unlinkSync(record.path);
      } catch {
        // The TTL sweep retries; the tool still reports failure.
      }
      throw new BackgroundResultIntegrityError("background result readback did not match the stored payload");
    }
    this.observeResultFile(record);
    return {
      resultId: record.resultId,
      groupId: record.groupId,
      path: record.path,
      checksum: verified.checksum,
      payloadChars: verified.payloadChars,
      createdAtMs: verified.createdAtMs,
      alreadyStored: false,
    };
  }

  /** Look up a live record; expired records are removed and reported as expired. */
  get(resultId: string): BackgroundResultRecord {
    if (!RESULT_ID_PATTERN.test(resultId)) {
      throw new BackgroundResultNotFoundError(`invalid background result id ${JSON.stringify(resultId)}`);
    }
    this.expireLazily();
    const record = this.records.get(resultId);
    if (record === undefined) {
      const receipt = this.consumedReceipts.get(resultId);
      if (receipt !== undefined) {
        // A consumed result is never re-materialized: no payload text is
        // available here. Repeating action="consume" returns the receipt.
        throw new BackgroundResultNotFoundError(
          `background result ${resultId} was already consumed; repeating action="consume" reports the receipt without deleting or re-delivering content`,
        );
      }
      throw new BackgroundResultNotFoundError(`unknown background result ${resultId}`);
    }
    if (record.deletePending) {
      throw new BackgroundResultNotFoundError(`background result ${resultId} expired`);
    }
    if (!record.busy && record.loading === undefined) {
      this.observeResultFile(record);
      const now = this.now();
      // A partially delivered result is in active use: the TTL must not pull
      // the remaining segments out from under the caller. Access and delivery
      // progress restart the window; consumption stays available after full
      // delivery.
      if (this.hasUndeliveredContent(record)) {
        record.expiresAtMs = Math.max(record.expiresAtMs, now + record.retentionMs);
      } else if (now >= record.expiresAtMs) {
        // Expired results are never revived by an access; this is what keeps
        // unconsumed results from living forever.
        this.retireRecord(record);
        throw new BackgroundResultNotFoundError(`background result ${resultId} expired`);
      } else if (record.resultObserved) {
        // An in-window access renews the unconsumed-result deadline, matching
        // the documented "last access or delivery progress" semantics.
        record.expiresAtMs = Math.max(record.expiresAtMs, now + record.retentionMs);
      }
    }
    return record;
  }

  private hasUndeliveredContent(record: BackgroundResultRecord): boolean {
    const materialized = record.materialized;
    if (materialized === undefined) return false;
    return record.nextOffset > 0 && record.nextOffset < materialized.text.length;
  }

  /** Attempt the delete; on failure keep the record so a later pass retries. */
  private retireRecord(record: BackgroundResultRecord): void {
    try {
      this.deleteRecord(record);
    } catch {
      record.deletePending = true;
    }
  }

  /**
   * Once a result file is present, the unconsumed-result TTL starts. Until then
   * the longer pending deadline applies, so a legitimate long-running host job
   * is not expired as if it were an unread result.
   */
  private observeResultFile(record: BackgroundResultRecord): void {
    if (record.resultObserved) return;
    let info;
    try {
      info = lstatSync(record.path);
    } catch {
      return;
    }
    if (!isRegularFile(info)) return;
    record.resultObserved = true;
    record.expiresAtMs = Math.min(record.expiresAtMs, this.now() + record.retentionMs);
  }

  private expireLazily(): void {
    const now = this.now();
    for (const record of [...this.records.values()]) {
      // Retry a previously failed delete before considering anything else.
      if (record.deletePending) {
        this.retireRecord(record);
        continue;
      }
      if (now < record.expiresAtMs) continue;
      // Never schedule a delete for an in-flight read. Expiry is re-evaluated
      // after the read completes; the completion path renews the TTL so the
      // caller can deliver the materialized text. Explicit cleanupAll still
      // flags busy records for deletion.
      if (record.busy || record.loading !== undefined) continue;
      if (this.hasUndeliveredContent(record)) {
        record.expiresAtMs = Math.max(record.expiresAtMs, now + record.retentionMs);
        continue;
      }
      this.retireRecord(record);
    }
  }

  private assertOwnedPath(record: BackgroundResultRecord): void {
    assertOwnedDirectory(this.dirPath);
    const ownDir = resolve(this.dirPath);
    const ownPath = resolve(record.path);
    if (dirname(ownPath) !== ownDir) {
      throw new BackgroundResultIntegrityError("background result path escapes the private result directory");
    }
    if (basename(ownPath) !== record.fileName || record.fileName !== `${record.groupId}.json`) {
      throw new BackgroundResultIntegrityError("background result path does not match the registered file name");
    }
  }

  private readRecordFile(record: BackgroundResultRecord): VerifiedBackgroundResultFile {
    this.assertOwnedPath(record);
    return readVerifiedFile(record.path, record.groupId, record.resultId);
  }

  /**
   * Materialize the verified payload exactly once. The callback runs the
   * shared decode + Result Gate path; concurrent callers share one promise.
   */
  async materialize(
    resultId: string,
    materializer: (input: VerifiedBackgroundResultFile & { record: BackgroundResultRecord }) => Promise<{
      text: string;
      details: Record<string, unknown>;
      isError: boolean;
    }>,
  ): Promise<BackgroundResultMaterialized> {
    const record = this.get(resultId);
    if (record.materialized !== undefined) return record.materialized;
    if (record.loading !== undefined) return await record.loading;

    record.busy = true;
    const loading = (async (): Promise<BackgroundResultMaterialized> => {
      try {
        const file = this.readRecordFile(record);
        if (!record.resultObserved) {
          record.resultObserved = true;
          record.expiresAtMs = Math.min(record.expiresAtMs, this.now() + record.retentionMs);
        }
        const value = await materializer({ ...file, record });
        const materialized: BackgroundResultMaterialized = {
          ...value,
          checksum: file.checksum,
          payloadChars: file.payloadChars,
        };
        record.materialized = materialized;
        // Materializing is read progress. If the async materializer crossed
        // the old deadline, give the caller a fresh window to deliver the
        // text instead of expiring the record before its first segment.
        record.expiresAtMs = Math.max(record.expiresAtMs, this.now() + record.retentionMs);
        return materialized;
      } finally {
        record.busy = false;
        record.loading = undefined;
        this.disposeIfFlagged(record);
      }
    })();
    record.loading = loading;
    try {
      return await loading;
    } finally {
      if (record.loading === loading) record.loading = undefined;
    }
  }

  /** Read and fully verify the file without materializing the group. */
  readVerified(resultId: string): VerifiedBackgroundResultFile {
    const record = this.get(resultId);
    const file = this.readRecordFile(record);
    if (!record.resultObserved) {
      record.resultObserved = true;
      record.expiresAtMs = Math.min(record.expiresAtMs, this.now() + record.retentionMs);
    }
    return file;
  }

  /**
   * Delete one record and its file without requiring a completed read. Used
   * only for host-side failures (compile collision, native eval error) and
   * synchronous foreground fallbacks already delivered in full.
   */
  discard(resultId: string): boolean {
    const record = this.get(resultId);
    if (record.busy || record.loading !== undefined) {
      record.disposeAfterBusy = true;
      return false;
    }
    this.deleteRecord(record);
    return true;
  }

  readSegment(resultId: string, offset?: number): BackgroundResultSegment {
    const record = this.get(resultId);
    const materialized = record.materialized;
    if (materialized === undefined) {
      throw new BackgroundResultStateError(
        "background result has not been materialized yet; call action=\"read\" without an offset first",
      );
    }
    const text = materialized.text;
    const total = text.length;
    const requested = offset ?? record.nextOffset;
    if (!Number.isInteger(requested) || requested < 0 || requested > total) {
      throw new BackgroundResultStateError(`offset must be an integer in [0, ${total}]`);
    }
    if (requested > record.nextOffset) {
      throw new BackgroundResultStateError(
        `offset ${requested} skips undelivered characters; continue at ${record.nextOffset}`,
      );
    }
    let end = Math.min(total, requested + BACKGROUND_RESULT_SEGMENT_CHARS);
    if (end < total && highSurrogateAt(text, end - 1)) end -= 1;
    if (end <= requested && requested < total) {
      // A pathological one-code-unit window: take the full budget instead of
      // returning an empty segment.
      end = Math.min(total, requested + BACKGROUND_RESULT_SEGMENT_CHARS);
    }
    if (end > record.nextOffset) {
      record.nextOffset = end;
      // Delivery progress restarts the unconsumed-result TTL so the caller
      // keeps a full window to read the rest and then consume.
      record.expiresAtMs = Math.max(record.expiresAtMs, this.now() + record.retentionMs);
    }
    return {
      resultId: record.resultId,
      groupId: record.groupId,
      offset: requested,
      end,
      total,
      deliveredChars: record.nextOffset,
      complete: record.nextOffset >= total,
      text: text.slice(requested, end),
      checksum: materialized.checksum,
      path: record.path,
    };
  }

  status(resultId: string): BackgroundResultStatus {
    const record = this.get(resultId);
    let fileBytes: number | undefined;
    try {
      this.assertOwnedPath(record);
      const info = lstatSync(record.path);
      if (!isRegularFile(info)) {
        throw new BackgroundResultIntegrityError("background result path is not a regular file");
      }
      fileBytes = info.size;
    } catch (error) {
      // A missing file is the normal pending state while the host job runs.
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    }
    const base: BackgroundResultStatus = {
      resultId: record.resultId,
      groupId: record.groupId,
      state:
        record.materialized !== undefined ? "materialized" : fileBytes !== undefined ? "ready" : "pending",
      path: record.path,
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
      expiresInMs: Math.max(0, record.expiresAtMs - this.now()),
      retentionMs: record.retentionMs,
    };
    if (fileBytes !== undefined) base.fileBytes = fileBytes;
    if (record.materialized !== undefined) {
      base.checksum = record.materialized.checksum;
      base.payloadChars = record.materialized.payloadChars;
      base.deliveredChars = record.nextOffset;
      base.totalChars = record.materialized.text.length;
    }
    return base;
  }

  /**
   * Explicitly consume one result after full delivery. The first call keeps
   * the original protocol: it deletes the file and returns the same consume
   * record as before. Repeating the call for an id consumed in this session
   * returns a receipt instead of an error, deletes nothing again, and never
   * re-delivers content. An id that was never consumed in this session stays
   * a not-found error, so an unregistered id is never mistaken for a consumed
   * one.
   */
  consume(resultId: string): BackgroundResultConsume | BackgroundResultConsumeReceipt {
    if (!RESULT_ID_PATTERN.test(resultId)) {
      throw new BackgroundResultNotFoundError(`invalid background result id ${JSON.stringify(resultId)}`);
    }
    let record: BackgroundResultRecord;
    try {
      record = this.get(resultId);
    } catch (error) {
      if (error instanceof BackgroundResultNotFoundError) {
        const receipt = this.consumedReceipts.get(resultId);
        if (receipt !== undefined) return { ...receipt };
        // Never registered, expired before consumption, or otherwise absent:
        // there is no receipt, so this is not a repeated consume. Preserve the
        // original not-found reason.
      }
      throw error;
    }
    if (record.busy || record.loading !== undefined) {
      throw new BackgroundResultStateError("background result is being read; consume it after the read completes");
    }
    const materialized = record.materialized;
    if (materialized === undefined) {
      throw new BackgroundResultStateError(
        "read the background result before consuming it; explicit consume deletes the private file",
      );
    }
    const total = materialized.text.length;
    if (record.nextOffset < total) {
      throw new BackgroundResultStateError(
        `${total - record.nextOffset} of ${total} characters have not been delivered; read the remaining result before consuming`,
      );
    }
    this.assertOwnedPath(record);
    const deleted = deleteVerifiedFile(record.path);
    this.records.delete(resultId);
    this.rememberConsumed({
      alreadyConsumed: true,
      resultId: record.resultId,
      groupId: record.groupId,
      path: record.path,
      checksum: materialized.checksum,
      payloadChars: materialized.payloadChars,
      deleted: false,
      consumedAtMs: this.now(),
    });
    return {
      resultId: record.resultId,
      groupId: record.groupId,
      path: record.path,
      checksum: materialized.checksum,
      payloadChars: materialized.payloadChars,
      deleted,
    };
  }

  /**
   * Retain one receipt without payload text. Insertion order is the eviction
   * order, so memory stays bounded by the configured count; receipts are never
   * time-expired, so a consumed id is not later misreported as expired.
   */
  private rememberConsumed(receipt: BackgroundResultConsumeReceipt): void {
    this.consumedReceipts.delete(receipt.resultId);
    this.consumedReceipts.set(receipt.resultId, receipt);
    while (this.consumedReceipts.size > this.options.consumedReceiptLimit) {
      const oldest = this.consumedReceipts.keys().next().value;
      if (oldest === undefined) break;
      this.consumedReceipts.delete(oldest);
    }
  }

  /**
   * Delete every record not currently in use. Busy records are flagged and
   * removed by their completion path. A failed delete keeps its record (marked
   * `deletePending`) so a later cleanup retries it. Returns the number of
   * records successfully removed.
   */
  cleanupAll(): number {
    let removed = 0;
    for (const record of [...this.records.values()]) {
      if (record.busy || record.loading !== undefined) {
        record.disposeAfterBusy = true;
        continue;
      }
      try {
        this.deleteRecord(record);
        removed += 1;
      } catch {
        // Keep the record and retry on the next access/cleanup instead of
        // silently leaking an untracked file.
        record.deletePending = true;
      }
    }
    this.sweepOrphans();
    return removed;
  }

  /** Close the store; the directory is removed only when it is empty. */
  dispose(): void {
    if (this.disposed) return;
    this.cleanupAll();
    this.disposed = true;
    this.removeDirectoryIfEmpty();
  }

  /**
   * Delete the registered file and only then forget the record. A deletion
   * failure propagates so the caller can retain a retryable record.
   */
  private deleteRecord(record: BackgroundResultRecord): void {
    this.assertOwnedPath(record);
    deleteVerifiedFile(record.path);
    this.records.delete(record.resultId);
  }

  private disposeIfFlagged(record: BackgroundResultRecord): void {
    if (!record.disposeAfterBusy || record.busy || record.loading !== undefined) return;
    try {
      this.deleteRecord(record);
    } catch {
      record.deletePending = true;
    }
    if (this.disposed) this.removeDirectoryIfEmpty();
  }

  /**
   * Remove the directory and its owner marker only when nothing else remains.
   * A failed delete above leaves the marker in place so the cross-process
   * sweep can retry after this process exits.
   */
  private removeDirectoryIfEmpty(): void {
    let children: string[];
    try {
      children = readdirSync(this.dirPath);
    } catch {
      return;
    }
    if (children.length > 1 || (children.length === 1 && children[0] !== BACKGROUND_RESULT_OWNER_FILE)) {
      return;
    }
    if (children.length === 1) {
      const marker = join(this.dirPath, BACKGROUND_RESULT_OWNER_FILE);
      try {
        const info = lstatSync(marker);
        const uid = uidOf();
        if (!isRegularFile(info) || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) {
          return;
        }
        unlinkSync(marker);
      } catch {
        return;
      }
    }
    try {
      rmdirSync(this.dirPath);
    } catch {
      // A concurrent writer may have re-populated the directory; restore the
      // owner marker so the cross-process sweep can retry after this process
      // exits instead of leaving an unprovable, forever-preserved directory.
      try {
        writeOwnerMarker(this.dirPath);
      } catch {
        // The directory is already gone or not writable; nothing more to do.
      }
    }
  }

  /**
   * Remove orphan temp/result files from this store's directory after a grace
   * period. Only exact plugin file names owned by this user are considered.
   */
  private sweepOrphans(): number {
    try {
      assertOwnedDirectory(this.dirPath);
    } catch {
      return 0;
    }
    const active = new Set(
      [...this.records.values()].map((record) => record.fileName),
    );
    let removed = 0;
    let children: string[];
    try {
      children = readdirSync(this.dirPath);
    } catch {
      return 0;
    }
    const now = this.now();
    const uid = uidOf();
    for (const child of children) {
      if (!FILE_NAME_PATTERN.test(child)) continue;
      if (active.has(child)) continue;
      const path = join(this.dirPath, child);
      let info;
      try {
        info = lstatSync(path);
      } catch {
        continue;
      }
      if (!isRegularFile(info) || (uid !== undefined && info.uid !== uid)) continue;
      if ((info.mode & 0o077) !== 0) continue;
      if (now - info.mtimeMs < ORPHAN_GRACE_MS) continue;
      try {
        unlinkSync(path);
        removed += 1;
      } catch {
        // Best effort only.
      }
    }
    return removed;
  }
}
