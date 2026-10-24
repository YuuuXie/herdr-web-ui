### Added
- The phone app can get the PC's alerts as push notifications. Turning alerts on in the app
  registers the phone with the push relay for that PC, and the PC sends it alerts as it sends them
  to a browser. On iPhone the app decrypts each alert on the phone (the relay and Apple cannot read
  it) and shows the PC's title and text, or "herdr needs you" when it cannot. The Android app does
  the same once it is built with a Firebase project. Alerts reach the app once the relay at
  `push.ovis.sh` is deployed.
