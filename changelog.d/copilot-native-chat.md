### Added
- Copilot CLI conversations can show native text, tool activity, recorded model, question choices
  and Autopilot completion summaries in chat on Linux when the foreground session is verified.
  Answer interactive questions in Terminal.
### Fixed
- Resumed Copilot conversations show their history and follow in-process session switches when
  the foreground process's lifecycle log proves the selection, even with older sessions open.
  Unverifiable sessions fall back to Terminal instead of showing another session's history.
- Copilot pagination and tool-output links from a prior foreground selection no longer
  become valid again after switching back; an unregister without a new registration
  also stops serving the old conversation.
- Copilot foreground discovery revalidates log checkpoints after rewrites and recovers
  from large polling gaps using bounded lifecycle-log reads.
