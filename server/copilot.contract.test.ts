import { afterAll, beforeAll, expect, it } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { launchedAgents } from "./launched-agents.ts";

const id = "12aa83d8-48bc-41f2-a498-7055c5c44a01";
const other = "12aa83d8-48bc-41f2-a498-7055c5c44a02";
const root = mkdtempSync(join(tmpdir(), "herdr-copilot-contract-"));
const home = join(root, "custom-home");
const executable = join(root, "copilot.js");
const file = (session: string) => join(home, "session-state", session, "events.jsonl");
const event = (type: string, data: object) => JSON.stringify({ type, data, id: crypto.randomUUID(), timestamp: "2026-10-21T00:00:00Z", parentId: null }) + "\n";
const fixture = (session: string, content: string) =>
  event("session.start", { sessionId: session, copilotVersion: "1.0.102-1" })
  + event("user.message", { content, transformedContent: "not shown", parentAgentTaskId: "root-task-id" })
  + event("assistant.message", { content: "fixture response", phase: "final_answer", model: "fixture-model" });
let app: ReturnType<typeof createServer>;
let workspace: string;
let pane: string;

beforeAll(async () => {
  if (process.platform !== "linux") return;
  for (const session of [id, other]) mkdirSync(join(home, "session-state", session), { recursive: true });
  writeFileSync(executable, `import { openSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.COPILOT_HOME;
const hold = (id) => { const dir = join(home, "session-state", id); mkdirSync(dir, { recursive: true }); openSync(join(dir, \`inuse.\${process.pid}.hold\`), "w"); };
hold(process.argv[2]);
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at; (at = buffer.indexOf("\\n")) !== -1;) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (line.startsWith(":hold ")) hold(line.slice(6));
    else if (line === ":quit") process.exit(0);
    else appendFileSync(join(home, "input.txt"), line + "\\n");
  }
});
console.log("fixture ready");`);
  chmodSync(executable, 0o755);
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-api" });
  workspace = created.workspace.workspace_id;
  pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `COPILOT_HOME=${home} node ${executable} ${id}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    if ((await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent === "copilot") break;
    if (Date.now() > deadline) throw new Error("isolated Copilot stand-in not detected by Herdr");
    await Bun.sleep(50);
  }
  app = createServer({ hostname: "127.0.0.1", port: 0, token: "", stateDir: join(root, "state"), tailscaleOwner: null });
});

afterAll(async () => {
  app?.stop();
  if (pane) launchedAgents.forget(pane);
  if (workspace) await workspaceClose(workspace);
  forgetTranscriptState();
  rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== "linux")("binds only the reported UUID to the foreground process's home and rejects old cursors after a switch", async () => {
  const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`;
  const read = async () => (await fetch(url)).json() as Promise<{ source: string; turns: { parts: { text?: string }[] }[]; cursor?: string; history_id?: string }>;
  const external = await read();
  expect(external.source).toBe("copilot-transcript");
  expect(external.turns).toEqual([]);
  expect(external.history_id).toBe(`unwritten:${id}`);
  expect((await read()).history_id).toBe(external.history_id);
  expect((await fetch(`${url}&from=old-history`)).status).toBe(409);
  writeFileSync(file(id), fixture(id, "session A"));
  expect((await read()).source).toBe("scrollback");
  const report = async (session: string, seq: number, source = "herdr:copilot", paneId = pane) => {
    await herdrRpc("pane.report_agent_session", { pane_id: paneId, agent: "copilot", source, seq: Date.now() * 1000 + seq, agent_session_id: session });
  };
  await report(id, 1, "untrusted");
  expect((await read()).source).toBe("scrollback");
  launchedAgents.launched(pane, "copilot");
  const pending = await read();
  expect(pending.source).toBe("copilot-transcript");
  expect(pending.turns).toEqual([]);
  expect(pending.history_id).toStartWith("unwritten:launch:");
  expect((await read()).history_id).toBe(pending.history_id);
  await report(id, 2);
  const first = await read();
  expect(first.source).toBe("copilot-transcript");
  expect(first.history_id).not.toBe(pending.history_id);
  expect(first.history_id).not.toBe(external.history_id);
  expect(first.turns[0]?.parts[0]?.text).toBe("session A");
  appendFileSync(file(id), event("assistant.message", { content: "Checking.", phase: "commentary",
    toolRequests: [{ toolCallId: "call-1", name: "shell", arguments: { command: "pwd" } }], model: "fixture-model" }));
  const toolUrl = `http://127.0.0.1:${app.port}/api/pane/conversation/tool-output?${new URLSearchParams({ pane_id: pane, ref: "call-1" })}`;
  expect((await read()).turns.at(-1)?.parts.at(-1)).toMatchObject({ kind: "tool", output: "" });
  appendFileSync(file(id), event("tool.execution_start", { toolCallId: "call-1", toolName: "shell" })
    + event("tool.execution_complete", { toolCallId: "call-1", success: false, result: { content: "error ".repeat(900) } }));
  expect((await read()).turns.at(-1)?.parts.at(-1)).toMatchObject({ kind: "tool", error: true, output_ref: "call-1" });
  expect(await (await fetch(toolUrl)).text()).toBe("error ".repeat(900));
  appendFileSync(file(id), event("session.resume", { selectedModel: "fixture-model" }) + event("user.message", { content: "appended" }));
  expect((await read()).history_id).toBe(first.history_id);
  expect((await read()).turns.at(-1)?.parts[0]?.text).toBe("appended");
  writeFileSync(file(other), fixture(other, "session B"));
  const second = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-peer" });
  try {
    const peer = second.root_pane.pane_id;
    await herdrRpc("pane.send_text", { pane_id: peer, text: `COPILOT_HOME=${home} node ${executable} ${other}\n` });
    for (const deadline = Date.now() + 10_000;;) {
      if ((await sessionSnapshot()).panes.find((p) => p.pane_id === peer)?.agent === "copilot") break;
      if (Date.now() > deadline) throw new Error("peer Copilot process was not detected");
      await Bun.sleep(50);
    }
    await report(other, 1, "herdr:copilot", peer);
    const peerUrl = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(peer)}`;
    expect((await (await fetch(peerUrl)).json()).turns[0].parts[0].text).toBe("session B");
    expect((await read()).turns[0]?.parts[0]?.text).toBe("session A");
    const duplicate = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-duplicate" });
    try {
      const claimant = duplicate.root_pane.pane_id;
      await herdrRpc("pane.send_text", { pane_id: claimant, text: `COPILOT_HOME=${home} node ${executable} ${id}\n` });
      for (const deadline = Date.now() + 10_000;;) {
        if ((await sessionSnapshot()).panes.find((p) => p.pane_id === claimant)?.agent === "copilot") break;
        if (Date.now() > deadline) throw new Error("duplicate claimant was not detected");
        await Bun.sleep(50);
      }
      await report(id, 1, "herdr:copilot", claimant);
      expect((await read()).source).toBe("scrollback");
      const claimantUrl = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(claimant)}`;
      expect((await (await fetch(claimantUrl)).json()).source).toBe("scrollback");
      expect((await (await fetch(peerUrl)).json()).source).toBe("copilot-transcript");
    } finally { await workspaceClose(duplicate.workspace.workspace_id); }
    expect((await read()).source).toBe("copilot-transcript");
  } finally { await workspaceClose(second.workspace.workspace_id); }
  await herdrRpc("pane.send_text", { pane_id: pane, text: `:hold ${other}\n` });
  for (const deadline = Date.now() + 4000;;) {
    if ((await read()).source === "scrollback") break;
    if (Date.now() > deadline) throw new Error("ambiguous native holds did not disable chat");
    await Bun.sleep(50);
  }
  await report(other, 3);
  // Herdr 0.9.3 ignores a replacement Copilot ID. Its stale old ID must not
  // show that old session as if it belonged to the now-switched pane.
  expect((await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent_session?.value).toBe(id);
  expect((await read()).source).toBe("scrollback");
  expect((await fetch(`${url}&from=${encodeURIComponent(first.cursor!)}`)).status).toBe(409);
  expect((await fetch(toolUrl)).status).toBe(404);
  await herdrRpc("pane.send_text", { pane_id: pane, text: ":quit\n" });
  for (const deadline = Date.now() + 10_000;;) {
    if ((await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent !== "copilot") break;
    if (Date.now() > deadline) throw new Error("isolated fixture did not exit");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.send_text", { pane_id: pane, text: `COPILOT_HOME=${home} node ${executable} ${other}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    if ((await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent === "copilot") break;
    if (Date.now() > deadline) throw new Error("replacement fixture not detected");
    await Bun.sleep(50);
  }
  await report(other, 4);
  expect((await read()).turns[0]?.parts[0]?.text).toBe("session B");
  expect((await fetch(`${url}&from=${encodeURIComponent(first.cursor!)}`)).status).toBe(409);
  writeFileSync(file(other), fixture(id, "wrong header"));
  expect((await read()).source).toBe("scrollback");
  rmSync(file(other));
  expect((await read()).source).toBe("scrollback");
  symlinkSync(file(id), file(other));
  expect((await read()).source).toBe("scrollback");
});
