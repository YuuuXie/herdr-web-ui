import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type Machine, type SetupJob } from "../shared/machines.ts";
import { unmanagedUpdateStatus, type UpdateStatus } from "../shared/update.ts";
import { MachineManager } from "./machines.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { posixHost } from "./remote-host.ts";
import { SshConnection } from "./ssh.ts";
import { CompletionTracker } from "./completion.ts";
import type { PushService } from "./push.ts";

// A PC whose own Ovis (an independently managed web server, not a bridge this app started) is older
// than this app: a real HTTP stand-in of that server behind a fake SSH host. Nothing is installed,
// stopped or started on any PC, and no user's herdr or Ovis is touched.
const MACHINE_ID = "00000000-0000-4000-8000-000000000001";
const SOCKET = "/home/fixture/.config/herdr/herdr.sock";
const OFFERED = "f".repeat(40);
const OLD_TOKEN = "a".repeat(64), NEW_TOKEN = "b".repeat(64);
/** the port its bridge registered: a relayed one (#1960) differs from the port it answers on */
const REGISTERED_PORT = 29431, OWN_PORT = 7317;

interface Remote {
  /** its update status; null answers 401, as a server that wants its OVIS_TOKEN does */
  status: UpdateStatus | null;
  /** what its install route answers, one per request (the last repeats); 202 when unset */
  install?: { status: number; code?: string }[];
  /** what its status says before it was asked to install, one answer per read; then `status` */
  beforeInstall?: Partial<UpdateStatus>[];
  /** a route that answers with a redirect to `to` instead */
  redirect?: { path: string; to: string };
  /** the pid its new bridge registers with */
  replacementPid?: unknown;
  /** the bundle version its new bridge registers with; this app's when unset */
  replacementBundle?: string;
  access?: Record<string, unknown>;
  bundle?: string;
  /** what its status says once asked to install, one answer per read (the last repeats); it restarts on the new version after `restartAfter` reads, never without */
  afterInstall?: { statuses: Partial<UpdateStatus>[]; restartAfter?: number };
}
const managedOffer = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true,
  current_version: "0.4.16", latest_version: "0.4.18", current_revision: "c".repeat(40), latest_revision: OFFERED, revision_bound_install: true, ...patch });

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function pc(remote: Remote, options: { registered?: boolean; autoUpdate?: boolean; ownUpdate?: { pollMs?: number; startMs?: number; checkMs?: number } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-own-update-"));
  let descriptor = { pid: 4242, port: REGISTERED_PORT, token: OLD_TOKEN, socket_path: SOCKET, managed_remote: false, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: remote.bundle ?? "35" };
  const requests: string[] = [];
  const installs: unknown[] = [];
  const operations: string[] = [];
  let installed = false, readsSinceInstall = 0, readsBefore = 0, installAttempts = 0, restarted = false, listingsSinceRestart = 0;
  const probes: string[] = [];
  const listedAfterRestart = Promise.withResolvers<void>();
  const restart = () => { restarted = true; descriptor = { ...descriptor, pid: (remote.replacementPid ?? 4343) as number, token: NEW_TOKEN, bundle_version: remote.replacementBundle ?? REMOTE_BUNDLE_VERSION }; };
  const relays: ReturnType<typeof Bun.serve>[] = [];
  const real = { start: SshConnection.prototype.start, run: SshConnection.prototype.run, close: SshConnection.prototype.close, forward: SshConnection.prototype.forward, connected: SshConnection.prototype.connected };
  const bundle = spyOn(posixHost, "installBundle").mockImplementation(async () => { operations.push("install-bundle"); });
  cleanups.push(() => {
    Object.assign(SshConnection.prototype, real);
    bundle.mockRestore();
    for (const relay of relays) relay.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  SshConnection.prototype.start = async () => {};
  SshConnection.prototype.close = () => {};
  // the PC still answers: a failed update is that update's, not a PC gone off the network
  SshConnection.prototype.connected = () => true;
  SshConnection.prototype.run = async (script: string) => {
    if (script.includes("uname")) return `Linux\nx86_64\n/home/fixture\n/home/fixture/.config\n/usr/bin/herdr\nbundle-older\n${JSON.stringify(descriptor)}\n`;
    if (script.includes("socket=")) return SOCKET;
    if (script.includes("--version")) return "herdr 0.9.3";
    if (script.includes("kill -0")) { probes.push(script); return "live"; }
    if (script.includes('for f in "$HOME/.config/herdr-web-ui/bridges/"')) {
      if (restarted && ++listingsSinceRestart === 2) listedAfterRestart.resolve();
      return JSON.stringify(descriptor);
    }
    // a stop, a start or anything else that changes the PC is not this app's to do there
    operations.push(script);
    throw new Error(`Unexpected remote command: ${script}`);
  };
  SshConnection.prototype.forward = async (local: number, port: number) => {
    expect(port).toBe(REGISTERED_PORT);
    relays.push(Bun.serve({ hostname: "127.0.0.1", port: local, async fetch(request, server) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (request.headers.get("authorization") !== `Bearer ${descriptor.token}`) return new Response("unauthorized", { status: 401 });
      if (remote.redirect?.path === path) return new Response(null, { status: 307, headers: { location: remote.redirect.to } });
      if (path === "/api/access") return remote.access ? Response.json(remote.access) : new Response("not found", { status: 404 });
      if (path === "/api/updates" && request.method === "GET" && installed && remote.afterInstall) {
        const { statuses, restartAfter } = remote.afterInstall;
        const answer = { ...remote.status, ...statuses[Math.min(readsSinceInstall, statuses.length - 1)] };
        if (++readsSinceInstall === restartAfter) restart();
        return Response.json(answer);
      }
      if (path === "/api/updates" && request.method === "GET" && !installed && readsBefore < (remote.beforeInstall?.length ?? 0)) return Response.json({ ...remote.status, ...remote.beforeInstall![readsBefore++] });
      if (path === "/api/updates" && request.method === "GET") return remote.status ? Response.json(remote.status) : Response.json({ error: { code: "unauthorized", message: "token required" } }, { status: 401 });
      if (path === "/api/updates/install" && request.method === "POST") {
        expect(request.headers.get("x-herdr-update")).toBe("1");
        installs.push(await request.json());
        const answer = remote.install?.[Math.min(installAttempts++, remote.install.length - 1)] ?? { status: 202 };
        // busy: an install of its own runs there already
        if (answer.code === "update_busy" && remote.afterInstall) installed = true;
        if (answer.status !== 202) return Response.json({ error: { code: answer.code, message: "refused here" } }, { status: answer.status });
        installed = true;
        // its supervisor installs and restarts it: the new version registers a bridge of its own
        if (!remote.afterInstall) restart();
        return Response.json({ accepted: true }, { status: 202 });
      }
      if (path === "/api/bridge") return Response.json({ ...descriptor, socket_id: "fixture:1", herdr: { version: "0.9.3", protocol: 22 } });
      if (path === "/api/session") return Response.json({ snapshot: { panes: [], workspaces: [] } });
      if (path === "/ws" && server.upgrade(request, { data: undefined })) return;
      return new Response("not found", { status: 404 });
    }, websocket: { message() {} } }));
  };
  mkdirSync(dir, { recursive: true });
  if (options.autoUpdate === false) writeFileSync(join(dir, "machine-settings.json"), JSON.stringify({ auto_update_bridges: false }));
  if (options.registered !== false) writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id: MACHINE_ID, name: "Home server", target: { destination: "devswha@100.123.228.51" }, enabled: true }]));
  const manager = new MachineManager(dir, { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => { throw new Error("local offline"); }, options.ownUpdate ? { ownUpdate: options.ownUpdate } : {});
  cleanups.push(() => manager.stop());
  /** the PC once `done` holds for it, or a failure naming its last state; waits on the manager's own events */
  const until = (done: (machine: Machine) => boolean): Promise<Machine> => new Promise((resolve, reject) => {
    let last: Machine | undefined;
    const timer = setTimeout(() => { stop(); reject(new Error(`PC never reached the state: ${JSON.stringify(last)}`)); }, 5000);
    const stop = manager.subscribe((event) => {
      if (event.type !== "machines") return;
      last = event.machines.find((machine) => machine.id === MACHINE_ID);
      if (last && done(last)) { clearTimeout(timer); queueMicrotask(() => stop()); resolve(structuredClone(last)); }
    });
  });
  return { manager, requests, installs, operations, probes, listedAfterRestart: listedAfterRestart.promise, until };
}

describe("a PC whose own Ovis is older than this app", () => {
  it("updates itself through its own updater on reconnect, with automatic updates on, then connects", async () => {
    const { manager, installs, operations, until } = pc({ status: managedOffer(), access: { port: OWN_PORT, tailscale: { serving_url: null } } });
    const connected = await until((machine) => machine.state === "connected");
    // the exact release its own updater offered, asked for once; nothing of this app's ran on that PC
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
    expect(operations).toEqual([]);
    expect(connected.remote_ovis ?? null).toBeNull();
    expect(connected.action_required ?? null).toBeNull();
    expect(manager.endpoint(MACHINE_ID)?.token).toBe(NEW_TOKEN);
  });

  it("offers the update on the PC's card and waits when automatic updates are off", async () => {
    const { manager, installs, until } = pc({ status: managedOffer(), access: { port: OWN_PORT, tailscale: { serving_url: null } } }, { autoUpdate: false });
    const waiting = await until((machine) => machine.action_required === "update_bridge");
    expect(waiting.remote_ovis).toEqual({ version: "0.4.16", latest_version: "0.4.18", updatable: true, reason: null, address: `100.123.228.51:${OWN_PORT}`, url: null });
    expect(waiting.error).toContain("own Ovis v0.4.16");
    expect(installs).toEqual([]);
    const response = await handleMachineRequest(new Request(`http://localhost:7317/api/machines/${MACHINE_ID}/update-bridge`, {
      method: "POST", headers: { origin: "http://localhost:7317", "x-herdr-machine": "1" } }), manager);
    expect(response.status).toBeLessThan(300);
    await until((machine) => machine.state === "connected");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  it("follows an install that its own Settings already started instead of failing", async () => {
    const { installs, until } = pc({ status: managedOffer(), install: [{ status: 409, code: "update_busy" }],
      afterInstall: { statuses: [{ phase: "building", step: "build" }], restartAfter: 2 } }, { ownUpdate: { pollMs: 5 } });
    await until((machine) => machine.state === "connected");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  const checking = { phase: "checking" as const, available: false, latest_revision: null };
  for (const [when, beforeInstall] of [["when it is asked what it offers", [checking, checking, checking]], ["when the update starts", [{}, {}, checking, checking]]] as const) it(`waits out a check for releases running there ${when}, then asks for the install`, async () => {
    // the reconnect and the update job each ask what it offers before the job's own first read
    const { installs, until } = pc({ status: managedOffer(), beforeInstall: [...beforeInstall] }, { ownUpdate: { pollMs: 5 } });
    await until((machine) => machine.state === "connected");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  it("tries again on its own, not waiting for a tap, when a check for releases there outlasts its wait", async () => {
    const { installs, until } = pc({ status: managedOffer(), beforeInstall: Array.from({ length: 10_000 }, () => checking) }, { ownUpdate: { pollMs: 5, checkMs: 20 } });
    const waiting = await until((machine) => machine.state === "reconnecting" && /still checking for updates/.test(machine.error ?? ""));
    expect(waiting.action_required ?? null).toBeNull();
    expect(installs).toEqual([]);
  });

  it("asks again when a check that started since it read the status made it answer busy", async () => {
    const { installs, until } = pc({ status: managedOffer(), install: [{ status: 409, code: "update_busy" }, { status: 202 }] }, { ownUpdate: { pollMs: 5 } });
    await until((machine) => machine.state === "connected");
    expect(installs).toEqual([{ expected_revision: OFFERED }, { expected_revision: OFFERED }]);
  });

  for (const path of ["/api/updates", "/api/updates/install"]) it(`never follows a redirect from ${path} out of the tunnel`, async () => {
    // a server on this PC's own loopback that a followed redirect would reach
    const hits: string[] = [];
    const canary = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { hits.push(`${request.method} ${new URL(request.url).pathname}`); return Response.json({ accepted: true }, { status: 202 }); } });
    cleanups.push(() => canary.stop(true));
    const { until } = pc({ status: managedOffer(), redirect: { path, to: `http://127.0.0.1:${canary.port}/api/herdr/update` } }, { ownUpdate: { pollMs: 5 } });
    const stopped = await until((machine) => !machine.updating && /\(307\)/.test(machine.error ?? ""));
    expect(stopped.state).toBe("error");
    expect(hits).toEqual([]);
  });

  it("tells an update that ended on another version as a setup, with no update on offer beside it", async () => {
    const { installs, until } = pc({ status: managedOffer(), replacementBundle: "36" }, { ownUpdate: { pollMs: 5 } });
    const waiting = await until((machine) => machine.action_required === "setup" && !machine.updating);
    expect(waiting.error).toContain("still differs from this app's (v36");
    expect(waiting.remote_ovis ?? null).toBeNull();
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  it("takes only a process id from its new bridge's descriptor into a command on that PC", async () => {
    const { probes, listedAfterRestart } = pc({ status: managedOffer(), replacementPid: "1; kill -TERM 4242; #",
      afterInstall: { statuses: [{ phase: "building", step: "build" }], restartAfter: 1 } }, { ownUpdate: { pollMs: 5 } });
    await listedAfterRestart;
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((script) => /^kill -0 \d+ /.test(script))).toBe(true);
  });

  it("waits out an earlier failure its status still shows right after it was asked, then connects", async () => {
    const earlier = { phase: "error" as const, error: "bun run build failed (exit 1)" };
    const { installs, until } = pc({ status: managedOffer(earlier),
      afterInstall: { statuses: [earlier, earlier, { phase: "building", step: "build", error: null }], restartAfter: 4 } }, { ownUpdate: { pollMs: 5 } });
    await until((machine) => machine.state === "connected");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  const failures: [string, Remote["status"], Partial<UpdateStatus>[], RegExp][] = [
    ["once its install ran", managedOffer(), [{ phase: "building", step: "dependencies" }, { phase: "error", error: "bun install failed (exit 1)" }], /could not update itself: bun install failed/],
    ["in other words than the earlier one, before it was seen running", managedOffer({ phase: "error", error: "an earlier failure" }), [{ phase: "error", error: "git fetch failed" }], /could not update itself: git fetch failed/],
  ];
  for (const [name, status, statuses, reason] of failures) it(`fails with that PC's words when it reports an error ${name}`, async () => {
    const { installs, until } = pc({ status, afterInstall: { statuses } }, { ownUpdate: { pollMs: 5 } });
    const failed = await until((machine) => machine.state === "error" && !machine.updating && reason.test(machine.error ?? ""));
    expect(failed.action_required).toBe("update_bridge");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  it("fails with the reason when the install it asked for never starts", async () => {
    const { installs, until } = pc({ status: managedOffer(), afterInstall: { statuses: [{ phase: "idle" }] } }, { ownUpdate: { pollMs: 5, startMs: 50 } });
    const failed = await until((machine) => machine.state === "error" && !machine.updating && /did not start its update/.test(machine.error ?? ""));
    expect(failed.error).toContain("Settings → Updates");
    expect(installs).toEqual([{ expected_revision: OFFERED }]);
  });

  const refusals: [string, Remote, RegExp][] = [
    ["not started by its updater", { status: { ...unmanagedUpdateStatus() } }, /does not update itself: Start with bun run start/],
    ["blocked there", { status: managedOffer({ blocked_reason: "The source checkout changed. Restart the app before updating." }) }, /cannot update itself now: The source checkout changed/],
    ["asks for its own token", { status: null }, /OVIS_TOKEN/],
    ["too old to install a named revision", { status: managedOffer({ revision_bound_install: undefined }) }, /too old to take an update/],
    ["without a newer release on offer", { status: managedOffer({ available: false, latest_revision: null }) }, /no newer release on offer than v0\.4\.16/],
  ];
  for (const [name, remote, reason] of refusals) it(`says why it cannot be updated from here when it is ${name}`, async () => {
    const { installs, operations, until } = pc({ ...remote, access: { port: OWN_PORT, tailscale: { serving_url: "https://home-server.example.ts.net" } } });
    const waiting = await until((machine) => machine.action_required === "setup");
    expect(waiting.state).toBe("error");
    expect(waiting.error).toContain("independently managed web server");
    expect(waiting.error).toMatch(reason);
    expect(waiting.remote_ovis).toMatchObject({ updatable: false, address: `100.123.228.51:${OWN_PORT}`, url: "https://home-server.example.ts.net" });
    expect(waiting.remote_ovis?.reason).toMatch(reason);
    expect(installs).toEqual([]);
    expect(operations).toEqual([]);
  });

  it("keeps a newer one's message, asks it nothing about its updates and links no address it did not give", async () => {
    const { requests, until } = pc({ status: managedOffer(), bundle: String(Number(REMOTE_BUNDLE_VERSION) + 1) });
    const waiting = await until((machine) => machine.action_required === "setup");
    expect(waiting.error).toContain("of a newer version");
    expect(waiting.error).toContain("Update this app in Settings");
    expect(waiting.remote_ovis ?? null).toBeNull();
    expect(requests.filter((request) => request.includes("/api/updates"))).toEqual([]);
  });

  it("links only an https address the PC names, and its own port over the registered one", async () => {
    const { until } = pc({ status: { ...unmanagedUpdateStatus() }, access: { port: OWN_PORT, tailscale: { serving_url: "http://plain.example" } } });
    const waiting = await until((machine) => machine.action_required === "setup");
    expect(waiting.remote_ovis).toMatchObject({ address: `100.123.228.51:${OWN_PORT}`, url: null });
  });

  it("tells a first connect the same, on the job the dialog reads", async () => {
    const { manager, installs } = pc({ status: managedOffer() }, { registered: false });
    const job = manager.setup({ destination: "devswha@100.123.228.51" });
    await (manager as unknown as { jobs: Map<string, { finished: Promise<void> }> }).jobs.get(job.id)?.finished;
    const failed = manager.job(job.id) as SetupJob;
    expect(failed).toMatchObject({ phase: "failed", action_required: "update_bridge", remote_ovis: { updatable: true, latest_version: "0.4.18", address: `100.123.228.51:${REGISTERED_PORT}` } });
    expect(installs).toEqual([]);
  });
});
