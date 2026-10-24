### Added
- Each release carries the Rust PTY host for Linux (x64, arm64) and macOS (universal) with a
  SHA-256 manifest. Installing the plugin, an update installed from the app and `install.sh` put the
  matching binary in `bin/ovis-pty-sidecar` after checking its checksum and that it runs, and the
  server uses it when `OVIS_PTY_SIDECAR=rust` asks for the Rust host. Remote PC bundles carry it
  too. The Node sidecar stays the default.

### Maintenance
- The **Rust PTY host binaries** workflow builds the host for each platform, runs `cargo test`, and
  on Linux runs the PTY session checks on the built binary; Release attaches its output before it
  publishes.
