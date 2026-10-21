import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearFileCache, filesNamed, GIT_LIST_DEADLINE_MS, GIT_LIST_MAX_BYTES, paneFiles, setGitListOptions } from "./files.ts";

const roots: string[] = [];
const inheritedGitDir = process.env["GIT_DIR"];
afterEach(() => {
  clearFileCache();
  setGitListOptions();
  if (inheritedGitDir === undefined) delete process.env["GIT_DIR"];
  else process.env["GIT_DIR"] = inheritedGitDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "files-search-"));
  roots.push(root);
  mkdirSync(join(root, "src", "components"), { recursive: true });
  mkdirSync(join(root, "node_modules", "hidden"), { recursive: true });
  writeFileSync(join(root, "src", "components", "PromptCard.tsx"), "export {};");
  writeFileSync(join(root, "src", "api.ts"), "export {};");
  writeFileSync(join(root, "README.md"), "read me");
  writeFileSync(join(root, "node_modules", "hidden", "prompt.ts"), "hidden");
  return root;
}

describe("paneFiles", () => {
  it("walks a non-git tree, skips heavy directories, and ranks matches", async () => {
    const root = fixture();
    expect(await paneFiles(root, "prompt", 20)).toEqual(["src/components/PromptCard.tsx"]);
    expect(await paneFiles(root, "sat", 20)).toContain("src/api.ts");
    expect(await paneFiles(root, "", 2)).toHaveLength(2);
  });

  it("uses tracked and untracked non-ignored files in a git repository", async () => {
    const root = fixture();
    const init = Bun.spawnSync(["git", "init", "-q", root]);
    expect(init.exitCode).toBe(0);
    writeFileSync(join(root, ".gitignore"), "README.md\n");
    const files = await paneFiles(root, "", 100);
    expect(files).toContain("src/api.ts");
    expect(files).not.toContain("README.md");
  });

  it("clamps the result limit to one through one hundred", async () => {
    const root = fixture();
    expect(await paneFiles(root, "", 0)).toHaveLength(3);
    expect(await paneFiles(root, "", 1)).toHaveLength(1);
  });

  it("preserves Unicode and newline filenames returned by git", async () => {
    const root = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    for (const name of ["설계 문서.md", "line\nbreak.txt"]) writeFileSync(join(root, name), "fixture");
    const files = await paneFiles(root, "", 100);
    expect(files).toContain("설계 문서.md");
    expect(files).toContain("line\nbreak.txt");
  });

  it("matches a Unicode query across normalization forms", async () => {
    const root = fixture();
    const name = "문서.md".normalize("NFD");
    writeFileSync(join(root, name), "fixture");
    clearFileCache();
    expect(await paneFiles(root, "문서".normalize("NFC"))).toContain(name);
  });

  it("preserves existing ASCII matches and scores for decomposed names", async () => {
    const root = mkdtempSync(join(tmpdir(), "files-unicode-search-"));
    roots.push(root);
    for (const name of [
      "abc/x.md",
      "café.txt".normalize("NFD"),
      "docs/readme.md",
      "ée/x.md",
      "éé/x.md".normalize("NFD"),
      "src/main.ts",
      "x.md",
      "메모.md",
      "문서.md".normalize("NFD"),
    ]) {
      const path = join(root, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "fixture");
    }
    clearFileCache();
    expect(await paneFiles(root, "cafe", 100)).toContain("café.txt".normalize("NFD"));
    expect(await paneFiles(root, "x", 100)).toEqual([
      "x.md",
      "ée/x.md",
      "abc/x.md",
      "éé/x.md".normalize("NFD"),
      "café.txt".normalize("NFD"),
    ]);
    expect(await paneFiles(root, "md", 100)).toEqual([
      "x.md",
      "메모.md",
      "ée/x.md",
      "abc/x.md",
      "문서.md".normalize("NFD"),
      "éé/x.md".normalize("NFD"),
      "docs/readme.md",
    ]);
  });

  it("honors git ignores from a nested working directory", async () => {
    const root = fixture();
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    writeFileSync(join(root, ".gitignore"), "src/secret.txt\n");
    writeFileSync(join(root, "src", "secret.txt"), "private");
    expect(await paneFiles(join(root, "src"), "", 100)).toEqual(["api.ts", "components/PromptCard.tsx"]);
  });

  it("keeps files listed after a folder of thousands in the git inventory", async () => {
    const root = mkdtempSync(join(tmpdir(), "files-search-"));
    roots.push(root);
    mkdirSync(join(root, "a-data"));
    for (let index = 0; index < 5_100; index += 1) writeFileSync(join(root, "a-data", `page-${index}.txt`), "");
    mkdirSync(join(root, "docs", "design"), { recursive: true });
    writeFileSync(join(root, "docs", "design", "11_two-version-design.md"), "# design");
    expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
    expect(await paneFiles(root, "two-version", 20)).toEqual(["docs/design/11_two-version-design.md"]);
  });
});

function gitRepository(root: string): void {
  expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
  // README.md is left out by git alone: the bounded walk would list it
  writeFileSync(join(root, ".gitignore"), "README.md\n");
}

/** A test-owned stand-in for git, in a folder of its own outside the tree it is asked about. */
function fakeGit(script: (folder: string) => string): { git: string; folder: string } {
  const folder = mkdtempSync(join(tmpdir(), "files-fake-git-"));
  roots.push(folder);
  const git = join(folder, "git");
  writeFileSync(git, `#!/bin/sh\n${script(folder)}\n`);
  chmodSync(git, 0o755);
  return { git, folder };
}

/** Resolves once `name` exists in `folder`; the watch is set up before whatever creates it runs. */
function appears(folder: string, name: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(folder, () => {
      if (existsSync(join(folder, name))) finish();
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(new Error(`${name} did not appear within ${timeoutMs} ms`));
    }, timeoutMs);
    function finish() {
      clearTimeout(timer);
      watcher.close();
      resolve();
    }
    if (existsSync(join(folder, name))) finish();
  });
}

const INERT_ARGV = ["--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false"];

describe("git inventories", () => {
  it("isolates both Git inventories from inherited repository variables", async () => {
    const root = fixture();
    gitRepository(root);
    const foreign = mkdtempSync(join(tmpdir(), "files-foreign-"));
    roots.push(foreign);
    expect(Bun.spawnSync(["git", "init", "-q", foreign]).exitCode).toBe(0);
    writeFileSync(join(foreign, "foreign-only.txt"), "elsewhere");
    expect(Bun.spawnSync(["git", "-C", foreign, "add", "foreign-only.txt"]).exitCode).toBe(0);

    // a server started with these set (from a hook, say) inherits them; Bun.spawn ignores later edits to process.env
    const script = `import { filesNamed, paneFiles } from ${JSON.stringify(join(import.meta.dir, "files.ts"))};
      const root = process.env.FILES_ROOT;
      console.log(JSON.stringify({ listed: await paneFiles(root, "", 100), foreign: filesNamed(root, "foreign-only.txt"), api: filesNamed(root, "api.ts") }));`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, FILES_ROOT: root, GIT_DIR: join(foreign, ".git"), GIT_WORK_TREE: foreign, GIT_INDEX_FILE: join(foreign, ".git", "index") },
    });
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(exitCode).toBe(0);
    const { listed, foreign: foreignNamed, api } = JSON.parse(output) as { listed: string[]; foreign: string[]; api: string[] };
    expect(listed).toContain("src/api.ts");
    expect(listed).not.toContain("README.md");
    expect(listed).not.toContain("foreign-only.txt");
    expect(foreignNamed).toEqual([]);
    expect(api).toEqual(["src/api.ts"]);
  });

  it("hands both subprocess APIs the inert argv, environment, cap and deadline", async () => {
    const root = fixture();
    gitRepository(root);
    process.env["GIT_DIR"] = join(root, "elsewhere");
    const spawn = spyOn(Bun, "spawn");
    const spawnSync = spyOn(Bun, "spawnSync");
    try {
      await paneFiles(root, "", 100);
      filesNamed(root, "api.ts");
      const argv = ["git", ...INERT_ARGV, "-C", root, "ls-files", "-z", "-co", "--exclude-standard"];
      const calls = [spawn.mock.calls[0], spawnSync.mock.calls[0]] as unknown as [string[], { stdin?: string; env?: Record<string, string> }][];
      for (const [command, options] of calls) {
        expect(command).toEqual(argv);
        expect(options.stdin).toBe("ignore");
        expect(options.env?.["GIT_DIR"]).toBeUndefined();
        expect(options.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" });
      }
      expect(spawnSync.mock.calls[0]![1]).toMatchObject({ timeout: GIT_LIST_DEADLINE_MS, maxBuffer: GIT_LIST_MAX_BYTES });
      expect(GIT_LIST_MAX_BYTES).toBe(16 * 1024 * 1024);
      expect(GIT_LIST_DEADLINE_MS).toBe(3_000);
    } finally {
      spawn.mockRestore();
      spawnSync.mockRestore();
    }
  });

  it("disables a local fsmonitor for both inventories", async () => {
    const root = fixture();
    gitRepository(root);
    expect(Bun.spawnSync(["git", "-C", root, "add", "src"]).exitCode).toBe(0);
    const hook = fakeGit((folder) => `touch "${folder}/ran"\nexit 1`);
    expect(Bun.spawnSync(["git", "-C", root, "config", "core.fsmonitor", hook.git]).exitCode).toBe(0);
    const config = readFileSync(join(root, ".git", "config"), "utf8");

    const files = await paneFiles(root, "", 100);
    expect(files).toContain("src/components/PromptCard.tsx");
    expect(files).not.toContain("README.md");
    expect(filesNamed(root, "PromptCard.tsx")).toEqual(["src/components/PromptCard.tsx"]);
    expect(existsSync(join(hook.folder, "ran"))).toBe(false);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe(config);
  });

  it("falls back instead of accepting an overflowing listing", async () => {
    const root = fixture();
    const cap = 64;
    const listing = join(mkdtempSync(join(tmpdir(), "files-listing-")), "listing");
    roots.push(join(listing, ".."));
    const { git } = fakeGit(() => `exec cat "${listing}"`);
    setGitListOptions({ git, maxBytes: cap });
    for (const bytes of [cap - 1, cap, cap + 1]) {
      // two complete NUL-terminated names, `bytes` long in all
      const second = `ghost-${bytes}-`.padEnd(bytes - "ghost-first\0".length - 1, "x");
      writeFileSync(listing, `ghost-first\0${second}\0`);
      expect(readFileSync(listing).byteLength).toBe(bytes);
      clearFileCache();
      const listed = await paneFiles(root, "", 100);
      const named = filesNamed(root, second);
      if (bytes <= cap) {
        expect(listed).toEqual([second, "ghost-first"].sort());
        expect(named).toEqual([second]);
      } else {
        expect(listed).toEqual(["README.md", "src/api.ts", "src/components/PromptCard.tsx"]);
        expect(named).toEqual([]);
        expect(filesNamed(root, "ghost-first")).toEqual([]);
      }
    }
  });

  it("ends an inventory whose descendant holds stdout", async () => {
    const root = fixture();
    const deadlineMs = 300;
    // git prints a whole name and exits 0, leaving a process that keeps its stdout open
    const { git, folder } = fakeGit((dir) => `printf 'ghost-held\\0'\nsleep 36 &\necho $! >> "${dir}/pids"\ntouch "${dir}/exited"\nexit 0`);
    setGitListOptions({ git, deadlineMs });
    const exited = appears(folder, "exited", 5_000);
    try {
      const started = performance.now();
      const listed = paneFiles(root, "", 100);
      await exited;
      expect(await listed).toEqual(["README.md", "src/api.ts", "src/components/PromptCard.tsx"]);
      expect(performance.now() - started).toBeLessThan(deadlineMs + 1_000);

      const startedNow = performance.now();
      expect(filesNamed(root, "ghost-held")).toEqual([]);
      expect(performance.now() - startedNow).toBeLessThan(deadlineMs + 1_000);
    } finally {
      const pids = existsSync(join(folder, "pids")) ? readFileSync(join(folder, "pids"), "utf8").trim().split("\n").map(Number) : [];
      for (const pid of pids) process.kill(pid, "SIGKILL");
      const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
      const deadline = Date.now() + 5_000;
      while (!pids.every(gone)) {
        if (Date.now() > deadline) throw new Error(`descendants ${pids.join(", ")} outlived SIGKILL`);
        await Bun.sleep(25);
      }
      expect(pids).toHaveLength(2);
    }
  });
});
