### Fixed
- A release installed in the app from 0.4.13 or older now gets its Rust PTY host too: the updater
  of those versions builds a release without fetching it, so its terminals ran on Node, or were
  mirrored on a PC without Node. The new release's supervisor fetches the host in the background
  and checks it as an update does, and the next terminal runs on it.
