# ovis-pty-sidecar

A PTY host written in Rust that speaks the protocol of `server/pty/pty-host.mjs`: the same argv
(`<cols> <rows> <command> [args...]`), the same newline-delimited JSON control frames on stdin
(`i` input, `r` resize, `p` pause/resume output reads, `w` SIGWINCH at the current size), the pty's
bytes on stdout, and the child's exit code. Linux and macOS only.

Its stdin is bounded: a control frame longer than 17 MiB is discarded up to its newline, and once
16 MiB of input wait for a command that is not reading (each frame counted with 80 bytes on top of its
own, empty ones not queued), further input frames are dropped (one stderr line per overflow) while
resize, pause and stop frames keep working. The command runs as the
leader of its own process group, which the host kills whenever it ends: the command exiting, a stop
(stdin closed, SIGTERM, SIGINT, SIGHUP, SIGQUIT, a broken stdout) or a crash (SIGABRT, SIGSEGV,
SIGBUS, SIGILL, SIGFPE). A host killed outright (SIGKILL) cannot do that: on Linux the command itself
is killed with it (`PR_SET_PDEATHSIG`), and the rest of the group gets the pty's hangup. After the
command exits, its output is read until EOF, 200 ms of quiet or 2 s; output paused then is held for
up to 15 s.

## Turning it on

The Node sidecar stays the default. The server runs this host instead on Linux and macOS when
`OVIS_PTY_SIDECAR=rust` is set and the binary passes a check (`server/pty/host.ts`):

```bash
cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml
OVIS_PTY_SIDECAR=rust bun run server
```

Each release ships this host, and the plugin's build, every update installed from the app and
`install.sh` put the binary for the PC in `bin/ovis-pty-sidecar` beside the server, with a record of
its SHA-256 (`scripts/pty-sidecar.ts`). The server takes that binary while its record vouches for it,
else `crates/pty-sidecar/target/release/ovis-pty-sidecar`. So for the app installed as a herdr
plugin, turning it on takes one line in the `env` file in the directory that
`herdr plugin config-dir devswha.ovis` prints, then a restart of the app:

```
OVIS_PTY_SIDECAR=rust
```

`OVIS_PTY_SIDECAR_BIN` points at a binary elsewhere (a leading `~/` is expanded, as that file is not a
shell). Name the binary itself, or a wrapper that `exec`s it, so that the server sees how the host
ended.

## When it cannot run

The server falls back to the Node sidecar, says why once on stderr, and keeps attaching:

- **Before the first use** (at startup, beside the Node check), it runs the binary twice: with no
  arguments it must print its usage line and exit 2, and `1 1 true` must exit 0. A missing file,
  one that is not executable or not for this CPU, another program, a host that crashes or hangs
  (3 s), or a PC where it cannot open a pty fails the check, and every attach uses Node.
- **When it cannot be started** after passing (the file was removed or replaced), that attach
  starts on Node.
- **When it ends by a signal the server did not send** (a crash, the out-of-memory killer), that
  attach ends as an attach does when its host stops, and every later one uses Node until the
  server restarts.

Other values of `OVIS_PTY_SIDECAR` than `rust` and `node` are reported once and mean Node.

Whether a pane is attached or mirrored still depends on Node: a PC without Node mirrors its panes
with this host turned on too. Windows and remote PCs always run the Node sidecar (or mirror); this
host is not shipped in the remote PC bundles.

## Checks

```bash
cargo test --manifest-path crates/pty-sidecar/Cargo.toml   # frame parsing
bun test server/pty/host.test.ts                           # the same PtySession checks on both hosts
OVIS_PTY_SIDECAR=rust bun test server/pty/session.test.ts  # the Node host's own tests, on this one
bun scripts/pty-sidecar-bench.ts                           # startup, teardown, echo, throughput, memory, a real attach
```

The Rust checks in `server/pty/host.test.ts` are skipped when the binary has not been built. CI's
Rust PTY host job builds it on GitHub's Ubuntu image and runs `cargo test`, `host.test.ts` and
`session.test.ts` on it; the other jobs run without it.
