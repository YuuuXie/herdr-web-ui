### Fixed
- An omp pane whose sessions live outside `~/.omp/agent` shows its chat: the bridge finds the store
  the pane's own omp process writes to, from its `--session-dir` or profile and the `HOME`,
  `PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR` or XDG data and state
  directories it was started with, never from the bridge's own environment. A session herdr names
  outside that store, a link out of it, another folder's session in a session directory of its own,
  a session version omp does not write, an omp whose environment cannot be read and two omp
  processes using different stores show no chat rather than a guess. Values omp reads from its own
  `.env` files are not seen, and Windows keeps reading `~/.omp` and its profiles only.
