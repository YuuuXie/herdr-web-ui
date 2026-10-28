### Fixed
- The server no longer keeps or hands out the read finishes of a herdr run that has ended, so a
  browser that reconnects stops writing them back into its storage and `seen.json` holds only the
  runs still going.
