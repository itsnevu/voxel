/* sw-register.js — registers the offline rescue (sw.js). Strictly an add-on.

   A service worker needs a secure context, so a file:// or plain-http page
   simply never asks for one and plays exactly as it always has. Any failure is
   swallowed on purpose: nothing about this game may depend on it.

   This used to be an inline <script> in index.html. The server's
   Content-Security-Policy is script-src 'self' with no 'unsafe-inline', which
   blocked that block outright — so over http(s) the worker was never registered
   and the offline shell never existed. A real file is the only CSP-clean home. */
if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function (e) {
      if (window.RF && RF.err) RF.err('sw:register', e, 'warn');
    });
  });
}
