### Fixed
- A rendered HTML page, its own pictures, scripts and stylesheets, and the videos it plays from the
  server, are read from the file that was checked, so a folder swapped on the way afterwards can
  no longer put another file in their place. An HTML file that is a symlink takes its pictures,
  scripts and stylesheets from the folder of the file it leads to.
