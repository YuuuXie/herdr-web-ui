import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { join as winJoin } from "node:path/win32";
import { guardPath } from "./owner-guard.ts";
import { readProcessBirth } from "./process-owner.ts";

const entryLines = readFileSync(new URL("./remote-entry.ts", import.meta.url), "utf8").split("\n");
const herdrConfigLine = entryLines.find((line) => line.startsWith("const herdrConfig ="));
const sessionLine = entryLines.find((line) => line.startsWith('const session = process.env["HERDR_REMOTE_SESSION"]'));
const socketLine = entryLines.find((line) => line.startsWith('process.env["HERDR_SOCKET"] ='));
if (!herdrConfigLine || !sessionLine || !socketLine) throw new Error("remote-entry socket setup was not found");

function windowsSocket(env: Record<string, string | undefined>): string {
  const evaluateSocket = new Function(
    "windows",
    "process",
    "join",
    "homedir",
    `${herdrConfigLine}\n${sessionLine}\n${socketLine}\nreturn process.env["HERDR_SOCKET"];`,
  );
  return String(evaluateSocket(true, { env }, winJoin, () => "C:\\Users\\u"));
}

describe("remote entry socket selection", () => {
  it("uses XDG_CONFIG_HOME before APPDATA on Windows", () => {
    // regression (fails on main): a set XDG_CONFIG_HOME owns herdr's Windows socket root
    expect(windowsSocket({ XDG_CONFIG_HOME: "C:\\Temp\\xdg", APPDATA: "C:\\Users\\u\\AppData\\Roaming", HERDR_REMOTE_SESSION: "qa" }))
      .toBe("C:\\Temp\\xdg\\herdr\\sessions\\qa\\herdr.sock");
  });

  it("uses APPDATA when Windows XDG_CONFIG_HOME is absent", () => {
    // control: APPDATA stays the Windows fallback
    expect(windowsSocket({ APPDATA: "C:\\Users\\u\\AppData\\Roaming", HERDR_REMOTE_SESSION: "qa" }))
      .toBe("C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\qa\\herdr.sock");
  });

  it("uses the roaming profile when both Windows config variables are absent", () => {
    // control: preserve the standard Windows profile fallback
    expect(windowsSocket({ HERDR_REMOTE_SESSION: "qa" }))
      .toBe("C:\\Users\\u\\AppData\\Roaming\\herdr\\sessions\\qa\\herdr.sock");
  });
});

/**
 * The real entry under a temporary home: herdr's socket is missing and its binary is a path that
 * does not exist, so a start that gets past the startup lock ends at "start herdr", touching no herdr.
 */
describe("remote entry startup lock", () => {
  let home = "", descriptor = "", lock = "";
  const others: Bun.Subprocess<"pipe", "ignore", "ignore">[] = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "remote-entry-"));
    const socket = resolve(join(home, "config", "herdr", "herdr.sock"));
    descriptor = join(home, ".config/herdr-web-ui/bridges", createHash("sha256").update(socket).digest("hex") + ".json");
    lock = descriptor + ".lock";
    mkdirSync(join(home, ".config/herdr-web-ui/bridges"), { recursive: true });
  });
  afterEach(async () => {
    for (const other of others.splice(0)) { other.stdin.end(); await other.exited; }
    rmSync(home, { recursive: true, force: true });
  });
  function other() {
    const child = Bun.spawn([process.execPath, "-e", "for await (const _ of console) break;"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", windowsHide: true });
    others.push(child);
    return child;
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  function ownerLock(pid: number, birth: { platform: string; value: string }) {
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(pid));
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid, generation: "earlier-start", birth }));
  }
  async function start(preload?: string) {
    const entry = join(import.meta.dir, "remote-entry.ts");
    const proc = Bun.spawn([process.execPath, ...(preload ? ["--preload", preload] : []), entry], {
      cwd: home, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"), HERDR_WEB_HERDR_BIN: join(home, "missing-herdr"), HERDR_REMOTE_SESSION: "", HERDR_SOCKET: "" },
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, output: out + err };
  }

  it("reclaims a startup lock whose PID another process now holds", async () => {
    // regression (fails on main, which waited for any live PID): a reused PID is not a starter
    const reused = other();
    ownerLock(reused.pid, { platform: process.platform, value: "an earlier process" });
    const run = await start();
    expect(run.output).not.toContain("Another bridge is starting");
    expect(run.output).toContain(join(home, "missing-herdr"));
    expect(run.code).not.toBe(0);
    // its own lock went with it; the guard stays for the next starter
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(guardPath(lock))).toBe(true);
    expect(alive(reused.pid)).toBe(true);
  }, 60_000);

  it("waits for a live starter", async () => {
    const starter = other();
    const reading = readProcessBirth(starter.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${starter.pid}`);
    ownerLock(starter.pid, reading.birth);
    const owner = readFileSync(join(lock, "owner.json"), "utf8");
    const run = await start();
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`Another bridge is starting; retry shortly (lock ${lock}, owner pid ${starter.pid} generation earlier-start)`);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(owner);
  }, 60_000);

  it("fails closed when the guard is unavailable", async () => {
    const reused = other();
    ownerLock(reused.pid, { platform: process.platform, value: "an earlier process" });
    const owner = readFileSync(join(lock, "owner.json"), "utf8");
    const preload = join(home, "no-guard.ts");
    writeFileSync(preload, `import { guardLibrary } from ${JSON.stringify(join(import.meta.dir, "owner-guard.ts"))};\nguardLibrary.path = ${JSON.stringify(join(home, "missing-libc.so.6"))};\n`);
    const run = await start(preload);
    expect(run.code).not.toBe(0);
    expect(run.output).toContain(`Another bridge is starting; retry shortly (lock ${lock}, owner pid ${reused.pid} generation earlier-start; the file lock could not be loaded`);
    expect(run.output).not.toContain(join(home, "missing-herdr"));
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(owner);
    expect(alive(reused.pid)).toBe(true);
  }, 60_000);

  it("starts over a registered bridge whose PID another process now holds, and leaves a live one", async () => {
    const reused = other(), bridge = other();
    const reading = readProcessBirth(bridge.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${bridge.pid}`);
    const registered = (pid: number, birth: { platform: string; value: string }) =>
      writeFileSync(descriptor, JSON.stringify({ port: 1, token: "registered-secret", pid, generation: "g", birth, socket_path: "s", bridge_protocol: 1, bundle_version: "v" }));
    registered(reused.pid, { platform: process.platform, value: "an earlier process" });
    expect((await start()).output).toContain(join(home, "missing-herdr"));
    // control: a live bridge is left serving, and no herdr is started for it
    registered(bridge.pid, reading.birth);
    const run = await start();
    expect(run.code).toBe(0);
    expect(run.output).not.toContain(join(home, "missing-herdr"));
    expect(existsSync(lock)).toBe(false);
  }, 60_000);
});
