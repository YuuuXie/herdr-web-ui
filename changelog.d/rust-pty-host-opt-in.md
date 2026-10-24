### Changed
- The Rust PTY host can be turned on for real use on Linux and macOS: with `OVIS_PTY_SIDECAR=rust`,
  the server checks the binary once before using it and stays on the Node sidecar when it is
  missing, cannot run or cannot open a terminal, starts an attach on Node when the binary has gone
  since, and uses Node until a restart after the host crashes. `~/` in `OVIS_PTY_SIDECAR_BIN` is
  expanded, so the plugin's `env` file can name the binary. The Node sidecar stays the default.

### Maintenance
- CI builds the Rust PTY host and runs its checks and the PTY session checks on it in a job of
  its own.
