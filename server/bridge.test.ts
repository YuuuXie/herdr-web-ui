import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { descriptorLive, registerBridge, type BridgeDescriptor } from "./bridge.ts";
import { guardLibrary, guardPath } from "./owner-guard.ts";
import { readProcessBirth } from "./process-owner.ts";

let root = "", path = "";
const others: Bun.Subprocess<"pipe", "ignore", "ignore">[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridge-registry-"));
  path = join(root, "bridges", "socket.json");
  mkdirSync(join(root, "bridges"));
});
afterEach(async () => {
  for (const other of others.splice(0)) { other.stdin.end(); await other.exited; }
  rmSync(root, { recursive: true, force: true });
});

/** A live process other than this one, blocked on its stdin until the test ends. */
function other() {
  const child = Bun.spawn([process.execPath, "-e", "for await (const _ of console) break;"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", windowsHide: true });
  others.push(child);
  return child;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function descriptor(fields: Partial<BridgeDescriptor> & { pid: number }): string {
  return JSON.stringify({ port: 1, token: "old-bridge-secret", socket_path: "/old.sock", bridge_protocol: 1, bundle_version: "old", ...fields });
}
const read = () => JSON.parse(readFileSync(path, "utf8")) as BridgeDescriptor;

describe("bridge registration", () => {
  it("registers its PID with a birth and a generation", () => {
    const registration = registerBridge(4242, "new-token", { path });
    const registered = read();
    expect(registered).toMatchObject({ port: 4242, token: "new-token", pid: process.pid, birth: { platform: process.platform } });
    expect(registered.generation).toBeString();
    expect(descriptorLive(registered)).toBe(true);
    registration.close();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(guardPath(path))).toBe(true);
  });

  it("replaces a descriptor whose PID another process now holds", () => {
    // regression (fails on main, which took any live PID for the bridge): a reused PID
    const reused = other();
    writeFileSync(path, descriptor({ pid: reused.pid, generation: "crashed", birth: { platform: process.platform, value: "an earlier process" } }));
    registerBridge(4242, "new-token", { path });
    expect(read()).toMatchObject({ port: 4242, pid: process.pid });
    expect(alive(reused.pid)).toBe(true);
  });

  it("keeps a live bridge's descriptor, and an older version's whose PID runs", () => {
    const bridge = other();
    const reading = readProcessBirth(bridge.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${bridge.pid}`);
    for (const text of [descriptor({ pid: bridge.pid, generation: "live", birth: reading.birth }), descriptor({ pid: bridge.pid })]) {
      writeFileSync(path, text);
      const registration = registerBridge(4242, "new-token", { path });
      expect(readFileSync(path, "utf8")).toBe(text);
      registration.close();
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });

  it("refuses a descriptor that changed after it was sampled", () => {
    const reused = other(), bridge = other();
    const reading = readProcessBirth(bridge.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${bridge.pid}`);
    // the replacement may itself look stale: a changed sample is never replaced
    for (const replacement of [descriptor({ pid: bridge.pid, generation: "won", birth: reading.birth }), descriptor({ pid: reused.pid, generation: "other", birth: { platform: process.platform, value: "x" } })]) {
      writeFileSync(path, descriptor({ pid: reused.pid, generation: "crashed", birth: { platform: process.platform, value: "an earlier process" } }));
      const registration = registerBridge(4242, "new-token", { path, sampled() { writeFileSync(path, replacement); } });
      expect(readFileSync(path, "utf8")).toBe(replacement);
      registration.close();
      expect(readFileSync(path, "utf8")).toBe(replacement);
    }
    expect(readdirSync(join(root, "bridges")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not remove another generation's descriptor on close", () => {
    const registration = registerBridge(4242, "new-token", { path });
    const later = JSON.stringify({ ...read(), generation: "a later registration" });
    writeFileSync(path, later);
    registration.close();
    expect(readFileSync(path, "utf8")).toBe(later);
  });

  it("fails closed when the guard is unavailable", () => {
    const reused = other();
    const stale = descriptor({ pid: reused.pid, generation: "crashed", birth: { platform: process.platform, value: "an earlier process" } });
    writeFileSync(path, stale);
    const original = guardLibrary.path;
    const logged = spyOn(console, "error").mockImplementation(() => {});
    guardLibrary.path = join(root, "missing-libc.so.6");
    let message = "";
    try {
      const registration = registerBridge(4242, "new-token", { path });
      registration.close();
      message = String(logged.mock.calls[0]?.[0]);
    } finally {
      guardLibrary.path = original;
      logged.mockRestore();
    }
    expect(readFileSync(path, "utf8")).toBe(stale);
    expect(message).toStartWith(`This bridge was not registered (descriptor ${path}): the file lock could not be loaded`);
    expect(message).not.toContain("old-bridge-secret");
    expect(message).not.toContain("new-token");
  });
});
