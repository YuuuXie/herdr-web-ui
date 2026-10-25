// The links that let a tester join the phone app tests on /beta/ and /ko/beta/. Each page ships
// its iPhone and Android sections hidden, with a note that the link is on its way; this shows a
// section, and hides its note, once its link is set below, so no tester meets a link that leads
// nowhere. scripts/ovis-site.test.ts checks each link's shape.
(() => {
  const BETA_LINKS = {
    // iPhone: the public link of the "Ovis Beta" TestFlight group,
    // https://testflight.apple.com/join/…
    testflight: "https://testflight.apple.com/join/dCVKYRA3",
    // Android: the Google Group whose members may join the Google Play closed test,
    // https://groups.google.com/g/…
    play: "https://groups.google.com/g/ovis-beta",
  };

  if (typeof module === "object" && module.exports) {
    module.exports = { BETA_LINKS };
    return;
  }

  for (const [key, link] of Object.entries(BETA_LINKS)) {
    if (!link) continue;
    for (const a of document.querySelectorAll(`a[data-beta-link="${key}"]`)) a.href = link;
    for (const section of document.querySelectorAll(`[data-beta="${key}"]`)) section.hidden = false;
    for (const note of document.querySelectorAll(`[data-beta-pending="${key}"]`)) note.hidden = true;
  }
})();
