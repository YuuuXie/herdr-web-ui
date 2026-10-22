#!/usr/bin/env python3
"""Explicitly verified, pinned personal Ovis releases; never updates the running checkout."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

SHA = re.compile(r"^[0-9a-f]{40}$")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def switch_link(path, target):
    temporary = path.with_name(path.name + ".next")
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target, target_is_directory=True)
    temporary.replace(path)


def verified_report(report, revision):
    end = report.get("source", {}).get("end", {})
    return (
        report.get("status") == "success"
        and report.get("verification", {}).get("status") == "verified"
        and report.get("source", {}).get("unchanged") is True
        and end.get("head") == revision
        and end.get("trackedDiffSha256") == hashlib.sha256(b"").hexdigest()
        and end.get("untrackedFileCount") == 0
    )


class Production:
    def __init__(self, config):
        self.config = config
        self.repo = Path(config["repository"]).resolve()
        self.data = Path(config["data_dir"]).resolve()
        self.releases = Path(config["releases_dir"]).resolve()
        self.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.env = {**os.environ, **config.get("environment", {}), "PYTHONDONTWRITEBYTECODE": "1"}
        self.env["PATH"] = config["tool_path"] + ":" + self.env.get("PATH", "")
        self.env["UNIT_TEST_WORKERS"] = "2"
        self.env["GIT_SSH_COMMAND"] = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15"

    def run(self, args, cwd=None, capture=False, input_text=None):
        result = subprocess.run(
            list(map(str, args)), cwd=cwd or self.repo, env=self.env,
            input=input_text, text=True, stdout=subprocess.PIPE if capture else None,
            check=True,
        )
        return result.stdout.strip() if capture else ""

    def git(self, *args, cwd=None):
        return self.run(["git", "--no-pager", *args], cwd=cwd, capture=True)

    def json_get(self, path, timeout=30):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.config['port']}{path}", timeout=timeout) as response:
            return json.load(response)

    def machines(self):
        roster = self.json_get("/api/machines")["machines"]
        if any(m["state"] != "connected" for m in roster if m.get("enabled")):
            raise RuntimeError("Reconnect every enabled PC before deployment")
        return [{"id": m["id"], "target": m["target"]} for m in roster if m.get("enabled") and m["kind"] == "ssh"]

    def remote(self, release, mode, machines):
        request = {"stateDir": self.config["state_dir"], "machines": machines}
        output = self.run(
            [self.config["bun"], "personal/remote.ts", mode], cwd=release, capture=True,
            input_text=json.dumps(request),
        )
        return json.loads(output)

    def receipt(self, release):
        release = Path(release).resolve()
        if release.parent != self.releases or not SHA.fullmatch(release.name):
            raise RuntimeError("Only a pinned personal release can be promoted")
        receipt = json.loads((self.data / "verified" / f"{release.name}.json").read_text())
        if receipt["revision"] != release.name or self.git("rev-parse", "HEAD", cwd=release) != release.name:
            raise RuntimeError("Release revision does not match its verification")
        if self.git("status", "--porcelain", cwd=release):
            raise RuntimeError("Release source was modified after verification")
        for filename, expected in receipt["artifacts"].items():
            path = release / filename
            if digest(path) != expected:
                raise RuntimeError(f"Verified release artifact changed: {filename}")
        report = json.loads(Path(receipt["report"]).read_text())
        if not verified_report(report, release.name):
            raise RuntimeError("Release verification report is not a clean successful source check")
        return receipt

    def checked_step(self, release, label, args):
        logs = self.data / "logs" / release.name
        logs.mkdir(parents=True, exist_ok=True)
        filename = logs / (label + ".log")
        print(f"{label}: {filename}", flush=True)
        with filename.open("w") as output:
            result = subprocess.run(args, cwd=release, env=self.env, stdout=output, stderr=subprocess.STDOUT, umask=0o022)
        if result.returncode:
            print("\n".join(filename.read_text(errors="replace").splitlines()[-70:]), file=sys.stderr)
            raise RuntimeError(f"{label} failed ({result.returncode}); running production was not changed")

    def prepare(self, revision):
        revision = self.git("rev-parse", revision + "^{commit}")
        if not SHA.fullmatch(revision):
            raise RuntimeError("Expected one full Git commit")
        release = self.releases / revision
        saved = self.data / "verified" / f"{revision}.json"
        if saved.exists():
            self.receipt(release)
            return release
        if not release.exists():
            self.run(["git", "worktree", "add", "--detach", release, revision])
        if self.git("status", "--porcelain", cwd=release):
            raise RuntimeError("Candidate release is dirty")
        if not (release / "node_modules").exists():
            # A fresh worktree has no installed tooling; retain the actual missing-tool failure.
            missing = subprocess.run(
                [self.config["bun"], "run", "build"], cwd=release, env=self.env,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
            if missing.returncode == 0:
                raise RuntimeError("Unexpected inherited build tooling in a fresh release")
            print(missing.stdout.strip(), flush=True)
            self.run([self.config["bun"], "install", "--frozen-lockfile"], cwd=release)
        self.checked_step(release, "personal-tests", ["python3", "-B", "-m", "unittest", "discover", "-s", "personal", "-p", "test_*.py"])
        self.checked_step(release, "personal-remote-tests", [self.config["bun"], "test", "personal/remote.test.ts"])
        reports = set((release / "node_modules/.cache/check").glob("*/report.json"))
        self.checked_step(release, "fast", [self.config["bun"], "run", "check", "fast"])
        fresh = set((release / "node_modules/.cache/check").glob("*/report.json")) - reports
        if len(fresh) != 1:
            raise RuntimeError("Expected exactly one fast verification report")
        report = fresh.pop()
        if not verified_report(json.loads(report.read_text()), revision):
            raise RuntimeError("Fast checks did not verify clean, unchanged candidate source")
        self.checked_step(release, "copilot-contract", [
            self.config["bun"], "run", "check", "run", self.config["bun"], "test", "--timeout", "20000",
            "server/copilot.contract.test.ts",
        ])
        self.checked_step(release, "copilot-browser", [
            self.config["bun"], "run", "check", "run", "--build",
            self.config["bun"], "scripts/copilot-chat-browser-qa.ts",
        ])
        self.checked_step(release, "copilot-menu", [
            self.config["bun"], "run", "check", "run", "--build", self.config["bun"], "personal/menu-qa.ts",
        ])
        machines = self.machines()
        platforms = {m["platform"] for m in self.remote(release, "inspect", machines)["machines"]}
        for platform in sorted(platforms):
            self.checked_step(release, "bundle-" + platform, [self.config["bun"], "run", "build:remote", platform])
        if self.git("status", "--porcelain", cwd=release):
            raise RuntimeError("Verification changed candidate source")
        artifacts = {}
        files = list((release / "dist").rglob("*")) + list((release / "remote-bundles").glob("*"))
        for filename in files:
            if filename.is_file():
                artifacts[str(filename.relative_to(release))] = digest(filename)
        atomic_json(saved, {"revision": revision, "report": str(report), "artifacts": artifacts})
        return release

    def wait_healthy(self, revision, before):
        deadline = time.monotonic() + 90
        last = "not ready"
        while time.monotonic() < deadline:
            try:
                health = self.json_get("/api/health", timeout=5)
                roster = self.json_get("/api/machines", timeout=5)["machines"]
                if health.get("ok") and health.get("web_ui", {}).get("revision") == revision:
                    if all(m["state"] == "connected" for m in roster if m.get("enabled")):
                        for old in before:
                            now = next((m for m in roster if m["id"] == old["id"]), None)
                            if now is None:
                                raise RuntimeError("A pre-existing PC is missing after promotion")
                            old_ids = {p["pane_id"] for p in old["snapshot"]["panes"]}
                            if not old_ids.issubset(p["pane_id"] for p in now["snapshot"]["panes"]):
                                raise RuntimeError("A pre-existing pane is missing after promotion")
                        return
                last = "waiting for the pinned revision and every enabled PC"
            except (OSError, ValueError, urllib.error.URLError) as error:
                last = str(error)
            time.sleep(1)
        raise RuntimeError("Production health check failed: " + last)

    def check_release(self, release):
        release = Path(release).resolve()
        fallback = Path(self.config["fallback_release"]).resolve()
        if release == fallback:
            if self.git("status", "--porcelain", cwd=release) or self.git("rev-parse", "HEAD", cwd=release) != self.config["fallback_revision"]:
                raise RuntimeError("The emergency preview was modified")
        else:
            self.receipt(release)

    def restore(self, saved):
        old = Path(saved["previous"]).resolve()
        helper = Path(saved["helper"]).resolve()
        self.check_release(old)
        self.receipt(helper)
        errors = []
        current = self.data / "current"
        if saved.get("local_stopped") or current.resolve() != old:
            try:
                self.run(["systemctl", "--user", "stop", self.config["service"]])
                switch_link(current, old)
                self.run(["systemctl", "--user", "start", self.config["service"]])
            except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
                errors.append(f"Local service restoration failed: {error}")
        for machine in saved["machines"]:
            try:
                self.remote(helper, "restore", [machine])
            except (RuntimeError, OSError, ValueError, subprocess.CalledProcessError) as error:
                errors.append(f"PC {machine['id']} restoration failed: {error}")
        try:
            self.wait_healthy(self.git("rev-parse", "HEAD", cwd=old), saved["before"])
        except (RuntimeError, OSError, ValueError, KeyError) as error:
            errors.append(f"Restored production health: {error}")
        if errors:
            atomic_json(self.data / "transaction.json", {**saved, "errors": errors})
            raise RuntimeError("; ".join(errors) + "; recovery journal retained, run ovis-personal rollback after resolving the outage")
        (self.data / "transaction.json").unlink(missing_ok=True)

    def rollback(self):
        transaction = self.data / "transaction.json"
        saved = json.loads((transaction if transaction.exists() else self.data / "previous-deployment.json").read_text())
        atomic_json(transaction, saved)
        self.restore(saved)
        print(f"Previous production release restored on localhost:{self.config['port']}", flush=True)

    def deploy(self, release):
        release = Path(release).resolve()
        self.receipt(release)
        current = self.data / "current"
        old = current.resolve() if current.is_symlink() else Path(self.config["fallback_release"]).resolve()
        if old == release:
            print("The verified release is already current; rollback target unchanged", flush=True)
            return
        self.check_release(old)
        roster = self.json_get("/api/machines")["machines"]
        before = [{"id": m["id"], "snapshot": {"panes": [{"pane_id": p["pane_id"]} for p in m["snapshot"]["panes"]]}} for m in roster if m.get("enabled")]
        machines = self.remote(release, "inspect", self.machines())["machines"]
        transaction = self.data / "transaction.json"
        saved = {"previous": str(old), "candidate": str(release), "helper": str(release),
                 "machines": machines, "before": before, "local_stopped": False}
        # The upstream installer swaps the remote alias while staging, so recovery must already exist.
        atomic_json(transaction, saved)
        try:
            for machine in machines:
                self.remote(release, "stage", [machine])
            saved["local_stopped"] = True
            atomic_json(transaction, saved)
            self.run(["systemctl", "--user", "stop", self.config["service"]])
            for machine in machines:
                self.remote(release, "activate", [machine])
            switch_link(current, release)
            self.run(["systemctl", "--user", "start", self.config["service"]])
            self.wait_healthy(self.git("rev-parse", "HEAD", cwd=release), before)
        except (RuntimeError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
            print(f"Promotion failed: {error}; restoring {old}", file=sys.stderr, flush=True)
            self.restore(saved)
            raise RuntimeError("Promotion failed; the previous release was restored") from error
        switch_link(self.data / "previous", old)
        atomic_json(self.data / "previous-deployment.json", saved)
        transaction.unlink()
        print(f"Production now runs {self.git('rev-parse', 'HEAD', cwd=release)} on localhost:{self.config['port']}", flush=True)

    def update(self):
        if self.git("status", "--porcelain"):
            raise RuntimeError("Production integration checkout is dirty")
        self.run(["git", "fetch", "upstream", "main"])
        self.run(["git", "fetch", "origin"])
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
        branch = "personal/candidate-" + stamp
        candidate = self.repo.parent / ("personal-candidate-" + stamp)
        self.run(["git", "worktree", "add", "-b", branch, candidate, "personal/production"])
        trailer = "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\nCopilot-Session: 1fad73aa-cbc5-42dd-916b-64e5198bc512"
        def merge(revision, message):
            self.run(["git", "-c", "core.editor=true", "merge", "--no-ff", revision, "-m", message, "-m", trailer], cwd=candidate)
        merge("upstream/main", "chore(personal): integrate current upstream")
        # REST listing avoids the search-index lag observed immediately after the upstream rename.
        pages = json.loads(self.run([
            self.config["gh"], "api", "--paginate", "--slurp",
            f"repos/{self.config['upstream']}/pulls?state=open&per_page=100",
        ], capture=True))
        for pr in sorted((p for page in pages for p in page if p["user"]["login"] == self.config["author"]), key=lambda p: p["number"]):
            if pr["head"]["repo"]["full_name"] != self.config["fork"]:
                raise RuntimeError("An authored PR uses another fork; review its source explicitly")
            self.run(["git", "fetch", "origin", pr["head"]["ref"]], cwd=candidate)
            fetched = self.git("rev-parse", "FETCH_HEAD", cwd=candidate)
            if fetched != pr["head"]["sha"]:
                raise RuntimeError("A PR changed during candidate creation; run update again")
            merge(fetched, f"chore(personal): integrate PR #{pr['number']}")
        revision = self.git("rev-parse", "HEAD", cwd=candidate)
        release = self.prepare(revision)
        self.deploy(release)
        self.run(["git", "merge", "--ff-only", revision])
        self.run(["git", "push", "origin", "personal/production:personal/production"])
        self.run(["git", "merge-base", "--is-ancestor", "origin/main", "upstream/main"])
        self.run(["git", "push", "origin", "upstream/main:main"])
        self.run(["git", "worktree", "remove", candidate])
        self.run(["git", "branch", "-d", branch])

    def serve(self):
        release = (self.data / "current").resolve(strict=True)
        self.check_release(release)
        revision = self.git("rev-parse", "HEAD", cwd=release)
        compatibility = self.config.get("fallback_environment", {}) if release == Path(self.config["fallback_release"]).resolve() else {}
        env = {**self.env, **compatibility, "HOST": "127.0.0.1", "PORT": str(self.config["port"]),
               "HERDR_SOCKET": self.config["herdr_socket"],
               "OVIS_STATE_DIR": self.config["state_dir"], "OVIS_REVISION": revision,
               "OVIS_AUTO_UPDATE": "0"}
        os.chdir(release)
        os.execve(self.config["bun"], [self.config["bun"], "server/index.ts"], env)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "deploy", "update", "rollback", "serve", "status"])
    parser.add_argument("revision", nargs="?")
    args = parser.parse_args()
    config = json.loads((Path.home() / ".config/ovis-personal/config.json").read_text())
    app = Production(config)
    if args.command == "serve":
        app.serve()
        return
    if args.command == "status":
        print(json.dumps(app.json_get("/api/health"), indent=2))
        return
    with (app.data / "operation.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        transaction = app.data / "transaction.json"
        if transaction.exists() and args.command != "rollback":
            raise RuntimeError("An interrupted promotion needs recovery; run ovis-personal rollback")
        if args.command == "prepare":
            print(app.prepare(args.revision or "personal/production"))
        elif args.command == "deploy":
            app.deploy(app.releases / (args.revision or app.git("rev-parse", "personal/production")))
        elif args.command == "update":
            app.update()
        else:
            app.rollback()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"ovis-personal: {error}", file=sys.stderr)
        sys.exit(1)
