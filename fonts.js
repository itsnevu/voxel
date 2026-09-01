/* fonts.js — flips the Google Fonts <link media="print"> to "all" once it has loaded.

   The link is fetched with media="print" so that from file:// (where the request
   never resolves) it can never hold up first paint. The switch used to be an
   inline onload="this.media='all'", but the server's Content-Security-Policy is
   script-src 'self' with no 'unsafe-inline', which silently blocks inline
   handlers — the fonts then downloaded and were never applied. Keeping the
   switch in a real file is the only CSP-clean way to do it. Shared by index.html
   and mint.html. */
(function () {
  'use strict';
  var links = document.querySelectorAll('link[rel="stylesheet"][data-font]');
  for (var i = 0; i < links.length; i++) {
    (function (l) {
      var apply = function () { l.media = 'all'; };
      if (l.sheet) { apply(); return; }            // already landed by the time we run
      l.addEventListener('load', apply);
    })(links[i]);
  }
})();
