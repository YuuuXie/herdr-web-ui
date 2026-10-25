import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../scripts/test-herdr.ts";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { chromium } from "playwright-core";
import { chromePath } from "../scripts/chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-personal-menu-"));
const server = createServer({
  hostname: "127.0.0.1", port: 0, token: "", stateDir: join(root, "state"),
  herdrConfigPath: join(root, "config.toml"), herdrProfiles: async () => [],
  tailscaleOwner: null, usage: new UsageService(undefined, []),
});
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, chromiumSandbox: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  const submissions: { path: string; agent: { kind: string } }[] = [];
  await page.route(/\/api\/(?:workspace|tab)\/create$/, async (route) => {
    const body = route.request().postDataJSON();
    submissions.push({ path: new URL(route.request().url()).pathname, agent: body.agent });
    await route.fulfill({ status: 400, json: { error: { code: "fixture_stop", message: "Owned fixture: no real agent launched" } } });
  });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  for (const mode of ["workspace", "tab"]) {
    if (mode === "workspace") await page.getByRole("button", { name: /^New workspace on / }).click();
    else {
      await page.locator(".tab-strip").getByRole("tab", { selected: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: "New tab with agent...", exact: true }).or(
        page.getByRole("menuitem", { name: "New tab with agent\u2026", exact: true }),
      ).click();
    }
    const dialog = page.getByRole("dialog", { name: mode === "workspace" ? /^New workspace/ : /^New tab/ });
    const picker = dialog.getByRole("combobox", { name: "Agent", exact: true });
    await picker.click();
    await page.getByRole("option").filter({ hasText: "GitHub Copilot" }).click();
    assert.match(await picker.innerText(), /GitHub Copilot/);
    await dialog.getByRole("button", { name: "Start", exact: true }).click();
    await dialog.getByText("Owned fixture: no real agent launched", { exact: true }).waitFor();
    assert.equal(submissions.at(-1)?.path, `/api/${mode}/create`);
    assert.equal(submissions.at(-1)?.agent.kind, "copilot");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  assert.equal(submissions.length, 2);
  console.log("PASS personal Copilot workspace/tab pickers and creation requests");
} finally {
  await browser.close();
  server.stop();
  rmSync(root, { recursive: true, force: true });
}
