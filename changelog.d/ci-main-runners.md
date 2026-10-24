### Maintenance
- Pushes to main can run their Linux CI jobs on self-hosted runners of their own (`run.sh
  --reserved` and the `CI_MAIN_SELF_HOSTED_LABELS` repository variable), so a merge's CI no longer
  queues behind pull request runs.
