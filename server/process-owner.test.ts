import { afterEach, describe, expect, it } from "bun:test";
import { linuxStartTicks, newOwnerRecord, ownerGone, parseLstart, parseOwnerRecord, readProcessBirth } from "./process-owner.ts";

// a process that is not the owner: alive and blocked on its stdin until the test closes it
const children: Bun.Subprocess<"pipe", "ignore", "ignore">[] = [];
function unrelated() {
  const child = Bun.spawn([process.execPath, "-e", "for await (const _ of console) break;"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child;
}
afterEach(async () => {
  for (const child of children.splice(0)) { child.stdin.end(); await child.exited; }
});

describe("process birth", () => {
  it("reads Linux start ticks after the last parenthesis, whatever the command name holds", () => {
    const fields = ["S", ...Array.from({ length: 18 }, (_, i) => String(i + 1)), "123456", "0", "0"].join(" ");
    expect(linuxStartTicks(`42 (bun) ${fields}`)).toBe("123456");
    expect(linuxStartTicks(`42 (a) b) (c) ${fields}`)).toBe("123456");
    expect(linuxStartTicks("42 (bun) S 1 2")).toBeNull();
    expect(linuxStartTicks("garbage")).toBeNull();
  });

  it("reads ps's start time only in its C-locale form", () => {
    expect(parseLstart("Wed Oct 21 17:41:40 2026\n")).toBe("Wed Oct 21 17:41:40 2026");
    expect(parseLstart("Thu Oct  1 07:01:02 2026")).toBe("Thu Oct 1 07:01:02 2026");
    expect(parseLstart("")).toBeNull();
    expect(parseLstart("21 oct. 2026 17:41:40")).toBeNull();
  });

  it("identifies a running process by the same birth on every read", () => {
    const child = unrelated();
    const first = readProcessBirth(child.pid);
    expect(first.state).toBe("identified");
    // births are compared only for one PID: on macOS they count whole seconds, so two PIDs may share one
    expect(readProcessBirth(child.pid)).toEqual(first);
  });

  it("proves a free PID absent", () => {
    expect(readProcessBirth(2147483647)).toEqual({ state: "absent" });
    expect(ownerGone({ pid: 2147483647, birth: { platform: process.platform, value: "x" } })).toBe(true);
  });
});

describe("owner records", () => {
  it("records a fresh generation for every acquisition", () => {
    const first = newOwnerRecord(), second = newOwnerRecord();
    expect(first.pid).toBe(process.pid);
    expect(first.generation).not.toBe(second.generation);
    expect(first.birth).toEqual(second.birth!);
    expect(first.birth?.platform).toBe(process.platform);
  });

  it("parses only well-formed records", () => {
    expect(parseOwnerRecord(JSON.stringify({ pid: 7, generation: "g", birth: { platform: "linux", value: "b:1" } }))).toEqual({ pid: 7, generation: "g", birth: { platform: "linux", value: "b:1" } });
    expect(parseOwnerRecord(JSON.stringify({ pid: 7, generation: "g" }))).toEqual({ pid: 7, generation: "g" });
    for (const text of ["", "{", "null", "7", JSON.stringify({ pid: -1, generation: "g" }), JSON.stringify({ pid: 7 }), JSON.stringify({ pid: 7, generation: "g", birth: "b" }), JSON.stringify({ pid: 7, generation: "g", birth: { platform: "linux" } })]) {
      expect(parseOwnerRecord(text)).toBeNull();
    }
  });

  it("keeps an owner whose birth matches", () => {
    expect(ownerGone(newOwnerRecord())).toBe(false);
  });

  it("proves an owner gone when another process now holds its PID", () => {
    // regression (fails on main, which trusted any live PID): a reused PID is not the owner
    const child = unrelated();
    expect(ownerGone({ pid: child.pid, birth: { platform: process.platform, value: "an earlier process" } })).toBe(true);
    expect(() => process.kill(child.pid, 0)).not.toThrow();
  });

  it("keeps legacy, foreign-platform and unreadable owners live", () => {
    const child = unrelated();
    // control: a PID-only record from an older version cannot be proved gone while its PID runs
    expect(ownerGone({ pid: child.pid })).toBe(false);
    // a birth recorded on another platform cannot be compared: unknown
    expect(ownerGone({ pid: child.pid, birth: { platform: "plan9", value: "x" } })).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps an owner whose probe is refused (EPERM)", () => {
    // pid 1 belongs to root: signal 0 is refused, which never proves it gone
    expect(ownerGone({ pid: 1, birth: { platform: process.platform, value: "not init's birth" } })).toBe(false);
  });
});
