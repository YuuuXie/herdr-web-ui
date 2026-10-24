### Maintenance
- A self-hosted CI runner host can raise its own herdr-backed slots, integration shards and browser
  and unit workers with `run.sh --env-file` (`CHECK_HOST_*`), so a large host shards wider while
  other hosts keep `ci.yml`'s values.
