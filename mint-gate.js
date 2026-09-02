/* mint-gate.js — closes the BUY path while the page stays open.

   The collection is worth looking at whether or not it is for sale, so this
   does not hide anything: the gallery, the traits and the rarity table all stay.
   It disables the purchase and says why.

   The switch is the server's (MINT_OPEN in the environment), not this file's,
   so opening and closing the sale is a restart rather than a release.

   mint.js re-renders the button whenever chain state moves, so a one-shot
   disable would be undone within the second. The button is therefore held shut
   three ways: a body class CSS can act on, an observer that re-applies the
   label, and a wrapper on RFMint.mint() so even a console call refuses. */
(function () {
  'use strict';

  function shut(reason) {
    document.body.classList.add('mint-closed');

    var btn = document.getElementById('mintBtn');
    var note = document.getElementById('mintNote');

    function hold() {
      if (btn) {
        btn.disabled = true;
        if (btn.textContent !== 'MINTING NOT OPEN YET') btn.textContent = 'MINTING NOT OPEN YET';
      }
      if (note && note.textContent !== reason) note.textContent = reason;
    }
    hold();

    /* mint.js owns this button and rewrites it on every chain update, so watch
       and re-apply rather than trusting one pass. */
    if (window.MutationObserver && btn) {
      new MutationObserver(hold).observe(btn, {
        childList: true, characterData: true, subtree: true, attributes: true,
      });
    }

    /* Last line: the page exposes window.RFMint for its own test harness, and
       that is also the way past a disabled button. */
    var tries = 0;
    var wrap = setInterval(function () {
      if (window.RFMint && typeof window.RFMint.mint === 'function' && !window.RFMint.__gated) {
        window.RFMint.__gated = true;
        window.RFMint.mint = function () {
          return Promise.reject(new Error('minting is not open yet'));
        };
        clearInterval(wrap);
      }
      if (++tries > 40) clearInterval(wrap);
    }, 250);
  }

  var REASON = 'Minting is not open yet · the collection is still being finalised. '
    + 'Look around — nothing here is for sale today.';

  /* Ask the server. A failed check leaves the page exactly as it was: a live
     buy button on an open sale is the correct default, and a blipped fetch must
     not be able to close a shop on its own. */
  fetch('/api/nft/config', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (c) { if (c && c.mintOpen === false) shut(REASON); })
    .catch(function () { /* leave the page alone */ });
})();
