### Fixed
- `GET /api/pane/read` refuses a blank, negative, fractional or too large `lines` with 400
  `invalid_lines` instead of passing it to herdr; a blank value is no longer read as zero. Every
  count herdr takes, from 0 to 4294967295, still goes through unchanged.
