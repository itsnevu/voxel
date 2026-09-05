/* ============================================================================
   sw.js — the offline rescue, and nothing else.

   The game already runs from file:// with no server at all. This only buys that
   same promise back for a tab opened over http(s) that later loses the network:
   reload on a dead train and the isle still comes up.

   NETWORK-FIRST, deliberately. game.js and the fifteen mods are edited all day
   and served with no build step and no content hash in their names, so a
   cache-first worker would quietly hand back yesterday's game.js after a save
   with nothing on screen to say why. Here the network always decides what runs;
   the cache is consulted only when the network fails outright.

   Registered by index.html, and only over https/localhost — a worker cannot own
   a file:// page. Nothing here is load-bearing: every failure path ends in the
   game running exactly as it did before this file existed.
   ========================================================================== */
'use strict';

const CACHE = 'reelfortune-v2';

/* The whole shell. Listed rather than discovered because a service worker has no
   directory listing, and a mod that 404s must not take the install down with it —
   hence the per-URL catch below. */
const SHELL = [
  './',
  'index.html',
  'game.js',
  'net.js',
  'fonts.js',
  'lib/three.min.js',
  'icon-32.png',
  'apple-touch-icon.png',
  'reels.png',
  'icon-192.png',
  'manifest.webmanifest',
  'mods/00-notify.js', 'mods/01-angler.js', 'mods/02-hud.js', 'mods/03-panels.js',
  'mods/04-world.js', 'mods/05-progress.js', 'mods/06-content.js', 'mods/07-juice.js',
  'mods/08-fortune.js', 'mods/09-social.js', 'mods/10-comfort.js', 'mods/11-touch.js',
  'mods/12-boot.js', 'mods/13-audio.js', 'mods/14-npc.js', 'mods/15-nft.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* One at a time, each failure swallowed: cache.addAll() is all-or-nothing,
       so a single renamed asset would leave the player with no offline copy of
       anything at all. */
    await Promise.all(SHELL.map((u) => cache.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // fonts, CDNs: not ours to cache

  /* /api/* is the authoritative server. Serving a stale balance or a stale
     leaderboard from disk would be a lie the player cannot see through, and
     replaying a cached POST-shaped GET is worse. Never touch it. */
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      /* Only successful, non-opaque answers are worth keeping — caching a 404
         page under game.js would survive the fix that made it a 200. */
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const copy = fresh.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      }
      return fresh;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      /* A navigation with nothing cached for that exact URL still deserves the
         isle rather than the browser's dinosaur. */
      if (req.mode === 'navigate') {
        const shell = await caches.match('index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
