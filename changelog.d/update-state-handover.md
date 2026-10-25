### Fixed
- An install made fresh with 0.4.14 or 0.4.15 no longer opens its sign-in gate after an update or a
  restart. Such an install moved to the state folder from before the rename, which held none of its
  paired devices, so any device, and anyone who could reach the address, got in without pairing;
  its shared settings were reset too. Ovis now uses the right folder, and takes the paired devices,
  shared settings and alert subscriptions of the other folder over into it, so devices paired before
  or after the update keep working and a revoked device stays revoked. A device list that cannot be
  read keeps the gate closed.
- An in-app update from such an install now stays on the new version after it restarts, instead of
  going back to the old one and offering the same update again.
