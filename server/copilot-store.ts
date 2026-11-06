import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { readProcessBirth } from "./process-owner.ts";
import type { COPILOT_STORE_DIAGNOSTICS } from "./conversation-shared.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_BYTES = 64 * 1024;
const MAX_DESCRIPTORS = 4096;
const LOG_WINDOW_BYTES = 16 * 1024 * 1024;
const LOG_HASH_BYTES = 64 * 1024 * 1024;
const MAX_LOG_ARCHIVES = 16;
// Cover FAT's two-second granularity plus coarse wall-clock lag.
const LOG_TIMESTAMP_MARGIN_NS = 3_000_000_000n;
const LOG_NAME = /^process-(\d+)-(\d+)\.log$/;
// Copilot names its log after the millisecond it started and stamps its first line within a few of them.
const LOG_START_MARGIN_MS = 5_000;
const LOG_LINE_TIME = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z) /;
const FOREGROUND_PREFIXES = ["Registering foreground session: ", "Unregistering foreground session: "] as const;
const FOREGROUND_EVENT = new RegExp(String.raw`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z \[INFO\] (${FOREGROUND_PREFIXES.join("|")})([\da-f-]{36})$`);
const LOG_READ_CHANGED = Symbol("log read changed");
const LOG_COPY_PENDING = Symbol("log copy pending");
type StoreDiagnostic = typeof COPILOT_STORE_DIAGNOSTICS[number];
interface ForegroundBinding { sessionId: string; generation: string }
type ForegroundState =
  | { kind: "legacy" }
  | { kind: "selected"; binding: ForegroundBinding }
  | { kind: "unregistered"; binding: ForegroundBinding | null }
  | { kind: "unavailable"; diagnostic: StoreDiagnostic };
const legacy: ForegroundState = { kind: "legacy" };
const unavailable = (diagnostic: StoreDiagnostic): Extract<ForegroundState, { kind: "unavailable" }> => ({ kind: "unavailable", diagnostic });
interface ForegroundCheckpoint {
  dev: bigint; ino: bigint; path: string; size: number; observedSize: number; mtimeNs: bigint; ctimeNs: bigint; checkedAtNs: bigint; pendingSwitch: boolean;
  hash: Hash; epoch: string; selection: ForegroundState; readConflict?: true;
  // The newest copy when this was read: another one since, or the same file written again, means
  // the open file rotated, even into the same bytes, and an empty prefix cannot show it at all.
  newestCopy: CopyStamp | null;
  // The newest copy ended inside a line when this initial log was read: it is read again next time.
  copyPending?: true;
}
interface CopyStamp { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
const sameCopy = (a: CopyStamp | null | undefined, b: CopyStamp | null | undefined): boolean =>
  a?.dev === b?.dev && a?.ino === b?.ino && a?.size === b?.size && a?.mtimeNs === b?.mtimeNs && a?.ctimeNs === b?.ctimeNs;
interface InitialLogRead { dev: bigint; ino: bigint; path: string; size: number; hash: string }
const foregroundLogProcesses = new Map<number, {
  started: string; observed: boolean; initialRead?: InitialLogRead; checkpoint?: ForegroundCheckpoint;
  denial?: Extract<ForegroundState, { kind: "unavailable" }>;
}>();

function currentForeground({ selection, pendingSwitch }: ForegroundCheckpoint): ForegroundState {
  if (!pendingSwitch || selection.kind === "unavailable") return selection;
  // An incomplete tail cannot authorize a handoff or hide a completed release.
  return unavailable(selection.kind === "unregistered" ? "copilot_session_unregistered" : "copilot_log_partial");
}

/** Revalidate every consumed byte: unchanged boundary samples cannot prove an append. */
function logPrefix(fd: number, size: number): Hash | null {
  const bytes = Buffer.alloc(HEADER_BYTES);
  const hash = createHash("sha256");
  for (let position = 0; position < size; position += bytes.length) {
    const length = Math.min(bytes.length, size - position);
    if (readSync(fd, bytes, 0, length, position) !== length) return null;
    hash.update(bytes.subarray(0, length));
  }
  return hash;
}

/** Applies complete log lines' lifecycle events in order; null when one names no valid session. */
function applyLifecycle(selected: ForegroundState, complete: string, position: number, generation: (position: number) => string): ForegroundState | null {
  for (const line of complete.split("\n")) {
    const match = FOREGROUND_EVENT.exec(line);
    if (match) {
      if (!SESSION_ID.test(match[2]!)) return null;
      if (match[1] === FOREGROUND_PREFIXES[0]) {
        selected = { kind: "selected", binding: { sessionId: match[2]!, generation: generation(position) } };
      } else {
        // A legacy parent's complete log may first name its session when releasing it to a child.
        const released: ForegroundBinding | null = selected.kind === "selected" && selected.binding.sessionId === match[2] ? selected.binding : selected.kind === "legacy"
          ? { sessionId: match[2]!, generation: generation(position) } : null;
        selected = { kind: "unregistered", binding: released };
      }
    }
    position += Buffer.byteLength(line) + 1;
  }
  return selected;
}

/**
 * Copilot rotates its process log at about 10 MiB: it copies the open file to `<name>.1.log`
 * (older copies move to .2, .3, …) and truncates the open file in place. The newest copy that
 * starts with every byte already consumed holds the lines written since; the newer copies, then
 * the truncated file, follow it. Without that copy the lines in between are unknown, so ownership
 * stays rejected until the open file registers a session again.
 */
function rotatedLifecycle(target: string, cached: ForegroundCheckpoint, uid: bigint, pid: number): ForegroundState | typeof LOG_READ_CHANGED | null {
  const archives: { fd: number; size: number; dev: bigint; ino: bigint }[] = [];
  try {
    const consumed = cached.hash.copy().digest("hex");
    // Bytes read to find and replay the copy: only copies newer than the match count.
    let total = 0;
    let continued = -1;
    for (let index = 1; index <= MAX_LOG_ARCHIVES && continued < 0; index++) {
      let fd: number;
      try { fd = openSync(`${target.slice(0, -".log".length)}.${index}.log`, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
      const archive = { fd, size: 0, dev: 0n, ino: 0n };
      archives.push(archive);
      const stat = fstatSync(fd, { bigint: true });
      Object.assign(archive, { size: Number(stat.size), dev: stat.dev, ino: stat.ino });
      if (!stat.isFile() || stat.uid !== uid) return null;
      if (archive.size < cached.size) { total += archive.size; continue; }
      if ((total += archive.size) > LOG_HASH_BYTES) return null;
      if (logPrefix(fd, cached.size)?.digest("hex") === consumed) continued = archives.length - 1;
    }
    // No copy carries on from the bytes read (an older one could revive a session left since):
    // what was logged in between is unknown, so the rejection stands. A release already seen stays one,
    // naming no session a handoff could take.
    if (continued < 0) return cached.selection.kind === "unregistered" ? { kind: "unregistered", binding: null } : null;
    let selected = cached.selection;
    // Until a rotated file holds a line, each read replays these copies from the same anchor: one binding.
    const epoch = cached.epoch;
    for (let index = continued; index >= 0; index--) {
      const { fd, size, dev, ino } = archives[index]!;
      const start = index === continued ? cached.size : 0;
      const bytes = Buffer.alloc(size - start);
      if (readSync(fd, bytes, 0, bytes.length, start) !== bytes.length || fstatSync(fd).size !== size) return LOG_READ_CHANGED;
      // Copilot writes whole lines; a copy ending inside one was not a rotation.
      if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) return null;
      const next = applyLifecycle(selected, bytes.toString("utf8"), start, (position) => `${pid}:${dev}:${ino}:${epoch}:${position}`);
      if (next === null) return null;
      selected = next;
    }
    return selected;
  } finally { for (const { fd } of archives) closeSync(fd); }
}

/**
 * A reader that first meets a process after its log rotated: the copies hold the lines before the
 * open file's, oldest first. They are replayed only when the oldest starts with the process's own
 * first line, so none was pruned, and every copy is still the file read once they all have been.
 * Otherwise null: as before, the open file alone stands for the log.
 */
function archivedLifecycle(target: string, open: { uid: bigint; size: number }, pid: number, epoch: string)
  : ForegroundState | typeof LOG_READ_CHANGED | typeof LOG_COPY_PENDING | null {
  const started = Number(LOG_NAME.exec(basename(target))?.[1]);
  const base = target.slice(0, -".log".length);
  const archives: { path: string; fd: number; size: number; dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint }[] = [];
  try {
    let total = open.size;
    for (let index = 1; index <= MAX_LOG_ARCHIVES; index++) {
      const path = `${base}.${index}.log`;
      let fd: number;
      try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") break;
        // A copy this reader may not open, or a link, proves no chain: the open file stands alone.
        if (code === "EACCES" || code === "EPERM" || code === "ELOOP") return null;
        throw error;
      }
      const archive = { path, fd, size: 0, dev: 0n, ino: 0n, mtimeNs: 0n, ctimeNs: 0n };
      archives.push(archive);
      const stat = fstatSync(fd, { bigint: true });
      Object.assign(archive, { size: Number(stat.size), dev: stat.dev, ino: stat.ino, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs });
      // Copilot writes its copies as the user that owns the open log: another user's file in a shared folder is none.
      if (!stat.isFile() || stat.uid !== open.uid || (total += archive.size) > LOG_HASH_BYTES) return null;
    }
    const oldest = archives.at(-1);
    if (oldest === undefined || !Number.isSafeInteger(started)) return null;
    const head = Buffer.alloc(Math.min(oldest.size, 64));
    readSync(oldest.fd, head, 0, head.length, 0);
    const first = Date.parse(LOG_LINE_TIME.exec(head.toString("utf8"))?.[1] ?? "");
    if (!(first >= started && first - started <= LOG_START_MARGIN_MS)) return null;
    let selected: ForegroundState = legacy;
    for (let index = archives.length - 1; index >= 0; index--) {
      const { fd, size, dev, ino, mtimeNs, ctimeNs } = archives[index]!;
      const bytes = Buffer.alloc(size);
      if (readSync(fd, bytes, 0, size, 0) !== size) return LOG_READ_CHANGED;
      const after = fstatSync(fd, { bigint: true });
      if (after.size !== BigInt(size) || after.mtimeNs !== mtimeNs || after.ctimeNs !== ctimeNs) return LOG_READ_CHANGED;
      // Copilot writes whole lines: an older copy ending inside one is not a whole rotation, and
      // never becomes one, while the newest may still be being written.
      if (size > 0 && bytes[size - 1] !== 0x0a) return index === 0 ? LOG_COPY_PENDING : null;
      const next = applyLifecycle(selected, bytes.toString("utf8"), 0, (position) => `${pid}:${dev}:${ino}:${epoch}:${position}`);
      if (next === null) return null;
      selected = next;
    }
    // A rotation that moved the copies while they were read would have them replayed out of order.
    for (const { path, dev, ino } of archives) {
      const now = statSync(path, { bigint: true, throwIfNoEntry: false });
      if (now?.dev !== dev || now.ino !== ino) return LOG_READ_CHANGED;
    }
    return selected;
  } finally { for (const { fd } of archives) closeSync(fd); }
}

/** The latest complete lifecycle event in the CLI's own open log, never the newest transcript. */
function loggedForeground(pid: number, logDirectories: readonly string[]): ForegroundState {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = scanForegroundLog(pid, logDirectories);
    if (result !== LOG_READ_CHANGED) return result;
  }
  return unavailable("copilot_log_read_raced");
}

function scanForegroundLog(pid: number, logDirectories: readonly string[]): ForegroundState | typeof LOG_READ_CHANGED {
  if (process.platform !== "linux") return unavailable("copilot_process_unproved");
  const birth = readProcessBirth(pid);
  if (birth.state !== "identified") return unavailable("copilot_process_unproved");
  const started = birth.birth.value;
  let owner = foregroundLogProcesses.get(pid);
  if (owner?.started !== started) {
    foregroundLogProcesses.delete(pid);
    owner = undefined;
  }
  if (owner === undefined) {
    if (foregroundLogProcesses.size >= 256) {
      for (const [previousPid, previous] of foregroundLogProcesses) {
        const current = readProcessBirth(previousPid);
        if (current.state === "absent" || (current.state === "identified" && current.birth.value !== previous.started)) {
          foregroundLogProcesses.delete(previousPid);
        }
      }
    }
    // Dropping live denial state would make stale report/marker fallback eligible again.
    if (foregroundLogProcesses.size >= 256) return unavailable("copilot_reader_capacity");
    owner = { started, observed: false };
    foregroundLogProcesses.set(pid, owner);
  }
  const observedBefore = owner.observed;
  const observe = (): void => {
    owner.observed = true;
  };
  const deny = (diagnostic: StoreDiagnostic): ForegroundState => {
    delete owner.initialRead;
    const failure = unavailable(diagnostic);
    owner.denial = failure;
    if (owner.checkpoint) owner.checkpoint.selection = failure;
    return failure;
  };
  const directory = opendirSync(`/proc/${pid}/fd`);
  let found: ForegroundState = legacy;
  let logFound = false;
  let loggedTarget: string | undefined;
  let count = 0;
  try {
    for (let descriptor = directory.readSync(); descriptor; descriptor = directory.readSync()) {
      if (++count > MAX_DESCRIPTORS) return deny("copilot_log_limit");
      let target: string;
      try { target = readlinkSync(`/proc/${pid}/fd/${descriptor.name}`); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (code === "EINTR" || code === "EAGAIN" || code === "EBUSY" || code === "EIO" || code === "ESTALE") {
          // Keep only the prefix to revalidate, never permission to serve a failed scan.
          const cached = owner.checkpoint;
          if (cached) cached.readConflict = true;
          return LOG_READ_CHANGED;
        }
        return deny("copilot_log_unreadable");
      }
      if (target.endsWith(" (deleted)") && LOG_NAME.test(basename(target.slice(0, -10)))) {
        observe();
        return deny("copilot_log_missing");
      }
      if (!logDirectories.some((path) => dirname(target) === path) || LOG_NAME.exec(basename(target))?.[2] !== String(pid)) continue;
      observe();
      // Copilot opens its log a second time to copy it when it rotates: that is still the one log.
      if (logFound && target === loggedTarget) continue;
      if (logFound) return deny("copilot_log_ambiguous");
      loggedTarget = target;
      logFound = true;
      try {
        if (realpathSync(target) !== target) return deny("copilot_log_replaced");
        const fd = openSync(`/proc/${pid}/fd/${descriptor.name}`, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const checkedAtNs = BigInt(Date.now()) * 1_000_000n;
          const stat = fstatSync(fd, { bigint: true });
          const named = statSync(target, { bigint: true });
          if (!stat.isFile() || stat.dev !== named.dev || stat.ino !== named.ino) return deny("copilot_log_replaced");
          if (stat.size > LOG_HASH_BYTES) return deny("copilot_log_limit");
          const size = Number(stat.size);
          const newestCopy = (): CopyStamp | null => {
            const newest = lstatSync(`${target.slice(0, -".log".length)}.1.log`, { bigint: true, throwIfNoEntry: false });
            return newest ? { dev: newest.dev, ino: newest.ino, size: newest.size, mtimeNs: newest.mtimeNs, ctimeNs: newest.ctimeNs } : null;
          };
          const newest = newestCopy();
          const earlier = owner.checkpoint;
          // A deleted copy's inode can come back as a new newest, so its size and times count too. No
          // newest copy at all (Copilot moving its copies up) also stands for a rotation: lines may have
          // left with it, so the binding waits for the copy that carries on from what was read.
          const rotatedSince = earlier !== undefined && !sameCopy(newest, earlier.newestCopy);
          // Only the copies named a session and no line of the open file was read: read the whole chain again, as a fresh reader does.
          const rereadChain = rotatedSince && earlier.size === 0 && (earlier.selection.kind === "selected" || earlier.selection.kind === "unregistered");
          // The newest copy was still being written at the first read: read the initial log and its copies again.
          const retryCopy = earlier?.copyPending === true && size >= earlier.size;
          const rereading = rereadChain || retryCopy;
          const cached = rereading ? undefined : owner.checkpoint;
          // A same-size rewrite can share both timestamps with this check.
          // Only a check already outside that tick can attest unchanged bytes.
          if (!rotatedSince && !cached?.readConflict && cached?.dev === stat.dev && cached.ino === stat.ino && cached.path === target
            && cached.observedSize === size && cached.mtimeNs === stat.mtimeNs && cached.ctimeNs === stat.ctimeNs
            && checkedAtNs >= cached.checkedAtNs
            && cached.checkedAtNs - stat.mtimeNs >= LOG_TIMESTAMP_MARGIN_NS
            && cached.checkedAtNs - stat.ctimeNs >= LOG_TIMESTAMP_MARGIN_NS) {
            found = currentForeground(cached);
            continue;
          }
          const prefix = cached && size >= cached.size ? logPrefix(fd, cached.size) : null;
          const changed: StoreDiagnostic | undefined = !cached ? undefined
            : cached.dev !== stat.dev || cached.ino !== stat.ino || cached.path !== target ? "copilot_log_replaced"
            : size < cached.size ? "copilot_log_truncated"
            : size - cached.size > LOG_WINDOW_BYTES ? "copilot_log_gap"
            : prefix?.copy().digest("hex") !== cached.hash.copy().digest("hex") ? "copilot_log_rewritten"
            // the same bytes again after a rotation: the copy that carries on from them holds what came between
            : rotatedSince && cached.size > 0 ? "copilot_log_rewritten"
            // a partial line already seen cannot go away from a log that is only appended to
            : size < cached.observedSize ? "copilot_log_truncated"
            // Copilot only appends and rotates: the same bytes in the same file cannot hide a lifecycle line,
            // so a binding read from them stands. Marker fallback still needs an untouched initial log.
            : size === cached.size && (stat.mtimeNs !== cached.mtimeNs || stat.ctimeNs !== cached.ctimeNs)
              && (cached.selection.kind === "legacy" || cached.selection.kind === "unavailable") ? "copilot_log_metadata_changed" : undefined;
          const same = cached !== undefined && changed === undefined;
          // The open file shrank or no longer starts with what was read: a rotation, when a copy carries on from it.
          const rotated = cached !== undefined && size <= LOG_WINDOW_BYTES && (changed === "copilot_log_truncated" || changed === "copilot_log_rewritten")
            ? rotatedLifecycle(target, cached, stat.uid, pid) : null;
          if (rotated === LOG_READ_CHANGED) {
            cached!.readConflict = true;
            return LOG_READ_CHANGED;
          }
          const epoch = same ? cached.epoch : randomUUID();
          const start = same ? cached.size : Math.max(0, size - LOG_WINDOW_BYTES);
          const bytes = Buffer.alloc(size - start);
          const read = readSync(fd, bytes, 0, bytes.length, start);
          const initial = owner.initialRead;
          // A raced bootstrap is still initial only while the bytes this read returned begin with
          // every byte already seen, in the same process-owned file. Judged from those bytes, not
          // a separate read, so a rewrite between two reads cannot pass. A lost/replaced log revokes it.
          const initialContinues = initial !== undefined && start === 0 && initial.dev === stat.dev && initial.ino === stat.ino
            && initial.path === target && read >= initial.size
            && createHash("sha256").update(bytes.subarray(0, initial.size)).digest("hex") === initial.hash;
          const hash = same ? prefix : logPrefix(fd, start);
          const initialLog = !same && start === 0 && (!observedBefore || initialContinues);
          // Until a read is kept, a proven chain still covers every line: a rotation that raced an
          // earlier read leaves its lines in the copies rather than losing them.
          // A raced read whose bytes no longer start the open log lost them to something else: the
          // copies cannot stand in for lines that were never copied.
          const archived = !same && start === 0 && cached === undefined && owner.denial === undefined
            && (rereadChain || initial === undefined || initialContinues)
            ? archivedLifecycle(target, { uid: stat.uid, size }, pid, epoch) : null;
          if (archived === LOG_READ_CHANGED) {
            if (initialLog && read === bytes.length && hash !== null) {
              owner.initialRead = { dev: stat.dev, ino: stat.ino, path: target, size, hash: hash.copy().update(bytes).digest("hex") };
            } else delete owner.initialRead;
            return LOG_READ_CHANGED;
          }
          const copyPending = archived === LOG_COPY_PENDING;
          const chain = copyPending ? null : archived;
          // Only an initial log may fall back to a held marker, even after copies without lifecycle lines.
          const fromCopies = chain !== null && (initialLog || chain.kind !== "legacy");
          const after = fstatSync(fd, { bigint: true });
          // A rotation during the read would pair the bytes read with a newer copy than they were cut into.
          const settled = newestCopy();
          if (read !== bytes.length || hash === null || after.size !== stat.size
            || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs
            || !sameCopy(settled, newest)) {
            if (cached) cached.readConflict = true;
            // A later raced read extends the protected prefix while it still starts with the first one,
            // so a rewrite back to an earlier prefix cannot drop lifecycle lines read in between.
            else if ((!observedBefore || initialContinues) && start === 0 && read === bytes.length && hash !== null) {
              owner.initialRead = { dev: stat.dev, ino: stat.ino, path: target, size,
                hash: hash.copy().update(bytes).digest("hex") };
            } else delete owner.initialRead;
            return LOG_READ_CHANGED;
          }
          const text = bytes.subarray(0, read).toString("utf8");
          const skip = start === 0 || same ? 0 : text.indexOf("\n") + 1;
          const complete = text.slice(skip, text.lastIndexOf("\n") + 1);
          if (start > 0 && !complete && !same) return deny("copilot_log_gap");
          // Only a complete initial log without lifecycle evidence permits marker/report fallback.
          const previous: ForegroundState = same ? cached.selection
            : fromCopies ? chain
            : initialLog ? legacy
            : rotated ?? unavailable(changed ?? owner.denial?.diagnostic ?? (start > 0 ? "copilot_log_gap" : "copilot_log_read_raced"));
          const position = start + Buffer.byteLength(text.slice(0, skip));
          const selected = applyLifecycle(previous, complete, position, (at) => `${pid}:${stat.dev}:${stat.ino}:${epoch}:${at}`);
          if (selected === null) return deny("copilot_log_unreadable");
          const completeBytes = bytes.lastIndexOf(0x0a) + 1;
          hash.update(bytes.subarray(0, completeBytes));
          const tail = text.slice(text.lastIndexOf("\n") + 1);
          // Cache the visible result separately from the last complete binding:
          // an unchanged partial timestamp or switch must remain unavailable.
          const message = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z \[INFO\] (.*)$/.exec(tail)?.[1];
          const pendingSwitch = !!tail && ((selected.kind === "unavailable" || selected.kind === "unregistered") || (/^\d/.test(tail) && (message === undefined
            || FOREGROUND_PREFIXES.some((event) => event.startsWith(message) || message.startsWith(event)))));
          // A chain that cannot be read yet, such as a copy still being written, is tried again on the
          // next lookup: the earlier read stays, and no denial outlasts this one.
          if (rereadChain && selected.kind === "unavailable") {
            found = selected;
            continue;
          }
          const checkpoint: ForegroundCheckpoint = {
            dev: stat.dev, ino: stat.ino, path: target, size: start + completeBytes,
            observedSize: size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, checkedAtNs, pendingSwitch, hash, epoch, selection: selected,
            newestCopy: newest,
            // Until the open log names a session, the copies may still: try them again next time.
            ...(copyPending && initialLog && selected.kind === "legacy" ? { copyPending: true as const } : {}),
          };
          // Every file starts with zero bytes: until the rotated file holds a line, only the
          // bytes read before it can find the copy a further rotation makes.
          if (rotated === null || checkpoint.size > 0) owner.checkpoint = checkpoint;
          if (selected.kind === "unavailable") owner.denial = selected;
          else if (selected.kind === "selected" || selected.kind === "legacy") delete owner.denial;
          delete owner.initialRead;
          // the retry is still the initial log while it begins with every byte read now
          if (checkpoint.copyPending) owner.initialRead = { dev: stat.dev, ino: stat.ino, path: target, size: checkpoint.size, hash: hash.copy().digest("hex") };
          found = currentForeground(checkpoint);
        } finally { closeSync(fd); }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EINTR" || code === "EAGAIN" || code === "EBUSY" || code === "EIO" || code === "ESTALE") {
          // Retain revalidation context, not permission to serve the old binding.
          const cached = owner.checkpoint;
          if (cached) cached.readConflict = true;
          return LOG_READ_CHANGED;
        }
        return deny("copilot_log_unreadable");
      }
    }
  } finally { directory.closeSync(); }
  return !logFound && owner.observed ? deny("copilot_log_missing") : found;
}

/** Pin one regular canonical file; callers must close the descriptor after reading. */
export function openCopilotFile(file: string): number {
  if (realpathSync(file) !== file) throw new Error("Copilot transcript path is not canonical");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    const pathStat = statSync(file);
    if (!stat.isFile() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      throw new Error("Copilot transcript is not a regular canonical file");
    }
    const session = basename(dirname(file));
    if (SESSION_ID.test(session)) {
      const bytes = Buffer.alloc(Math.min(stat.size, HEADER_BYTES));
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      const newline = bytes.indexOf(0x0a);
      if (newline < 0 || newline >= length) throw new Error("Copilot transcript header is incomplete");
      const header = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as { type?: unknown; data?: { sessionId?: unknown } };
      if (header?.type !== "session.start" || header.data?.sessionId !== session) throw new Error("Copilot transcript header does not match its session");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Only an actual PID-owned, open and canonical marker proves this process still holds a session. */
function scanHeldSessions(pid: number, store: string): Set<string> | null | undefined {
  const sessions = new Set<string>();
  const directory = opendirSync(`/proc/${pid}/fd`);
  let count = 0;
  try {
    for (let fd = directory.readSync(); fd; fd = directory.readSync()) {
      if (++count > MAX_DESCRIPTORS) return null;
      let target: string;
      try { target = readlinkSync(`/proc/${pid}/fd/${fd.name}`); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        return null;
      }
      const path = relative(store, target);
      if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) continue;
      const parts = path.split(sep);
      if (parts.length !== 2 || !SESSION_ID.test(parts[0]!) || parts[1] !== `inuse.${pid}.hold`) {
        if (target.includes("inuse.") || target.includes(".hold")) return null;
        continue;
      }
      if (realpathSync(join(store, parts[0]!)) !== join(store, parts[0]!)
        || realpathSync(target) !== target) return null;
      const marker = statSync(target);
      const open = statSync(`/proc/${pid}/fd/${fd.name}`);
      if (!marker.isFile() || !open.isFile() || marker.dev !== open.dev || marker.ino !== open.ino) return null;
      sessions.add(parts[0]!);
    }
  } finally { directory.closeSync(); }
  return sessions;
}

/** A disappearing descriptor invalidates that scan; retry once, then fall back. */
export function heldSessions(pid: number, store: string): Set<string> | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sessions = scanHeldSessions(pid, store);
    if (sessions !== undefined) return sessions;
  }
  return null;
}

type ProcessSession = { sessionId: string; path: string } & (
  | { logged: true; generation: string }
  | { logged: false }
);

function copilotStoreLayout(environment: readonly string[] | null, argv: readonly string[]): { store: string; logs: string[] } | null {
  if (environment === null) return null;
  const values = (key: string) => environment.filter((item) => item.startsWith(`${key}=`)).map((item) => item.slice(key.length + 1));
  const home = values("HOME");
  const explicit = values("COPILOT_HOME");
  if (home.length > 1 || explicit.length > 1) return null;
  const config: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const option = argv[i]!;
    if (option === "--") break;
    if (option.startsWith("--config-dir=")) config.push(option.slice("--config-dir=".length));
    else if (option === "--config-dir") config.push(argv[++i] ?? "");
  }
  if (config.length > 1) return null;
  const chosen = config[0] ?? explicit[0] ?? (home[0] ? join(home[0], ".copilot") : "");
  if (!isAbsolute(chosen)) return null;
  try {
    const canonicalHome = realpathSync(chosen);
    if (!statSync(canonicalHome).isDirectory()) return null;
    const store = join(canonicalHome, "session-state");
    if (realpathSync(store) !== store) return null;
    const logOptions: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--") break;
      if (argv[i] === "--log-dir") logOptions.push(argv[++i] ?? "");
      else if (argv[i]?.startsWith("--log-dir=")) logOptions.push(argv[i]!.slice("--log-dir=".length));
    }
    if (logOptions.length > 1 || (logOptions.length && !isAbsolute(logOptions[0]!))) return null;
    const logs = logOptions.length ? logOptions : [join(canonicalHome, "logs"), ...(home[0] ? [join(home[0], ".copilot", "logs")] : [])];
    return { store, logs };
  } catch { return null; }
}

/** The API names the session; its file must still belong to this process's canonical store. */
export function copilotApiTranscript(sessionId: string, environment: readonly string[] | null, argv: readonly string[]): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  const layout = copilotStoreLayout(environment, argv);
  if (layout === null) return null;
  try {
    const directory = join(layout.store, sessionId);
    if (realpathSync(directory) !== directory) return null;
    const path = join(directory, "events.jsonl");
    const fd = openCopilotFile(path);
    closeSync(fd);
    return path;
  } catch { return null; }
}

/** Resolve once per validation pass; never reuse this evidence across a transcript read. */
export function copilotProcessSession(environment: readonly string[] | null, argv: readonly string[], pid: number, mode: "current" | "unregistered" = "current"): ProcessSession | null {
  return readCopilotProcessSession(environment, argv, pid, mode).session;
}

type ProcessResolution = { session: ProcessSession; diagnostic?: never } | { session: null; diagnostic: StoreDiagnostic };

/** Failure reasons describe evidence only; never carry session IDs, paths or OS exception text to logs. */
export function readCopilotProcessSession(environment: readonly string[] | null, argv: readonly string[], pid: number, mode: "current" | "unregistered" = "current"): ProcessResolution {
  const fail = (diagnostic: StoreDiagnostic): ProcessResolution => ({ session: null, diagnostic });
  if (!Number.isSafeInteger(pid) || pid < 1) return fail("copilot_process_unproved");
  const layout = copilotStoreLayout(environment, argv);
  if (layout === null) return fail("copilot_store_unproved");
  const { store, logs } = layout;
  let stage: StoreDiagnostic = "copilot_log_unreadable";
  try {
    const foreground = loggedForeground(pid, logs);
    if (foreground.kind === "unavailable") return fail(foreground.diagnostic);
    stage = "copilot_session_directory_unproved";
    if (mode === "unregistered") {
      const ended = foreground.kind === "unregistered" ? foreground.binding : null;
      if (!ended) return fail("copilot_session_unregistered");
      const directory = join(store, ended.sessionId);
      if (realpathSync(directory) !== directory) return fail(stage);
      return { session: { ...ended, path: join(directory, "events.jsonl"), logged: true } };
    }
    if (foreground.kind === "unregistered") return fail("copilot_session_unregistered");
    if (foreground.kind === "selected") {
      const directory = join(store, foreground.binding.sessionId);
      if (realpathSync(directory) !== directory) return fail(stage);
      return { session: { ...foreground.binding, path: join(directory, "events.jsonl"), logged: true } };
    }
    stage = "copilot_marker_unreadable";
    const held = heldSessions(pid, store);
    if (held === null) return fail(stage);
    if (held.size === 0) return fail("copilot_marker_missing");
    if (held.size !== 1) return fail("copilot_marker_ambiguous");
    const session = [...held][0]!;
    const directory = join(store, session);
    stage = "copilot_session_directory_unproved";
    if (realpathSync(directory) !== directory) return fail(stage);
    return { session: { sessionId: session, path: join(directory, "events.jsonl"), logged: false } };
  } catch { return fail(stage); }
}

interface HandoffProcess { pid: number; argv: readonly string[] }
interface LinuxGroup { parent: number; group: number; session: number; terminal: number; foreground: number; birth: number }

function linuxGroup(pid: number): LinuxGroup | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    const [parent, group, session, terminal, foreground, birth] = [1, 2, 3, 4, 5, 19].map((index) => Number(fields[index]));
    if (![parent, group, session, terminal, foreground, birth].every(Number.isSafeInteger)) return null;
    return { parent: parent!, group: group!, session: session!, terminal: terminal!, foreground: foreground!, birth: birth! };
  } catch { return null; }
}

function onlyOption(argv: readonly string[], name: string, expected: string): boolean {
  const values: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--") break;
    if (argv[i] === name) values.push(argv[++i] ?? "");
    else if (argv[i]?.startsWith(`${name}=`)) values.push(argv[i]!.slice(name.length + 1));
  }
  return values.length === 1 && values[0] === expected;
}

/** An unregistered parent may hand its reported session to its direct, foreground child. */
export function copilotHandoffSession(
  parent: HandoffProcess, child: HandoffProcess, report: string, groupId: number | null | undefined, tty: string | null | undefined,
  environment: (pid: number) => readonly string[] | null,
): ProcessSession | null {
  if (process.platform !== "linux" || !SESSION_ID.test(report) || !Number.isSafeInteger(parent.pid)
    || !Number.isSafeInteger(child.pid) || !groupId || parent.pid === child.pid
    || !onlyOption(parent.argv, "--resume", report) || !onlyOption(child.argv, "--session-id", report)) return null;
  const beforeParent = linuxGroup(parent.pid);
  const beforeChild = linuxGroup(child.pid);
  if (!beforeParent || !beforeChild || beforeChild.parent !== parent.pid
    || beforeParent.birth > beforeChild.birth || beforeParent.terminal <= 0
    || beforeParent.terminal !== beforeChild.terminal || beforeParent.session !== beforeChild.session
    || beforeParent.group !== beforeChild.group || beforeParent.group !== groupId
    || beforeParent.foreground !== groupId || beforeChild.foreground !== groupId) return null;
  if (tty) {
    try {
      const terminal = realpathSync(tty);
      if (realpathSync(`/proc/${parent.pid}/fd/0`) !== terminal || realpathSync(`/proc/${child.pid}/fd/0`) !== terminal) return null;
    } catch { return null; }
  }
  const ended = copilotProcessSession(environment(parent.pid), parent.argv, parent.pid, "unregistered");
  const held = copilotProcessSession(environment(child.pid), child.argv, child.pid);
  const childLog = foregroundLogProcesses.get(child.pid)?.checkpoint;
  if (!ended?.logged || !held || held.logged || !foregroundLogProcesses.get(child.pid)?.observed
    || !childLog || childLog.selection.kind !== "legacy" || childLog.pendingSwitch
    || ended.sessionId !== report || held.sessionId !== report || ended.path !== held.path) return null;
  const afterParent = linuxGroup(parent.pid);
  const afterChild = linuxGroup(child.pid);
  if (!afterParent || !afterChild || afterParent.birth !== beforeParent.birth || afterChild.birth !== beforeChild.birth
    || afterChild.parent !== parent.pid || afterParent.group !== groupId || afterChild.group !== groupId
    || afterParent.terminal !== beforeParent.terminal || afterChild.terminal !== beforeChild.terminal
    || afterParent.foreground !== groupId || afterChild.foreground !== groupId) return null;
  return { ...held, logged: true, generation: `handoff:${parent.pid}:${ended.generation}:${child.pid}:${afterChild.birth}` };
}

/** Only the reported session, or the process-owned lifecycle selection. */
export function copilotTranscriptFile(session: unknown, held: ProcessSession | null): string | null {
  if (held === null || (session === null ? !held.logged : typeof session !== "string" || !SESSION_ID.test(session) || held.sessionId !== session)) return null;
  try {
    const fd = openCopilotFile(held.path);
    try {
      return held.path;
    } finally { closeSync(fd); }
  } catch { return null; }
}

/** A process-held session with no transcript yet, never permission to read unreported history. */
export function copilotUnwrittenSession(held: ProcessSession | null, argv: readonly string[]): { sessionId: string; path: string } | null {
  if (held === null) return null;
  if (!held.logged && copilotExplicitResume(argv)) return null;
  try {
    lstatSync(held.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessionId: held.sessionId, path: held.path };
  }
  return null;
}

export function copilotExplicitResume(argv: readonly string[]): boolean {
  return argv.some((word) => word === "--continue" || word === "-r" || word === "--resume" || word.startsWith("--resume="));
}
