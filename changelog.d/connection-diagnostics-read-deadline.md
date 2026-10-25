### Fixed
- A connection diagnostics report whose body takes more than 10 seconds to arrive is cut off, so a
  device sending one slowly can no longer hold every report slot and get other reports refused.
