### Fixed
- Pi's installed `questionnaire` tool now uses the web prompt card for options, free-text answers,
  and multi-question review, including narrow panes. Answers are bound to the pending tool call
  and checked against the current widget before input is sent; incomplete reviews cannot submit.
