### Added
- Files → Changes compares a branch against a base of your choosing: a **Branch** scope with a
  base picker that lists the repository's local and remote branches (or takes a typed branch or
  commit), and reads what the branch changed since its merge base with that base, untracked files
  included, so what the base went on to change stays out. Each file's patch is read from the
  comparison the list answered with: a base that moves on changes nothing until Refresh, and a
  moved HEAD asks for one. A base that names no commit, a repository with no commit yet and a base
  sharing no history with HEAD are each refused by name, with nothing compared in their place.
