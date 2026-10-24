### Fixed
- The phone app no longer opens a PC in the browser (Firefox, for one) when the address it opens
  answers with a redirect to Ovis elsewhere: http to https, an IP address to the PC's name or
  another port. That address becomes the PC and opens in the app. When the address redirects to
  anything that is not Ovis, such as a sign-in page, the app shows its error page naming it
  instead. Links to other sites still open in the browser.
