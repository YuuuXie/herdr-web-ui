### Fixed
- A server or remote bridge that crashed no longer blocks its restart when its old process number
  now belongs to another program: startup locks and the bridge registry record the owner's start
  identity, and that other program is never signalled.
