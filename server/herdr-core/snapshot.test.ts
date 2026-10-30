import { describe, expect, it } from "bun:test";
import { buildSnapshot, type HcTerminal, keyBytes, OTHER_WORKSPACE_ID } from "./snapshot.ts";

function terminal(address: string, extra: Partial<HcTerminal> = {}): HcTerminal {
  return { address, cols: 120, rows: 40, cwd: "/home/u", state: "live", ...extra };
}

function block(address: string) {
  return { type: "block", id: `p-${address}`, content: { terminal: address } };
}

describe("buildSnapshot", () => {
  it("reads the app's spaces as workspaces, its tabs as tabs and each terminal block as a pane, in the app's order", () => {
    const layout = {
      spaces: [
        { id: "s1", name: "api", tabs: [
          { id: "s1t1", name: "", root: { type: "row", id: "r", children: [block("t3"), { type: "column", id: "c", children: [block("t1"), block("t2")] }] } },
          { id: "s1t2", name: "logs", root: { type: "row", id: "r2", children: [block("t4")] } },
        ] },
        { id: "s2", name: "", folder: "/work/web", tabs: [{ id: "s2t1", name: "", root: block("t5") }] },
      ],
    };
    const snapshot = buildSnapshot([terminal("t1"), terminal("t2"), terminal("t3"), terminal("t4"), terminal("t5")], layout, "0.1.14");
    expect(snapshot.workspaces.map((w) => [w.workspace_id, w.label, w.tab_count, w.pane_count, w.active_tab_id])).toEqual([
      ["s1", "api", 2, 4, "s1t1"],
      ["s2", "web", 1, 1, "s2t1"],
    ]);
    expect(snapshot.tabs.map((t) => [t.tab_id, t.label, t.number])).toEqual([["s1t1", "1", 1], ["s1t2", "logs", 2], ["s2t1", "1", 1]]);
    expect(snapshot.panes.map((p) => [p.pane_id, p.terminal_id, p.tab_id])).toEqual([
      ["t3", "t3", "s1t1"], ["t1", "t1", "s1t1"], ["t2", "t2", "s1t1"], ["t4", "t4", "s1t2"], ["t5", "t5", "s2t1"],
    ]);
  });

  it("names an unnamed space and tab as the app labels their terminals", () => {
    const layout = { spaces: [{ id: "s1", name: "", tabs: [{ id: "s1t1", name: "", root: block("t1") }] }] };
    const snapshot = buildSnapshot([terminal("t1", { labels: { where: "tmp / 3" } })], layout, "0.1.14");
    expect(snapshot.workspaces[0]!.label).toBe("tmp");
    expect(snapshot.tabs[0]!.label).toBe("3");
  });

  it("leaves out finished terminals and tabs left with none, and gives a terminal no tab holds a tab of its own", () => {
    const layout = { spaces: [
      { id: "s1", name: "a", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [block("t1"), block("t2")] } }] },
      { id: "s2", name: "b", tabs: [{ id: "s2t1", name: "", root: block("t9") }] },
    ] };
    const snapshot = buildSnapshot([terminal("t1"), terminal("t2", { state: "finished" }), terminal("t7", { name: "worker" }), terminal("t8")], layout, "0.1.14");
    expect(snapshot.workspaces.map((w) => w.workspace_id)).toEqual(["s1", OTHER_WORKSPACE_ID]);
    expect(snapshot.panes.map((p) => [p.pane_id, p.workspace_id])).toEqual([["t1", "s1"], ["t7", OTHER_WORKSPACE_ID], ["t8", OTHER_WORKSPACE_ID]]);
    expect(snapshot.tabs.filter((t) => t.workspace_id === OTHER_WORKSPACE_ID).map((t) => t.label)).toEqual(["worker", "t8"]);
  });

  it("reads a document it cannot make sense of as no layout at all", () => {
    for (const layout of [null, "spaces", { spaces: "x" }, { spaces: [{ id: 1 }, { id: "s", tabs: [{ id: "t", root: { children: 5 } }] }] }]) {
      const snapshot = buildSnapshot([terminal("t1")], layout, "0.1.14");
      expect(snapshot.panes.map((p) => [p.pane_id, p.workspace_id])).toEqual([["t1", OTHER_WORKSPACE_ID]]);
    }
  });

  it("takes each pane's agent and status from what its program reported, and rolls the most pressing up", () => {
    const layout = { spaces: [{ id: "s1", name: "a", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [block("t1"), block("t2"), block("t3"), block("t4")] } }] }] };
    const snapshot = buildSnapshot([
      terminal("t1", { status: { app: "claude", state: "working" } }),
      terminal("t2", { status: { app: "codex", state: "blocked" } }),
      terminal("t3", { status: { app: "omp", state: "error" } }),
      terminal("t4"),
    ], layout, "0.1.14");
    expect(snapshot.panes.map((p) => [p.agent, p.agent_status])).toEqual([["claude", "working"], ["codex", "blocked"], ["omp", "done"], [null, "unknown"]]);
    expect(snapshot.tabs[0]!.agent_status).toBe("blocked");
    expect(snapshot.workspaces[0]!.agent_status).toBe("blocked");
    expect(snapshot.agents.map((a) => a.pane_id)).toEqual(["t1", "t2", "t3"]);
  });

  it("gives each pane its terminal's own grid at its place in the tab's splits, so no two panes overlap", () => {
    const layout = { spaces: [{ id: "s1", name: "a", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [block("t1"), { type: "column", id: "c", children: [block("t2"), block("t3")] }] } }] }] };
    const snapshot = buildSnapshot([terminal("t1", { cols: 80, rows: 49 }), terminal("t2", { cols: 60, rows: 24 }), terminal("t3", { cols: 60, rows: 24 })], layout, "0.1.14");
    const tab = snapshot.layouts[0]!;
    expect(tab.panes.map((pane) => [pane.pane_id, pane.rect])).toEqual([
      ["t1", { x: 0, y: 0, width: 80, height: 49 }],
      ["t2", { x: 81, y: 0, width: 60, height: 24 }],
      ["t3", { x: 81, y: 25, width: 60, height: 24 }],
    ]);
    expect(tab.area).toEqual({ x: 0, y: 0, width: 141, height: 49 });
  });

  it("places a terminal the document names twice once, and skips a space or tab whose id was seen or is empty", () => {
    const layout = { spaces: [
      { id: "s1", name: "a", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [block("t1"), block("t1")] } }, { id: "s1t1", name: "", root: block("t2") }] },
      { id: "s1", name: "b", tabs: [{ id: "x", name: "", root: block("t3") }] },
      { id: OTHER_WORKSPACE_ID, name: "c", tabs: [{ id: "y", name: "", root: block("t3") }] },
      { id: "", name: "d", tabs: [{ id: "z", name: "", root: block("t3") }] },
    ] };
    const snapshot = buildSnapshot([terminal("t1"), terminal("t2"), terminal("t3")], layout, "0.1.14");
    expect(snapshot.panes.map((p) => [p.pane_id, p.workspace_id])).toEqual([["t1", "s1"], ["t2", OTHER_WORKSPACE_ID], ["t3", OTHER_WORKSPACE_ID]]);
    expect(new Set(snapshot.workspaces.map((w) => w.workspace_id)).size).toBe(snapshot.workspaces.length);
  });
});

describe("keyBytes", () => {
  it("types printable characters, Enter, Tab, Backspace, and Alt or Shift on a character hc has no key for; leaves the rest to hc's encoder", () => {
    expect(["x", "A", "한", " ", "Enter", "tab", "Backspace", "plus", "shift+plus", "alt+|", "alt+shift+plus"].map(keyBytes))
      .toEqual(["x", "A", "한", " ", "\r", "\t", "\x7f", "+", "+", "\x1b|", "\x1b+"]);
    for (const key of ["\x7f", "\x1b", "esc", "Up", "ctrl+enter", "shift+tab", "ctrl+c", "C-d", "alt+x", "ctrl+|", "constructor", "ctrl+alt+shift+left"]) expect(keyBytes(key)).toBeNull();
  });
});
