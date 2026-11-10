import "../server/adopt-legacy-env.ts";
import { createServer } from "node:net";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type BridgeIdentity, type SshTarget } from "../shared/machines.ts";
import type { BridgeDescriptor } from "../server/bridge.ts";
import { shellQuote, validateTarget } from "../server/machine-security.ts";
import { posixHost, REMOTE_PATH, type HostInspection } from "../server/remote-host.ts";
import { SshConnection } from "../server/ssh.ts";

interface Saved {
  platform: string; socket: string; socket_id: string; runtime: string; pointer: string;
  pid: number; birth: string; bundle_version: string; herdr: string; panes: string[];
}
interface Machine { id: string; target: SshTarget; saved?: Saved }
interface Proof { pid: number; executable: string; birth: string; argv: string[]; uid: number; owner: number; session: string }

export function checkedIdentity(value: unknown, descriptor: BridgeDescriptor, socket: string): BridgeIdentity {
  if (value === null || typeof value !== "object") throw new Error("Missing bridge identity");
  const identity = value as Partial<BridgeIdentity>;
  if (identity.managed_remote !== true || identity.pid !== descriptor.pid
    || identity.socket_path !== socket || typeof identity.socket_id !== "string" || !identity.socket_id
    || identity.bridge_protocol !== BRIDGE_PROTOCOL || typeof identity.bundle_version !== "string"
    || !Number.isInteger(identity.herdr?.protocol) || identity.herdr!.protocol < 22) {
    throw new Error("Bridge ownership/socket identity could not be verified; nothing was stopped");
  }
  return identity as BridgeIdentity;
}

export function paneIds(value: unknown): string[] {
  if (value !== null && typeof value === "object" && "snapshot" in value) value = value.snapshot;
  if (value === null || typeof value !== "object" || !("panes" in value) || !Array.isArray(value.panes)) {
    throw new Error("The bridge did not return a session snapshot");
  }
  return value.panes.map((pane: unknown) => {
    if (pane === null || typeof pane !== "object" || !("pane_id" in pane) || typeof pane.pane_id !== "string") {
      throw new Error("Invalid pane identity in bridge snapshot");
    }
    return pane.pane_id;
  });
}

export function requirePreserved(before: string[], after: string[]): void {
  const current = new Set(after);
  if (before.some((id) => !current.has(id))) throw new Error("A pre-existing pane disappeared during bridge deployment");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not reserve a loopback port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function endpoint(ssh: SshConnection, descriptor: BridgeDescriptor, inspection: HostInspection) {
  if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1
    || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535
    || !/^[a-f0-9]{64}$/.test(descriptor.token)) throw new Error("Invalid registered bridge credentials");
  const port = await freePort();
  await ssh.forward(port, descriptor.port);
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { authorization: `Bearer ${descriptor.token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Verified bridge request failed (${response.status})`);
    return response.json();
  };
  const identity = checkedIdentity(await get("/api/bridge"), descriptor, inspection.expectedSocket);
  return { identity, get };
}

function immutableRuntime(home: string, runtime: string): boolean {
  const base = `${home}/.local/share/herdr-web-ui/`;
  return runtime.startsWith(base) && /^remote-v[0-9]+-[a-f0-9]{16}$/.test(runtime.slice(base.length));
}

async function proof(ssh: SshConnection, bun: string, pid: number): Promise<Proof> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid bridge PID");
  const code = `const f=require("node:fs"),p="/proc/"+process.argv[1];const s=f.readFileSync(p+"/stat","utf8");console.log(JSON.stringify({pid:Number(process.argv[1]),executable:f.readlinkSync(p+"/exe"),birth:s.slice(s.lastIndexOf(")")+2).split(" ")[19],argv:f.readFileSync(p+"/cmdline","utf8").split("\\0").filter(Boolean),uid:f.statSync(p).uid,owner:process.getuid(),session:(f.readFileSync(p+"/environ","utf8").split("\\0").find(x=>x.startsWith("HERDR_REMOTE_SESSION="))||"HERDR_REMOTE_SESSION=").slice(21)}))`;
  return JSON.parse(await ssh.run(`${shellQuote(bun)} -e ${shellQuote(code)} ${pid}`)) as Proof;
}

export function ownedProcess(actual: Proof, saved: Saved, candidate: string, session: string): boolean {
  if (actual.uid !== actual.owner || !/^\d+$/.test(actual.birth)) return false;
  if (actual.pid === saved.pid && actual.executable === `${saved.runtime}/bin/bun` && actual.birth === saved.birth) return true;
  return actual.executable === `${candidate}/bin/bun`
    && actual.argv[1] === `${candidate}/server/remote-entry.ts`
    && actual.session === session && BigInt(actual.birth) > BigInt(saved.birth);
}

export async function recoverableDescriptor(ssh: Pick<SshConnection, "run">, descriptor: BridgeDescriptor | undefined) {
  if (!descriptor) return undefined;
  if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1) throw new Error("Invalid registered bridge PID");
  const present = await ssh.run(`if test -d /proc/${descriptor.pid}; then printf present; fi`);
  return present === "present" ? descriptor : undefined;
}

async function pointer(ssh: SshConnection, inspection: HostInspection, runtime: string, bun: string) {
  const path = inspection.runtimeDir;
  if (runtime) {
    await ssh.run(`set -eu; test -x ${shellQuote(runtime + "/bin/bun")}; tmp=${shellQuote(path + ".personal-" + process.pid)}; ln -s ${shellQuote(runtime)} "$tmp"; ${shellQuote(bun)} -e 'require("node:fs").renameSync(process.argv[1],process.argv[2])' "$tmp" ${shellQuote(path)}`);
  } else {
    await ssh.run(`if test -L ${shellQuote(path)}; then ${shellQuote(bun)} -e 'require("node:fs").unlinkSync(process.argv[1])' ${shellQuote(path)}; else test ! -e ${shellQuote(path)}; fi`);
  }
}

async function start(ssh: SshConnection, runtime: string, herdr: string, session: string | undefined) {
  // Unlike upstream's version alias, the immutable path also works during cross-version recovery.
  await ssh.run(REMOTE_PATH + `umask 077; mkdir -p "$HOME/.config/herdr-web-ui/bridges"; HERDR_REMOTE_SESSION=${shellQuote(session ?? "")} OVIS_HERDR_BIN=${shellQuote(herdr)} nohup ${shellQuote(runtime + "/bin/bun")} ${shellQuote(runtime + "/server/remote-entry.ts")} </dev/null >>"$HOME/.config/herdr-web-ui/bridges/bridge.log" 2>&1 &`);
}

async function ready(ssh: SshConnection, inspection: HostInspection, runtime: string, version: string, saved: Saved) {
  let last: unknown = new Error("The replacement bridge did not register");
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    const descriptors = (await posixHost.descriptors(ssh)).filter((entry) => entry.socket_path === inspection.expectedSocket);
    if (descriptors.length > 1) throw new Error("Multiple bridges registered for the same socket");
    if (descriptors[0]) {
      try {
        const next = await endpoint(ssh, descriptors[0], inspection);
        if (next.identity.bundle_version !== version || next.identity.socket_id !== saved.socket_id) {
          throw new Error("Replacement version or preserved herdr socket could not be verified");
        }
        if ((await ssh.run(`readlink -f /proc/${descriptors[0].pid}/exe`)).trim() !== `${runtime}/bin/bun`) {
          throw new Error("The bridge is not running the expected immutable bundle");
        }
        requirePreserved(saved.panes, paneIds(await next.get("/api/session")));
        return;
      } catch (error) { last = error; }
    }
    await Bun.sleep(250);
  }
  throw new Error("The managed bridge did not become healthy", { cause: last });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (!["inspect", "stage", "activate", "restore"].includes(mode ?? "")) throw new Error("Use inspect, stage, activate or restore");
  const input: unknown = await Bun.stdin.json();
  if (input === null || typeof input !== "object" || !("stateDir" in input) || typeof input.stateDir !== "string"
    || !input.stateDir.startsWith("/") || !("machines" in input) || !Array.isArray(input.machines)) throw new Error("Invalid deployment request");
  const machines: Machine[] = input.machines.map((machine: unknown) => {
    if (machine === null || typeof machine !== "object" || !("id" in machine) || typeof machine.id !== "string"
      || !/^[a-f0-9-]{36}$/.test(machine.id) || !("target" in machine)) throw new Error("Invalid saved PC identity");
    return { id: machine.id, target: validateTarget(machine.target), saved: "saved" in machine ? machine.saved as Saved : undefined };
  });
  const results: (Machine & { platform: string; runtime?: string })[] = [];
  for (const machine of machines) {
    const directory = join(input.stateDir, "ssh");
    const ssh = new SshConnection(machine.target, directory, join(directory, machine.id));
    try {
      await ssh.start();
      const inspection = await posixHost.inspect(ssh, machine.target.session);
      if (!inspection.platform.startsWith("linux-")) throw new Error("Personal deployment supports existing Linux herdr hosts only");
      const descriptors = inspection.descriptors.filter((entry) => entry.socket_path === inspection.expectedSocket);
      if (descriptors.length > 1) throw new Error("Multiple bridges registered for the same socket");
      if (mode === "inspect") {
        if (!descriptors[0]) throw new Error("No existing bridge to inspect");
        const current = await endpoint(ssh, descriptors[0], inspection);
        const executable = (await ssh.run(`readlink -f /proc/${descriptors[0].pid}/exe`)).trim();
        const runtime = dirname(dirname(executable));
        if (!immutableRuntime(inspection.home, runtime) || !executable.endsWith("/bin/bun")) throw new Error("The current bridge is not an immutable managed runtime");
        const herdr = inspection.herdrPath || `${runtime}/bin/herdr`;
        await ssh.run(`test -x ${shellQuote(herdr)}`);
        const actual = await proof(ssh, executable, descriptors[0].pid);
        const saved: Saved = {
          platform: inspection.platform, socket: inspection.expectedSocket, socket_id: current.identity.socket_id,
          runtime, pointer: (await ssh.run(`if test -e ${shellQuote(inspection.runtimeDir)}; then readlink -f ${shellQuote(inspection.runtimeDir)}; fi`)).trim(),
          pid: descriptors[0].pid, birth: actual.birth, bundle_version: current.identity.bundle_version,
          herdr, panes: paneIds(await current.get("/api/session")),
        };
        results.push({ ...machine, platform: inspection.platform, saved });
        continue;
      }
      const saved = machine.saved;
      if (!saved || saved.socket !== inspection.expectedSocket || saved.platform !== inspection.platform
        || !/^\d+$/.test(saved.birth) || !immutableRuntime(inspection.home, saved.runtime)
        || (saved.pointer && !immutableRuntime(inspection.home, saved.pointer))
        || typeof saved.herdr !== "string" || !saved.herdr.startsWith("/")) throw new Error("Missing verified pre-deployment bridge snapshot");
      const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "remote-bundles", `manifest-${inspection.platform}.json`), "utf8")) as { version: string; assets: Record<string, { sha256: string }> };
      const sha = manifest.assets[inspection.platform]?.sha256;
      if (manifest.version !== REMOTE_BUNDLE_VERSION || !sha || !/^[a-f0-9]{64}$/.test(sha)) throw new Error("Invalid personal bundle manifest");
      const candidate = `${inspection.runtimeDir}-${sha.slice(0, 16)}`;
      if ((await ssh.run(`stat -Lc '%d:%i' ${shellQuote(saved.socket)}`)).trim() !== saved.socket_id) {
        throw new Error("The existing herdr socket changed; no bridge was stopped");
      }
      if (mode === "stage") {
        if (!descriptors[0]) throw new Error("The original bridge is missing before staging");
        const current = await endpoint(ssh, descriptors[0], inspection);
        if (current.identity.socket_id !== saved.socket_id) throw new Error("The verified original socket changed");
        await posixHost.installBundle(ssh, inspection.platform, AbortSignal.timeout(30 * 60_000));
        results.push({ ...machine, platform: inspection.platform, runtime: candidate });
        continue;
      }
      const runtime = mode === "restore" ? saved.runtime : candidate;
      const version = mode === "restore" ? saved.bundle_version : REMOTE_BUNDLE_VERSION;
      await pointer(ssh, inspection, mode === "restore" ? saved.pointer : candidate, `${saved.runtime}/bin/bun`);
      const descriptor = mode === "restore" ? await recoverableDescriptor(ssh, descriptors[0]) : descriptors[0];
      if (descriptor) {
        const actual = await proof(ssh, `${saved.runtime}/bin/bun`, descriptor.pid);
        if (actual.executable === `${runtime}/bin/bun`) {
          try {
            await ready(ssh, inspection, runtime, version, saved);
            results.push({ ...machine, platform: inspection.platform, runtime });
            continue;
          } catch (error) {
            if (mode !== "restore") throw error;
            console.error(`The saved bridge on PC ${machine.id} is unhealthy; verifying its saved process ownership before restart`, error);
          }
        }
        if (mode === "restore") {
          // SSH proof permits restoring our failed candidate even when its HTTP endpoint is unavailable.
          if (!ownedProcess(actual, saved, candidate, machine.target.session ?? "")) throw new Error("The registered process is not the saved bridge or our exact candidate; it was not stopped");
        } else {
          const current = await endpoint(ssh, descriptor, inspection);
          if (current.identity.socket_id !== saved.socket_id || actual.birth !== saved.birth
            || descriptor.pid !== saved.pid) throw new Error("The original bridge changed before activation");
        }
        await posixHost.stop(ssh, descriptor.pid);
        for (const deadline = Date.now() + 15_000; await posixHost.alive(ssh, descriptor.pid);) {
          if (Date.now() > deadline) throw new Error("The verified bridge did not exit");
          await Bun.sleep(100);
        }
      } else if (mode !== "restore") throw new Error("The original bridge disappeared before activation");
      await start(ssh, runtime, saved.herdr, machine.target.session);
      await ready(ssh, inspection, runtime, version, saved);
      results.push({ ...machine, platform: inspection.platform, runtime });
    } finally { ssh.close(); }
  }
  console.log(JSON.stringify({ release: realpathSync(join(import.meta.dir, "..")), machines: results }));
}

if (import.meta.main) await main();
