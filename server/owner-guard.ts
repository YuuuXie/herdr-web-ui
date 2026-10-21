/**
 * Startup ownership (supervisor.lock, the remote bridge's descriptor lock, the bridge descriptor)
 * changes only under a kernel lock on a permanent sibling file, `<lock>.guard`: flock on POSIX, a
 * LockFileEx byte lock on Windows. Both key on the opened file object, not on how its path is
 * spelled, and both kernels release the lock when its holder dies. The guard is held only around
 * synchronous code, never across an await, and its file is never deleted: a starter may hold it.
 *
 * A new owner directory is published whole: written in a private sibling, then renamed into place.
 * An empty directory is therefore what an older version (or an interrupted one) left, and is
 * reclaimed. Older versions take no guard, so an old and a new version starting at the same moment
 * for the same lock is not protected: that mixed-version case is unsupported.
 */
import { dlopen, FFIType, read } from "bun:ffi";
import { randomBytes } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { legacyOwnerReplaced, newOwnerRecord, ownerGone, parseOwnerRecord, type OwnerRecord } from "./process-owner.ts";

export class OwnerGuardUnavailable extends Error {}

/** The library the lock comes from; a test points it at a missing file to show the guard fails closed. */
export const guardLibrary = { path: process.platform === "darwin" ? "libSystem.B.dylib" : process.platform === "win32" ? "kernel32.dll" : "libc.so.6" };

const LOCK_EX = 2, LOCK_UN = 8, EINTR = 4;
const GENERIC_READ_WRITE = 0xc000_0000, FILE_SHARE_READ_WRITE = 3, OPEN_ALWAYS = 4, FILE_ATTRIBUTE_NORMAL = 0x80, LOCKFILE_EXCLUSIVE_LOCK = 2;
const INVALID_HANDLE = 0xffff_ffff_ffff_ffffn;

const flockSymbol = { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } as const;
const errnoSymbol = { args: [], returns: FFIType.ptr } as const;
function posixLibrary(path: string) {
  if (process.platform === "darwin") {
    const { symbols } = dlopen(path, { flock: flockSymbol, __error: errnoSymbol });
    return { flock: symbols.flock, errno: symbols.__error };
  }
  const { symbols } = dlopen(path, { flock: flockSymbol, __errno_location: errnoSymbol });
  return { flock: symbols.flock, errno: symbols.__errno_location };
}
function windowsLibrary(path: string) {
  return dlopen(path, {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
    LockFileEx: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    UnlockFileEx: { args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
}
const libraries = new Map<string, ReturnType<typeof posixLibrary> | ReturnType<typeof windowsLibrary>>();
function library() {
  const path = guardLibrary.path;
  let loaded = libraries.get(path);
  if (!loaded) {
    try { loaded = process.platform === "win32" ? windowsLibrary(path) : posixLibrary(path); }
    catch (error) { throw new OwnerGuardUnavailable(`the file lock could not be loaded from ${path}: ${error instanceof Error ? error.message : error}`); }
    libraries.set(path, loaded);
  }
  return loaded;
}

/** Blocks until this process holds the guard; the returned function releases it. */
function lockGuard(path: string): () => void {
  if (process.platform === "win32") {
    const { symbols } = library() as ReturnType<typeof windowsLibrary>;
    const handle = symbols.CreateFileW(Buffer.from(`${path}\0`, "utf16le"), GENERIC_READ_WRITE, FILE_SHARE_READ_WRITE, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null);
    if (handle === INVALID_HANDLE) throw new OwnerGuardUnavailable(`${path} could not be opened (error ${symbols.GetLastError()})`);
    const overlapped = new Uint8Array(32);
    if (!symbols.LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped)) {
      const code = symbols.GetLastError();
      symbols.CloseHandle(handle);
      throw new OwnerGuardUnavailable(`${path} could not be locked (error ${code})`);
    }
    return () => {
      symbols.UnlockFileEx(handle, 0, 1, 0, overlapped);
      // closing releases the byte range even if the unlock failed
      if (!symbols.CloseHandle(handle)) throw new OwnerGuardUnavailable(`${path} could not be closed (error ${symbols.GetLastError()})`);
    };
  }
  const symbols = library() as ReturnType<typeof posixLibrary>;
  const errno = () => {
    const at = symbols.errno();
    return at === null ? -1 : read.i32(at, 0);
  };
  let fd: number;
  try { fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600); }
  catch (error) { throw new OwnerGuardUnavailable(`${path} could not be opened: ${(error as NodeJS.ErrnoException).code ?? error}`); }
  for (;;) {
    if (symbols.flock(fd, LOCK_EX) === 0) break;
    const code = errno();
    if (code === EINTR) continue;
    closeSync(fd);
    throw new OwnerGuardUnavailable(`${path} could not be locked (errno ${code})`);
  }
  return () => {
    symbols.flock(fd, LOCK_UN);
    // closing releases the lock even if the unlock failed
    closeSync(fd);
  };
}

export function guardPath(lockPath: string): string { return `${lockPath}.guard`; }

/** Runs `fn` while holding the guard of `lockPath`; `fn` must be synchronous. Throws OwnerGuardUnavailable, without running `fn`, when the guard cannot be taken. */
export function withOwnerGuard<T>(lockPath: string, fn: () => T): T {
  const release = lockGuard(guardPath(lockPath));
  try { return fn(); } finally { release(); }
}

/** What a lock directory holds at one moment; two equal samples mean nobody changed it in between. */
interface OwnerSample { directory: string | null; pid: string | null; owner: string | null; recordedAt: number | null; unreadable: boolean }

/** A directory's identity: a removed directory's inode number is often handed to the next one, so its change time goes along. */
function directoryIdentity(path: string): string {
  const stat = statSync(path);
  return `${stat.dev}:${stat.ino}:${stat.ctimeMs}`;
}
function readOptional(path: string): { text: string | null; ok: boolean } {
  try { return { text: readFileSync(path, "utf8"), ok: true }; }
  catch (error) { return { text: null, ok: (error as NodeJS.ErrnoException).code === "ENOENT" }; }
}
function sample(lock: string): OwnerSample {
  let directory: string;
  try { directory = directoryIdentity(lock); }
  catch (error) {
    const absent = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { directory: null, pid: null, owner: null, recordedAt: null, unreadable: !absent };
  }
  const pid = readOptional(join(lock, "pid")), owner = readOptional(join(lock, "owner.json"));
  let recordedAt: number | null = null;
  try { recordedAt = statSync(join(lock, "pid")).mtimeMs; } catch { /* no pid file */ }
  return { directory, pid: pid.text, owner: owner.text, recordedAt, unreadable: !pid.ok || !owner.ok };
}
const same = (a: OwnerSample, b: OwnerSample) =>
  a.directory === b.directory && a.pid === b.pid && a.owner === b.owner && a.recordedAt === b.recordedAt && a.unreadable === b.unreadable;

/** The owner a sample names: its full record, or a PID alone (older versions wrote only `pid`). */
function owner(state: OwnerSample): { pid: number; record: OwnerRecord | null } | null {
  if (state.pid === null || !/^\d+$/.test(state.pid.trim())) return null;
  const pid = Number(state.pid.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const record = state.owner === null ? null : parseOwnerRecord(state.owner);
  // a record that names another PID describes an earlier owner, not this one
  return { pid, record: record?.pid === pid ? record : null };
}

type Verdict = "absent" | "stale" | "live";
function verdict(state: OwnerSample): Verdict {
  if (state.directory === null) return state.unreadable ? "live" : "absent";
  if (state.unreadable) return "live";
  if (state.pid === null && state.owner === null) return "stale"; // record-less: abandoned by an older or interrupted start
  const named = owner(state);
  if (!named || (state.owner !== null && parseOwnerRecord(state.owner) === null)) return "live"; // malformed: unknown
  if (named.record) return ownerGone(named.record) ? "stale" : "live";
  return ownerGone({ pid: named.pid }) || (state.recordedAt !== null && legacyOwnerReplaced(named.pid, state.recordedAt)) ? "stale" : "live";
}

/** Who the lock names, for an error message: never more than a PID and a generation. */
function describe(lock: string, state: OwnerSample): string {
  if (state.directory === null) return state.unreadable ? `lock ${lock}, unreadable` : `lock ${lock}, no owner`;
  if (state.pid === null && state.owner === null && !state.unreadable) return `lock ${lock}, record-less`;
  const named = owner(state);
  if (!named || state.unreadable) return `lock ${lock}, unknown owner`;
  return named.record ? `lock ${lock}, owner pid ${named.pid} generation ${named.record.generation}` : `lock ${lock}, owner pid ${named.pid}`;
}

/** Test seams, each called synchronously: before the guard is taken, once it is held, after the stale owner is re-proved, and with the complete staged directory before it is renamed into place. */
export interface OwnerLockHooks { observed?(): void; locked?(): void; validated?(): void; staged?(staging: string): void }
export interface OwnerLease { record: OwnerRecord; release(): void }

/**
 * Takes the owner directory `lock` for this process. A live owner (or one that cannot be proved
 * gone) throws `errors.running`; a lock that changed while this start waited for the guard, or a
 * guard that is unavailable, throws `errors.starting`. Nothing is signalled beyond signal 0.
 */
export function acquireOwnerDirectory(lock: string, errors: { running: string; starting: string }, hooks: OwnerLockHooks = {}): OwnerLease {
  const seen = sample(lock);
  if (verdict(seen) === "live") throw new Error(`${errors.running} (${describe(lock, seen)})`);
  hooks.observed?.();
  const record = newOwnerRecord();
  let published: string;
  try {
    published = withOwnerGuard(lock, () => {
      hooks.locked?.();
      const now = sample(lock);
      // re-proved under the guard: an unchanged sample that is still provably stale
      if (!same(now, seen) || verdict(now) === "live") throw new Error(`${errors.starting} (${describe(lock, now)})`);
      hooks.validated?.();
      const staging = `${lock}.tmp-${randomBytes(8).toString("hex")}`;
      mkdirSync(staging, { mode: 0o700 });
      try {
        writeFileSync(join(staging, "pid"), String(record.pid), { mode: 0o600 });
        writeFileSync(join(staging, "owner.json"), JSON.stringify(record), { mode: 0o600 });
        hooks.staged?.(staging);
        if (now.directory !== null) rmSync(lock, { recursive: true });
        renameSync(staging, lock);
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
      return directoryIdentity(lock);
    });
  } catch (error) {
    if (error instanceof OwnerGuardUnavailable) throw new Error(`${errors.starting} (${describe(lock, seen)}; ${error.message})`);
    throw error;
  }
  return {
    record,
    /** Removes the lock only while it is still this acquisition's directory and generation. */
    release() {
      try {
        withOwnerGuard(lock, () => {
          const now = sample(lock);
          if (now.directory === published && now.owner !== null && parseOwnerRecord(now.owner)?.generation === record.generation) rmSync(lock, { recursive: true, force: true });
        });
      } catch (error) {
        console.error(`The startup lock ${lock} was left in place: ${error instanceof Error ? error.message : error}`);
      }
    },
  };
}
