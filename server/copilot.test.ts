import { expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCopilotTranscript } from "./copilot.ts";
import { copilotLoggedBinding, copilotLoggedSession, copilotTranscriptFile, copilotUnwrittenSession, heldSessions } from "./copilot-store.ts";
import { ConversationUnavailable, forgetTranscriptState, HistoryChanged, transcriptPage, transcriptToolOutput } from "./conversation.ts";
import { parseConversationMetadata } from "./conversation-metadata.ts";

const session = "12aa83d8-48bc-41f2-a498-7055c5c44a01";
const line = (type: string, data: object, agentId?: string) =>
  JSON.stringify({ type, data, id: crypto.randomUUID(), timestamp: "2026-10-21T00:00:00Z", parentId: null, ...(agentId ? { agentId } : {}) }) + "\n";
const start = line("session.start", { sessionId: session, copilotVersion: "1.0.102-1" });
const prompt = (text: string) => line("user.message", { content: text, transformedContent: "model-only text", turnId: crypto.randomUUID() });
const answer = (text: string, phase = "final_answer") => line("assistant.message", { content: text, phase, model: "fixture-model", turnId: crypto.randomUUID() });

it("parses persisted Copilot messages and tool rounds once, with failures and recorded metadata", () => {
  const text = start + prompt("Visible prompt")
    + line("assistant.message", { content: "Checking.", phase: "commentary", toolRequests: [{ toolCallId: "call-1", name: "shell", arguments: { command: "pwd" }, toolTitle: "Check directory" }], model: "fixture-model" })
    + line("tool.execution_start", { toolCallId: "call-1", toolName: "shell" })
    + line("tool.execution_complete", { toolCallId: "call-1", success: false, result: { content: "failure ".repeat(900) } })
    + answer("Finished.") + line("system.message", { content: "not a prompt" })
    + line("session.compaction_complete", { success: true, summaryContent: "internal summary" })
    + line("assistant.message", { content: "another agent", model: "leaked-model" }, "child-agent")
    + line("user.message", { content: "child prompt" }, "child-agent")
    + line("user.message", { content: "nested prompt", parentAgentTaskId: "task-1", agentId: "child-agent" })
    + line("assistant.message", { content: "nested answer", agentId: "child-agent", model: "nested-model" })
    + '{"type":"user.message","data":';
  const turns = parseCopilotTranscript(text);
  expect(turns.map(({ role }) => role)).toEqual(["user", "assistant"]);
  expect(turns[0]?.parts).toEqual([{ kind: "text", text: "Visible prompt" }]);
  expect(turns[1]?.parts[0]).toEqual({ kind: "text", text: "Checking.", phase: "commentary" });
  expect(turns[1]?.parts[1]).toMatchObject({ kind: "tool", name: "shell", summary: "Check directory", error: true, output_ref: "call-1" });
  expect(turns[1]?.parts[2]).toEqual({ kind: "text", text: "Finished.", phase: "final_answer" });
  expect(parseConversationMetadata(text, "copilot-transcript")).toEqual({ model: "fixture-model", reasoning_effort: null });
});

it("keeps root prompts carrying parentAgentTaskId and pages at those prompts", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-root-page-"));
  const path = join(dir, "events.jsonl");
  try {
    const root = (i: number) => line("user.message", { content: `root ${i}`, parentAgentTaskId: `task-${i}` });
    writeFileSync(path, start + Array.from({ length: 65 }, (_, i) => root(i) + answer(`response ${i}`)
      + line("user.message", { content: `child ${i}`, parentAgentTaskId: `task-${i}`, agentId: "child" }, "child")).join(""));
    const latest = transcriptPage("copilot-transcript", path);
    expect(latest.turns.filter((turn) => turn.role === "user").map((turn) => turn.parts[0])).toContainEqual({ kind: "text", text: "root 64" });
    expect(latest.cursor).not.toBeNull();
    const older = transcriptPage("copilot-transcript", path, { before: latest.cursor! });
    expect(older.turns[0]?.parts[0]).toEqual({ kind: "text", text: "root 0" });
    expect([...latest.turns, ...older.turns].some((turn) => turn.parts.some((part) => part.kind === "text" && part.text.startsWith("child")))).toBe(false);
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("reads initial model and effort then folds native changes in order", () => {
  const header = line("session.start", { sessionId: session, selectedModel: "initial-model", reasoningEffort: "high" });
  expect(parseConversationMetadata(header, "copilot-transcript")).toEqual({ model: "initial-model", reasoning_effort: "high" });
  expect(parseConversationMetadata(header + line("session.model_change", { newModel: "next-model", reasoningEffort: "low" })
    + line("session.resume", { selectedModel: "resumed-model", reasoningEffort: "medium" }), "copilot-transcript"))
    .toEqual({ model: "resumed-model", reasoning_effort: "medium" });
});

it("keeps unphased completed prose available as an answer, and explicit commentary in work", () => {
  const turns = parseCopilotTranscript(start + prompt("question") + line("assistant.message", { content: "work", phase: "commentary" })
    + line("assistant.message", { content: "unphased answer" }) + line("assistant.turn_end", {}));
  expect(turns.at(-1)?.parts).toEqual([{ kind: "text", text: "work", phase: "commentary" }, { kind: "text", text: "unphased answer" }]);
});

it("renders completed Autopilot summaries as final replies without duplicating an explicit answer or a child completion", () => {
  const completion = (id: string, summary: string) =>
    line("assistant.message", { toolRequests: [{ toolCallId: id, name: "task_complete", arguments: { summary } }] })
    + line("tool.execution_complete", { toolCallId: id, success: true, result: { content: "Task complete." } });
  const transcript = start + prompt("first") + answer("Working", "commentary")
    + completion("done-1", "Completed first task.")
    + line("session.task_complete", { summary: "Completed first task." })
    + prompt("second") + completion("done-2", "Tool fallback.")
    + line("session.task_complete", { summary: "Authoritative second summary." })
    + answer("Actual final reply.")
    + line("session.task_complete", { summary: "Do not repeat the final reply." })
    + prompt("third") + line("assistant.message", { content: "child", phase: "commentary" }, "child")
    + line("session.task_complete", { summary: "child secret", agentId: "child" }, "child")
    + line("assistant.message", { toolRequests: [{ toolCallId: "failed", name: "task_complete", arguments: { summary: "failed" } }] })
    + line("tool.execution_complete", { toolCallId: "failed", success: false, result: { content: "failed" } });
  const turns = parseCopilotTranscript(transcript);
  expect(turns[1]?.parts.filter((part) => part.kind === "text")).toEqual([
    { kind: "text", text: "Working", phase: "commentary" },
    { kind: "text", text: "Completed first task.", phase: "final_answer" },
  ]);
  expect(turns[3]?.parts.filter((part) => part.kind === "text")).toEqual([
    { kind: "text", text: "Actual final reply.", phase: "final_answer" },
  ]);
  expect(JSON.stringify(turns)).not.toContain("child secret");
  expect(JSON.stringify(turns)).not.toContain('"text":"failed"');
});

it.each(["commentary", "final_answer", undefined])("tracks the latest assistant message timestamp with phase %s", (phase) => {
  const stamp = "2026-10-21T00:00:05Z";
  const transcript = start + prompt("question") + answer("Working.", "commentary")
    + JSON.stringify({ type: "assistant.message", timestamp: stamp, data: { content: "Latest message.", phase } }) + "\n";
  expect(parseCopilotTranscript(transcript).at(-1)).toMatchObject({
    ts: "2026-10-21T00:00:00Z", end_ts: stamp,
  });
  const missingTimestamp = JSON.stringify({ type: "assistant.turn_end", data: {}, timestamp: null }) + "\n";
  expect(parseCopilotTranscript(transcript + missingTimestamp).at(-1)?.end_ts).toBe(stamp);
});

it("advances activity time past intermediate tool rounds and the final answer without changing turn boundaries", () => {
  const at = (type: string, data: object, second: number) =>
    JSON.stringify({ type, data, timestamp: `2026-10-21T00:00:0${second}Z` }) + "\n";
  const work = start + prompt("question") + at("assistant.message", { content: "Working.", phase: "commentary" }, 1)
    + at("assistant.turn_end", {}, 2);
  const final = work + at("assistant.message", { content: "Done.", phase: "final_answer" }, 3);
  const completed = final + at("assistant.turn_end", {}, 4);
  expect(parseCopilotTranscript(work).at(-1)?.end_ts).toBe("2026-10-21T00:00:02Z");
  expect(parseCopilotTranscript(final).at(-1)?.end_ts).toBe("2026-10-21T00:00:03Z");
  expect(parseCopilotTranscript(completed).at(-1)?.end_ts).toBe("2026-10-21T00:00:04Z");
  const turns = parseCopilotTranscript(completed + at("user.message", { content: "Next question." }, 5)
    + at("assistant.turn_end", {}, 6));
  expect(turns.map(({ role }) => role)).toEqual(["user", "assistant", "user"]);
  expect(turns[1]?.end_ts).toBe("2026-10-21T00:00:04Z");
  expect(turns[2]?.end_ts).toBeUndefined();
});

it("pages bounded native turns and observes append, torn lines, and same-file resume without reset", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-page-"));
  const path = join(dir, "events.jsonl");
  try {
    writeFileSync(path, start + Array.from({ length: 65 }, (_, i) => prompt(`prompt ${i}`) + answer(`answer ${i}`)).join(""));
    const first = transcriptPage("copilot-transcript", path);
    expect(first.turns.at(-1)?.parts[0]).toEqual({ kind: "text", text: "answer 64", phase: "final_answer" });
    expect(first.cursor).not.toBeNull();
    const older = transcriptPage("copilot-transcript", path, { before: first.cursor! });
    expect(older.turns[0]?.parts[0]).toEqual({ kind: "text", text: "prompt 0" });
    appendFileSync(path, '{"type":"user.message","data":');
    expect(transcriptPage("copilot-transcript", path).turns).toEqual(first.turns);
    appendFileSync(path, '\n' + line("session.resume", { selectedModel: "fixture-model" }) + prompt("after resume") + answer("still here"));
    const resumed = transcriptPage("copilot-transcript", path);
    expect(resumed.history_id).toBe(first.history_id);
    expect(resumed.turns.at(-1)?.parts[0]).toEqual({ kind: "text", text: "still here", phase: "final_answer" });
    expect(transcriptPage("copilot-transcript", path, { before: first.cursor! }).turns).toEqual(older.turns);
    writeFileSync(path, start + prompt("replacement"));
    expect(() => transcriptPage("copilot-transcript", path, { before: first.cursor! })).toThrow(HistoryChanged);
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("fetches only a bounded complete output for the selected native call ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-output-"));
  const path = join(dir, "events.jsonl");
  try {
    writeFileSync(path, start + prompt("tool")
      + line("assistant.message", { content: "", toolRequests: [{ toolCallId: "call-1", name: "shell", arguments: {} }] })
      + line("tool.execution_complete", { toolCallId: "call-1", success: true, result: { content: "x".repeat(5000) } })
      + line("tool.execution_complete", { toolCallId: "unrelated", success: true, result: { content: "hidden" } }));
    expect(transcriptPage("copilot-transcript", path).turns.at(-1)?.parts[0]).toMatchObject({ kind: "tool", output_ref: "call-1" });
    expect(transcriptToolOutput("copilot-transcript", path, "call-1")).toBe("x".repeat(5000));
    expect(transcriptToolOutput("copilot-transcript", path, "../secret")).toBeNull();
    expect(transcriptToolOutput("copilot-transcript", path, "unrelated")).toBeNull();
    const alias = join(dir, "alias.jsonl");
    symlinkSync(path, alias);
    expect(() => transcriptPage("copilot-transcript", alias)).toThrow(ConversationUnavailable);
    expect(transcriptToolOutput("copilot-transcript", alias, "call-1")).toBeNull();
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("reads a complete Copilot tool result at EOF across read chunks, but refuses malformed or oversized EOF records", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-output-eof-"));
  const path = join(dir, "events.jsonl");
  try {
    const request = start + line("assistant.message", { toolRequests: [{ toolCallId: "eof-call", name: "shell" }] });
    const complete = line("tool.execution_complete", { toolCallId: "eof-call", success: true, result: { content: "z".repeat(70_000) } }).trimEnd();
    writeFileSync(path, request + complete);
    expect(transcriptPage("copilot-transcript", path).turns.at(-1)?.parts[0]).toMatchObject({ kind: "tool", output_ref: "eof-call" });
    expect(transcriptToolOutput("copilot-transcript", path, "eof-call")).toBe("z".repeat(70_000));
    writeFileSync(path, request + complete.slice(0, -1));
    expect(transcriptToolOutput("copilot-transcript", path, "eof-call")).toBeNull();
    writeFileSync(path, request + line("tool.execution_complete", { toolCallId: "eof-call", result: { content: "z".repeat(9_000_000) } }).trimEnd());
    expect(transcriptToolOutput("copilot-transcript", path, "eof-call")).toBeNull();
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("retains root Copilot model and effort controls across the head and cold latest-page gap in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-cold-metadata-"));
  const path = join(dir, "events.jsonl");
  const fillGap = () => {
    const turn = prompt("filler") + line("assistant.message", { content: "f".repeat(32_000), phase: "final_answer" });
    // Each control is now more than a 16 MiB page away from the next cold read.
    appendFileSync(path, turn.repeat(540));
  };
  try {
    writeFileSync(path, line("session.start", { sessionId: session, selectedModel: "initial", reasoningEffort: "high" })
      + line("system.message", { content: "padding".repeat(10_000) })
      + line("session.model_change", { newModel: "child-model", reasoningEffort: "high", agentId: "child" }, "child")
      + line("session.model_change", { newModel: "low-model", reasoningEffort: "low" })
      + line("session.model_change", { newModel: "latest-model" }));
    fillGap();
    forgetTranscriptState();
    expect(transcriptPage("copilot-transcript", path).metadata).toEqual({ model: "latest-model", reasoning_effort: "low" });
    appendFileSync(path, line("session.resume", { selectedModel: "child-model", reasoningEffort: "high", agentId: "child" }, "child")
      + line("session.resume", { selectedModel: "resumed-model", reasoningEffort: "medium" })
      + line("session.resume", { selectedModel: "latest-resumed-model" }));
    fillGap();
    forgetTranscriptState();
    expect(transcriptPage("copilot-transcript", path).metadata).toEqual({ model: "latest-resumed-model", reasoning_effort: "medium" });
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it("skips oversized unrelated records and bounds selected output before parsing", () => {
  const dir = mkdtempSync(join(tmpdir(), "copilot-large-output-"));
  const path = join(dir, "events.jsonl");
  try {
    const request = line("assistant.message", { toolRequests: [{ toolCallId: "chosen", name: "shell" }] });
    writeFileSync(path, start + request
      + line("tool.execution_complete", { toolCallId: "other", result: { content: "u".repeat(10_000_000) } })
      + line("tool.execution_complete", { toolCallId: "chosen", result: { content: "v".repeat(2_100_000) } }));
    expect(transcriptToolOutput("copilot-transcript", path, "chosen")).toBe(`${"v".repeat(2_000_000)}\n… trimmed`);
    expect(transcriptToolOutput("copilot-transcript", path, "../invalid")).toBeNull();
    writeFileSync(path, start + request + line("tool.execution_complete", { toolCallId: "chosen", result: { content: "w".repeat(10_000_000) } })
      + line("tool.execution_complete", { toolCallId: "chosen", result: { content: "incorrect fallback" } }));
    expect(transcriptToolOutput("copilot-transcript", path, "chosen")).toBeNull();
  } finally { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "linux")("uses only the process home and a canonical regular file with the matching native header", async () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-store-"));
  const custom = join(root, "custom");
  const defaultHome = join(root, "user");
  const legacy = join(root, "legacy");
  const fixture = (home: string) => {
    const directory = join(home, "session-state", session);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "events.jsonl"), start + prompt("safe"));
    return join(directory, "events.jsonl");
  };
  let stop: (() => Promise<number>) | undefined;
  try {
    const chosen = fixture(custom);
    const defaultFile = fixture(join(defaultHome, ".copilot"));
    const legacyFile = fixture(legacy);
    const child = Bun.spawn(["node", "-e", `
      const { openSync, closeSync } = require("node:fs");
      const { join } = require("node:path");
      const homes = process.argv.slice(1);
      for (const home of homes) openSync(join(home, "session-state", "${session}", "inuse." + process.pid + ".hold"), "w");
      let extra;
      let input = "";
      process.stdin.on("data", (chunk) => {
        input += chunk;
        for (let at; (at = input.indexOf("\\n")) !== -1;) {
          const command = input.slice(0, at); input = input.slice(at + 1);
          if (command === "extra") extra = openSync(join(homes[0], "session-state", "${session.slice(0, -2)}02", "inuse." + process.pid + ".hold"), "w");
          if (command === "close") closeSync(extra);
          console.log("ok");
        }
      });

      console.log("ready");
    `, custom, join(defaultHome, ".copilot"), legacy], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    stop = () => { child.kill(); return child.exited; };
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    const pid = child.pid;
    const command = async (value: string) => {
      child.stdin.write(`${value}\n`);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ok");
    };
    expect([...heldSessions(pid, join(custom, "session-state"))!]).toEqual([session]);
    expect(copilotTranscriptFile(session, [`HOME=${defaultHome}`, `COPILOT_HOME=${custom}`], ["copilot"], pid)).toBe(chosen);
    expect(copilotTranscriptFile(session, null, ["copilot"], pid)).toBeNull();
    expect(copilotTranscriptFile("../bad", [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=relative`], ["copilot"], pid)).toBeNull();
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    writeFileSync(chosen, start.replace(session, "12aa83d8-48bc-41f2-a498-7055c5c44a02"));
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    rmSync(chosen);
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toEqual({ sessionId: session, path: chosen });
    expect(copilotUnwrittenSession(null, ["copilot"], pid)).toBeNull();
    expect(copilotUnwrittenSession([`COPILOT_HOME=relative`], ["copilot"], pid)).toBeNull();
    for (const args of [["--resume", session], [`--resume=${session}`], ["--continue"], ["-r", session]]) {
      expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot", ...args], pid)).toBeNull();
    }
    symlinkSync(join(root, "missing.jsonl"), chosen);
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    rmSync(chosen);
    symlinkSync(legacyFile, chosen);
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    rmSync(chosen);
    mkdirSync(chosen);
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    rmSync(chosen, { recursive: true });
    expect(await Bun.spawn(["mkfifo", chosen], { stdout: "ignore", stderr: "inherit" }).exited).toBe(0);
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    rmSync(chosen);
    writeFileSync(chosen, start);
    const extra = "12aa83d8-48bc-41f2-a498-7055c5c44a02";
    mkdirSync(join(custom, "session-state", extra));
    await command("extra");
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    rmSync(chosen);
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    await command("close");
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toEqual({ sessionId: session, path: chosen });
    writeFileSync(chosen, "");
    expect(copilotUnwrittenSession([`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBeNull();
    writeFileSync(chosen, start);
    expect(copilotTranscriptFile(session, [`COPILOT_HOME=${custom}`], ["copilot"], pid)).toBe(chosen);
    expect(copilotTranscriptFile(session, [`HOME=${defaultHome}`], ["copilot"], pid)).toBe(defaultFile);
    expect(copilotTranscriptFile(session, [`HOME=${defaultHome}`, `COPILOT_HOME=${custom}`], ["copilot", "--config-dir", legacy], pid)).toBe(legacyFile);
  } finally {
    if (stop) await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux")("keeps report-and-marker fallback for a complete CLI log without lifecycle events", async () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-log-no-lifecycle-"));
  const directory = join(root, "session-state", session);
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(root, "logs"));
  const path = join(directory, "events.jsonl");
  writeFileSync(path, start + prompt("existing conversation"));
  const child = Bun.spawn(["node", "-e", `
    const {openSync} = require("node:fs");
    const root = process.argv[1];
    openSync(root + "/session-state/${session}/inuse." + process.pid + ".hold", "w");
    openSync(root + "/logs/process-100-" + process.pid + ".log", "w");
    console.log("ready");
    process.stdin.on("data", () => {
      openSync(root + "/logs/process-200-" + process.pid + ".log", "w");
      console.log("opened");
    });
  `, root], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    const log = join(root, "logs", `process-100-${child.pid}.log`);
    const environment = [`COPILOT_HOME=${root}`];
    const argv = ["copilot", `--resume=${session}`];
    for (const content of ["", "2026-10-23T00:00:00.000Z [INFO] CLI started\n"]) {
      writeFileSync(log, content);
      expect(copilotLoggedBinding(environment, argv, child.pid)).toBeNull();
      expect(copilotTranscriptFile(session, environment, argv, child.pid)).toBe(path);
      expect(copilotTranscriptFile(null, environment, argv, child.pid)).toBeNull();
      expect(copilotTranscriptFile(session.slice(0, -2) + "02", environment, argv, child.pid)).toBeNull();
    }
    writeFileSync(log, `2026-10-23T00:00:00.000Z [INFO] Unregistering foreground session: ${session}\n`);
    expect(copilotTranscriptFile(session, environment, argv, child.pid)).toBeNull();
    writeFileSync(log, "x".repeat(16 * 1024 * 1024) + "\n");
    expect(copilotTranscriptFile(session, environment, argv, child.pid)).toBeNull();
    writeFileSync(log, "2026-10-23T00:00:00.000Z [INFO] CLI started");
    expect(copilotTranscriptFile(session, environment, argv, child.pid)).toBeNull();
    writeFileSync(log, `2026-10-23T00:00:00.000Z [INFO] Registering foreground session: ${session}\n`);
    expect(copilotLoggedBinding(environment, argv, child.pid)?.sessionId).toBe(session);
    writeFileSync(log, "2026-10-23T00:00:00.000Z [INFO] CLI restarted\n");
    expect(copilotTranscriptFile(session, environment, argv, child.pid)).toBeNull();
    expect(copilotTranscriptFile(session, environment, argv, child.pid)).toBeNull();
    child.stdin.write("extra\n");
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("opened");
    expect(copilotTranscriptFile(session, environment, argv, child.pid)).toBeNull();
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of ["rewrite", "gap"] as const) {
  it.skipIf(process.platform !== "linux")(`recovers foreground discovery after a log ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "copilot-log-continuity-"));
    const other = "12aa83d8-48bc-41f2-a498-7055c5c44a02";
    for (const id of [session, other]) mkdirSync(join(root, "session-state", id), { recursive: true });
    mkdirSync(join(root, "logs"));
    const child = Bun.spawn(["node", "-e", `
      const {openSync} = require("node:fs");
      openSync(process.argv[1] + "/logs/process-100-" + process.pid + ".log", "w");
      console.log("ready");
      process.stdin.resume();
    `, root], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    const reader = child.stdout.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      const log = join(root, "logs", `process-100-${child.pid}.log`);
      const register = (id: string) => `2026-10-22T00:00:00.000Z [INFO] Registering foreground session: ${id}\n`;
      const options = [`COPILOT_HOME=${root}`];
      const binding = () => copilotLoggedBinding(options, ["copilot"], child.pid);
      appendFileSync(log, register(session));
      const original = binding();
      expect(original?.sessionId).toBe(session);
      if (scenario === "rewrite") {
        writeFileSync(log, register(other));
        expect(binding()?.sessionId).toBe(other);
        writeFileSync(log, register(session));
        expect(binding()?.sessionId).toBe(session);
        expect(binding()?.generation).not.toBe(original?.generation);
        writeFileSync(log, register(other) + "unrelated\n");
        expect(binding()?.sessionId).toBe(other);
        const replaced = binding();
        appendFileSync(log, "ordinary append\n");
        expect(binding()?.generation).toBe(replaced?.generation);
      } else {
        appendFileSync(log, "unrelated\n".repeat(2 * 1024 * 1024));
        expect(binding()).toBeNull();
        appendFileSync(log, register(session).replace("Registering", "Unregistering") + register(other));
        expect(binding()?.sessionId).toBe(other);
        appendFileSync(log, "unrelated\n".repeat(2 * 1024 * 1024) + register(session));
        expect(binding()?.sessionId).toBe(session);
        expect(binding()?.generation).not.toBe(original?.generation);
      }
    } finally {
      child.kill();
      await child.exited;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

it.skipIf(process.platform !== "linux")("follows process-owned foreground evidence through fork and switch-back with multiple holds", async () => {
  const root = mkdtempSync(join(tmpdir(), "copilot-foreground-"));
  const home = join(root, "home");
  const logs = join(home, "logs");
  const other = "12aa83d8-48bc-41f2-a498-7055c5c44a02";
  const options = [`COPILOT_HOME=${home}`];
  const args = ["copilot", "--resume", session];
  for (const id of [session, other]) {
    const directory = join(home, "session-state", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "events.jsonl"), line("session.start", { sessionId: id }) + prompt(id));
  }
  mkdirSync(logs);
  const child = Bun.spawn(["node", "-e", `
    const { openSync, appendFileSync } = require("node:fs");
    const { join } = require("node:path");
    const root = process.argv[1];
    const ids = process.argv.slice(2);
    const path = join(root, "logs", "process-100-" + process.pid + ".log");
    openSync(path, "w");
    for (const id of ids) openSync(join(root, "session-state", id, "inuse." + process.pid + ".hold"), "w");
    const event = (action, id) => appendFileSync(path, new Date().toISOString() + " [INFO] " + action + " foreground session: " + id + "\\n");
    event("Registering", ids[0]);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (input) => { for (const command of input.trim().split("\\n")) {
      if (command === "fork") { event("Unregistering", ids[0]); event("Registering", ids[1]); }
      if (command === "back") { event("Unregistering", ids[1]); event("Registering", ids[0]); }
      if (command === "incomplete") appendFileSync(path, new Date().toISOString() + " [INFO] Registering foreground session: " + ids[1]);
      console.log("ok");
    } });
    console.log("ready");
  `, home, session, other], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    const command = async (value: string) => {
      child.stdin.write(`${value}\n`);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ok");
    };
    expect(heldSessions(child.pid, join(home, "session-state"))?.size).toBe(2);
    expect(copilotLoggedSession(options, args, child.pid)).toBe(session);
    expect(copilotTranscriptFile(null, options, args, child.pid)).toBe(join(home, "session-state", session, "events.jsonl"));
    const log = join(logs, `process-100-${child.pid}.log`);
    for (let n = 0; n < 17; n++) {
      appendFileSync(log, `unrelated ${".".repeat(1024 * 1024)}\n`);
      expect(copilotLoggedSession(options, args, child.pid)).toBe(session);
    }
    expect(copilotLoggedSession(options, args, child.pid)).toBe(session);
    await command("fork");
    expect(copilotLoggedSession(options, args, child.pid)).toBe(other);
    expect(copilotTranscriptFile(session, options, args, child.pid)).toBeNull();
    expect(copilotTranscriptFile(other, options, args, child.pid)).toBe(join(home, "session-state", other, "events.jsonl"));
    await command("back");
    expect(copilotLoggedSession(options, args, child.pid)).toBe(session);
    await command("incomplete");
    expect(copilotLoggedSession(options, args, child.pid)).toBeNull();
    expect(copilotTranscriptFile(session, options, args, child.pid)).toBeNull();
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
