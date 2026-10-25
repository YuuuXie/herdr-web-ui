### Fixed
- A touch swipe on a terminal no longer sends a leftover scroll step after a key, a disconnect, a
  pane switch, the observe role or a released attach: each of them ends the swipe. A fast swipe's
  scroll steps are spread over the next few frames, at most six per frame, instead of all at once,
  and every step still arrives.
