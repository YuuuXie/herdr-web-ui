### Added
- Edit queued or held messages back into the composer without replacing its existing draft.
### Fixed
- Queued-message Edit requires ownership on the bridge and shares its withdrawal outcome with
  other tabs' held-copy resends, so a delivery that already won or could not be confirmed cannot
  also restore the draft. Dismissing uncertain text does not claim it was withdrawn.
- Pi transcript confirmation reads bounded history tails and new entries instead of re-reading
  the whole conversation, and tolerates ongoing appends without accepting partial records.
- Exact Pi delivery receipts reconcile after browser reconnection or reload on the local machine
  without clearing unrelated messages that happen to have the same text. Remote-machine receipt
  resumption is disabled until relays can identify the originating paired device securely.
