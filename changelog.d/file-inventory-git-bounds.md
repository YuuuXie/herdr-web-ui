### Fixed
- File search and path lookup no longer run a repository's fsmonitor hook, follow Git variables
  the server was started with, or wait on a Git listing that never ends: a listing past 16 MiB
  or 3 seconds, or one cut off mid-name, falls back to the folder walk.
