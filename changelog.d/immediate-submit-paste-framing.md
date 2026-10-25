### Fixed
- A message sent from the chat or the terminal's input line can no longer end its own bracketed paste
  early: a paste marker pasted into it is dropped, and the bridge refuses a message whose text and
  typed bytes disagree or that holds terminal control characters, before anything is typed or a
  terminal draft is cleared. The draft stays with the reason.
