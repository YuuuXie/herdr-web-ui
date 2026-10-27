### Fixed
- Muse chat reads the last 16 MiB of a growing session log once per append to check it for a
  rewrite, instead of hashing it twice with SHA-256.
