/**
 * Isolated, read-only experiment: never launches Copilot or authorizes transcript access.
 * The protected transport contract is unresolved; this is deliberately not imported by Chat.
 */
import { closeSync, openSync, readSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { readProcessBirth } from "../server/process-owner.ts";

type Diagnostic = "unsupported_platform" | "process_unproved" | "not_opted_in" | "endpoint_unproved"
  | "process_changed" | "rpc_failed" | "rpc_timeout" | "malformed_rpc" | "rpc_rejected"
  | "unsupported_protocol" | "foreground_changed" | "no_foreground";
export type ForegroundObservation =
  | { state: "unavailable"; diagnostic: Diagnostic }
  | { state: "observed"; sessionId: string; authorization: "unproven" };
interface Endpoint { host: string; address: string; port: number; inode: string }
interface Owner { pid: number; birth: string; endpoint: Endpoint }
interface TcpEntry { address: string; port: number; remoteAddress: string; remotePort: number; state: string; inode: string }

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK: Readonly<Record<string, string>> = { "0100007F": "127.0.0.1", "00000000000000000000000001000000": "::1" };
const MAX_MESSAGE = 64 * 1024;
class Unavailable extends Error {
  constructor(readonly diagnostic: Diagnostic) { super(diagnostic); }
}

function boundedFile(path: string, limit: number): string {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) return bytes.subarray(0, length).toString("utf8");
      length += read;
    }
    throw new Unavailable("process_unproved");
  } finally { closeSync(fd); }
}

function socketInodes(pid: number): Set<string> {
  const descriptors = readdirSync(`/proc/${pid}/fd`);
  if (descriptors.length > 4096) throw new Unavailable("process_unproved");
  const inodes = new Set<string>();
  for (const descriptor of descriptors) {
    let target: string;
    try { target = readlinkSync(`/proc/${pid}/fd/${descriptor}`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match) inodes.add(match[1]!);
  }
  return inodes;
}

function tcpEntries(pid: number): TcpEntry[] {
  return ["tcp", "tcp6"].flatMap((table) =>
    boundedFile(`/proc/${pid}/net/${table}`, 4 * 1024 * 1024).split("\n").slice(1).filter((line) => line.trim()).map((line) => {
      const fields = line.trim().split(/\s+/);
      const local = /^([\dA-F]+):([\dA-F]{4})$/.exec(fields[1] ?? "");
      const remote = /^([\dA-F]+):([\dA-F]{4})$/.exec(fields[2] ?? "");
      if (!local || !remote || !fields[3] || !/^\d+$/.test(fields[9] ?? "")) throw new Unavailable("endpoint_unproved");
      return { address: local[1]!, port: Number.parseInt(local[2]!, 16), remoteAddress: remote[1]!,
        remotePort: Number.parseInt(remote[2]!, 16), state: fields[3], inode: fields[9]! };
    }));
}

function owner(pid: number): Owner {
  if (!Number.isSafeInteger(pid) || pid < 1 || statSync(`/proc/${pid}`).uid !== process.getuid?.()) throw new Unavailable("process_unproved");
  const birth = readProcessBirth(pid);
  if (birth.state !== "identified") throw new Unavailable("process_unproved");
  const argv = boundedFile(`/proc/${pid}/cmdline`, MAX_MESSAGE).split("\0");
  const delimiter = argv.indexOf("--");
  if (!argv.slice(0, delimiter < 0 ? undefined : delimiter).includes("--ui-server")) throw new Unavailable("not_opted_in");
  const inodes = socketInodes(pid);
  const listening = tcpEntries(pid).filter((entry) => entry.state === "0A" && inodes.has(entry.inode));
  const endpoint = listening[0];
  if (listening.length !== 1 || !endpoint || !Object.hasOwn(LOOPBACK, endpoint.address)) throw new Unavailable("endpoint_unproved");
  return { pid, birth: birth.birth.value, endpoint: { ...endpoint, host: LOOPBACK[endpoint.address]! } };
}

function unchanged(expected: Owner): void {
  const current = owner(expected.pid);
  if (current.birth !== expected.birth || current.endpoint.inode !== expected.endpoint.inode
    || current.endpoint.address !== expected.endpoint.address || current.endpoint.port !== expected.endpoint.port) {
    throw new Unavailable("process_changed");
  }
}

function acceptedByOwner(expected: Owner, socket: Socket): boolean {
  unchanged(expected);
  const inodes = socketInodes(expected.pid);
  return tcpEntries(expected.pid).some((entry) => entry.state === "01" && inodes.has(entry.inode)
    && entry.address === expected.endpoint.address && entry.port === expected.endpoint.port
    && entry.remoteAddress === expected.endpoint.address && entry.remotePort === socket.localPort);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function* messages(socket: Socket, switched: () => void): AsyncGenerator<Record<string, unknown>> {
  let bytes: Buffer = Buffer.alloc(0);
  for await (const chunk of socket) {
    bytes = Buffer.concat([bytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (bytes.length > MAX_MESSAGE + 8192) throw new Unavailable("malformed_rpc");
    const ready: Record<string, unknown>[] = [];
    for (;;) {
      const boundary = bytes.indexOf("\r\n\r\n");
      if (boundary < 0) {
        if (bytes.length > 8192) throw new Unavailable("malformed_rpc");
        break;
      }
      if (boundary > 8192) throw new Unavailable("malformed_rpc");
      const lengths = bytes.subarray(0, boundary).toString("ascii").split("\r\n").filter((line) => /^Content-Length:/i.test(line));
      const match = lengths.length === 1 ? /^Content-Length: (\d+)$/i.exec(lengths[0]!) : null;
      const length = match ? Number(match[1]) : 0;
      if (!Number.isSafeInteger(length) || length < 1 || length > MAX_MESSAGE) throw new Unavailable("malformed_rpc");
      if (bytes.length < boundary + 4 + length) break;
      let value: unknown;
      try { value = JSON.parse(bytes.subarray(boundary + 4, boundary + 4 + length).toString("utf8")); }
      catch { throw new Unavailable("malformed_rpc"); }
      bytes = bytes.subarray(boundary + 4 + length);
      if (!record(value) || value.jsonrpc !== "2.0") throw new Unavailable("malformed_rpc");
      if (!Object.hasOwn(value, "id") && (value.method === "session.foreground" || value.method === "session.background")) switched();
      ready.push(value);
    }
    // Observe complete trailing switch events before yielding the response ahead of them.
    for (const value of ready) yield value;
  }
  throw new Unavailable("rpc_failed");
}

async function query(expected: Owner): Promise<ForegroundObservation> {
  const socket = createConnection({ host: expected.endpoint.host, port: expected.endpoint.port });
  let rejectFailure: (error: Unavailable) => void = () => {};
  const failed = new Promise<never>((_, reject) => { rejectFailure = reject; });
  socket.on("error", () => rejectFailure(new Unavailable("rpc_failed")));
  socket.on("close", () => rejectFailure(new Unavailable("rpc_failed")));
  let disposed = false;
  const timer = setTimeout(() => {
    rejectFailure(new Unavailable("rpc_timeout"));
    socket.destroy();
  }, 2000);
  const run = async (): Promise<ForegroundObservation> => {
    await once(socket, "connect");
    const deadline = performance.now() + 2000;
    while (!acceptedByOwner(expected, socket)) {
      if (disposed || socket.destroyed) throw new Unavailable("rpc_failed");
      if (performance.now() > deadline) throw new Unavailable("rpc_timeout");
      await Bun.sleep(5);
    }
    let invalidated = false;
    const incoming = messages(socket, () => { invalidated = true; });
    let sequence = 0;
    let received = 0;
    const request = async (method: "connect" | "session.getForeground"): Promise<unknown> => {
      if (!acceptedByOwner(expected, socket)) throw new Unavailable("process_changed");
      const id = ++sequence;
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }));
      socket.write(`Content-Length: ${body.length}\r\n\r\n`);
      socket.write(body);
      for (;;) {
        const next = await incoming.next();
        if (next.done || ++received > 32) throw new Unavailable("malformed_rpc");
        const value = next.value;
        if (!Object.hasOwn(value, "id") && (value.method === "session.foreground" || value.method === "session.background")) {
          invalidated = true;
          continue;
        }
        if (value.id !== id || Object.hasOwn(value, "method")) throw new Unavailable("malformed_rpc");
        if (Object.hasOwn(value, "error")) throw new Unavailable("rpc_rejected");
        if (!Object.hasOwn(value, "result")) throw new Unavailable("malformed_rpc");
        if (!acceptedByOwner(expected, socket)) throw new Unavailable("process_changed");
        return value.result;
      }
    };
    const connection = await request("connect");
    if (!record(connection) || connection.ok !== true || connection.protocolVersion !== 3) throw new Unavailable("unsupported_protocol");
    const selection = async (): Promise<string> => {
      const result = await request("session.getForeground");
      if (!record(result)) throw new Unavailable("malformed_rpc");
      if (result.sessionId === null || result.sessionId === undefined) throw new Unavailable("no_foreground");
      if (typeof result.sessionId !== "string" || !SESSION_ID.test(result.sessionId)) throw new Unavailable("malformed_rpc");
      return result.sessionId;
    };
    const first = await selection();
    const second = await selection();
    if (first !== second || invalidated) throw new Unavailable("foreground_changed");
    unchanged(expected);
    return { state: "observed", sessionId: second, authorization: "unproven" };
  };
  try { return await Promise.race([run(), failed]); }
  finally { disposed = true; clearTimeout(timer); socket.destroy(); }
}

/** An observation, NOT ownership authority. No environment secrets or control methods are sent. */
export async function observeCopilotForeground(pid: number): Promise<ForegroundObservation> {
  if (process.platform !== "linux") return { state: "unavailable", diagnostic: "unsupported_platform" };
  try { return await query(owner(pid)); }
  catch (error) {
    if (error instanceof Unavailable) return { state: "unavailable", diagnostic: error.diagnostic };
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "ESRCH", "EACCES", "EPERM", "EIO", "ECONNRESET", "ECONNREFUSED"].includes(code ?? "")) {
      return { state: "unavailable", diagnostic: "process_unproved" };
    }
    throw error;
  }
}

if (import.meta.main) {
  const result = await observeCopilotForeground(Number(process.argv[2]));
  console.log(JSON.stringify(result.state === "observed"
    ? { state: result.state, foreground_present: true, authorization: result.authorization }
    : result));
  process.exitCode = result.state === "observed" ? 0 : 1;
}
