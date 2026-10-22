# Personal production

This directory belongs to the fork's `personal/production` integration branch,
not either upstream Copilot PR. Fork `main` stays an upstream mirror.

The local `ovis-personal` command reads `~/.config/ovis-personal/config.json`.
That private configuration contains this installation's paths, never Git-tracked
credentials. The user service is `ovis-personal.service`, serving localhost:7318.

```sh
ovis-personal status
ovis-personal update
ovis-personal rollback
systemctl --user restart ovis-personal.service
journalctl --user -u ovis-personal.service -n 80 --no-pager
```

`update` fetches upstream, merges it and every open PR by the configured author
from the configured fork into a separate candidate branch, then prepares a
detached, pinned release. Conflicts stop the operation and leave the candidate
for inspection; they never modify the running release or PR branches.

Before promotion, the command runs the personal lifecycle tests, full fast
checks, isolated Copilot API/browser/menu checks and checksum-verified remote
bundle builds. Logs and verification receipts live under
`~/.local/share/ovis-personal/`. Browser prerequisites are configured there.
An existing receipt is reusable only while source and recorded artifacts match.

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
restore the previous pinned local and remote builds. A no-change update preserves
the existing rollback target.

The production branch and clean fork `main` are pushed after successful updates.
No upstream PR is merged. Closed/merged PR branches are not merged again by the
update command; their already-integrated history is reconciled with upstream.
Nothing updates on a timer: run the command when ready to verify and promote.
