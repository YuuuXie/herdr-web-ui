import { describe, expect, it, spyOn } from "bun:test";
import { createDarwinStartReader, parseElapsed, processStartedAt, processStartedAtAsync, processStartLowerBound, processStartUpperBound, processStartUpperBoundAsync } from "./process-start.ts";

describe("bounded macOS process start reads", () => {
  it("returns unknown when the bounded spawn times out even with partial output", () => {
    // Given a probe that reached its timeout after writing valid elapsed time.
    const probes: { argv: string[]; timeout: number; killSignal: string }[] = [];
    const read = createDarwinStartReader((argv, options) => {
      probes.push({ argv, timeout: options.timeout, killSignal: options.killSignal });
      return { exitCode: 0, stdout: "00:05", exitedDueToTimeout: true };
    });
    // When the process start is requested, then timeout output grants no identity.
    expect(read(42)).toBeNull();
    expect(probes).toEqual([{ argv: ["/bin/ps", "-o", "etime=", "-p", "42"], timeout: 1000, killSignal: "SIGKILL" }]);
  });

  it.each([1, 0])("returns unknown for failed or unreadable output with exit code %i", (exitCode) => {
    // Given a failed exit with valid output, or a successful exit with unreadable output.
    const read = createDarwinStartReader(() => ({ exitCode, stdout: exitCode === 0 ? "" : "00:05" }));
    // When read, then neither case grants a process identity.
    expect(read(42)).toBeNull();
  });

  it("returns unknown when spawning throws", () => {
    // Given an unavailable subprocess.
    const read = createDarwinStartReader(() => { throw new TypeError("spawn unavailable"); });
    // When read, then the existing failed-read result is preserved.
    expect(read(42)).toBeNull();
  });

  it("preserves the before and after clocks for the lower bound and start estimate", () => {
    // Given a probe that takes 20 ms.
    let now = 10_000;
    const read = createDarwinStartReader(() => {
      now += 20;
      return { exitCode: 0, stdout: "00:05" };
    }, () => now);
    // When read, then its lower bound uses the earlier clock, not the later estimate.
    expect(read(42)).toEqual({ started: 5020, lower: 4000 });
  });
});

describe("process start read without holding the event loop", () => {
  it("reads macOS's start from ps run as an awaited child, never a synchronous one", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const blocking = spyOn(Bun, "spawnSync");
    const probes: { argv: string[]; timeout?: number; killSignal?: string }[] = [];
    const awaited = spyOn(Bun, "spawn").mockImplementation(((argv: string[], options?: { timeout?: number; killSignal?: string }) => {
      probes.push({ argv, timeout: options?.timeout, killSignal: options?.killSignal });
      return { stdout: new Response("   00:05\n").body, exited: Promise.resolve(0), signalCode: null, kill: () => {} };
    }) as unknown as typeof Bun.spawn);
    try {
      const before = Date.now();
      const started = await processStartedAtAsync(42);
      expect(started).toBeGreaterThanOrEqual(before - 5000);
      expect(started).toBeLessThanOrEqual(Date.now() - 5000);
      expect(probes).toEqual([{ argv: ["/bin/ps", "-o", "etime=", "-p", "42"], timeout: 1000, killSignal: "SIGKILL" }]);
      expect(blocking).not.toHaveBeenCalled();
    } finally {
      awaited.mockRestore();
      blocking.mockRestore();
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("counts a macOS birth from when ps started, so a late answer does not move it", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    // the clock moves 900 ms while ps runs and the event loop is busy before its answer is taken
    let now = 100_000;
    const clock = spyOn(Date, "now").mockImplementation(() => now);
    const awaited = spyOn(Bun, "spawn").mockImplementation((() => {
      now += 900;
      return { stdout: new Response("00:10\n").body, exited: Promise.resolve(0), signalCode: null, kill: () => {} };
    }) as unknown as typeof Bun.spawn);
    try {
      expect(await processStartedAtAsync(42)).toBe(100_000 - 10_000);
      // the bound from above stays one: counted from after the answer
      expect(await processStartUpperBoundAsync(42)).toBe(now - 10_000 + 1000);
    } finally {
      awaited.mockRestore();
      clock.mockRestore();
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("says nothing for a macOS ps that was killed at its deadline", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const awaited = spyOn(Bun, "spawn").mockImplementation((() => ({ stdout: new Response("00:05\n").body, exited: Promise.resolve(0), signalCode: "SIGKILL", kill: () => {} })) as unknown as typeof Bun.spawn);
    try {
      expect(await processStartedAtAsync(42)).toBeNull();
    } finally {
      awaited.mockRestore();
      Object.defineProperty(process, "platform", platform);
    }
  });

  it.skipIf(process.platform !== "linux")("reads Linux's start as the same identity the synchronous read gives", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      expect(await processStartedAtAsync(child.pid)).toBe(processStartedAt(child.pid));
      expect(await processStartedAtAsync(2147483647)).toBeNull();
    } finally { child.kill(); }
  });
});

describe("process start time", () => {
  it("reads every form of ps's elapsed time", () => {
    expect(parseElapsed("   00:07\n")).toBe(7);
    expect(parseElapsed("12:34")).toBe(12 * 60 + 34);
    expect(parseElapsed("01:02:03")).toBe(3723);
    expect(parseElapsed("2-01:02:03")).toBe(2 * 86400 + 3723);
    expect(parseElapsed("")).toBeNull();
  });

  it("tells when a running process started, to the second", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const started = processStartedAt(child.pid);
      expect(started).not.toBeNull();
      expect(Math.abs(started! - Date.now())).toBeLessThan(2500);
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux")("bounds a new Linux process closely enough to identify its first thread", async () => {
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const upper = processStartUpperBound(child.pid);
      expect(upper).not.toBeNull();
      expect(upper!).toBeGreaterThanOrEqual(before);
      expect(upper!).toBeLessThanOrEqual(Date.now() + 25);
      expect(processStartUpperBound(2147483647)).toBeNull();
      // the async form a send's process check awaits is the same bound from above, never the one from below
      const awaited = await processStartUpperBoundAsync(child.pid);
      expect(awaited).not.toBeNull();
      expect(awaited!).toBeGreaterThanOrEqual(before);
      expect(awaited!).toBeLessThanOrEqual(Date.now() + 25);
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("bounds a process's start from below, closely enough to take in a thread made as it starts", async () => {
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    const spawned = Date.now();
    try {
      const lower = processStartLowerBound(child.pid);
      expect(lower).not.toBeNull();
      // never after the process started (it started by the time spawn returned) ...
      expect(lower!).toBeLessThanOrEqual(spawned);
      // ... and close: on Linux within btime's whole second and a tick, on macOS the second `ps` counts
      // and the one it may round away
      expect(lower!).toBeGreaterThanOrEqual(before - (process.platform === "linux" ? 1030 : 2100));
      expect(processStartLowerBound(2147483647)).toBeNull();
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux")("keeps a Linux start the same on every read: it is the process's identity", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const reads = new Set(Array.from({ length: 20 }, () => processStartedAt(child.pid)));
      expect(reads.size).toBe(1);
      expect([...reads][0]).not.toBeNull();
    } finally { child.kill(); }
  });

  it.skipIf(process.platform !== "linux")("bounds a Linux start below both readings: btime's and the uptime's", async () => {
    // btime is whole seconds: processStartedAt may be up to a second early, the bound below it still
    const before = Date.now();
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    const spawned = Date.now();
    try {
      const started = processStartedAt(child.pid)!;
      const lower = processStartLowerBound(child.pid)!;
      expect(lower).toBeLessThanOrEqual(started - 10);
      expect(lower).toBeLessThanOrEqual(spawned);
      expect(lower).toBeGreaterThanOrEqual(before - 1030);
    } finally { child.kill(); }
  });
});
