### Changed
- Todo updates an agent makes one after another fold into one row in the chat's work block: the
  current list with its progress, how many updates are still pending or failed, and every update
  in order when opened. Narration or any other step between updates keeps them apart.
- The chat says a plan update succeeded only when the transcript records it: Claude Code's
  results do; Codex and other agents record no outcome, so their latest list carries
  "outcome not recorded" instead of a success claim.
