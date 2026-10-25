import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { processAlive, processStartedAt } from "./process-start.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADER_BYTES = 64 * 1024;
const MAX_DESCRIPTORS = 4096;
const LOG_WINDOW_BYTES = 16 * 1024 * 1024;
const LOG_NAME = /^process-\d+-(\d+)\.log$/;
const FOREGROUND_EVENT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z \[INFO\] (Registering|Unregistering) foreground session: ([\da-f-]{36})$/;
interface ForegroundBinding { sessionId: string; generation: string }
interface ForegroundCheckpoint {
  dev: number; ino: number; path: string; size: number; mtimeMs: number; ctimeMs: number;
  boundary: string; epoch: string; binding: ForegroundBinding | null | undefined;
}
const foregroundCheckpoints = new Map<number, ForegroundCheckpoint>();
const foregroundLogProcesses = new Map<number, { started: number; observed: boolean }>();

/** Check consumed content at both ends before treating the next read as an append. */
function logBoundary(fd: number, size: number): string | null {
  const length = Math.min(size, HEADER_BYTES);
  const bytes = Buffer.alloc(length);
  const hash = createHash("sha256");
  for (const position of [0, Math.max(0, size - length)]) {
    if (readSync(fd, bytes, 0, length, position) !== length) return null;
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** The latest complete lifecycle event in the CLI's own open log, never the newest transcript. */
function loggedForeground(pid: number, logDirectories: readonly string[]): ForegroundBinding | null | undefined {
  const started = processStartedAt(pid);
  if (started === null) return undefined;
  let owner = foregroundLogProcesses.get(pid);
  if (owner?.started !== started) {
    foregroundLogProcesses.delete(pid);
    foregroundCheckpoints.delete(pid);
    owner = undefined;
  }
  if (owner === undefined) {
    if (foregroundLogProcesses.size >= 256) {
      for (const [previousPid, previous] of foregroundLogProcesses) {
        const current = processStartedAt(previousPid);
        if ((current !== null && current !== previous.started) || !processAlive(previousPid)) {
          foregroundLogProcesses.delete(previousPid);
          foregroundCheckpoints.delete(previousPid);
        }
      }
    }
    // Dropping live denial state would make stale report/marker fallback eligible again.
    if (foregroundLogProcesses.size >= 256) return undefined;
    owner = { started, observed: false };
    foregroundLogProcesses.set(pid, owner);
  }
  const observedBefore = owner.observed;
  const observe = (): void => {
    owner.observed = true;
  };
  const unavailable = (): undefined => {
    const checkpoint = foregroundCheckpoints.get(pid);
    if (checkpoint) checkpoint.binding = undefined;
    return undefined;
  };
  const directory = opendirSync(`/proc/${pid}/fd`);
  let found: ForegroundBinding | null | undefined = null;
  let logFound = false;
  let count = 0;
  try {
    for (let descriptor = directory.readSync(); descriptor; descriptor = directory.readSync()) {
      if (++count > MAX_DESCRIPTORS) return unavailable();
      let target: string;
      try { target = readlinkSync(`/proc/${pid}/fd/${descriptor.name}`); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return unavailable();
      }
      if (target.endsWith(" (deleted)") && LOG_NAME.test(basename(target.slice(0, -10)))) {
        observe();
        return unavailable();
      }
      if (!logDirectories.some((path) => dirname(target) === path) || LOG_NAME.exec(basename(target))?.[1] !== String(pid)) continue;
      observe();
      if (logFound) return unavailable();
      logFound = true;
      try {
        if (realpathSync(target) !== target) return unavailable();
        const fd = openSync(`/proc/${pid}/fd/${descriptor.name}`, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(fd);
          const named = statSync(target);
          if (!stat.isFile() || stat.dev !== named.dev || stat.ino !== named.ino) return unavailable();
          const cached = foregroundCheckpoints.get(pid);
          const same = cached?.dev === stat.dev && cached.ino === stat.ino && cached.path === target
            && stat.size >= cached.size && stat.size - cached.size <= LOG_WINDOW_BYTES
            && (stat.size !== cached.size || (stat.mtimeMs === cached.mtimeMs && stat.ctimeMs === cached.ctimeMs))
            && logBoundary(fd, cached.size) === cached.boundary;
          const epoch = same ? cached.epoch : randomUUID();
          const start = same ? cached.size : Math.max(0, stat.size - LOG_WINDOW_BYTES);
          const bytes = Buffer.alloc(stat.size - start);
          const read = readSync(fd, bytes, 0, bytes.length, start);
          const boundary = logBoundary(fd, stat.size);
          const after = fstatSync(fd);
          if (read !== bytes.length || boundary === null || after.size !== stat.size
            || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return unavailable();
          const text = bytes.subarray(0, read).toString("utf8");
          if (text && !text.endsWith("\n")) return undefined;
          const skip = start === 0 || same ? 0 : text.indexOf("\n") + 1;
          const complete = text.slice(skip, text.lastIndexOf("\n") + 1);
          if (start > 0 && !complete && !same) return unavailable();
          // Only a complete initial log without lifecycle evidence permits marker/report fallback.
          let selected = same ? cached.binding : start === 0 && !observedBefore ? null : undefined;
          let position = start + Buffer.byteLength(text.slice(0, skip));
          for (const line of complete.split("\n")) {
            const match = FOREGROUND_EVENT.exec(line);
            if (match) {
              if (!SESSION_ID.test(match[2]!)) return unavailable();
              if (match[1] === "Registering") selected = { sessionId: match[2]!, generation: `${pid}:${stat.dev}:${stat.ino}:${epoch}:${position}` };
              else selected = undefined;
            }
            position += Buffer.byteLength(line) + 1;
          }
          foregroundCheckpoints.set(pid, {
            dev: stat.dev, ino: stat.ino, path: target, size: stat.size,
            mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, boundary, epoch, binding: selected,
          });
          found = selected;
        } finally { closeSync(fd); }
      } catch { return unavailable(); }
    }
  } finally { directory.closeSync(); }
  return !logFound && owner.observed ? unavailable() : found;
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

/** Resolve once per validation pass; never reuse this evidence across a transcript read. */
export function copilotProcessSession(environment: readonly string[] | null, argv: readonly string[], pid: number): ProcessSession | null {
  if (environment === null || !Number.isSafeInteger(pid) || pid < 1) return null;
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
    const foreground = loggedForeground(pid, logs);
    if (foreground === undefined) return null;
    if (foreground !== null) {
      const directory = join(store, foreground.sessionId);
      if (realpathSync(directory) !== directory) return null;
      return { ...foreground, path: join(directory, "events.jsonl"), logged: true };
    }
    const held = heldSessions(pid, store);
    if (held === null || held.size !== 1) return null;
    const session = [...held][0]!;
    const directory = join(store, session);
    if (realpathSync(directory) !== directory) return null;
    return { sessionId: session, path: join(directory, "events.jsonl"), logged: false };
  } catch { return null; }
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
