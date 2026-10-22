import { expect, it } from "bun:test";
import { checkedIdentity, ownedProcess, paneIds, recoverableDescriptor, requirePreserved } from "./remote.ts";
import { BRIDGE_PROTOCOL } from "../shared/machines.ts";

const descriptor = { managed_remote: true, pid: 42, port: 1234, token: "a".repeat(64), socket_path: "/owned/herdr.sock", bridge_protocol: BRIDGE_PROTOCOL, bundle_version: "32" };
const identity = { managed_remote: true, pid: 42, socket_path: descriptor.socket_path, socket_id: "1:2", bridge_protocol: BRIDGE_PROTOCOL, bundle_version: "32", herdr: { version: "0.9.3", protocol: 22 } };

it("requires authenticated bridge ownership and exact PID/socket evidence before deployment", () => {
  expect(checkedIdentity(identity, descriptor, descriptor.socket_path)).toEqual(identity);
  for (const change of [{ managed_remote: false }, { pid: 43 }, { socket_path: "/other.sock" }, { socket_id: null }, { socket_id: "" }, { bridge_protocol: BRIDGE_PROTOCOL + 1 }, { herdr: { protocol: 21 } }]) {
    expect(() => checkedIdentity({ ...identity, ...change }, descriptor, descriptor.socket_path)).toThrow();
  }
});

it("rejects malformed snapshots instead of recording empty preserved sessions", () => {
  for (const value of [null, {}, { panes: null }, { panes: [{}] }]) expect(() => paneIds(value)).toThrow();
  expect(paneIds({ panes: [{ pane_id: "w1:p1" }] })).toEqual(["w1:p1"]);
  expect(paneIds({ snapshot: { panes: [{ pane_id: "w1:p1" }] } })).toEqual(["w1:p1"]);
});

it("recovery treats a crashed candidate's stale descriptor as absent without signalling its PID", async () => {
  const absent = { run: async () => "" };
  expect(await recoverableDescriptor(absent, descriptor)).toBeUndefined();
  const present = { run: async () => "present" };
  expect(await recoverableDescriptor(present, descriptor)).toEqual(descriptor);
  await expect(recoverableDescriptor(present, { ...descriptor, pid: -1 })).rejects.toThrow("Invalid registered");
});

it("permits newly created panes but refuses any missing pre-deployment pane", () => {
  expect(() => requirePreserved(["w1:p1"], ["w1:p1", "w2:p1"])).not.toThrow();
  expect(() => requirePreserved(["w1:p1", "w2:p1"], ["w1:p1"])).toThrow();
});

it("SSH recovery proves the exact failed candidate, owner, process birth and session", () => {
  const saved = { platform: "linux-x64", socket: "/herdr.sock", socket_id: "1:2", runtime: "/old",
    pointer: "/old", pid: 42, birth: "100", bundle_version: "32", herdr: "/old/bin/herdr", panes: [] };
  const actual = { pid: 43, executable: "/new/bin/bun", birth: "110", argv: ["/new/bin/bun", "/new/server/remote-entry.ts"],
    uid: 1000, owner: 1000, session: "" };
  expect(ownedProcess(actual, saved, "/new", "")).toBe(true);
  for (const change of [{ uid: 1001 }, { birth: "99" }, { argv: ["/new/bin/bun", "/other.ts"] }, { session: "other" }, { executable: "/other/bin/bun" }]) {
    expect(ownedProcess({ ...actual, ...change }, saved, "/new", "")).toBe(false);
  }
  expect(ownedProcess({ ...actual, pid: 42, executable: "/old/bin/bun", birth: "100" }, saved, "/new", "")).toBe(true);
  expect(ownedProcess({ ...actual, executable: "/old/bin/bun", birth: "100" }, saved, "/new", "")).toBe(false);
});
