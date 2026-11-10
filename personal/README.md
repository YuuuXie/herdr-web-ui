# Personal production

This directory lives on the fork's `personal/tooling` branch: personal deployment
tooling only, kept current with upstream `main` and never part of an upstream PR.
Fork `main` stays an upstream mirror.

Each release is a new versioned branch, `personal/production-YYYYMMDD`, built from
the audited upstream `main`, then merging the selected open PR heads and
`personal/tooling`. It never starts from an earlier release, so its diff from `main`
is exactly those PRs plus this tooling; anything else is drift to investigate.
After a successful deploy, the maintainer manually publishes the release branch,
checks it out in the controller worktree (`repository` in the private configuration)
and prunes older release branches, keeping the two newest plus the current and
previous deployed releases. The controller does none of this itself; pinned
releases stay reachable through their local release checkouts. Releases are
prepared and deployed by the controller already checked out in `repository`, so
controller changes take effect from the following release.

The local `ovis-personal` command reads `~/.config/ovis-personal/config.json`.
That private configuration contains this installation's paths, never Git-tracked
credentials. The user service is `ovis-personal.service`, serving localhost:7318.

```sh
ovis-personal status
ovis-personal prepare <full-release-sha>
ovis-personal deploy <full-release-sha>
ovis-personal rollback
systemctl --user restart ovis-personal.service
journalctl --user -u ovis-personal.service -n 80 --no-pager
```

`prepare <revision>` resolves the revision, creates a detached, pinned release
checkout of that commit and verifies it. `deploy` needs the release's full SHA and
promotes only a verified release.

Before promotion, `prepare` runs the personal lifecycle tests, full fast
checks, isolated Copilot API/browser/menu checks and checksum-verified remote
bundle builds. Logs and verification receipts live under
`~/.local/share/ovis-personal/`. Browser prerequisites are configured there.
An existing receipt is reusable only while source and recorded artifacts match.

For an explicitly approved partial rollout, `prepare <sha> --exclude-machine <id>`
and `deploy <sha> --exclude-machine <id>` leave that enabled SSH PC untouched.
Repeat the flag for multiple PCs. Exclusions must name existing enabled SSH PCs;
the local PC cannot be excluded. Preparation receipts and recovery journals retain
the exact exclusions, and promotion refuses a different scope. All selected PCs
still require connectivity, authenticated bundle deployment and preservation checks.
This does not disable or remove the excluded PC from Ovis.
Exclusions apply to this controller rollout, not the app's existing automatic
bridge-update preference when a PC later reconnects.

Remote deployment reuses upstream's strict SSH, authenticated bridge identity,
checksum verification and immutable runtime installation. It explicitly refreshes
the bundle by content even when the upstream bundle version is unchanged: the
stock updater otherwise regards same-version bridges as already current.
Only the authenticated managed bridge PID is restarted. Recovery can also stop
the deployment's exact failed candidate using SSH-verified executable, process
birth, owner, entrypoint and session evidence when HTTP is unavailable. Existing herdr daemons,
agent processes, hooks and global runtimes are not installed or stopped.
This installation's deployment helper supports existing Linux SSH hosts.

The service runs `server/index.ts` directly, not the stock release supervisor.
It preserves the existing state directory and disables stock release installation.
The stock plugin is disabled after migration so it cannot race this installation.
Do not use the stock updater to manage this custom build.

Promotion keeps `current` and `previous` links and checks the exact local revision,
every enabled PC and existing pane identities. A failed promotion restores the
previous release. A transaction is recorded before remote staging changes any
activation pointer. It retains each host's original immutable runtime and permits
explicit recovery even if the web server or a remote bridge is down. Recovery
starts the previous local app independently, attempts every host, and retains the
original journal if an outage needs another attempt. The initial fallback restores
the prior verified preview and its exact original remote runtimes; later rollbacks
restore the previous pinned local and remote builds. Redeploying the current release preserves
the existing rollback target.

No upstream PR is merged here; merged PRs arrive through `main`. Nothing updates on a timer.
